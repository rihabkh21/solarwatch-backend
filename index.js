/**
 * SolarWatch - Backend MQTT → Firebase + ML + Alertes
 * Lancer avec : node index.js
 */

const mqtt   = require("mqtt");
const admin  = require("firebase-admin");
const http   = require("http");
const serviceAccount = require("./serviceAccount.json");

// ========================================
// FIREBASE
// ========================================
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: "https://solarwatch-8c68a-default-rtdb.firebaseio.com"
});

const realtimeDb = admin.database();
const firestore  = admin.firestore();
console.log("✅ Firebase connecté (Realtime + Firestore)");

// ========================================
// SEUILS D'ALERTE
// ========================================
const THRESHOLDS = {
  temperature_critical: 70,
  temperature_warning:  55,
  voltage_min:          5,
  current_max:          10000,
  fault_prob_critical:  80,
  fault_prob_warning:   50,
};

const lastAlertTime = {};
const ALERT_COOLDOWN = 60000; // 1 minute

// ========================================
// HELPER : envoyer alerte Firestore
// ========================================
async function sendAlert(type, message, sensor, value, threshold) {
  const key = `${type}_${sensor}`;
  const now = Date.now();
  if (lastAlertTime[key] && now - lastAlertTime[key] < ALERT_COOLDOWN) return;
  lastAlertTime[key] = now;

  try {
    await firestore.collection("alerts").add({
      type, message, sensor,
      value:     value     ?? null,
      threshold: threshold ?? null,
      resolved:  false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`🚨 Alerte [${type}] : ${message}`);
  } catch (err) {
    console.error("❌ Erreur alerte:", err.message);
  }
}

// ========================================
// HELPER : appeler API XGBoost
// ========================================
function callMLApi(mlData) {
  return new Promise((resolve) => {
    const body    = JSON.stringify(mlData);
    const options = {
      hostname: "localhost", port: 5000, path: "/analyze", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data",  chunk => data += chunk);
      res.on("end",   ()    => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ========================================
// MQTT
// ========================================
const mqttClient = mqtt.connect("mqtt://broker.hivemq.com:1883");

mqttClient.on("connect", () => {
  console.log("✅ MQTT connecté → broker.hivemq.com");
  mqttClient.subscribe("solarwatch/ESP32_001/data");
  mqttClient.subscribe("solarwatch/ESP32_001/status");
  console.log("📡 Abonné aux topics ESP32\n");
});

// ========================================
// TRAITEMENT MESSAGES
// ========================================
mqttClient.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    console.log(`\n📩 [${topic}]`);

    // ── STATUT ────────────────────────────
    if (topic === "solarwatch/ESP32_001/status") {
      await realtimeDb.ref("sensors/ESP32_001/status").set({
        ...data, updatedAt: Date.now()
      });
      if (data.status === "offline") {
        await sendAlert("critical", "ESP32 déconnecté du réseau", "ESP32", null, null);
      }
      return;
    }

    if (topic !== "solarwatch/ESP32_001/data") return;

    // ── EXTRACTION DONNÉES ────────────────
    const lux         = data.bh1750?.lux                || 0;
    const irradiance  = lux / 120;
    const temperature = data.ds18b20?.temperature        || 0;
    const voltage     = data.voltageDivider?.voltage     || 0;
    const currentMa   = data.currentShunt?.current       || 0;
    const currentA    = currentMa / 1000;
    const power       = data.calculated?.power           || (voltage * currentA);

    console.log(`   🌡️  ${temperature}°C | ☀️  ${lux} lux | ⚡ ${voltage}V | 🔋 ${currentMa}mA`);

    // ── APPEL ML ──────────────────────────
    const mlResult = await callMLApi({ irradiance, temperature, voltage, current: currentA });

    // ── ALERTES SEUILS ────────────────────
    if (temperature > THRESHOLDS.temperature_critical) {
      await sendAlert("critical", `Température critique : ${temperature.toFixed(1)}°C`,
        "DS18B20", temperature, THRESHOLDS.temperature_critical);
    } else if (temperature > THRESHOLDS.temperature_warning) {
      await sendAlert("warning", `Température élevée : ${temperature.toFixed(1)}°C`,
        "DS18B20", temperature, THRESHOLDS.temperature_warning);
    }

    if (voltage > 0 && voltage < THRESHOLDS.voltage_min) {
      await sendAlert("warning", `Tension faible : ${voltage.toFixed(2)}V`,
        "Panneau solaire", voltage, THRESHOLDS.voltage_min);
    }

    if (currentMa > THRESHOLDS.current_max) {
      await sendAlert("critical", `Courant excessif : ${currentMa.toFixed(0)}mA`,
        "ACS712", currentMa, THRESHOLDS.current_max);
    }

    // ── ALERTES ML ────────────────────────
    if (mlResult?.classification) {
      const faultProb = mlResult.classification.probabilities?.fault || 0;
      const status    = mlResult.classification.status;

      if (status === "fault" && faultProb >= THRESHOLDS.fault_prob_critical) {
        await sendAlert("critical",
          `Anomalie IA détectée (${faultProb}% confiance)`,
          "XGBoost ML", faultProb, THRESHOLDS.fault_prob_critical);
      } else if (status === "fault" && faultProb >= THRESHOLDS.fault_prob_warning) {
        await sendAlert("warning",
          `Comportement suspect (${faultProb}%)`,
          "XGBoost ML", faultProb, THRESHOLDS.fault_prob_warning);
      } else if (status === "normal") {
        const hourKey = `info_normal_${Math.floor(Date.now() / 3600000)}`;
        if (!lastAlertTime[hourKey]) {
          lastAlertTime[hourKey] = Date.now();
          await sendAlert("info",
            `Système opérationnel — puissance: ${mlResult.regression?.power_predicted_w}W`,
            "SolarWatch", mlResult.regression?.power_predicted_w, null);
        }
      }

      console.log(`   🤖 ML: ${mlResult.classification.label} (panne: ${faultProb}%)`);
      console.log(`   ⚡ Puissance prévue: ${mlResult.regression?.power_predicted_w}W`);
    }

    // ── DONNÉES ENRICHIES ─────────────────
    const enriched = {
      ...data,
      irradiance,
      mlInput: { irradiance, temperature, voltage, current: currentA },
      prediction: mlResult ? {
        status:         mlResult.classification?.status,
        label:          mlResult.classification?.label,
        level:          mlResult.classification?.level,
        probabilities:  mlResult.classification?.probabilities,
        powerPredicted: mlResult.regression?.power_predicted_w,
        energy24h:      mlResult.regression?.energy_24h_wh,
        revenue24h:     mlResult.regression?.revenue_24h_tnd,
        updatedAt:      Date.now()
      } : null,
      receivedAt: Date.now()
    };

    // ── REALTIME DATABASE ─────────────────
    await realtimeDb.ref("sensors/ESP32_001/current").set(enriched);
    await realtimeDb.ref("sensors/ESP32_001/history").push(enriched);

    // ── ✅ FIRESTORE sensorHistory (pour graphiques React) ──
    await firestore.collection("sensorHistory").add({
      deviceId:    "ESP32_001",
      temperature: temperature,
      lux:         lux,
      voltage:     voltage,
      current:     currentA,
      power:       power,
      irradiance:  irradiance,
      prediction:  mlResult?.classification?.status || "unknown",
      powerPredicted: mlResult?.regression?.power_predicted_w || 0,
      timestamp:   Date.now(),
      createdAt:   admin.firestore.FieldValue.serverTimestamp()
    });

    console.log("✅ Firebase Realtime + Firestore mis à jour");

  } catch (err) {
    console.error("❌ Erreur:", err.message);
  }
});

// ========================================
// ERREURS
// ========================================
mqttClient.on("error",   (err) => console.error("❌ MQTT:", err.message));
mqttClient.on("offline", ()    => console.log("⚠️  MQTT déconnecté..."));

process.on("SIGINT", () => {
  console.log("\n🛑 Arrêt...");
  mqttClient.end();
  process.exit();
});

console.log("🚀 SolarWatch Backend — MQTT + Firebase + ML + Alertes");
console.log("   En attente de données ESP32...\n");
