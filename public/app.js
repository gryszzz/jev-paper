(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let state = null;
  let tf = 'LIVE';
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
    grad.addColorStop(0, 'rgba(57,255,140,0.28)');
    grad.addColorStop(1, 'rgba(57,255,140,0)');
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = X(p.t);
      const y = Y(p.equity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#39ff8c';
    ctx.lineWidth = 2;
    ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.lineTo(X(last.t), h - pad);
    ctx.lineTo(X(pts[0].t), h - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  const AGENT_META = {
    scanner: { name: 'Scanner', color: '#5b8cff' },
    analyst: { name: 'Analyst', color: '#a78bfa' },
    executor: { name: 'Executor', color: '#39ff8c' },
    risk: { name: 'Risk', color: '#ff9f0a' },
    whale: { name: 'Whale', color: '#22d3ee' },
  };

  /** Distinct original character art (not xAI/Grok trademark). */
  function agentSvg(key, a, meta) {
    const c = meta.color;
    if (key === 'scanner') {
      return `<svg class="bot bot-scanner" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="11" fill="none" stroke="${c}" stroke-width="1.2" opacity=".35"/>
        <circle cx="16" cy="16" r="7" fill="none" stroke="${c}" stroke-width="1" opacity=".25"/>
        <path class="av-sweep" d="M16 16 L16 5 A11 11 0 0 1 26.5 20 Z" fill="${c}" opacity=".28"/>
        <circle cx="16" cy="16" r="2.2" fill="${c}"/>
        <circle class="av-blip" cx="23" cy="9" r="2" fill="${c}" opacity="0"/>
        <circle class="av-blip" cx="10" cy="22" r="1.5" fill="#39ff8c" opacity="0" style="animation-delay:.35s"/>
      </svg>`;
    }
    if (key === 'analyst') {
      const score = Math.max(0, Math.min(100, Number(a.score) || 0));
      const circ = 2 * Math.PI * 9;
      const off = circ * (1 - score / 100);
      return `<svg class="bot bot-analyst" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="11" fill="#12121a" stroke="${c}" stroke-width="1.2" opacity=".5"/>
        <circle class="av-gauge" cx="16" cy="16" r="9" fill="none" stroke="${c}" stroke-width="2.4"
          stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
          stroke-linecap="round" transform="rotate(-90 16 16)"/>
        <rect class="av-scan" x="8" y="14" width="16" height="1.4" fill="${c}" opacity=".7"/>
        <text class="av-think" x="16" y="18.5" text-anchor="middle" fill="#fff" font-size="8" font-weight="700" font-family="Inter,system-ui,sans-serif">${score || '—'}</text>
      </svg>`;
    }
    if (key === 'executor') {
      return `<svg class="bot bot-executor" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="5" y="10" width="14" height="12" rx="3" fill="#12121a" stroke="${c}" stroke-width="1.4"/>
        <path class="av-bolt" d="M20 6 L15 16 H19 L14 26 L24 14 H19 Z" fill="${c}" opacity=".9"/>
        <g class="av-ticket" opacity="0">
          <rect x="18" y="18" width="10" height="7" rx="1.5" fill="#1a1a24" stroke="${c}" stroke-width="1"/>
          <path d="M20 20.5h6M20 22.5h4" stroke="${c}" stroke-width="1" opacity=".8"/>
        </g>
      </svg>`;
    }
    if (key === 'risk') {
      const la = a.lastAction;
      const mood = la && la.pnl != null ? (la.pnl >= 0 ? 'ok' : 'block') : 'idle';
      const fill = mood === 'block' ? 'rgba(255,69,58,0.25)' : mood === 'ok' ? 'rgba(57,255,140,0.2)' : 'rgba(255,159,10,0.15)';
      const stroke = mood === 'block' ? '#ff453a' : mood === 'ok' ? '#39ff8c' : c;
      return `<svg class="bot bot-risk" viewBox="0 0 32 32" aria-hidden="true" data-mood="${mood}">
        <path class="av-shield" d="M16 4 L26 8 V16 C26 22 21.5 26.5 16 28 C10.5 26.5 6 22 6 16 V8 Z"
          fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M12.5 16.2 L15 18.7 L20 12.8" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
      </svg>`;
    }
    if (key === 'whale') {
      return `<svg class="bot bot-whale" viewBox="0 0 32 32" aria-hidden="true">
        <g class="av-whale">
          <ellipse cx="15" cy="18" rx="10" ry="6" fill="#12121a" stroke="${c}" stroke-width="1.3"/>
          <path d="M24 16 C28 12 29 10 27 8 C25 11 24 13 22 15" fill="none" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>
          <circle class="av-ring" cx="11.5" cy="16.5" r="4.2" fill="none" stroke="${c}" stroke-width="1" opacity=".4"/>
          <circle cx="11.5" cy="16.5" r="2.6" fill="#0a0a10" stroke="${c}" stroke-width="1"/>
          <circle class="av-eye-pupil" cx="11.5" cy="16.5" r="1.15" fill="${c}"/>
        </g>
      </svg>`;
    }
    return '';
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

  function agentSparkline(key, s) {
    const act = s.activity || [];
    const map = {
      scanner: (it) => /scan|found|launch|new/i.test(it.type || '') || it.agent === 'Scanner',
      analyst: (it) => /score|pass|analyst/i.test(it.type || '') || it.agent === 'Analyst',
      executor: (it) => /buy|sell|fill|tp|stop/i.test(it.type || '') || it.agent === 'Executor',
      risk: (it) => /stop|trail|tp|kill|risk|whale_exit/i.test(it.type || '') || it.agent === 'Risk',
      whale: (it) => /whale/i.test(it.type || '') || it.agent === 'Whale Watch' || it.agent === 'Whale',
    };
    const filt = map[key] || (() => true);
    let pts = act.filter(filt).slice(0, 16).reverse().map((it) => {
      if (it.pnl != null) return Number(it.pnl);
      if (it.amountUsd != null) return Number(it.amountUsd) * 0.05;
      return 1;
    });
    if (pts.length < 2) {
      // synthesize gentle idle wave from agent counters
      const a = (s.agents && s.agents[key]) || {};
      const seed = (a.pools || a.scored || a.trades || a.watching || 3) % 7;
      pts = Array.from({ length: 10 }, (_, i) => Math.sin((i + seed) * 0.7) * (1 + seed * 0.1));
    }
    const w = 100, h = 14, pad = 1;
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || 1;
    const coords = pts.map((v, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return [x, y];
    });
    const d = coords.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    const first = pts[0];
    const up = last >= first;
    const stroke = up ? '#39ff8c' : '#ff453a';
    return `<svg class="agent-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" stroke="${stroke}"/></svg>`;
  }

  function flashClass(flash) {
    if (flash === 'profit') return ' flash-profit';
    if (flash === 'loss') return ' flash-loss';
    if (flash === 'alert' || flash === 'entry') return ' flash-alert';
    if (flash === 'pulse') return ' flash-pulse';
    if (flash === 'block') return ' flash-loss';
    return '';
  }

  function renderAgents(targetId, large) {
    const el = $(targetId);
    if (!el || !state) return;
    const order = ['scanner', 'analyst', 'executor', 'risk', 'whale'];
    el.innerHTML = order
      .map((key) => {
        const a = state.agents[key] || {};
        const meta = AGENT_META[key];
        const on = a.status && a.status !== 'idle';
        const mood = key === 'risk' && a.lastAction && a.lastAction.pnl != null
          ? (a.lastAction.pnl >= 0 ? 'ok' : 'block')
          : '';
        return `<div class="agent-card${on ? ' active-agent' : ''}${flashClass(a.flash)}" data-agent="${key}"${mood ? ` data-mood="${mood}"` : ''}>
          <div class="agent-top">
            <div class="agent-avatar">${agentSvg(key, a, meta)}</div>
            <div class="agent-head">
              <div class="agent-name">${meta.name}</div>
              <div class="agent-status ${on ? 'on' : ''}">${a.status || 'idle'}</div>
            </div>
          </div>
          <div class="agent-live">${agentLiveLine(key, a, state)}</div>
          ${agentSparkline(key, state)}
        </div>`;
      })
      .join('');
    order.forEach((key) => {
      const f = state.agents[key] && state.agents[key].flash;
      if (f && f !== 'null') {
        setTimeout(() => {
          if (state.agents[key] && state.agents[key].flash === f) state.agents[key].flash = null;
        }, 900);
      }
    });
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
        return `<div class="act" role="button" data-mint="${it.mint || ''}">
          ${img}
          <div><div class="t1">${it.type} · ${it.symbol || ''}</div>
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
    $('gainLine').textContent = `${g >= 0 ? '+' : ''}${money(g)} (${pct(gp)})`;
    $('gainLine').classList.toggle('neg', g < 0);
    $('multPill').textContent = `${(state.multiplier || 1).toFixed(2)}x`;
    $('bannerText').textContent = (state.banner && state.banner.text) || 'JEV · Mode: PAPER';
    $('modeBadge').textContent = 'Mode: PAPER';
    if (state.banner && state.banner.icon) {
      $('bannerIcon').src = state.banner.icon;
      $('bannerIcon').classList.remove('hide');
    } else $('bannerIcon').classList.add('hide');
    $('disclaimer').textContent = state.disclaimer || '';
    const running = state.settings && state.settings.running && !state.killSwitch;
    $('runToggle').setAttribute('aria-pressed', running ? 'true' : 'false');
    $('runToggle').querySelector('.run-label').textContent = state.killSwitch ? 'KILL' : running ? 'On' : 'Paused';
    $('agentsRunning').textContent = running ? '5 agents' : state.killSwitch ? 'killed' : 'paused';
    drawEquity($('equityChart'), state.equityHistory || []);
    renderAgents('agentsGrid', false);
    renderAgents('agentsFull', true);
    renderActivity('activityHome', 5);
    renderActivity('activityFull', 80);
    renderStats();
    renderAccount();
    if (state.newPeak && state.equity > peakCelebrated) {
      peakCelebrated = state.equity;
      burstConfetti();
    }
  }

  function burstConfetti() {
    const layer = $('confetti');
    layer.hidden = false;
    layer.innerHTML = '';
    for (let i = 0; i < 28; i++) {
      const d = document.createElement('i');
      d.style.left = Math.random() * 100 + '%';
      d.style.background = ['#39ff8c', '#a78bfa', '#5b8cff', '#ff9f0a'][i % 4];
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
    $('seeAllActivity').onclick = () => {
      document.querySelector('.nav-btn[data-tab="activity"]').click();
    };
    $('tfRow').addEventListener('click', (e) => {
      const b = e.target.closest('.tf');
      if (!b) return;
      tf = b.dataset.tf;
      document.querySelectorAll('.tf').forEach((x) => x.classList.toggle('active', x === b));
      if (state) drawEquity($('equityChart'), state.equityHistory || []);
    });
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
