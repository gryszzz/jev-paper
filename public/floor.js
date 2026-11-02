/* JEV Trading Floor v13 — compact agent badge icons (~40px), slim stage */
(function (global) {
  'use strict';

  const META = {
    scanner: { name: 'Scanner', short: 'SCAN', color: '#5b8cff' },
    analyst: { name: 'Analyst', short: 'ANAL', color: '#a78bfa' },
    risk: { name: 'Risk', short: 'RISK', color: '#ff9f0a' },
    executor: { name: 'Executor', short: 'EXEC', color: '#00FF66' },
    whale: { name: 'Whale', short: 'WHALE', color: '#22d3ee' },
  };
  const ORDER = ['scanner', 'analyst', 'risk', 'executor', 'whale'];
  const BADGE = 40; // px icon diameter target

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function hexAlpha(hex, a) {
    const n = hex.replace('#', '');
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function createFloor(canvas) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { alpha: false });
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const bots = {};
    ORDER.forEach((k, i) => {
      bots[k] = {
        key: k,
        home: (i + 0.5) / ORDER.length,
        x: (i + 0.5) / ORDER.length,
        speech: '',
        speechT: 0,
        active: false,
        pulse: 0,
        tick: 0,
      };
    });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let running = false;
    let tSec = 0;
    let coin = null;
    let lastSig = '';
    let agentsSnap = {};
    let ticks = []; // green win ticks {x,y,life}

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(280, rect.width || canvas.parentElement?.clientWidth || 400);
      const cssH = 100;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      w = cssW;
      h = cssH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function speak(key, text, ms) {
      const b = bots[key];
      if (!b || !text) return;
      b.speech = String(text).slice(0, 18);
      b.speechT = ms || 2400;
    }

    function startCoinPass(symbol) {
      coin = { prog: 0, symbol: symbol || '???' };
      speak('scanner', `$${symbol || ''}`, 1600);
      bots.scanner.active = true;
      bots.scanner.pulse = 1;
    }

    function onState(state) {
      if (!state) return;
      const agents = state.agents || {};
      agentsSnap = agents;

      const lines = {
        scanner: (() => {
          const a = agents.scanner || {};
          const last = (a.recent || []).find((x) => x.ok) || (a.recent || [])[0];
          if (last) return `$${last.symbol}`;
          if (a.wsConnected || a.status === 'streaming') return 'LIVE';
          return a.status === 'scanning' ? 'scan' : '';
        })(),
        analyst: (() => {
          const a = agents.analyst || {};
          if (a.symbol != null && a.score != null) return `${a.score}`;
          return a.status === 'scoring' ? 'score' : '';
        })(),
        risk: (() => {
          const a = agents.risk || {};
          if (a.guarding) return 'guard';
          const la = a.lastAction;
          if (la && la.pnl != null) return la.pnl >= 0 ? `+${Math.abs(la.pnl).toFixed(1)}` : 'cut';
          return '';
        })(),
        executor: (() => {
          const a = agents.executor || {};
          if (a.status === 'buying') return 'buy';
          const f = a.lastFill;
          if (f) return `$${f.symbol}`;
          return '';
        })(),
        whale: (() => {
          const a = agents.whale || {};
          if (a.lastAlert) return 'alert';
          if (a.watching) return `×${a.watching}`;
          return '';
        })(),
      };

      for (const k of ORDER) {
        if (lines[k]) speak(k, lines[k], 2200);
        bots[k].active = false;
      }

      const sc = agents.scanner || {};
      const an = agents.analyst || {};
      if (sc.status === 'scanning' || sc.status === 'streaming') {
        bots.scanner.active = true;
        bots.scanner.pulse = Math.max(bots.scanner.pulse, 0.6);
      }
      if (an.status === 'scoring') {
        bots.analyst.active = true;
        bots.analyst.pulse = Math.max(bots.analyst.pulse, 0.6);
      }
      if ((agents.executor || {}).status === 'buying') {
        bots.executor.active = true;
        bots.executor.pulse = 1;
      }
      if ((agents.whale || {}).watching) bots.whale.active = true;
      if ((agents.whale || {}).lastAlert) {
        bots.whale.active = true;
        bots.whale.pulse = 1;
      }

      const act = (state.activity && state.activity[0]) || null;
      const sig = act ? `${act.ts}|${act.type}|${act.symbol}|${act.pnl}` : '';
      if (sig && sig !== lastSig) {
        lastSig = sig;
        const t = (act.type || '').toLowerCase();
        if (t === 'buy') {
          startCoinPass(act.symbol);
          speak('executor', `$${act.symbol}`, 2800);
          bots.executor.pulse = 1;
        } else if (act.pnl != null && (t === 'sell' || t === 'tp' || t === 'stopped')) {
          if (act.pnl >= 0) {
            speak('risk', `+${Math.abs(act.pnl).toFixed(1)}`, 2800);
            bots.risk.pulse = 1;
            bots.risk.tick = 1;
            ticks.push({
              x: bots.risk.x,
              y: 0.42,
              life: 1,
            });
          } else {
            speak('risk', 'cut', 2400);
            bots.risk.pulse = 1;
          }
        } else if (t === 'whale_exit' || (agents.whale && agents.whale.lastAlert)) {
          speak('whale', 'alert', 3000);
          bots.whale.pulse = 1;
        }
      }

      if (an.status === 'passed' && an.symbol) {
        const passSig = `pass:${an.symbol}:${an.score}`;
        if (passSig !== bots._lastPass) {
          bots._lastPass = passSig;
          if (!coin) startCoinPass(an.symbol);
        }
      }
    }

    function roundRect(x, y, rw, rh, r) {
      const rr = Math.min(r, rw / 2, rh / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + rw, y, x + rw, y + rh, rr);
      ctx.arcTo(x + rw, y + rh, x, y + rh, rr);
      ctx.arcTo(x, y + rh, x, y, rr);
      ctx.arcTo(x, y, x + rw, y, rr);
      ctx.closePath();
    }

    function drawStage() {
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, w, h);
      // faint baseline
      const y = h * 0.72;
      const g = ctx.createLinearGradient(0, y, w, y);
      g.addColorStop(0, 'rgba(91,140,255,0)');
      g.addColorStop(0.5, 'rgba(0,255,102,0.18)');
      g.addColorStop(1, 'rgba(34,211,238,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(12, y);
      ctx.lineTo(w - 12, y);
      ctx.stroke();
    }

    /** Bold white glyph on dark rounded badge — original JEV marks, not Grok/xAI */
    function drawGlyph(key, size) {
      const s = size;
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = Math.max(1.6, s * 0.07);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (key === 'scanner') {
        // radar arcs
        ctx.beginPath();
        ctx.arc(0, s * 0.12, s * 0.18, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, s * 0.12, s * 0.3, -Math.PI * 0.78, -Math.PI * 0.22);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, s * 0.12, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (key === 'analyst') {
        // eye + mini chart
        ctx.beginPath();
        ctx.ellipse(0, -s * 0.06, s * 0.22, s * 0.14, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -s * 0.06, s * 0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-s * 0.22, s * 0.22);
        ctx.lineTo(-s * 0.06, s * 0.1);
        ctx.lineTo(s * 0.06, s * 0.18);
        ctx.lineTo(s * 0.22, s * 0.02);
        ctx.stroke();
      } else if (key === 'risk') {
        // shield
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.28);
        ctx.lineTo(s * 0.22, -s * 0.14);
        ctx.lineTo(s * 0.22, s * 0.06);
        ctx.quadraticCurveTo(s * 0.22, s * 0.26, 0, s * 0.32);
        ctx.quadraticCurveTo(-s * 0.22, s * 0.26, -s * 0.22, s * 0.06);
        ctx.lineTo(-s * 0.22, -s * 0.14);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.1);
        ctx.lineTo(0, s * 0.14);
        ctx.stroke();
      } else if (key === 'executor') {
        // bolt
        ctx.beginPath();
        ctx.moveTo(s * 0.04, -s * 0.3);
        ctx.lineTo(-s * 0.12, s * 0.02);
        ctx.lineTo(s * 0.02, s * 0.02);
        ctx.lineTo(-s * 0.04, s * 0.3);
        ctx.lineTo(s * 0.16, -s * 0.02);
        ctx.lineTo(0, -s * 0.02);
        ctx.closePath();
        ctx.fill();
      } else if (key === 'whale') {
        // whale tail
        ctx.beginPath();
        ctx.moveTo(-s * 0.02, s * 0.08);
        ctx.quadraticCurveTo(-s * 0.05, -s * 0.05, -s * 0.28, -s * 0.22);
        ctx.quadraticCurveTo(-s * 0.12, -s * 0.02, -s * 0.02, s * 0.08);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(s * 0.02, s * 0.08);
        ctx.quadraticCurveTo(s * 0.05, -s * 0.05, s * 0.28, -s * 0.22);
        ctx.quadraticCurveTo(s * 0.12, -s * 0.02, s * 0.02, s * 0.08);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, s * 0.08);
        ctx.lineTo(0, s * 0.28);
        ctx.stroke();
      }
    }

    function drawBadge(b) {
      const meta = META[b.key];
      const size = Math.min(BADGE, w * 0.11);
      const x = b.x * w;
      const y = h * 0.42;
      const active = b.active || b.pulse > 0.15;
      const pulse =
        reduced || !active ? 0 : 0.5 + 0.5 * Math.sin(tSec * 3.2 + b.home * 8);

      // soft glow under ring when active
      if (active && !reduced) {
        const g = ctx.createRadialGradient(x, y, size * 0.2, x, y, size * 0.85);
        g.addColorStop(0, hexAlpha(meta.color, 0.18 + pulse * 0.12));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }

      // dark badge (rounded square)
      const r = size * 0.28;
      const half = size / 2;
      ctx.fillStyle = '#12121a';
      roundRect(x - half, y - half, size, size, r);
      ctx.fill();
      ctx.fillStyle = '#0a0a10';
      roundRect(x - half + 1, y - half + 1, size - 2, size - 2, r - 1);
      ctx.fill();

      // colored ring
      const ringW = active ? 2.2 : 1.5;
      ctx.strokeStyle = hexAlpha(meta.color, active ? 0.75 + pulse * 0.25 : 0.45);
      ctx.lineWidth = ringW;
      if (active && !reduced) {
        ctx.shadowColor = meta.color;
        ctx.shadowBlur = 6 + pulse * 6;
      }
      roundRect(x - half + 1, y - half + 1, size - 2, size - 2, r - 1);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // white glyph
      ctx.save();
      ctx.translate(x, y);
      drawGlyph(b.key, size);
      ctx.restore();

      // tiny name
      ctx.font = '700 8px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = hexAlpha(meta.color, 0.9);
      ctx.fillText(meta.name, x, y + half + 11);

      // speech pill
      if (b.speech && b.speechT > 0) {
        const alpha = clamp(b.speechT / 350, 0, 1);
        ctx.globalAlpha = alpha;
        ctx.font = '600 8px Inter, system-ui, sans-serif';
        const tw = Math.min(ctx.measureText(b.speech).width, w * 0.16);
        const pw = tw + 10;
        const px = x - pw / 2;
        const py = y - half - 16;
        ctx.fillStyle = 'rgba(10,10,16,0.85)';
        roundRect(px, py, pw, 14, 7);
        ctx.fill();
        ctx.strokeStyle = hexAlpha(meta.color, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#eee';
        ctx.fillText(b.speech, x, py + 10);
        ctx.globalAlpha = 1;
      }

      // green tick overlay on win
      if (b.tick > 0) {
        ctx.globalAlpha = clamp(b.tick, 0, 1);
        ctx.strokeStyle = '#00FF66';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(x - 5, y + 2);
        ctx.lineTo(x - 1, y + 7);
        ctx.lineTo(x + 8, y - 6);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    function drawCoinDot() {
      if (!coin) return;
      const path = [
        { k: 'scanner', t: 0 },
        { k: 'analyst', t: 0.33 },
        { k: 'risk', t: 0.66 },
        { k: 'executor', t: 1 },
      ];
      let i = 0;
      while (i < path.length - 1 && coin.prog > path[i + 1].t) i++;
      const a = path[i];
      const b = path[Math.min(i + 1, path.length - 1)];
      const span = b.t - a.t || 1;
      const u = easeOut(clamp((coin.prog - a.t) / span, 0, 1));
      const x = lerp(bots[a.k].x, bots[b.k].x, u) * w;
      const y = h * 0.42 - 22 - Math.sin(u * Math.PI) * 6;

      ctx.save();
      ctx.fillStyle = '#f5c542';
      ctx.shadowColor = '#f5c542';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      bots[a.k].active = true;
      bots[a.k].pulse = Math.max(bots[a.k].pulse, 0.7);
      if (u > 0.5) {
        bots[b.k].active = true;
        bots[b.k].pulse = Math.max(bots[b.k].pulse, 0.7);
      }
    }

    function tick(ts) {
      if (!running) return;
      const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
      last = ts;
      tSec = ts / 1000;

      if (!reduced) {
        for (const k of ORDER) {
          const b = bots[k];
          b.x = lerp(b.x, b.home, 0.12);
          if (b.pulse > 0) b.pulse = Math.max(0, b.pulse - dt * 0.55);
          if (b.tick > 0) b.tick = Math.max(0, b.tick - dt * 0.9);
          if (b.speechT > 0) b.speechT -= dt * 1000;
        }
        if (coin) {
          coin.prog += dt * 0.7;
          if (coin.prog >= 1) {
            speak('executor', `$${coin.symbol}`, 2000);
            bots.executor.pulse = 1;
            bots.executor.tick = 0.8;
            ticks.push({ x: bots.executor.x, y: 0.42, life: 1 });
            coin = null;
          }
        }
      } else {
        for (const k of ORDER) {
          const b = bots[k];
          if (b.speechT > 0) b.speechT -= dt * 1000;
        }
      }

      for (const t of ticks) t.life -= dt * 1.2;
      ticks = ticks.filter((t) => t.life > 0);

      drawStage();
      drawCoinDot();
      for (const k of ORDER) drawBadge(bots[k]);

      // floating green ticks
      for (const t of ticks) {
        const x = t.x * w;
        const y = h * t.y - (1 - t.life) * 12;
        ctx.globalAlpha = t.life;
        ctx.strokeStyle = '#00FF66';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x - 0.5, y + 4);
        ctx.lineTo(x + 6, y - 5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (reduced) {
        raf = setTimeout(() => {
          raf = requestAnimationFrame(tick);
        }, 500);
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    function start() {
      if (running) return;
      running = true;
      resize();
      last = performance.now();
      raf = requestAnimationFrame(tick);
      window.addEventListener('resize', resize);
    }
    function stop() {
      running = false;
      if (typeof raf === 'number') {
        cancelAnimationFrame(raf);
        clearTimeout(raf);
      }
      window.removeEventListener('resize', resize);
    }

    return { start, stop, resize, onState, startCoinPass };
  }

  global.JevFloor = { createFloor };
})(window);
