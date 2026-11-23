# WattGuard — Smart Home Power & Fault Monitor (with AI + Backend)

## Run
1. Install Node.js 18+ (https://nodejs.org)
2. **Copy your original `index.html` into the `public/` folder** (the scripts are wired in automatically on start)
3. In this folder:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000

Optional Claude assistant: copy `.env.example` to `.env`, paste your `ANTHROPIC_API_KEY`, restart.
Without a key the assistant uses the built-in offline engine, so the demo always works.

## Architecture
```
Browser (public/)                          Node.js backend (server.js)
 index.html  – dashboard + Three.js 3D      Express REST API
 ai-engine.js – anomaly detection (EWMA),   JSON file store  (data/db.json)
                forecasting, automation     /api/ai  → Claude (key stays server-side)
                rules, chat assistant
 app-backend.js – saves readings/events ──► /api/readings, /api/events
 history.html – charts of stored data   ◄── /api/stats, /api/export.csv
```

## API
| Method | Route | Purpose |
|---|---|---|
| POST | /api/readings | store a load reading (every 5 s) |
| GET | /api/readings?limit=n | recent readings |
| POST / GET | /api/events | store / list event log |
| GET | /api/stats | peak, average, kWh, cost, AI mode |
| GET | /api/export.csv | download readings |
| POST | /api/ai | assistant (Claude if key set, else client falls back) |
| DELETE | /api/data | clear stored data |

## AI features
- Anomaly detection: exponentially-weighted moving average + z-score (> 3σ)
- Forecast: linear regression on last 20 readings → +10 s load, monthly bill projection
- Automation: load shedding (> 2200 W), water-heater timeout, idle-light eco mode
- Assistant: natural-language control ("turn off all lights", "cut wire in garage")

## Notes for your report
Readings are simulated (no real sensors). In a real deployment, an ESP32 + current sensor (e.g. ACS712) would POST to `/api/readings`. Add authentication before exposing the server publicly.
