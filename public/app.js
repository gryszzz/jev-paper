(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let state = null;
  let tf = 'LIVE';
  let lastNotified = new Set();
  let odoTarget = 0;
  let odoShown = 0;
  let odoRaf = 0;
  let peakCelebrated = 0;

  const money = (n, d = 2) => {
    const v = Number(n) || 0;
    const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    return (v < 0 ? '-$' : '$') + abs;
  };
  const pct = (n) => `${n >= 0 ? '+' : ''}${(Number(n) || 0).toFixed(2)}%`;
  const ago = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  const ageLabel = (ms) => {
    if (ms == null) return '—';
    const h = ms / 3600000;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m old`;
    if (h < 48) return `${h.toFixed(1)}h old`;
    return `${Math.round(h / 24)}d old`;
  };
  const compact = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return money(v, 0);
  };
  const iconFallback = (sym) =>
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="#222" width="64" height="64" rx="32"/><text x="32" y="38" text-anchor="middle" fill="#9f9" font-size="18" font-family="sans-serif">${(sym || '?').slice(0, 3)}</text></svg>`
    )}`;

  let odoPrimed = false;
  function setOdometer(value) {
    odoTarget = Number(value) || 0;
    if (!odoPrimed) {
      odoPrimed = true;
      odoShown = odoTarget;
      $('balance').textContent = money(odoShown);
      return;
    }
    if (!odoRaf) tickOdo();
  }
  function tickOdo() {
    const diff = odoTarget - odoShown;
    if (Math.abs(diff) < 0.005) {
      odoShown = odoTarget;
      $('balance').textContent = money(odoShown);
      odoRaf = 0;
      return;
    }
    odoShown += diff * 0.18;
    $('balance').textContent = money(odoShown);
    odoRaf = requestAnimationFrame(tickOdo);
  }

  function drawEquity(canvas, history, marks = []) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!history || history.length < 2) {
      ctx.fillStyle = '#333';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('Waiting for equity samples…', 12, h / 2);
      return;
    }

    const now = Date.now();
    const windows = { LIVE: 15 * 60e3, '1H': 3600e3, '4H': 4 * 3600e3, '1D': 86400e3, '1W': 7 * 86400e3, ALL: Infinity };
    const win = windows[tf] || windows.LIVE;
    let pts = history.filter((p) => now - p.t <= win);
    if (pts.length < 2) pts = history.slice(-30);
    const xs = pts.map((p) => p.t);
    const ys = pts.map((p) => p.equity);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys) * 0.995;
    const maxY = Math.max(...ys) * 1.005;
    const pad = 8;
    const X = (t) => pad + ((t - minX) / Math.max(1, maxX - minX)) * (w - pad * 2);
    const Y = (v) => h - pad - ((v - minY) / Math.max(1e-9, maxY - minY)) * (h - pad * 2);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(57,255,140,0.28)');
    grad.addColorStop(1, 'rgba(57,255,140,0)');
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t);
      const y = Y(p.equity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(X(pts[pts.length - 1].t), h);
    ctx.lineTo(X(pts[0].t), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t);
      const y = Y(p.equity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#39ff8c';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // trade dots from activity
    for (const m of marks) {
      if (m.t < minX || m.t > maxX) continue;
      // map to nearest equity y
      let nearest = pts[0];
      for (const p of pts) if (Math.abs(p.t - m.t) < Math.abs(nearest.t - m.t)) nearest = p;
      const x = X(m.t);
      const y = Y(nearest.equity);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'buy' ? '#39ff8c' : '#ff453a';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawCoinChart(canvas, pos) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const hist = pos.priceHistory && pos.priceHistory.length ? pos.priceHistory : [{ t: pos.openedAt, price: pos.entryPrice }, { t: Date.now(), price: pos.markPrice || pos.entryPrice }];
    const xs = hist.map((p) => p.t);
    const ys = hist.map((p) => p.price);
    const levels = [pos.entryPrice, pos.trailStop, pos.stopPrice, pos.markPrice].filter((x) => x > 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys, ...levels) * 0.98;
    const maxY = Math.max(...ys, ...levels) * 1.02;
    const pad = 10;
    const X = (t) => pad + ((t - minX) / Math.max(1, maxX - minX)) * (w - pad * 2);
    const Y = (v) => h - pad - ((v - minY) / Math.max(1e-12, maxY - minY)) * (h - pad * 2);

    // executor buy
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#5b8cff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pad, Y(pos.entryPrice));
    ctx.lineTo(w - pad, Y(pos.entryPrice));
    ctx.stroke();

    // trail
    ctx.strokeStyle = '#ff9f0a';
    ctx.beginPath();
    ctx.moveTo(pad, Y(pos.trailStop));
    ctx.lineTo(w - pad, Y(pos.trailStop));
    ctx.stroke();
    ctx.setLineDash([]);

    // price path dotted
    ctx.beginPath();
    hist.forEach((p, i) => {
      const x = X(p.t), y = Y(p.price);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#39ff8c';
    ctx.lineWidth = 2;
    ctx.stroke();

    // pills
    const pill = (label, y, color) => {
      ctx.fillStyle = color;
      const tw = ctx.measureText(label).width + 14;
      const x = w - pad - tw;
      roundRect(ctx, x, y - 10, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.fillText(label, x + 7, y + 3);
    };
    ctx.font = '600 10px Inter, sans-serif';
    pill('Executor buy', Y(pos.entryPrice), '#5b8cff');
    pill('trail stop', Y(pos.trailStop), '#ff9f0a');
    const px = (pos.markPrice || 0).toPrecision(4).replace(/e.*/, '');
    pill(px, Y(pos.markPrice || pos.entryPrice), '#39ff8c');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function agentCards(s) {
    const a = s.agents || {};
    const scanItems = (a.scanner && a.scanner.recent) || [];
    const scanHtml = scanItems
      .map(
        (r) => `<li><img src="${r.icon || iconFallback(r.symbol)}" onerror="this.src='${iconFallback(r.symbol)}'"/><span>${r.symbol}</span><span class="${r.ok ? 'tag-good' : 'tag-bad'}">${r.tag}</span></li>`
      )
      .join('');

    const score = a.analyst && a.analyst.score != null ? a.analyst.score : 0;
    const donutClass = score >= 70 ? '' : score >= 50 ? 'warn' : 'bad';

    const fill = a.executor && a.executor.lastFill;
    const prog = (a.executor && a.executor.progress) || 0;
    const exStatus = a.executor && a.executor.status;
    const filledLabel =
      exStatus === 'filled' || prog >= 100
        ? `<span class="ok">Filled · 0.25s</span>`
        : exStatus === 'buying'
          ? `<span>Buying… ${prog}%</span>`
          : `<span>${(a.executor && a.executor.trades) || 0} trades</span>`;

    const risk = a.risk || {};

    return [
      `<article class="agent-card" data-agent="scanner">
        <h3>🔎 Scanner <span class="badge ${(a.scanner && a.scanner.status) === 'scanning' ? 'on' : ''}">${(a.scanner && a.scanner.pools) || 0} pools</span></h3>
        <ul class="mini-list">${scanHtml || '<li><span class="badge">scanning Solana / pump.fun…</span></li>'}</ul>
      </article>`,
      `<article class="agent-card" data-agent="analyst">
        <h3>🧠 Analyst <span class="badge">${a.analyst && a.analyst.status === 'passed' ? 'passed' : a.analyst && a.analyst.status === 'scoring' ? 'scoring…' : 'idle'}</span></h3>
        <div class="donut-wrap">
          <div class="donut ${donutClass}" style="--p:${score}"><span>${score || '—'}</span></div>
          <div>
            <div style="font-weight:700">${(a.analyst && a.analyst.symbol) || '—'}</div>
            <div class="badge">${(a.analyst && a.analyst.passed) || 0} passed · ${(a.analyst && a.analyst.scored) || 0} scored</div>
          </div>
        </div>
      </article>`,
      `<article class="agent-card" data-agent="executor">
        <h3>☁️ Executor <span class="badge on">${(a.executor && a.executor.trades) || 0} trades</span></h3>
        <div style="font-size:13px;font-weight:600">${fill ? `${fill.symbol} · ${money(fill.amountUsd)}` : 'Waiting for score ≥ 70'}</div>
        <div class="badge">${fill ? `${fill.pct}% of stack · paper` : 'max 3 open'}</div>
        <div class="progress"><i style="width:${prog}%"></i></div>
        <div class="fill-meta">${filledLabel}<span></span></div>
      </article>`,
      `<article class="agent-card" data-agent="risk">
        <h3>🎃 Risk <span class="badge ${risk.status === 'guarding' ? 'on' : ''}">${risk.guarding ? `Guarding ${risk.guarding}` : 'idle'}</span></h3>
        <div style="font-size:13px">${risk.lastAction ? `${risk.lastAction.reason === 'stop' ? 'Stopped' : 'Took profit'} ${risk.lastAction.symbol} ${risk.lastAction.pnl >= 0 ? '+' : ''}${money(Math.abs(risk.lastAction.pnl)).replace('$-','-')}` : 'Hard stop + trailing stop'}</div>
        <div class="pills"><span class="pill red">stop -6%</span><span class="pill green">trail 10%</span></div>
      </article>`,
    ].join('');
  }

  function renderActivity(list, el, limit = 20) {
    const items = (list || []).slice(0, limit);
    if (!items.length) {
      el.innerHTML = `<div class="act"><div></div><div><div class="t1">No fills yet</div><div class="t2">Scanner is hunting Solana pools ≥ $38k liq</div></div><div></div></div>`;
      return;
    }
    el.innerHTML = items
      .map((it) => {
        const title =
          it.type === 'buy'
            ? `Bought ${it.symbol}`
            : it.type === 'stopped'
              ? `Stopped ${it.symbol}`
              : `Sold ${it.symbol}`;
        const right =
          it.pnl == null
            ? `<div class="right">${money(it.amountUsd)}<span class="sub">${it.detail || ''}</span></div>`
            : `<div class="right ${it.pnl >= 0 ? 'pos' : 'neg'}">${it.pnl >= 0 ? '+' : ''}${money(Math.abs(it.pnl))}<span class="sub">${pct(it.pnlPct)}</span></div>`;
        return `<div class="act" data-mint="${it.mint || ''}" data-symbol="${it.symbol}">
          <img src="${it.icon || iconFallback(it.symbol)}" onerror="this.src='${iconFallback(it.symbol)}'"/>
          <div><div class="t1">${title}</div><div class="t2">${it.agent || ''} · ${ago(it.ts)}</div></div>
          ${right}
        </div>`;
      })
      .join('');
  }

  function confetti() {
    const layer = $('confetti');
    layer.hidden = false;
    layer.innerHTML = '';
    const colors = ['#39ff8c', '#7c3aed', '#5b8cff', '#ff9f0a', '#ff453a', '#fff'];
    for (let i = 0; i < 48; i++) {
      const p = document.createElement('i');
      p.className = 'confetti-piece';
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.appendChild(p);
    }
    setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
    }, 3200);
  }

  async function maybeNotify(items) {
    if (!items || !items.length) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    if (Notification.permission !== 'granted') return;
    for (const n of items) {
      if (lastNotified.has(n.id)) continue;
      lastNotified.add(n.id);
      try {
        new Notification(n.title, { body: n.body, icon: n.icon || '/icons/icon-192.png' });
      } catch (_) {}
    }
  }

  function openSheet(pos) {
    if (!pos) return;
    const sheet = $('coinSheet');
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    $('coinIcon').src = pos.icon || iconFallback(pos.symbol);
    $('coinTitle').textContent = pos.symbol;
    $('coinSub').textContent = `${pos.symbol} · Solana · ${ageLabel(pos.ageMs)} · Analyst ${pos.score || '—'}`;
    const px = pos.markPrice || pos.entryPrice;
    $('coinPrice').textContent = px >= 0.01 ? money(px, 4) : `$${Number(px).toPrecision(4)}`;
    const since = pos.pnlPct || 0;
    const sinceEl = $('coinSince');
    sinceEl.textContent = `${since >= 0 ? '▲' : '▼'} ${Math.abs(since).toFixed(1)}% since entry`;
    sinceEl.className = `coin-since ${since >= 0 ? '' : 'neg'}`;
    $('coinStats').innerHTML = `
      <div class="stat"><div class="k">Market cap</div><div class="v">${compact(pos.marketCap)}</div></div>
      <div class="stat"><div class="k">Liquidity</div><div class="v">${compact(pos.liquidity)}</div></div>
      <div class="stat"><div class="k">Holders</div><div class="v">—</div></div>
      <div class="stat"><div class="k">24h volume</div><div class="v">${compact(pos.volumeH24)}</div></div>`;
    $('posCard').innerHTML = `
      <div class="row"><div><div class="lbl">Your position</div><div style="font-weight:700;margin-top:4px">${money(pos.amountUsd)} in · Executor</div></div>
      <div style="text-align:right"><div style="font-weight:800;font-size:18px">${money(pos.markValue)}</div>
      <div class="${pos.pnl >= 0 ? 'pos' : 'neg'}" style="font-weight:700">${pos.pnl >= 0 ? '+' : ''}${money(Math.abs(pos.pnl))}</div></div></div>`;
    $('riskCard').innerHTML = `
      <div class="row"><div><div class="lbl">Risk</div><div style="font-weight:700;margin-top:4px">Guarding ${pos.symbol}</div></div>
      <div class="pills"><span class="pill red">stop -6%</span><span class="pill orange">trail 10%</span></div></div>
      <div class="badge" style="margin-top:8px;display:block">stop @ ${Number(pos.stopPrice).toPrecision(4)} · trail @ ${Number(pos.trailStop).toPrecision(4)}</div>`;
    requestAnimationFrame(() => drawCoinChart($('coinChart'), pos));
  }

  function render(s) {
    state = s;
    const running = !!(s.settings && s.settings.running);
    $('bannerText').textContent = (s.banner && s.banner.text) || 'JEV · paper mode';
    if (s.banner && s.banner.icon) {
      $('bannerIcon').src = s.banner.icon;
      $('bannerIcon').classList.remove('hide');
    } else {
      $('bannerIcon').classList.add('hide');
    }
    setOdometer(s.equity);
    const gainEl = $('gainLine');
    const g = s.gain || 0;
    gainEl.textContent = `${g >= 0 ? '▲ +' : '▼ '}${money(Math.abs(g))} (${pct(s.gainPct).replace('+', g >= 0 ? '+' : '')})`.replace('(+-', '(-');
    gainEl.className = `gain-line ${g >= 0 ? '' : 'neg'}`;
    $('multPill').textContent = `${(s.multiplier || 1).toFixed(2)}x`;

    const toggle = $('runToggle');
    toggle.setAttribute('aria-pressed', running ? 'true' : 'false');
    toggle.querySelector('.run-label').textContent = running ? 'Live' : 'Paused';
    $('agentsRunning').textContent = running ? '4 running' : 'paused';

    const marks = (s.activity || [])
      .filter((a) => a.type === 'buy' || a.type === 'sell' || a.type === 'stopped')
      .map((a) => ({ t: a.ts, kind: a.type === 'buy' ? 'buy' : 'sell' }));
    drawEquity($('equityChart'), s.equityHistory, marks);
    const open = (s.positions || []).length;
    $('chartMeta').textContent = open
      ? `${open} open · trail 10% · stop -6% · slip ${((s.settings && s.settings.slippage) || 0.02) * 100}%`
      : `Paper equity · slip ${((s.settings && s.settings.slippage) || 0.02) * 100}% haircut on fills`;

    const cards = agentCards(s);
    $('agentsCarousel').innerHTML = cards;
    $('agentsFull').innerHTML = cards;
    renderActivity(s.activity, $('activityHome'), 8);
    renderActivity(s.activity, $('activityFull'), 50);

    $('acctCash').textContent = money(s.cash);
    $('acctEquity').textContent = money(s.equity);
    $('acctPeak').textContent = money(s.peakBalance);
    $('acctPos').textContent = String((s.positions || []).length);
    $('disclaimer').textContent = s.disclaimer || '';

    if (s.settings) {
      $('slippage').value = s.settings.slippage;
      $('minLiq').value = s.settings.minLiquidity;
      $('minScore').value = s.settings.minScore;
      $('startBal').value = s.startingBalance;
    }

    if (s.newPeak && s.equity > (peakCelebrated || s.startingBalance)) {
      peakCelebrated = s.equity;
      confetti();
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const s = await res.json();
      render(s);
    } catch (e) {
      console.warn(e);
    }
    try {
      const n = await fetch('/api/notifications', { cache: 'no-store' }).then((r) => r.json());
      await maybeNotify(n.items || []);
    } catch (_) {}
  }

  // nav
  $('bottomNav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(`view-${tab}`).classList.add('active');
  });
  $('seeAllActivity').addEventListener('click', () => {
    document.querySelector('.nav-btn[data-tab="activity"]').click();
  });

  $('tfRow').addEventListener('click', (e) => {
    const b = e.target.closest('.tf');
    if (!b) return;
    tf = b.dataset.tf;
    document.querySelectorAll('.tf').forEach((x) => x.classList.toggle('active', x === b));
    if (state) drawEquity($('equityChart'), state.equityHistory, (state.activity || []).map((a) => ({ t: a.ts, kind: a.type === 'buy' ? 'buy' : 'sell' })));
  });

  $('runToggle').addEventListener('click', async () => {
    const running = $('runToggle').getAttribute('aria-pressed') !== 'true';
    const s = await fetch('/api/running', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ running }),
    }).then((r) => r.json());
    render(s);
  });

  $('saveSettings').addEventListener('click', async () => {
    const body = {
      startingBalance: Number($('startBal').value),
      slippage: Number($('slippage').value),
      minLiquidity: Number($('minLiq').value),
      minScore: Number($('minScore').value),
    };
    const s = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    render(s);
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset paper wallet? Open positions and history will clear.')) return;
    const s = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startingBalance: Number($('startBal').value) || 100 }),
    }).then((r) => r.json());
    peakCelebrated = 0;
    render(s);
  });

  $('sheetClose').addEventListener('click', () => {
    $('coinSheet').classList.remove('open');
    $('coinSheet').setAttribute('aria-hidden', 'true');
  });
  $('coinSheet').addEventListener('click', (e) => {
    if (e.target.id === 'coinSheet') $('sheetClose').click();
  });

  document.addEventListener('click', (e) => {
    const act = e.target.closest('.act');
    if (!act || !state) return;
    const mint = act.dataset.mint;
    const pos = (state.positions || []).find((p) => p.mint === mint || p.symbol === act.dataset.symbol);
    if (pos) openSheet(pos);
  });

  window.addEventListener('resize', () => {
    if (state) {
      drawEquity($('equityChart'), state.equityHistory);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  refresh();
  setInterval(refresh, 2500);
})();
