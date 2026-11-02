(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let state = null;
  let deskTradeLimit = 30;
  let jevFloor = null;
  let tf = '1D';
  let odoTarget = 0;
  let odoShown = 0;
  let odoRaf = 0;
  let odoPrimed = false;
  let peakCelebrated = 0;
  let authToken = localStorage.getItem('jev_session') || '';
  let unlocked = false;

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
  const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');
  const iconFallback = (sym) =>
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="#222" width="64" height="64" rx="32"/><text x="32" y="38" text-anchor="middle" fill="#9f9" font-size="18" font-family="sans-serif">${(sym || '?').slice(0, 3)}</text></svg>`
    )}`;

  function headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (authToken) h['x-jev-session'] = authToken;
    return h;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      ...opts,
      headers: headers(opts.headers || {}),
    });
    if (res.status === 401) {
      showLock(true);
      throw new Error('auth');
    }
    return res.json();
  }

  function showLock(on) {
    $('lockScreen').classList.toggle('hide', !on);
    $('app').style.visibility = on ? 'hidden' : 'visible';
    unlocked = !on;
  }

  async function checkAuth() {
    try {
      const s = await fetch('/api/auth/status', { credentials: 'include', headers: headers() }).then((r) => r.json());
      // Server only sets required=true when LIVE_ENABLED; PAPER never locks.
      if (!s.required || s.ok) {
        showLock(false);
        return true;
      }
      showLock(true);
      return false;
    } catch (_) {
      showLock(false);
      return true;
    }
  }

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

  function drawEquity(canvas, history) {
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
    grad.addColorStop(0, 'rgba(0,255,102,0.28)');
    grad.addColorStop(1, 'rgba(0,255,102,0)');
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t);
      const y = Y(p.equity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00FF66';
    ctx.lineWidth = 2.4;
    ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.lineTo(X(last.t), h - pad);
    ctx.lineTo(X(pts[0].t), h - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  const AGENT_META = {
    scanner: { name: 'Scanner', short: 'SCAN', color: '#5b8cff', role: 'Radar on new Pump + DEX launches.' },
    analyst: { name: 'Analyst', short: 'ANAL', color: '#a78bfa', role: 'Scores liquidity, age, smart money.' },
    executor: { name: 'Executor', short: 'EXEC', color: '#00FF66', role: 'Paper fills with Jito/slip sim.' },
    risk: { name: 'Risk', short: 'RISK', color: '#ff9f0a', role: 'Stops, trail, streak cooldown, sweep.' },
    whale: { name: 'Whale Watch', short: 'WHALE', color: '#22d3ee', role: 'Tracks top holders + smart buys.' },
  };
  const AGENT_ORDER = ['scanner', 'analyst', 'executor', 'risk', 'whale'];

  /** Crisp original pixel/voxel-style bots (not xAI/Grok). */
  function pixelBot(key, color) {
    const c = color;
    const body = `
      <rect x="10" y="14" width="12" height="10" fill="#12121a" stroke="${c}" stroke-width="1"/>
      <rect x="11" y="8" width="10" height="8" fill="#16161f" stroke="${c}" stroke-width="1"/>
      <rect class="blink-eye" x="13" y="11" width="2" height="2" fill="${c}"/>
      <rect class="blink-eye" x="17" y="11" width="2" height="2" fill="${c}" style="animation-delay:.15s"/>
      <rect x="12" y="24" width="3" height="4" fill="${c}" opacity=".85"/>
      <rect x="17" y="24" width="3" height="4" fill="${c}" opacity=".85"/>
      <rect x="7" y="16" width="3" height="2" fill="${c}" opacity=".7"/>
      <rect x="22" y="16" width="3" height="2" fill="${c}" opacity=".7"/>`;
    if (key === 'scanner') {
      return `<svg class="pixel-bot" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">${body}
        <rect x="14" y="3" width="4" height="3" fill="${c}"/>
        <rect x="15" y="1" width="2" height="2" fill="${c}"/>
        <path d="M16 4 Q24 2 26 8" fill="none" stroke="${c}" stroke-width="1.5"/>
        <rect x="24" y="7" width="3" height="3" fill="${c}" opacity=".9"/>
      </svg>`;
    }
    if (key === 'analyst') {
      return `<svg class="pixel-bot" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">${body}
        <rect x="12" y="10" width="8" height="1" fill="${c}"/>
        <rect x="12" y="10" width="1" height="3" fill="${c}"/>
        <rect x="19" y="10" width="1" height="3" fill="${c}"/>
        <rect x="23" y="18" width="2" height="6" fill="${c}" opacity=".85"/>
        <rect x="25" y="20" width="2" height="4" fill="${c}" opacity=".7"/>
        <rect x="27" y="16" width="2" height="8" fill="${c}"/>
      </svg>`;
    }
    if (key === 'executor') {
      return `<svg class="pixel-bot" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">${body}
        <path d="M22 6 L18 14 H21 L17 22 L25 12 H21 Z" fill="${c}"/>
        <rect x="21" y="5" width="2" height="2" fill="#fff" opacity=".5"/>
      </svg>`;
    }
    if (key === 'risk') {
      return `<svg class="pixel-bot" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">${body}
        <path d="M6 8 L10 6 L14 8 L14 14 L10 17 L6 14 Z" fill="rgba(255,159,10,0.25)" stroke="${c}" stroke-width="1"/>
        <rect x="9" y="10" width="2" height="3" fill="${c}"/>
      </svg>`;
    }
    if (key === 'whale') {
      return `<svg class="pixel-bot" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">${body}
        <rect x="11" y="2" width="10" height="5" rx="1" fill="#0e1a1f" stroke="${c}" stroke-width="1"/>
        <rect x="20" y="3" width="2" height="6" fill="${c}"/>
        <rect x="19" y="8" width="4" height="2" fill="${c}" opacity=".8"/>
        <rect x="8" y="4" width="3" height="2" fill="${c}" opacity=".7"/>
      </svg>`;
    }
    return `<svg class="pixel-bot" viewBox="0 0 32 32" shape-rendering="crispEdges">${body}</svg>`;
  }

  function agentSpeech(key, a) {
    if (!a) return '';
    if (key === 'scanner') {
      const last = (a.recent || []).find((x) => x.ok) || (a.recent || [])[0];
      if (last) return `SCAN $${last.symbol}`;
      return a.wsConnected || a.status === 'streaming' ? `SCAN ${a.pools || 0}` : '';
    }
    if (key === 'analyst') {
      if (a.symbol != null && a.score != null) return `SCORE ${a.score} $${a.symbol}`;
      return a.status === 'scoring' ? 'SCORING…' : '';
    }
    if (key === 'executor') {
      const f = a.lastFill;
      if (f) {
        const sol = (Number(f.amountUsd) / 150);
        return `BUY $${f.symbol} ${sol >= 0.1 ? sol.toFixed(1) : Number(f.amountUsd).toFixed(0)}`;
      }
      if (a.status === 'buying') return 'FIRING…';
      return '';
    }
    if (key === 'risk') {
      const la = a.lastAction;
      if (la) {
        if (la.pnl != null && la.pnl >= 0) return `WIN $${la.symbol} +${Math.abs(la.pnl).toFixed(1)}`;
        if (la.pnl != null) return `CUT $${la.symbol}`;
        return String(la.reason || 'GUARD').toUpperCase();
      }
      if (a.guarding) return `GUARD $${a.guarding}`;
      if (a.status === 'cooldown') return 'COOLDOWN';
      return '';
    }
    if (key === 'whale') {
      if (a.lastAlert) return `ALERT $${a.lastAlert.symbol || ''}`.trim();
      if (a.entrySignals) return `SMART ${a.entrySignals}`;
      if (a.watching) return `WATCH ${a.watching}`;
      return '';
    }
    return '';
  }

  function agentStateLabel(key, a) {
    const st = (a && a.status) || 'idle';
    if (key === 'scanner') {
      if (st === 'streaming' || st === 'scanning') return 'scan';
      return 'idle';
    }
    if (key === 'analyst') {
      if (st === 'passed') return 'pass';
      if (st === 'scoring') return 'score';
      return 'idle';
    }
    if (key === 'executor') {
      if (st === 'buying' || st === 'filled') return 'fire';
      return 'idle';
    }
    if (key === 'risk') {
      if (st === 'cooldown') return 'block';
      const la = a && a.lastAction;
      if (la && la.pnl != null && la.pnl > 0) return 'win';
      if (la && la.pnl != null && la.pnl < 0) return 'cut';
      if (st === 'guarding') return 'guard';
      return 'idle';
    }
    if (key === 'whale') {
      if (a && a.lastAlert) return 'alert';
      if (st === 'watching') return 'watch';
      return 'idle';
    }
    return st;
  }

  function shortAgo(ts) {
    if (!ts) return '—';
    // tolerate seconds or ms
    let t = Number(ts);
    if (t < 1e12) t *= 1000;
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (!Number.isFinite(s) || s > 86400 * 30) return '—';
    if (s < 5) return 'now';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  function pickActiveAgent(agents) {
    const rank = { fire: 5, buying: 5, filled: 5, alert: 4, scan: 3, streaming: 3, scoring: 3, pass: 2, guard: 2, watch: 2, win: 2, block: 1, cut: 1, idle: 0 };
    let best = null, bestScore = -1;
    for (const key of AGENT_ORDER) {
      const a = agents[key] || {};
      const label = agentStateLabel(key, a);
      const speech = agentSpeech(key, a);
      const score = (rank[label] || rank[a.status] || 0) + (speech ? 0.5 : 0) + (a.flash ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = key; }
    }
    return bestScore > 0 ? best : 'scanner';
  }

  function sparkPath(history, color, id) {
    const el = $(id);
    if (!el) return;
    if (!history || history.length < 2) {
      el.innerHTML = `<path d="M0 14 L120 14" stroke="${color}" opacity=".35"/>`;
      return;
    }
    const now = Date.now();
    const windows = { '1H': 3600e3, '1D': 86400e3, ALL: Infinity };
    const win = windows[tf] || windows['1D'];
    let pts = history.filter((p) => now - p.t <= win);
    if (pts.length < 2) pts = history.slice(-40);
    const ys = pts.map((p) => p.equity);
    const min = Math.min(...ys), max = Math.max(...ys);
    const span = max - min || 1;
    const w = 120, h = 28, pad = 2;
    const d = pts.map((p, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (p.equity - min) / span) * (h - pad * 2);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    el.innerHTML = `<path d="${d}" stroke="${up ? color : '#ff453a'}"/>`;
  }

  function ensureFloor() {
    if (jevFloor) return jevFloor;
    const c = $('floorCanvas');
    if (!c || !window.JevFloor) return null;
    jevFloor = window.JevFloor.createFloor(c);
    if (jevFloor) jevFloor.start();
    return jevFloor;
  }

  function renderDesk() {
    if (!state) return;
    const agents = state.agents || {};
    const floor = ensureFloor();
    if (floor) floor.onState(state);

    $('deskStatus').innerHTML = AGENT_ORDER.map((key) => {
      const a = agents[key] || {};
      const meta = AGENT_META[key];
      return `<div class="st-cell">
        <div class="st-name" style="color:${meta.color}">${meta.short}</div>
        <div class="st-state">${agentStateLabel(key, a)}</div>
        <div class="st-ago">${shortAgo(a.lastRun)}</div>
      </div>`;
    }).join('');

    const allTrades = (state.activity || []).filter((it) => {
      const t = (it.type || '').toLowerCase();
      return t === 'buy' || t === 'sell' || t === 'tp' || t === 'stopped' || t === 'stop' || it.pnl != null || it.amountUsd != null;
    });
    const trades = allTrades.slice(0, deskTradeLimit);
    const stack = $('tradeStack');
    const countEl = $('tradesCount');
    if (countEl) countEl.textContent = String(allTrades.length);
    if (!trades.length) {
      stack.innerHTML = '<div class="trade-empty">No paper trades yet — desk is scanning</div>';
    } else {
      stack.innerHTML = trades.map((it) => {
        const t = (it.type || '').toLowerCase();
        let side = 'other';
        let sideLabel = (it.type || 'TRADE').toUpperCase();
        if (t === 'buy') { side = 'buy'; sideLabel = 'BUY'; }
        else if (t === 'sell' || t === 'tp') { side = 'sell'; sideLabel = t === 'tp' ? 'TP' : 'SELL'; }
        else if (t === 'stopped' || t === 'stop') { side = 'sell'; sideLabel = 'STOP'; }
        const right = it.pnl != null
          ? `<div class="tr-right ${it.pnl >= 0 ? 'pos' : 'neg'}">${money(it.pnl)}<span class="sub">${pct(it.pnlPct)}</span></div>`
          : `<div class="tr-right">${money(it.amountUsd)}<span class="sub">${ago(it.ts)}</span></div>`;
        const img = it.icon || iconFallback(it.symbol);
        const agent = (it.agent || 'EXEC').replace(/^Risk.*/, 'Risk').replace(/^Whale.*/, 'Whale');
        const size = it.amountUsd != null ? money(it.amountUsd, 0) : '';
        const lane = (it.lane || '').toUpperCase();
        const laneBadge = lane
          ? `<span class="tr-lane lane-${lane.toLowerCase()}">${lane}</span>`
          : '';
        const subBits = [agent, size, ago(it.ts)].filter(Boolean).join(' · ');
        return `<div class="trade-row" data-mint="${it.mint || ''}">
          <img src="${img}" alt="" onerror="this.src='${iconFallback(it.symbol)}'"/>
          <div class="tr-mid">
            <div class="tr-title"><span class="tr-side ${side}">${sideLabel}</span> $${it.symbol || '—'} ${laneBadge}</div>
            <div class="tr-sub"><span class="tr-agent">${agent}</span><span>${subBits.replace(agent + ' · ', '')}</span></div>
          </div>
          ${right}
        </div>`;
      }).join('');
      if (allTrades.length > trades.length) {
        stack.innerHTML += `<button type="button" class="trade-more" id="tradeMoreBtn">Show older (${allTrades.length - trades.length} more)</button>`;
      }
      stack.querySelectorAll('.trade-row').forEach((el) => {
        el.onclick = () => openCoin(el.dataset.mint);
      });
      const more = $('tradeMoreBtn');
      if (more) {
        more.onclick = (e) => {
          e.stopPropagation();
          deskTradeLimit += 30;
          renderDesk();
        };
      }
    }
  }

  function agentLiveLine(key, a, s) {
    if (!a) return '—';
    if (key === 'scanner') {
      const n = a.launches || a.pools || 0;
      const last = (a.recent || []).find((x) => x.ok) || (a.recent || [])[0];
      if (last) return `Found <strong>$${last.symbol}</strong> · ${n} scanned`;
      return a.wsConnected ? `Scanning <strong>${n}</strong> new coins` : `DEX scan · <strong>${a.pools || 0}</strong> pools`;
    }
    if (key === 'analyst') {
      if (a.symbol != null && a.score != null) return `Score <strong>${a.score}</strong> · $${a.symbol}`;
      return `Scored <strong>${a.scored || 0}</strong> · ${a.passed || 0} passed`;
    }
    if (key === 'executor') {
      const f = a.lastFill;
      if (f) {
        const sol = (Number(f.amountUsd) / 150).toFixed(2); // rough display; USD primary
        return `Bought <strong>$${f.symbol}</strong> $${Number(f.amountUsd).toFixed(0)}`;
      }
      return a.status === 'idle' ? 'Waiting for fill' : String(a.status || 'idle');
    }
    if (key === 'risk') {
      const la = a.lastAction;
      if (la) {
        const verb = la.pnl >= 0 ? 'Approved' : 'Blocked';
        const pnl = la.pnl != null ? ` ${la.pnl >= 0 ? '+' : ''}$${Math.abs(la.pnl).toFixed(2)}` : '';
        return `${verb} <strong>$${la.symbol}</strong>${pnl}`;
      }
      return a.guarding ? `Guarding <strong>$${a.guarding}</strong>` : 'TP · trail · sweep';
    }
    if (key === 'whale') {
      const alert = a.lastAlert;
      if (alert) return `Alert <strong>$${alert.symbol || ''}</strong> ${(alert.detail || '').slice(0, 28)}`;
      if (a.entrySignals) return `Smart-money <strong>${a.entrySignals}</strong> entries`;
      return `Watching <strong>${a.watching || 0}</strong> · eye on whales`;
    }
    return '';
  }

  function agentLivePlain(key, a) {
    const html = agentLiveLine(key, a, state);
    return html.replace(/<[^>]+>/g, '');
  }

  function renderActivity(targetId, limit) {
    const el = $(targetId);
    if (!el || !state) return;
    const items = (state.activity || []).slice(0, limit);
    if (!items.length) {
      el.innerHTML = '<div class="activity-empty">No activity yet</div>';
      return;
    }
    el.innerHTML = items
      .map((it) => {
        const pnlCls = it.pnl == null ? '' : it.pnl >= 0 ? 'pos' : 'neg';
        const right =
          it.pnl != null
            ? `<div class="right ${pnlCls}">${money(it.pnl)}<span class="sub">${pct(it.pnlPct)}</span></div>`
            : it.amountUsd != null
              ? `<div class="right">${money(it.amountUsd)}</div>`
              : `<div class="right"></div>`;
        const img = it.icon
          ? `<img src="${it.icon}" alt="" onerror="this.src='${iconFallback(it.symbol)}'"/>`
          : `<img src="${iconFallback(it.symbol)}" alt=""/>`;
        const lane = it.lane ? ` <span class="tr-lane lane-${String(it.lane).toLowerCase()}">${it.lane}</span>` : '';
        return `<div class="act" role="button" data-mint="${it.mint || ''}">
          ${img}
          <div><div class="t1">${it.type} · ${it.symbol || ''}${lane}</div>
          <div class="t2">${it.agent || ''} · ${it.detail || ''} · ${ago(it.ts)}</div></div>
          ${right}
        </div>`;
      })
      .join('');
  }

  function renderStats() {
    if (!state) return;
    const st = state.stats || {};
    const winRate = st.wins + st.losses > 0 ? Math.round((st.wins / (st.wins + st.losses)) * 100) : 0;
    $('statsCards').innerHTML = [
      ['Realized PnL', money(st.realizedPnl || 0)],
      ['Win rate', `${winRate}%`],
      ['Trades', String(st.trades || 0)],
      ['Whale exits', String(st.whaleExits || 0)],
      ['Best', money(st.bestTrade || 0)],
      ['Worst', money(st.worstTrade || 0)],
      ['Avg whale react', `${st.avgWhaleLatencyMs || 0} ms`],
      ['Day PnL', money(state.dayPnl || 0)],
    ]
      .map(([lbl, val]) => `<div class="stat-card"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`)
      .join('');

    const byLane = st.byLane || {};
    const laneKeys = ['FRESH', 'GRAD', 'MOVER'].filter((k) => byLane[k]);
    const laneEl = $('laneStats');
    if (laneEl) {
      laneEl.innerHTML = laneKeys.length
        ? laneKeys
            .map((k) => {
              const r = byLane[k] || {};
              return `<div class="strategy-row"><span class="tr-lane lane-${k.toLowerCase()}">${k}</span><strong>${r.buys || r.trades || 0} buys · ${money(r.pnl || 0)} · ${r.wins || 0}W/${r.losses || 0}L</strong></div>`;
            })
            .join('')
        : '<div class="strategy-row"><span>No lane fills yet</span></div>';
    }

    const by = st.byStrategy || {};
    const keys = Object.keys(by);
    $('strategyStats').innerHTML = keys.length
      ? keys
          .map((k) => {
            const r = by[k];
            return `<div class="strategy-row"><span>${k}</span><strong>${r.trades} trades · ${money(r.pnl)} · ${r.wins}W</strong></div>`;
          })
          .join('')
      : '<div class="strategy-row"><span>No closed trades yet</span></div>';

    const ww = state.whaleWatch || {};
    const mints = Object.keys(ww);
    $('whaleStats').innerHTML = mints.length
      ? mints
          .map((m) => {
            const w = ww[m];
            const top = (w.holders || [])
              .slice(0, 3)
              .map((h) => `#${h.rank} ${h.pct != null ? h.pct.toFixed(1) + '%' : ''}`)
              .join(' · ');
            return `<div class="whale-row"><span>${w.symbol || shortAddr(m)}</span><strong>${top || '…'} · ${w.latencyMs || '—'}ms</strong></div>`;
          })
          .join('')
      : '<div class="whale-row"><span>No open positions watched</span></div>';
  }

  function renderAccount() {
    if (!state) return;
    $('acctMode').textContent = state.mode || 'PAPER';
    $('acctLive').textContent = state.liveEnabled ? 'ON' : 'DISABLED';
    $('acctCash').textContent = money(state.cash);
    $('acctEquity').textContent = money(state.equity);
    $('acctPeak').textContent = money(state.peakBalance);
    $('acctPos').textContent = String((state.positions || []).length);
    $('acctDay').textContent = money(state.dayPnl || 0);
    const s = state.settings || {};
    $('startBal').value = state.startingBalance || 100;
    $('slippage').value = s.slippage ?? 0.02;
    $('minLiq').value = s.minLiquidity ?? 38000;
    if ($('maxMcap')) $('maxMcap').value = s.maxMarketCapUsd ?? 8000000;
    $('minScore').value = s.minScore ?? 70;
    $('whaleDrop').value = s.whaleDropPct ?? 15;
    $('whalePoll').value = s.whalePollMs ?? 20000;
    document.querySelectorAll('.preset-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === (s.strategyId || 'balanced'));
    });
    if (state.killSwitch) $('killBtn').textContent = 'Kill switch ON';
    else $('killBtn').textContent = 'Kill switch';
  }

  function renderAll() {
    if (!state || state.loading) return;
    setOdometer(state.equity);
    const g = state.gain || 0;
    const gp = state.gainPct || 0;
    const gainEl = $('gainLine');
    if (gainEl) {
      gainEl.textContent = `${g >= 0 ? '+' : ''}${money(g)}`;
      gainEl.classList.toggle('neg', g < 0);
      gainEl.classList.toggle('pos', g >= 0);
    }
    const pill = $('gainPill');
    if (pill) {
      pill.textContent = pct(gp);
      pill.classList.toggle('neg', gp < 0);
    }
    const cashPos = $('cashPos');
    if (cashPos) cashPos.textContent = `${money(state.cash, 0)} · ${(state.positions || []).length} pos`;
    const mult = $('multPill');
    if (mult) mult.textContent = `${(state.multiplier || 1).toFixed(2)}x`;
    $('bannerText').textContent = (state.banner && state.banner.text) || 'Paper desk · memecoins';
    $('modeBadge').textContent = 'PAPER';
    const running = state.settings && state.settings.running && !state.killSwitch;
    const rt = $('runToggle');
    if (rt) {
      rt.setAttribute('aria-pressed', running ? 'true' : 'false');
      const lab = rt.querySelector('.run-label');
      if (lab) lab.textContent = state.killSwitch ? 'Agents KILL' : running ? 'Agents On' : 'Agents Off';
    }
    const pk = $('pillKill');
    if (pk) pk.classList.toggle('on', !!state.killSwitch);
    const chart = $('equityChart');
    if (chart) drawEquity(chart, state.equityHistory || []);
    renderDesk();
    renderCoins();
    renderActivity('activityFull', 80);
    renderStats();
    renderAccount();
    if (state.newPeak && state.equity > peakCelebrated) {
      peakCelebrated = state.equity;
      burstConfetti();
    }
  }

  function renderCoins() {
    const el = $('coinsList');
    if (!el || !state) return;
    const pos = state.positions || [];
    if (!pos.length) {
      el.innerHTML = '<div class="activity-empty">No open coins</div>';
      return;
    }
    el.innerHTML = pos.map((p) => {
      const cls = p.pnl >= 0 ? 'pos' : 'neg';
      return `<div class="coin-row" data-mint="${p.mint}">
        <img src="${p.icon || iconFallback(p.symbol)}" alt="" onerror="this.src='${iconFallback(p.symbol)}'"/>
        <div><div class="cr-title">$${p.symbol}</div><div class="cr-sub">${money(p.markPrice || p.entryPrice, 6)} · ${ageLabel(p.ageMs)}</div></div>
        <div class="cr-pnl ${cls}">${money(p.pnl)}<span class="sub">${pct(p.pnlPct)}</span></div>
      </div>`;
    }).join('');
    el.querySelectorAll('.coin-row').forEach((row) => {
      row.onclick = () => openCoin(row.dataset.mint);
    });
  }

  function burstConfetti() {
    const layer = $('confetti');
    layer.hidden = false;
    layer.innerHTML = '';
    for (let i = 0; i < 28; i++) {
      const d = document.createElement('i');
      d.style.left = Math.random() * 100 + '%';
      d.style.background = ['#00FF66', '#a78bfa', '#5b8cff', '#ff9f0a'][i % 4];
      d.style.animationDelay = Math.random() * 0.4 + 's';
      layer.appendChild(d);
    }
    setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
    }, 1600);
  }

  async function openCoin(mint) {
    if (!mint) return;
    const pos = (state.positions || []).find((p) => p.mint === mint) || (await api(`/api/position/${mint}`).catch(() => null));
    if (!pos || pos.error) return;
    $('coinSheet').classList.add('open');
    $('coinSheet').setAttribute('aria-hidden', 'false');
    $('coinIcon').src = pos.icon || iconFallback(pos.symbol);
    $('coinTitle').textContent = pos.symbol;
    $('coinSub').textContent = pos.name || '';
    $('coinPrice').textContent = money(pos.markPrice || pos.entryPrice, 6);
    $('coinSince').textContent = `${pct(pos.pnlPct)} since entry · ${ageLabel(pos.ageMs)}`;
    drawEquity($('coinChart'), (pos.priceHistory || []).map((p) => ({ t: p.t, equity: p.price })));
    $('coinStats').innerHTML = [
      ['Liquidity', compact(pos.liquidity)],
      ['Market cap', compact(pos.marketCap)],
      ['Score', String(pos.score ?? '—')],
      ['Impact', `${round1(pos.impactPct)}%`],
      ['Fill', pos.fillSource || 'paper'],
      ['Strategy', pos.strategyId || state.settings.strategyId],
    ]
      .map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`)
      .join('');
    $('posCard').innerHTML = `<div>Basis ${money(pos.remainingUsdBasis || pos.amountUsd)} · Tokens ${Number(pos.tokens).toPrecision(4)}</div>
      <div>PnL <strong class="${pos.pnl >= 0 ? 'green' : 'red'}">${money(pos.pnl)} (${pct(pos.pnlPct)})</strong></div>`;
    const ladder = (pos.ladder || []).map((r) => `${r.mult}x ${r.hit ? '✓' : '…'}`).join(' · ');
    $('riskCard').innerHTML = `<div>Stop ${money(pos.stopPrice, 6)} · Trail ${money(pos.trailStop, 6)}</div><div>Ladder ${ladder || '—'}</div>`;

    const ww = (state.whaleWatch && state.whaleWatch[mint]) || pos.whales || null;
    if (ww && ww.holders && ww.holders.length) {
      $('whaleBox').innerHTML = ww.holders
        .map(
          (h) => `<div class="wh-row"><span class="addr">#${h.rank} ${shortAddr(h.owner)}</span>
          <strong>${h.pct != null ? h.pct.toFixed(2) + '%' : '—'} · ${compact(h.amount).replace('$', '')}</strong></div>`
        )
        .join('') + `<div class="agent-meta">poll ${ww.latencyMs || '—'}ms · thresh ${state.settings.whaleDropPct}%</div>`;
    } else {
      $('whaleBox').innerHTML = '<div class="agent-meta">Waiting for holder snapshot…</div>';
    }
  }

  function round1(n) {
    return (Math.round((Number(n) || 0) * 10) / 10).toFixed(1);
  }

  function closeSheet() {
    $('coinSheet').classList.remove('open');
    $('coinSheet').setAttribute('aria-hidden', 'true');
  }

  function bind() {
    $('bottomNav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
    });
    $('tfRow').addEventListener('click', (e) => {
      const b = e.target.closest('.tf');
      if (!b) return;
      tf = b.dataset.tf;
      document.querySelectorAll('.tf').forEach((x) => x.classList.toggle('active', x === b));
      if (state) {
        const chart = $('equityChart');
        if (chart) drawEquity(chart, state.equityHistory || []);
      }
    });
    const pillKill = $('pillKill');
    if (pillKill) {
      pillKill.onclick = async () => {
        const next = !(state && state.killSwitch);
        await api('/api/kill', { method: 'POST', body: JSON.stringify({ kill: next }) }).catch(() => {});
        await refresh();
      };
    }
    $('runToggle').onclick = async () => {
      const running = !($('runToggle').getAttribute('aria-pressed') === 'true');
      state = await api('/api/running', { method: 'POST', body: JSON.stringify({ running }) });
      renderAll();
    };
    $('saveSettings').onclick = async () => {
      state = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          startingBalance: Number($('startBal').value),
          slippage: Number($('slippage').value),
          minLiquidity: Number($('minLiq').value),
          maxMarketCapUsd: Number($('maxMcap') && $('maxMcap').value),
          minScore: Number($('minScore').value),
          whaleDropPct: Number($('whaleDrop').value),
          whalePollMs: Number($('whalePoll').value),
        }),
      });
      renderAll();
    };
    $('presetRow').addEventListener('click', async (e) => {
      const b = e.target.closest('.preset-btn');
      if (!b) return;
      state = await api('/api/settings', { method: 'POST', body: JSON.stringify({ strategyId: b.dataset.preset }) });
      renderAll();
    });
    $('killBtn').onclick = async () => {
      if (!confirm('Engage kill switch? Halts all paper trading.')) return;
      state = await api('/api/kill', { method: 'POST', body: JSON.stringify({ kill: true }) });
      renderAll();
    };
    $('clearKillBtn').onclick = async () => {
      state = await api('/api/kill', { method: 'POST', body: JSON.stringify({ kill: false }) });
      renderAll();
    };
    $('resetBtn').onclick = async () => {
      if (!confirm('Reset paper wallet?')) return;
      state = await api('/api/reset', {
        method: 'POST',
        body: JSON.stringify({ startingBalance: Number($('startBal').value) }),
      });
      odoPrimed = false;
      renderAll();
    };
    $('sheetClose').onclick = closeSheet;
    $('coinSheet').addEventListener('click', (e) => {
      if (e.target.id === 'coinSheet') closeSheet();
    });
    document.addEventListener('click', (e) => {
      const row = e.target.closest('.act');
      if (row && row.dataset.mint) openCoin(row.dataset.mint);
    });
    $('passSubmit').onclick = async () => {
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passcode: $('passInput').value }),
        }).then((x) => x.json());
        if (!r.ok) {
          $('passError').classList.remove('hide');
          return;
        }
        if (r.token) {
          authToken = r.token;
          localStorage.setItem('jev_session', r.token);
        }
        $('passError').classList.add('hide');
        showLock(false);
        await refresh();
      } catch (_) {
        $('passError').classList.remove('hide');
      }
    };
  }

  async function refresh() {
    if (!unlocked && $('lockScreen') && !$('lockScreen').classList.contains('hide')) return;
    try {
      state = await api('/api/state');
      renderAll();
      const notes = await api('/api/notifications');
      // notifications reserved for future toast UI
      void notes;
    } catch (e) {
      if (e.message !== 'auth') console.warn(e);
    }
  }

  async function boot() {
    bind();
    if ('serviceWorker' in navigator) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
      navigator.serviceWorker
        .register('/sw.js?v=6')
        .then((reg) => {
          const ping = () => reg.update().catch(() => {});
          ping();
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') ping();
          });
          setInterval(ping, 60e3);
        })
        .catch(() => {});
    }
    const ok = await checkAuth();
    if (ok) await refresh();
    setInterval(refresh, 4000);
  }

  boot();
})();
