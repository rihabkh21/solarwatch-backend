/**
 * SolarWatch - Backend MQTT → Firebase + ML + Alertes
 * Firebase credentials depuis variables d'environnement Railway
 */

const mqtt  = require("mqtt");
const admin = require("firebase-admin");
const http  = require("http");

// ── Firebase — variables d'environnement (pas de serviceAccount.json) ─────────
const serviceAccount = {
  type:                        "service_account",
  project_id:                  process.env.FIREBASE_PROJECT_ID,
  private_key_id:              process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key:                 (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  client_email:                process.env.FIREBASE_CLIENT_EMAIL,
  client_id:                   process.env.FIREBASE_CLIENT_ID,
  auth_uri:                    "https://accounts.google.com/o/oauth2/auth",
  token_uri:                   "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url:        process.env.FIREBASE_CERT_URL,
};

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: "https://solarwatch-8c68a-default-rtdb.firebaseio.com"
});

const realtimeDb = admin.database();
const firestore  = admin.firestore();
console.log("✅ Firebase connecté (Realtime + Firestore)");

const PANEL_MAX_POWER = 15;
const PANEL_AREA_M2   = 0.11;
const SEND_INTERVAL_S = 3;

let energyAccWh   = 0;
let lastResetDate = new Date().toDateString();
let lastMsgTime   = null;

function resetEnergyAtMidnight() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    console.log(`🌙 Minuit — remise à zéro énergie (${energyAccWh.toFixed(4)} Wh produits hier)`);
    firestore.collection("dailyEnergy").add({
      date: lastResetDate, energyWh: energyAccWh, energyKwh: energyAccWh / 1000,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
    energyAccWh = 0; lastResetDate = today;
  }
}

function accumulateEnergy(powerW) {
  resetEnergyAtMidnight();
  const now = Date.now();
  const intervalS = lastMsgTime ? Math.min((now - lastMsgTime) / 1000, 10) : SEND_INTERVAL_S;
  lastMsgTime = now;
  energyAccWh += powerW * (intervalS / 3600);
  return parseFloat(energyAccWh.toFixed(6));
}

const THRESHOLDS = {
  temperature_critical: 70, temperature_warning: 55,
  voltage_min: 5, current_max: 4000,
  fault_prob_critical: 80, fault_prob_warning: 50,
};
const lastAlertTime  = {};
const ALERT_COOLDOWN = 60000;

