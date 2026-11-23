// WattGuard backend — Express + JSON file store + optional Claude assistant
const fs = require('fs'), path = require('path');
const express = require('express');

// tiny .env loader (no extra dependency)
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}); } catch {}

const PORT = process.env.PORT || 3000, KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', RATE = 8; // INR per kWh
const PUB = path.join(__dirname, 'public'), DATA = path.join(__dirname, 'data', 'db.json');

/* ---------- storage ---------- */
fs.mkdirSync(path.dirname(DATA), { recursive: true });
let db = { readings: [], events: [] }, dirty = false;
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
const flush = () => { if (dirty) { fs.writeFileSync(DATA, JSON.stringify(db)); dirty = false; } };
setInterval(flush, 2000);
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { flush(); process.exit(); }));

/* ---------- auto-wire the front-end scripts into public/index.html ---------- */
function inject() {
  const f = path.join(PUB, 'index.html');
  if (!fs.existsSync(f)) { console.warn('⚠  Copy your WattGuard index.html into the public/ folder.'); return; }
  let h = fs.readFileSync(f, 'utf8');
  if (h.includes('app-backend.js')) return;
  h = h.replace(/<script src="ai-engine\.js"><\/script>\s*/g, '')
       .replace('</body>', '<script src="app-backend.js"></script>\n<script src="ai-engine.js"></script>\n</body>');
  fs.writeFileSync(f, h); console.log('✓ Added backend + AI scripts to public/index.html');
}
inject();

/* ---------- helpers ---------- */
const app = express();
app.use(express.json({ limit: '50kb' }));
const num = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
const hits = new Map();
const allow = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length <= 20; };

function stats() {
  const r = db.readings; let kwh = 0, peak = 0, sum = 0;
  r.forEach((x, i) => {
    const dt = i < r.length - 1 ? Math.min((r[i + 1].t - x.t) / 1000, 10) : 5;
    kwh += x.watts * dt / 3.6e6; peak = Math.max(peak, x.watts); sum += x.watts;
  });
  return { readings: r.length, events: db.events.length, peakWatts: peak, avgWatts: r.length ? Math.round(sum / r.length) : 0,
    kWh: +kwh.toFixed(4), cost: +(kwh * RATE).toFixed(2), since: r[0]?.t || null };
}

/* ---------- REST API ---------- */
app.post('/api/readings', (req, res) => {
  const b = req.body || {};
  db.readings.push({ t: Date.now(), watts: num(b.watts, 50000), risk: num(b.risk, 100),
    rooms: Array.isArray(b.rooms) ? b.rooms.slice(0, 12).map(r => ({ id: String(r.id).slice(0, 20), w: num(r.w, 50000), fault: !!r.fault })) : [] });
  if (db.readings.length > 20000) db.readings.splice(0, db.readings.length - 20000);
  dirty = true; res.json({ ok: true });
});
app.get('/api/readings', (req, res) => {
  const n = Math.min(+req.query.limit || 200, 5000);
  res.json(db.readings.slice(-n).map(({ t, watts, risk }) => ({ t, watts, risk })));
});
app.post('/api/events', (req, res) => {
  const b = req.body || {};
  db.events.push({ t: Date.now(), msg: String(b.msg || '').slice(0, 300), cls: ['ok', 'fault', 'restore'].includes(b.cls) ? b.cls : 'ok' });
  if (db.events.length > 5000) db.events.splice(0, db.events.length - 5000);
  dirty = true; res.json({ ok: true });
});
app.get('/api/events', (req, res) => res.json(db.events.slice(-Math.min(+req.query.limit || 50, 500)).reverse()));
app.get('/api/stats', (_, res) => res.json({ ...stats(), ai: KEY ? 'claude' : 'offline' }));
app.get('/api/export.csv', (_, res) => {
  res.type('text/csv').attachment('wattguard-readings.csv');
  res.send('time,watts,risk\n' + db.readings.map(r => `${new Date(r.t).toISOString()},${r.watts},${r.risk}`).join('\n'));
});
app.delete('/api/data', (_, res) => { db = { readings: [], events: [] }; dirty = true; res.json({ ok: true }); });

/* ---------- AI assistant (Claude) ---------- */
const SYSTEM = `You are WattGuard, an energy assistant for a smart home dashboard. Rooms ids: living, kitchen, bedroom, bathroom, garage, study.
Device names: Light, TV, Refrigerator, Fan, Water Heater, EV Charger, Computer. Rate is Rs 8 per kWh.
Reply with ONLY a JSON object, no markdown: {"reply": "short helpful answer", "actions": []}
Add actions ONLY when the user asks you to change something. Action shapes:
{"type":"set","room":"<id>","device":"<Device name>","on":true|false} | {"type":"fault","room":"<id>"} | {"type":"reset","room":"<id>"}
Use the supplied house state and stats to answer questions about usage, cost and savings. Keep replies under 70 words.`;

app.post('/api/ai', async (req, res) => {
  if (!KEY) return res.json({ reply: null, source: 'offline' });
  if (!allow(req.ip)) return res.status(429).json({ error: 'Too many requests' });
  const message = String((req.body || {}).message || '').slice(0, 500);
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM,
        messages: [{ role: 'user', content: `House state: ${JSON.stringify(req.body.state || []).slice(0, 4000)}\nStored stats: ${JSON.stringify(stats())}\n\nUser: ${message}` }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'API error ' + r.status);
    const text = (j.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    let out; try { out = JSON.parse(text); } catch { out = { reply: text, actions: [] }; }
    const rooms = ['living', 'kitchen', 'bedroom', 'bathroom', 'garage', 'study'];
    const actions = (Array.isArray(out.actions) ? out.actions : []).filter(a => rooms.includes(a.room) && ['set', 'fault', 'reset'].includes(a.type)).slice(0, 12);
    res.json({ reply: String(out.reply || ''), actions, source: 'claude' });
  } catch (e) { console.error('AI error:', e.message); res.json({ reply: null, error: e.message }); }
});

app.use(express.static(PUB));
app.listen(PORT, () => console.log(`⚡ WattGuard running at http://localhost:${PORT}  (assistant: ${KEY ? 'Claude ' + MODEL : 'offline engine'})`));
