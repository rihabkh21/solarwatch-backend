# SolarWatch – Backend

Backend of an IoT solar monitoring system: it receives ESP32 sensor data over MQTT, stores it in Firebase, and serves a machine learning module ([à préciser : prédiction de production ?]).

## Architecture
ESP32 → MQTT → Backend (Node.js) → Firebase → React dashboard
([lien vers solarwatch-frontend])

## Features
- MQTT ingestion of [tension, courant, température...]
- Storage in Firebase
- ML module (`/ml`, Python): [ce qu'il fait]

## Stack
Node.js · MQTT · Firebase · Python · Railway

## Run locally
1. `npm install`
2. Create a `.env` file with: [variables, sans les valeurs]
3. `node index.js`

