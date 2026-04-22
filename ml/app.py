"""
SolarWatch - API Flask avec 2 modèles XGBoost
  - /predict  → Classification (Normal / Panne)
  - /forecast → Régression (Puissance prévue en Watts)
  - /analyze  → Les deux ensemble
Lancer : python app.py
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, r2_score, mean_absolute_error
import joblib
import os

app = Flask(__name__)
CORS(app)

DATASET_PATH     = "C:/Users/asus/Desktop/dataset_final.csv"
MODEL_CLASS_PATH = "model.joblib"
MODEL_REG_PATH   = "modelregression.joblib"

FEATURES = ["irradiance", "temperature", "voltage", "current"]

model_class = None
model_reg   = None

# ========================================
# CHARGER / ENTRAÎNER CLASSIFICATION
# ========================================
def load_or_train_classifier():
    global model_class
    if os.path.exists(MODEL_CLASS_PATH):
        model_class = joblib.load(MODEL_CLASS_PATH)
        print("✅ Modèle classification chargé (model.joblib)")
    else:
        print("🤖 Entraînement classification...")
        df = pd.read_csv(DATASET_PATH)
        X = df[FEATURES]
        y = df["fault"].astype(int)
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=y)
        model_class = xgb.XGBClassifier(
            n_estimators=100, max_depth=6,
            learning_rate=0.1, random_state=42, verbosity=0)
        model_class.fit(X_train, y_train)
        acc = accuracy_score(y_test, model_class.predict(X_test))
        print(f"✅ Classification — Accuracy: {acc*100:.2f}%")
        joblib.dump(model_class, MODEL_CLASS_PATH)

# ========================================
# CHARGER / ENTRAÎNER RÉGRESSION
# ========================================
def load_or_train_regressor():
    global model_reg
    if os.path.exists(MODEL_REG_PATH):
        model_reg = joblib.load(MODEL_REG_PATH)
        print("✅ Modèle régression chargé (modelregression.joblib)")
    else:
        print("🤖 Entraînement régression...")
        df = pd.read_csv(DATASET_PATH)
        X = df[FEATURES]          # mêmes features que classification
        y = df["power"]           # target = puissance
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42)
        model_reg = xgb.XGBRegressor(
            n_estimators=100, max_depth=6,
            learning_rate=0.1, random_state=42, verbosity=0)
        model_reg.fit(X_train, y_train)
        r2  = r2_score(y_test, model_reg.predict(X_test))
        mae = mean_absolute_error(y_test, model_reg.predict(X_test))
        print(f"✅ Régression — R²: {r2:.4f} | MAE: {mae:.4f}")
        joblib.dump(model_reg, MODEL_REG_PATH)

# Charger au démarrage
load_or_train_classifier()
load_or_train_regressor()

# ========================================
# HELPER : extraire features
# ========================================
def extract_features(data):
    irradiance  = float(data.get("irradiance",  data.get("lux", 0)))
    temperature = float(data.get("temperature", 0))
    voltage     = float(data.get("voltage",     0))
    current     = float(data.get("current",     0))
    if current > 100:
        current = current / 1000.0

    return pd.DataFrame(
        [[irradiance, temperature, voltage, current]],
        columns=FEATURES
    )

# ========================================
# ROUTE : ACCUEIL
# ========================================
@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "service": "SolarWatch ML API",
        "endpoints": {
            "predict":  "POST /predict  → Normal ou Panne",
            "forecast": "POST /forecast → Puissance prévue (W)",
            "analyze":  "POST /analyze  → Les deux ensemble",
            "health":   "GET  /health"
        }
    })

# ========================================
# ROUTE : CLASSIFICATION
# ========================================
@app.route("/predict", methods=["POST"])
def predict():
    try:
        features    = extract_features(request.get_json())
        prediction  = model_class.predict(features)[0]
        probability = model_class.predict_proba(features)[0]

        prob_normal = round(float(probability[0]) * 100, 1)
        prob_fault  = round(float(probability[1]) * 100, 1)

        if prediction == 1:
            status = "fault"
            label  = "⚠️ Anomalie détectée"
            level  = "critical" if prob_fault > 80 else "warning"
        else:
            status = "normal"
            label  = "✅ Fonctionnement normal"
            level  = "info"

        print(f"🔍 Classification: {label} (panne: {prob_fault}%)")

        return jsonify({
            "prediction":    int(prediction),
            "status":        status,
            "label":         label,
            "level":         level,
            "probabilities": {"normal": prob_normal, "fault": prob_fault},
            "input":         features.to_dict(orient="records")[0]
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ========================================
# ROUTE : RÉGRESSION
# ========================================
@app.route("/forecast", methods=["POST"])
def forecast():
    try:
        features        = extract_features(request.get_json())
        power_predicted = float(model_reg.predict(features)[0])
        power_predicted = max(0, round(power_predicted, 2))
        energy_24h      = round(power_predicted * 24, 2)
        revenue_24h     = round(energy_24h * 0.15, 3)

        print(f"📈 Régression: {power_predicted} W prévus")

        return jsonify({
            "power_predicted_w": power_predicted,
            "energy_24h_wh":     energy_24h,
            "revenue_24h_tnd":   revenue_24h,
            "input":             features.to_dict(orient="records")[0]
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ========================================
# ROUTE : ANALYSE COMPLÈTE
# ========================================
@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        features    = extract_features(request.get_json())

        # Classification
        prediction  = model_class.predict(features)[0]
        probability = model_class.predict_proba(features)[0]
        prob_normal = round(float(probability[0]) * 100, 1)
        prob_fault  = round(float(probability[1]) * 100, 1)

        if prediction == 1:
            status = "fault"
            label  = "⚠️ Anomalie détectée"
            level  = "critical" if prob_fault > 80 else "warning"
        else:
            status = "normal"
            label  = "✅ Fonctionnement normal"
            level  = "info"

        # Régression
        power_predicted = float(model_reg.predict(features)[0])
        power_predicted = max(0, round(power_predicted, 2))
        energy_24h      = round(power_predicted * 24, 2)
        revenue_24h     = round(energy_24h * 0.15, 3)

        print(f"🔍 {label} | ⚡ {power_predicted}W")

        return jsonify({
            "classification": {
                "prediction":    int(prediction),
                "status":        status,
                "label":         label,
                "level":         level,
                "probabilities": {"normal": prob_normal, "fault": prob_fault}
            },
            "regression": {
                "power_predicted_w": power_predicted,
                "energy_24h_wh":     energy_24h,
                "revenue_24h_tnd":   revenue_24h
            },
            "input": features.to_dict(orient="records")[0]
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ========================================
# ROUTE : HEALTH
# ========================================
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":               "ok",
        "model_classification": model_class is not None,
        "model_regression":     model_reg   is not None
    })

# ========================================
# LANCER
# ========================================
if __name__ == "__main__":
    print("\n🚀 SolarWatch ML API — 2 modèles actifs")
    print("   Classification : POST /predict")
    print("   Régression     : POST /forecast")
    print("   Les deux       : POST /analyze")
    print("   URL            : http://localhost:5000\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
