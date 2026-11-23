/* WattGuard AI Engine — drop-in add-on.
   Add  <script src="ai-engine.js"></script>  just before </body>.
   Features: anomaly detection (EWMA + z-score), load forecasting (linear regression),
   rule-based automation (load shedding, safety timer, eco mode), risk score,
   saving recommendations, and a natural-language assistant (offline NLP,
   with an optional hook to your own backend/LLM via BACKEND_URL). */
(function () {
  const BACKEND_URL = '/api/ai'; // Node backend (Claude-powered when ANTHROPIC_API_KEY is set); falls back to the offline engine
  const SHED_LIMIT = 2200, HEATER_MAX_S = 20, IDLE_LIGHT_S = 15;

  /* ---------- UI ---------- */
  const css = `
  .ai-wrap{margin-top:20px}
  .ai-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:14px 18px}
  @media(max-width:700px){.ai-stats{grid-template-columns:repeat(2,1fr)}}
  .ai-stat{background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
  .ai-stat .v{font-size:19px;font-weight:700;color:var(--copper-bright)}
  .ai-stat .l{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-top:3px}
  .ai-bar{height:5px;background:#1a232c;border-radius:3px;margin-top:7px;overflow:hidden}
  .ai-bar i{display:block;height:100%;width:0;background:var(--safe);transition:all .4s}
  .ai-cols{display:grid;grid-template-columns:1fr 1.3fr;border-top:1px solid var(--border)}
  @media(max-width:900px){.ai-cols{grid-template-columns:1fr}}
  .ai-col{padding:14px 18px}
  .ai-col+.ai-col{border-left:1px solid var(--border)}
  .ai-col h3{margin:0 0 10px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}
  .rule{display:flex;justify-content:space-between;align-items:center;padding:7px 0;font-size:12.5px;color:var(--text-dim)}
  .tips{margin-top:12px;font-size:12px;color:var(--text-dim);line-height:1.6}
  .tips b{color:var(--safe)}
  .chat{height:190px;overflow-y:auto;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px}
  .msg{font-size:12.5px;margin-bottom:8px;line-height:1.5;white-space:pre-wrap}
  .msg.u{color:var(--copper-bright);text-align:right}
  .msg.a{color:var(--text)}
  .chat-in{display:flex;gap:8px;margin-top:10px}
  .chat-in input{flex:1;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:9px 11px;color:var(--text);font:inherit;font-size:12.5px}
  .chat-in button{background:var(--copper);border:0;border-radius:6px;color:#0b0f14;font-weight:700;padding:0 16px;cursor:pointer}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .chips span{font-size:10.5px;border:1px solid var(--border);border-radius:999px;padding:4px 9px;color:var(--text-dim);cursor:pointer}
  .chips span:hover{border-color:var(--copper);color:var(--copper-bright)}`;
  document.head.insertAdjacentHTML('beforeend', `<style>${css}</style>`);

  const rules = {
    shed:  { label: `Smart load shedding (> ${SHED_LIMIT} W)`, on: true },
    timer: { label: `Water-heater safety timeout (${HEATER_MAX_S} s)`, on: true },
    eco:   { label: `Auto-off lights in idle rooms (${IDLE_LIGHT_S} s)`, on: true },
  };

  const panel = document.createElement('div');
  panel.className = 'panel ai-wrap';
  panel.innerHTML = `
    <div class="panel-head"><h2>AI Control Center</h2><span class="hint">anomaly detection · forecasting · automation</span></div>
    <div class="ai-stats">
      <div class="ai-stat"><div class="v mono" id="ai-risk">0</div><div class="l">Risk score</div><div class="ai-bar"><i id="ai-riskbar"></i></div></div>
      <div class="ai-stat"><div class="v mono" id="ai-fc">–</div><div class="l">Forecast (+10 s)</div></div>
      <div class="ai-stat"><div class="v mono" id="ai-month">–</div><div class="l">Projected / month</div></div>
      <div class="ai-stat"><div class="v mono" id="ai-anom">0</div><div class="l">Anomalies caught</div></div>
    </div>
    <div class="ai-cols">
      <div class="ai-col">
        <h3>Automation rules</h3><div id="ai-rules"></div>
        <div class="tips" id="ai-tips"></div>
      </div>
      <div class="ai-col">
        <h3>WattGuard Assistant</h3>
        <div class="chat" id="chat"></div>
        <div class="chat-in"><input id="chat-input" placeholder='Try: "turn off all lights" or "cut wire in garage"'><button id="chat-send">Send</button></div>
        <div class="chips"><span>status</span><span>turn off all lights</span><span>turn on water heater</span><span>how can I save money?</span><span>forecast</span><span>reset all</span></div>
      </div>
    </div>`;
  document.querySelector('.app').insertBefore(panel, document.querySelector('footer'));

  const $ = id => document.getElementById(id);
  function renderRules() {
    $('ai-rules').innerHTML = Object.entries(rules).map(([k, r]) =>
      `<div class="rule"><span>${r.label}</span><div class="switch ${r.on ? 'on' : ''}" data-rule="${k}"></div></div>`).join('');
  }
  $('ai-rules').addEventListener('click', e => {
    const s = e.target.closest('.switch'); if (!s) return;
    const r = rules[s.dataset.rule]; r.on = !r.on;
    addLog(`AI rule "${r.label}" ${r.on ? 'enabled' : 'disabled'}`, 'ok'); renderRules();
  });
  renderRules();

  /* ---------- helpers ---------- */
  function setDevice(room, dev, on, why) {
    if (room.fault || dev.on === on) return false;
    dev.on = on;
    addLog(`🤖 ${why || 'AI'}: ${room.name} ${dev.name} → ${on ? 'ON' : 'OFF'}`, 'restore');
    renderRooms(); updateRoomVisual(room); return true;
  }
  const findDev = (room, sub) => room.devices.filter(d => d.name.toLowerCase().includes(sub));

  /* ---------- AI: anomaly detection + forecast ---------- */
  let mean = null, vari = 0, anomalies = 0, cooldown = 0, recent = [];
  function detect(w) {
    if (mean === null) { mean = w; return; }
    const sd = Math.max(Math.sqrt(vari), 30), z = (w - mean) / sd;
    if (cooldown > 0) cooldown--;
    if (history.length > 10 && Math.abs(z) > 3 && Math.abs(w - mean) > 300 && cooldown === 0) {
      anomalies++; cooldown = 8; recent.push(Date.now());
      addLog(`🤖 Anomaly: load ${w} W vs expected ~${Math.round(mean)} W (z=${z.toFixed(1)}) — ${z > 0 ? 'sudden surge' : 'sudden drop'}`, 'fault');
    }
    const a = 0.2, d = w - mean;
    mean += a * d; vari = (1 - a) * (vari + a * d * d);
  }
  function forecast(steps = 10) {
    const h = history.slice(-20), n = h.length;
    if (n < 5) return history[n - 1] || 0;
    const xm = (n - 1) / 2, ym = h.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    h.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
    const slope = num / den;
    return Math.max(0, Math.round(ym + slope * (n - 1 + steps - xm)));
  }
  function riskScore(w) {
    recent = recent.filter(t => Date.now() - t < 60000);
    const faults = ROOMS.filter(r => r.fault).length;
    return Math.min(100, Math.round(w / 40 + recent.length * 15 + faults * 30));
  }

  /* ---------- AI: automation rules ---------- */
  let heaterT = 0; const idle = {};
  function automate(w) {
    if (rules.shed.on && w > SHED_LIMIT) {
      for (const sub of ['charger', 'heater']) {
        for (const r of ROOMS) for (const d of findDev(r, sub))
          if (d.on && !r.fault && setDevice(r, d, false, `Load shedding (${w} W > ${SHED_LIMIT} W)`)) return;
      }
    }
    const bath = ROOMS.find(r => r.id === 'bathroom'), heater = bath.devices.find(d => d.name === 'Water Heater');
    heaterT = heater.on && !bath.fault ? heaterT + 1 : 0;
    if (rules.timer.on && heaterT >= HEATER_MAX_S) { setDevice(bath, heater, false, 'Safety timeout'); heaterT = 0; }
    ROOMS.forEach(r => {
      const light = r.devices.find(d => d.name === 'Light');
      const othersOn = r.devices.some(d => d !== light && d.on);
      idle[r.id] = light.on && !othersOn && !r.fault ? (idle[r.id] || 0) + 1 : 0;
      if (rules.eco.on && idle[r.id] >= IDLE_LIGHT_S) { setDevice(r, light, false, 'Eco mode'); idle[r.id] = 0; }
    });
  }

  function tips() {
    const on = []; ROOMS.forEach(r => !r.fault && r.devices.forEach(d => d.on && on.push({ r, d })));
    on.sort((a, b) => b.d.w - a.d.w);
    if (!on.length) return 'No active loads — nothing to optimise.';
    const t = on[0], save = (t.d.w / 1000 * 2 * 8 * 30).toFixed(0);
    return `💡 <b>Top consumer:</b> ${t.r.name} ${t.d.name} (${t.d.w} W). Using it 2 h less per day would save about <b>₹${save}/month</b>.`;
  }

  /* ---------- AI: natural-language assistant ---------- */
  const DEV = [[/\b(light|lights|lamp|lamps|bulb)\b/, 'light'], [/\b(tv|television)\b/, 'tv'], [/\b(fridge|refrigerator)\b/, 'refrigerator'],
    [/\bfan\b/, 'fan'], [/\b(heater|geyser)\b/, 'heater'], [/\b(charger|ev)\b/, 'charger'], [/\b(computer|pc)\b/, 'computer']];
  function handle(text) {
    const t = text.toLowerCase();
    const room = ROOMS.find(r => t.includes(r.id) || t.includes(r.name.toLowerCase()));
    const dev = (DEV.find(([re]) => re.test(t)) || [])[1];
    const off = /\b(off|disable|stop|kill)\b/.test(t), on = /\b(on|enable|start)\b/.test(t) && !off;

    if (/\b(reset|restore|fix|reconnect)\b/.test(t)) {
      const list = room ? [room] : ROOMS.filter(r => r.fault);
      const f = list.filter(r => r.fault); f.forEach(resetCircuit);
      return f.length ? `Restored ${f.map(r => r.name).join(', ')}.` : 'No faulted circuits to reset.';
    }
    if (/\b(cut|fault|short|break|trip)\b/.test(t) && room)
      return room.fault ? `${room.name} is already isolated.` : (triggerFault(room), `Simulated wire cut in ${room.name}. Circuit isolated.`);
    if (on || off) {
      const rs = room ? [room] : ROOMS; let n = 0;
      const targets = /\b(all|everything|every)\b/.test(t) && !dev ? null : dev;
      rs.forEach(r => r.devices.forEach(d => {
        if ((targets === null || d.name.toLowerCase().includes(targets)) && (dev || targets === null)) if (setDevice(r, d, on, 'Assistant')) n++;
      }));
      return dev || /\b(all|everything)\b/.test(t) ? (n ? `Done — ${on ? 'turned on' : 'turned off'} ${n} device(s).` : 'Nothing changed (already in that state or circuit is faulted).') : 'Which device? e.g. "turn off the TV in living room".';
    }
    if (/forecast|predict|next|future/.test(t)) return `Predicted load in 10 s: ${forecast()} W (current ${currentWatts()} W). Trend: ${forecast() > currentWatts() ? 'rising ↗' : forecast() < currentWatts() ? 'falling ↘' : 'steady →'}`;
    if (/save|saving|tip|reduce|optimi[sz]e|bill|cost/.test(t)) return `${tips().replace(/<\/?b>/g, '')}\nCurrent cost: ₹${(currentWatts() / 1000 * RATE_PER_KWH).toFixed(2)}/hr.`;
    if (/why|high|spike|anomal/.test(t)) {
      const top = ROOMS.flatMap(r => r.fault ? [] : r.devices.filter(d => d.on).map(d => ({ n: `${r.name} ${d.name}`, w: d.w }))).sort((a, b) => b.w - a.w).slice(0, 3);
      return `Load is ${currentWatts()} W. Biggest contributors: ${top.map(x => `${x.n} (${x.w} W)`).join(', ') || 'none'}. Anomalies caught so far: ${anomalies}.`;
    }
    if (/status|state|how|load|power|watt/.test(t)) {
      const f = ROOMS.filter(r => r.fault).map(r => r.name);
      return `Load: ${currentWatts()} W · Risk: ${riskScore(currentWatts())}/100\nFaults: ${f.length ? f.join(', ') : 'none'}\nActive devices: ${ROOMS.reduce((s, r) => s + (r.fault ? 0 : r.devices.filter(d => d.on).length), 0)}`;
    }
    return 'I can control devices ("turn off all lights"), simulate/reset faults ("cut wire in garage", "reset all"), and answer "status", "forecast", "why is load high?" or "how can I save money?".';
  }
  async function ask(text) {
    if (BACKEND_URL) {
      try {
        const res = await fetch(BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, state: ROOMS.map(r => ({ room: r.name, fault: r.fault, devices: r.devices })) }) });
        const j = await res.json();
        (j.actions || []).forEach(a => {
          const r = ROOMS.find(x => x.id === a.room); if (!r) return;
          if (a.type === 'set') { const d = r.devices.find(d => d.name.toLowerCase() === String(a.device).toLowerCase()); d && setDevice(r, d, !!a.on, 'Claude'); }
          else if (a.type === 'fault' && !r.fault) triggerFault(r);
          else if (a.type === 'reset' && r.fault) resetCircuit(r);
        });
        if (j.reply) return j.reply;
      } catch (e) { /* fall back to local engine */ }
    }
    return handle(text);
  }
  function say(txt, who) {
    const d = document.createElement('div'); d.className = 'msg ' + who; d.textContent = txt;
    $('chat').appendChild(d); $('chat').scrollTop = 1e6;
  }
  async function send(text) {
    text = text.trim(); if (!text) return;
    say(text, 'u'); $('chat-input').value = ''; say(await ask(text), 'a');
  }
  $('chat-send').onclick = () => send($('chat-input').value);
  $('chat-input').addEventListener('keydown', e => e.key === 'Enter' && send(e.target.value));
  panel.querySelectorAll('.chips span').forEach(c => c.onclick = () => send(c.textContent));
  say('Hi, I\'m the WattGuard assistant. I can control devices, handle faults and explain your energy use.', 'a');

  /* ---------- main AI loop ---------- */
  let tickN = 0;
  setInterval(() => {
    const w = currentWatts();
    detect(w); automate(w);
    const risk = riskScore(currentWatts()), fc = forecast();
    $('ai-risk').textContent = risk;
    const bar = $('ai-riskbar'); bar.style.width = risk + '%';
    bar.style.background = risk > 66 ? 'var(--fault)' : risk > 33 ? 'var(--copper-bright)' : 'var(--safe)';
    $('ai-fc').textContent = fc + ' W';
    const avg = history.reduce((s, v) => s + v, 0) / Math.max(history.length, 1);
    $('ai-month').textContent = '₹' + Math.round(avg / 1000 * RATE_PER_KWH * 24 * 30);
    $('ai-anom').textContent = anomalies;
    if (tickN++ % 5 === 0) $('ai-tips').innerHTML = tips();
  }, 1000);
  addLog('🤖 AI engine online — anomaly detection, forecasting & automation active', 'restore');
})();
