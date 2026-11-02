/* JEV Trading Floor v14 — tiny free-standing agents, no badges/boxes */
(function (global) {
  'use strict';

  const META = {
    scanner: { name: 'Scanner', color: '#5b8cff' },
    analyst: { name: 'Analyst', color: '#a78bfa' },
    risk: { name: 'Risk', color: '#ff9f0a' },
    executor: { name: 'Executor', color: '#00FF66' },
    whale: { name: 'Whale', color: '#22d3ee' },
  };
  const ORDER = ['scanner', 'analyst', 'risk', 'executor', 'whale'];

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
        bob: Math.random() * Math.PI * 2,
        speech: '',
        speechT: 0,
        active: false,
        flash: 0,
        action: 0, // 0..1 small action pose
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
    let radarA = 0;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(280, rect.width || canvas.parentElement?.clientWidth || 400);
      const cssH = 105;
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
      b.speech = String(text).slice(0, 16);
      b.speechT = ms || 2400;
    }

    function startCoinPass(symbol) {
      coin = { prog: 0, symbol: symbol || '???' };
      speak('scanner', `$${symbol || ''}`, 1600);
      bots.scanner.active = true;
      bots.scanner.action = 1;
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
          if (a.wsConnected || a.status === 'streaming') return 'live';
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
        bots.scanner.action = Math.max(bots.scanner.action, 0.5);
      }
      if (an.status === 'scoring') {
        bots.analyst.active = true;
        bots.analyst.action = Math.max(bots.analyst.action, 0.5);
      }
      if ((agents.executor || {}).status === 'buying') {
        bots.executor.active = true;
        bots.executor.action = 1;
        bots.executor.flash = 1;
      }
      if ((agents.whale || {}).watching) bots.whale.active = true;
      if ((agents.whale || {}).lastAlert) {
        bots.whale.active = true;
        bots.whale.action = 1;
        bots.whale.flash = 1;
      }

      const act = (state.activity && state.activity[0]) || null;
      const sig = act ? `${act.ts}|${act.type}|${act.symbol}|${act.pnl}` : '';
      if (sig && sig !== lastSig) {
        lastSig = sig;
        const t = (act.type || '').toLowerCase();
        if (t === 'buy') {
          startCoinPass(act.symbol);
          speak('executor', `$${act.symbol}`, 2800);
          bots.executor.action = 1;
          bots.executor.flash = 1;
        } else if (act.pnl != null && (t === 'sell' || t === 'tp' || t === 'stopped')) {
          if (act.pnl >= 0) {
            speak('risk', `+${Math.abs(act.pnl).toFixed(1)}`, 2800);
            bots.risk.action = 1;
            bots.risk.flash = 1;
          } else {
            speak('risk', 'cut', 2400);
            bots.risk.action = 1;
          }
        } else if (t === 'whale_exit' || (agents.whale && agents.whale.lastAlert)) {
          speak('whale', 'alert', 3000);
          bots.whale.action = 1;
          bots.whale.flash = 1;
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

    function px(x, y, rw, rh, fill, stroke) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, rw, rh);
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
      }
    }

    function drawStage() {
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, w, h);
      const y = h * 0.78;
      const g = ctx.createLinearGradient(0, y, w, y);
      g.addColorStop(0, 'rgba(91,140,255,0)');
      g.addColorStop(0.5, 'rgba(0,255,102,0.14)');
      g.addColorStop(1, 'rgba(34,211,238,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.lineTo(w - 10, y);
      ctx.stroke();
    }

    /**
     * Tiny free-standing JEV agent (~48–52px). Crisp pixel-ish body + role prop.
     * No badge, circle, ring, or card behind the figure.
     */
    function drawAgent(b) {
      const meta = META[b.key];
      const c = meta.color;
      const scale = Math.min(1.65, w / 240); // ~52px tall on phone
      const unit = 16 * scale; // body unit
      const tall = unit * 3.2; // ~51px
      const bob = reduced ? 0 : Math.sin(b.bob) * 1.8;
      const x = b.x * w;
      const groundY = h * 0.72;
      const y = groundY + bob;
      const blink = !reduced && Math.sin(b.bob * 0.55 + b.home * 9) > 0.92;
      const act = b.action > 0 && !reduced ? Math.sin((1 - b.action) * Math.PI) : 0;

      // soft glow under feet only
      const gg = ctx.createRadialGradient(x, groundY + 2, 1, x, groundY + 2, unit * 1.1);
      gg.addColorStop(0, hexAlpha(c, b.active || b.flash > 0 ? 0.35 : 0.16));
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.ellipse(x, groundY + 2, unit * 1.05, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.translate(x, y);
      if (b.flash > 0) {
        ctx.shadowColor = c;
        ctx.shadowBlur = 8;
      }

      const s = scale;
      // legs (walk tip when active)
      const leg = reduced ? 0 : Math.sin(b.bob * 2) * 1.2 * s;
      const legLift = act * 2 * s;
      px(-5 * s, -8 * s, 3.5 * s, 8 * s, c);
      px(2 * s, -8 * s, 3.5 * s, 8 * s, c);
      // foot shift
      px(-6 * s - leg, 0, 4.5 * s, 2.2 * s, c);
      px(1.5 * s + leg, 0 - legLift * 0.3, 4.5 * s, 2.2 * s, c);

      // torso
      px(-7 * s, -20 * s, 14 * s, 13 * s, '#12121a', c);

      // arms
      const armUp = b.key === 'executor' && b.active ? -4 * s * (0.4 + act) : 0;
      const armOut = b.key === 'analyst' && b.active ? 2 * s : 0;
      px(-10 * s, -18 * s, 3.2 * s, 2.4 * s, c);
      px(7 * s + armOut, -18 * s + armUp, 3.2 * s, 2.4 * s, c);

      // head
      px(-6 * s, -29 * s, 12 * s, 10 * s, '#16161f', c);

      // eyes / blink
      if (!blink) {
        px(-3.5 * s, -25 * s, 2.4 * s, 2.4 * s, c);
        px(1.2 * s, -25 * s, 2.4 * s, 2.4 * s, c);
        // eye shine
        px(-3 * s, -25.3 * s, 1 * s, 1 * s, '#fff');
        px(1.7 * s, -25.3 * s, 1 * s, 1 * s, '#fff');
      } else {
        ctx.strokeStyle = c;
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.beginPath();
        ctx.moveTo(-3.5 * s, -24 * s);
        ctx.lineTo(-1 * s, -24 * s);
        ctx.moveTo(1.2 * s, -24 * s);
        ctx.lineTo(3.6 * s, -24 * s);
        ctx.stroke();
      }

      // role props — free-standing, no frames
      if (b.key === 'scanner') drawScannerProp(c, s);
      if (b.key === 'analyst') drawAnalystProp(c, s, act);
      if (b.key === 'risk') drawRiskProp(c, s, act);
      if (b.key === 'executor') drawExecutorProp(c, s, act);
      if (b.key === 'whale') drawWhaleProp(c, s, act);

      ctx.restore();

      // name under feet
      ctx.font = '700 8px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = c;
      ctx.fillText(meta.name, x, groundY + 14);

      // speech pill (only when speaking) — not a character frame
      if (b.speech && b.speechT > 0) {
        const alpha = clamp(b.speechT / 350, 0, 1);
        ctx.globalAlpha = alpha;
        ctx.font = '600 8px Inter, system-ui, sans-serif';
        const tw = Math.min(ctx.measureText(b.speech).width, w * 0.15);
        const pw = tw + 8;
        const px0 = x - pw / 2;
        const py = y - tall - 4;
        ctx.fillStyle = 'rgba(8,8,14,0.82)';
        roundRect(px0, py, pw, 13, 6);
        ctx.fill();
        ctx.fillStyle = '#eee';
        ctx.fillText(b.speech, x, py + 9.5);
        ctx.globalAlpha = 1;
      }
    }

    function drawScannerProp(c, s) {
      // antenna + rotating radar dish
      px(-1 * s, -34 * s, 2.2 * s, 5 * s, c);
      ctx.save();
      ctx.translate(0, -36 * s);
      ctx.rotate(radarA);
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, 1.3 * s);
      ctx.beginPath();
      ctx.arc(0, 0, 5 * s, -0.9, 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 8 * s, -0.7, 0.7);
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(0, 0, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
      // beam wedge
      if (!reduced) {
        ctx.fillStyle = hexAlpha(c, 0.25);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 9 * s, -0.25, 0.25);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    function drawAnalystProp(c, s, act) {
      // glasses
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, 1.2 * s);
      ctx.strokeRect(-5 * s, -26 * s, 4.5 * s, 3.5 * s);
      ctx.strokeRect(0.5 * s, -26 * s, 4.5 * s, 3.5 * s);
      ctx.beginPath();
      ctx.moveTo(-0.5 * s, -24.2 * s);
      ctx.lineTo(0.5 * s, -24.2 * s);
      ctx.stroke();
      // floating mini chart in hand
      const ox = 11 * s + act * 2 * s;
      const oy = -16 * s - act * 2 * s;
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.moveTo(ox - 3 * s, oy + 3 * s);
      ctx.lineTo(ox - 1 * s, oy - 1 * s);
      ctx.lineTo(ox + 1 * s, oy + 1 * s);
      ctx.lineTo(ox + 3.5 * s, oy - 3 * s);
      ctx.stroke();
    }

    function drawRiskProp(c, s, act) {
      const ox = -12 * s - act * s;
      const oy = -18 * s;
      ctx.fillStyle = hexAlpha(c, 0.22);
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, 1.2 * s);
      ctx.beginPath();
      ctx.moveTo(ox, oy - 6 * s);
      ctx.lineTo(ox + 5 * s, oy - 4 * s);
      ctx.lineTo(ox + 5 * s, oy + 2 * s);
      ctx.lineTo(ox, oy + 6 * s);
      ctx.lineTo(ox - 5 * s, oy + 2 * s);
      ctx.lineTo(ox - 5 * s, oy - 4 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    function drawExecutorProp(c, s, act) {
      ctx.save();
      ctx.translate(10 * s, -30 * s - act * 3 * s);
      if (act > 0.2) {
        ctx.shadowColor = c;
        ctx.shadowBlur = 6;
      }
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(2 * s, -6 * s);
      ctx.lineTo(-3 * s, 1 * s);
      ctx.lineTo(0.5 * s, 1 * s);
      ctx.lineTo(-1.5 * s, 7 * s);
      ctx.lineTo(4 * s, 0);
      ctx.lineTo(0.5 * s, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawWhaleProp(c, s, act) {
      // periscope hat
      px(-5 * s, -35 * s, 10 * s, 5 * s, '#0e1a1f', c);
      px(4 * s, -34 * s, 2 * s, 7 * s + act * s, c);
      px(3 * s, -28 * s + act * s, 4 * s, 2 * s, c);
      // little whale buddy floating beside
      const bx = 12 * s;
      const by = -14 * s + Math.sin(tSec * 2.5 + 1) * (reduced ? 0 : 1.5 * s);
      ctx.fillStyle = hexAlpha(c, 0.9);
      ctx.beginPath();
      ctx.ellipse(bx, by, 4.5 * s, 2.8 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // tail
      ctx.beginPath();
      ctx.moveTo(bx + 4 * s, by);
      ctx.lineTo(bx + 7 * s, by - 3 * s);
      ctx.lineTo(bx + 7 * s, by + 3 * s);
      ctx.closePath();
      ctx.fill();
      px(bx - 2 * s, by - 1 * s, 1.4 * s, 1.4 * s, '#050508');
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
      const y = h * 0.42 - Math.sin(u * Math.PI) * 8;

      ctx.save();
      ctx.fillStyle = '#f5c542';
      ctx.shadowColor = '#f5c542';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      bots[a.k].active = true;
      if (u > 0.5) bots[b.k].active = true;
    }

    function tick(ts) {
      if (!running) return;
      const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
      last = ts;
      tSec = ts / 1000;

      if (!reduced) {
        radarA += dt * 2.5;
        for (const k of ORDER) {
          const b = bots[k];
          b.bob += dt * (2.2 + b.home);
          b.x = lerp(b.x, b.home, 0.12);
          if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 1.1);
          if (b.action > 0) b.action = Math.max(0, b.action - dt * 0.7);
          if (b.speechT > 0) b.speechT -= dt * 1000;
        }
        if (coin) {
          coin.prog += dt * 0.7;
          if (coin.prog >= 1) {
            speak('executor', `$${coin.symbol}`, 2000);
            bots.executor.action = 1;
            bots.executor.flash = 1;
            coin = null;
          }
        }
      } else {
        for (const k of ORDER) {
          if (bots[k].speechT > 0) bots[k].speechT -= dt * 1000;
        }
      }

      drawStage();
      drawCoinDot();
      for (const k of ORDER) drawAgent(bots[k]);

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