async function sendAlert(type, message, sensor, value, threshold) {
  const key = `${type}_${sensor}`;
  const now = Date.now();
  if (lastAlertTime[key] && now - lastAlertTime[key] < ALERT_COOLDOWN) return;
  lastAlertTime[key] = now;
  try {
    await firestore.collection("alerts").add({
      type, message, sensor, value: value ?? null, threshold: threshold ?? null,
      resolved: false, timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`⚠️  Alerte [${type}] : ${message}`);
  } catch (err) { console.error("❌ Erreur alerte:", err.message); }
}

function estimateVoltage(lux, measuredVoltage) {
  if (measuredVoltage > 0) return measuredVoltage;
  return parseFloat((6.0 + (lux / 100000.0) * 6.0).toFixed(2));
}
function filterCurrent(currentMa, lux) { return lux < 50 ? 0 : currentMa; }
function calculateEfficiency(powerW) {
  if (powerW <= 0) return 0;
  return parseFloat(Math.min((powerW / PANEL_MAX_POWER) * 100, 100).toFixed(1));
}

const ML_HOST = process.env.ML_SERVICE_URL || "localhost";
const ML_PORT = parseInt(process.env.ML_SERVICE_PORT || "5000");

function callMLApi(mlData) {
  return new Promise((resolve) => {
    const body = JSON.stringify(mlData);
    const options = {
      hostname: ML_HOST, port: ML_PORT, path: "/analyze", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(body); req.end();
  });
}

const HIVEMQ_HOST     = "4a24dfd2e8ba429ea6be9824c0611d27.s1.eu.hivemq.cloud";
const HIVEMQ_USER     = "solarwatch";
const HIVEMQ_PASSWORD = "SolarWatch2026!";

const mqttClient = mqtt.connect(`mqtts://${HIVEMQ_HOST}:8883`, {
  username: HIVEMQ_USER, password: HIVEMQ_PASSWORD,
  reconnectPeriod: 5000, connectTimeout: 30000,
  clientId: "SolarWatch-Backend-" + Math.random().toString(16).slice(2, 8),
});

mqttClient.on("connect", () => {
  console.log(`✅ MQTT connecté → ${HIVEMQ_HOST}:8883 (TLS)`);
  mqttClient.subscribe("solarwatch/ESP32_001/data");
  mqttClient.subscribe("solarwatch/ESP32_001/status");
  console.log("📡 Abonné aux topics ESP32\n");
  realtimeDb.ref("sensors/ESP32_001/current/energy24h").once("value").then(snap => {
    if (snap.exists()) {
      realtimeDb.ref("sensors/ESP32_001/current/energyDate").once("value").then(dateSnap => {
        if (dateSnap.exists() && dateSnap.val() === new Date().toDateString()) {
          energyAccWh = snap.val();
          console.log(`🔋 Énergie restaurée: ${energyAccWh.toFixed(4)} Wh`);
        }
      });
    }
  }).catch(() => {});
});

mqttClient.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const now  = Date.now();
    console.log(`\n📨 [${new Date().toISOString()}] ${topic}`);

    if (topic === "solarwatch/ESP32_001/status") {
      await realtimeDb.ref("sensors/ESP32_001/status").set({ ...data, updatedAt: now });
      if (data.status === "offline") await sendAlert("critical", "ESP32 déconnecté", "ESP32", null, null);
      return;
    }
    if (topic !== "solarwatch/ESP32_001/data") return;

    const temperature = data.temperature ?? 0;
    const lux         = data.lux         ?? 0;
    const lightLevel  = data.lightLevel  ?? "unknown";
    const voltageRaw  = data.voltage     ?? 0;
    const currentRaw  = data.current     ?? 0;
    const irradiance  = data.irradiance  ?? (lux / 120);
    const wifiRSSI    = data.wifiRSSI    ?? 0;
    const uptime      = data.uptime      ?? 0;
    const freeHeap    = data.freeHeap    ?? 0;

    const voltage   = estimateVoltage(lux, voltageRaw);
    const currentMa = filterCurrent(currentRaw, lux);
    const currentA  = currentMa / 1000;

    const powerCalculated      = voltage > 0 && currentMa > 0 ? parseFloat(((voltage * currentMa) / 1000).toFixed(2)) : 0;
    const energy24hWh          = accumulateEnergy(powerCalculated);
    const efficiencyCalculated = calculateEfficiency(powerCalculated);

    console.log(`   🌡️  ${temperature}°C | ☀️  ${lux} lux | ⚡ ${voltage}V | 🔋 ${currentMa}mA | 💡 ${powerCalculated}W | 📊 ${efficiencyCalculated}% | 🔌 ${(energy24hWh/1000).toFixed(4)} kWh`);

    const isOutdoor = lux >= 5000;
    const mlResult  = isOutdoor ? await callMLApi({ irradiance, temperature, voltage, current: currentA }) : null;
    if (!isOutdoor) console.log(`   🤖 ML: désactivé (intérieur, ${lux} lux < 5000)`);

    if (temperature > 0 && temperature > THRESHOLDS.temperature_critical)
      await sendAlert("critical", `Temp critique: ${temperature.toFixed(1)}C`, "DS18B20", temperature, THRESHOLDS.temperature_critical);
    else if (temperature > 0 && temperature > THRESHOLDS.temperature_warning)
      await sendAlert("warning", `Temp elevee: ${temperature.toFixed(1)}C`, "DS18B20", temperature, THRESHOLDS.temperature_warning);
    if (voltage > 0 && voltage < THRESHOLDS.voltage_min)
      await sendAlert("warning", `Tension faible: ${voltage.toFixed(2)}V`, "Panneau", voltage, THRESHOLDS.voltage_min);
    if (currentMa > THRESHOLDS.current_max)
      await sendAlert("critical", `Courant excessif: ${currentMa}mA`, "ACS712", currentMa, THRESHOLDS.current_max);

    if (mlResult?.classification) {
      const faultProb = mlResult.classification.probabilities?.fault || 0;
      const status    = mlResult.classification.status;
      if (status === "fault" && faultProb >= THRESHOLDS.fault_prob_critical)
        await sendAlert("critical", `Anomalie IA: ${faultProb}%`, "XGBoost", faultProb, THRESHOLDS.fault_prob_critical);
      else if (status === "fault" && faultProb >= THRESHOLDS.fault_prob_warning)
        await sendAlert("warning", `Comportement suspect: ${faultProb}%`, "XGBoost", faultProb, THRESHOLDS.fault_prob_warning);
      console.log(`   🤖 ML: ${mlResult.classification.label} | Panne: ${faultProb}% | Prévu: ${mlResult.regression?.power_predicted_w}W`);
    } else if (isOutdoor) {
      console.log("   🤖 ML: non disponible (Flask non démarré)");
    }

    const enriched = {
      deviceId: "ESP32_001", temperature, lux, lightLevel,
      voltage, voltageEstimated: voltageRaw === 0,
      current: currentMa, currentRaw,
      power: powerCalculated, efficiency: efficiencyCalculated,
      energy24h: energy24hWh, energyDate: new Date().toDateString(),
      irradiance, panelMaxPower: PANEL_MAX_POWER, panelArea: PANEL_AREA_M2,
      wifiRSSI, uptime, freeHeap,
      prediction: mlResult ? {
        status: mlResult.classification?.status, label: mlResult.classification?.label,
        probabilities: mlResult.classification?.probabilities,
        powerPredicted: mlResult.regression?.power_predicted_w,
        energy24h: mlResult.regression?.energy_24h_wh,
      } : null,
      receivedAt: now
    };

    await realtimeDb.ref("sensors/ESP32_001/current").set(enriched);
    await realtimeDb.ref("sensors/ESP32_001/history").push(enriched);
    await firestore.collection("sensorHistory").add({ ...enriched, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    const cutoff = now - (24 * 60 * 60 * 1000);
    const snap   = await realtimeDb.ref("sensors/ESP32_001/history").orderByChild("receivedAt").endAt(cutoff).once("value");
    if (snap.exists()) {
      const updates = {};
      snap.forEach(child => { updates[child.key] = null; });
      await realtimeDb.ref("sensors/ESP32_001/history").update(updates);
      console.log(`🧹 ${Object.keys(updates).length} entrées supprimées`);
    }
    console.log("✅ Firebase mis à jour");

  } catch (err) { console.error("❌ Erreur:", err.message); }
});

mqttClient.on("error",     err => console.error("❌ MQTT:", err.message));
mqttClient.on("offline",   ()  => console.log("⚠️  MQTT hors ligne - reconnexion..."));
mqttClient.on("reconnect", ()  => console.log("🔄 MQTT reconnexion..."));

process.on("SIGINT", () => {
  console.log(`\n🌙 Arrêt — énergie accumulée: ${energyAccWh.toFixed(4)} Wh`);
  mqttClient.end(); process.exit(0);
});

console.log("🌞 SolarWatch Backend — MQTT HiveMQ Cloud TLS + Firebase + ML");
console.log(`   Panneau : ${PANEL_MAX_POWER}W nominale | ${PANEL_AREA_M2}m²`);
console.log("   En attente de données ESP32...\n");