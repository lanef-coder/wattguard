/* WattGuard front-end ↔ backend bridge: saves readings & events, shows backend status. */
(function () {
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});

  const badge = document.createElement('div');
  badge.className = 'status-pill';
  badge.innerHTML = '<span class="status-dot" id="be-dot" style="background:#5b6b78;box-shadow:none"></span><span id="be-text">connecting…</span>';
  document.querySelector('.meter-row').insertBefore(badge, document.getElementById('status-pill'));
  const link = 'style="color:var(--copper-bright);text-decoration:none"';

  async function refresh() {
    try {
      const s = await (await fetch('/api/stats')).json();
      document.getElementById('be-dot').style.cssText = 'background:var(--safe);box-shadow:0 0 10px var(--safe)';
      document.getElementById('be-text').innerHTML =
        `Backend · ${s.readings} saved · peak ${s.peakWatts} W · ₹${s.cost} · AI: ${s.ai} · <a href="history.html" ${link}>History</a> · <a href="/api/export.csv" ${link}>CSV</a>`;
    } catch {
      document.getElementById('be-dot').style.cssText = 'background:var(--fault)';
      document.getElementById('be-text').textContent = 'Backend offline — standalone mode';
    }
  }

  // mirror every event-log entry to the server
  const orig = window.addLog;
  window.addLog = function (msg, cls) { orig(msg, cls); post('/api/events', { msg, cls }); };

  // store a reading every 5 s
  setInterval(() => {
    const risk = +(document.getElementById('ai-risk') || {}).textContent || 0;
    post('/api/readings', { watts: currentWatts(), risk,
      rooms: ROOMS.map(r => ({ id: r.id, fault: r.fault, w: r.fault ? 0 : r.devices.reduce((s, d) => s + (d.on ? d.w : 0), 0) })) });
  }, 5000);
  refresh(); setInterval(refresh, 8000);
})();
