/* JEV Trading Floor v19 — crisp vector agents + state FX (no cards/rings) */
(function (global) {
  'use strict';

  const META = {
    scanner: { name: 'Scanner', color: '#5b8cff', accent: '#9ec1ff' },
    analyst: { name: 'Analyst', color: '#a78bfa', accent: '#ddd6fe' },
    risk: { name: 'Risk', color: '#ff9f0a', accent: '#ffd28a' },
    executor: { name: 'Executor', color: '#00FF66', accent: '#9affc0' },
    whale: { name: 'Whale', color: '#22d3ee', accent: '#a5f3fc' },
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
      // inset so edge FX (radar/ripple/companion) don't clip on ~390px
      const home = 0.12 + (i * 0.76) / (ORDER.length - 1);
      bots[k] = {
        key: k,
        home,
        x: home,
        bob: Math.random() * Math.PI * 2,
        speech: '',
        speechT: 0,
        active: false,
        flash: 0,
        action: 0,
        fx: null, // { kind, t, life, side?, score? }
        ping: 0,
        radarOn: false,
      };
    });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let running = false;
    let tSec = 0;
    let coin = null; // flip coin on buy path
    let lastSig = '';
    let lastScanSym = '';
    let lastRiskFlash = '';
    let radarA = 0;
    const fxPool = []; // lightweight world FX {x,y,kind,t,life,color}

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(280, rect.width || canvas.parentElement?.clientWidth || 400);
      const cssH = 118;
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

    function triggerFx(key, kind, extra) {
      const b = bots[key];
      if (!b) return;
      b.fx = Object.assign({ kind, t: 0, life: 0.9 }, extra || {});
      b.action = 1;
      b.flash = 1;
      b.active = true;
    }

    function startCoinPass(symbol) {
      coin = { prog: 0, symbol: symbol || '???', spin: 0 };
      speak('scanner', `$${symbol || ''}`, 1600);
      bots.scanner.active = true;
      bots.scanner.action = 1;
      bots.scanner.ping = 1;
      triggerFx('scanner', 'ping');
    }

    function onState(state) {
      if (!state) return;
      const agents = state.agents || {};

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
          if (a.flash === 'block' || a.guarding) return 'block';
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
        bots[k].radarOn = false;
      }

      const sc = agents.scanner || {};
      const an = agents.analyst || {};
      const rk = agents.risk || {};
      const ex = agents.executor || {};
      const wh = agents.whale || {};

      if (sc.status === 'scanning' || sc.status === 'streaming') {
        bots.scanner.active = true;
        bots.scanner.radarOn = true;
        bots.scanner.action = Math.max(bots.scanner.action, 0.45);
      }
      // ping when a new coin appears in recent
      const newest = (sc.recent || []).find((x) => x && x.symbol) || null;
      if (newest && newest.symbol && newest.symbol !== lastScanSym) {
        lastScanSym = newest.symbol;
        bots.scanner.ping = 1;
        triggerFx('scanner', 'ping');
        speak('scanner', `$${newest.symbol}`, 1800);
      }

      if (an.status === 'scoring') {
        bots.analyst.active = true;
        bots.analyst.action = Math.max(bots.analyst.action, 0.55);
        if (!bots.analyst.fx || bots.analyst.fx.kind !== 'glyphs') {
          triggerFx('analyst', 'glyphs', { life: 1.1 });
        }
      }
      if (an.status === 'passed' && an.symbol && an.score != null) {
        const passSig = `pass:${an.symbol}:${an.score}`;
        if (passSig !== bots._lastPass) {
          bots._lastPass = passSig;
          triggerFx('analyst', 'score', { score: an.score, life: 1.2 });
          speak('analyst', String(an.score), 2400);
          if (!coin) startCoinPass(an.symbol);
        }
      }

      // Risk shield on block/veto flash from engine
      if (rk.flash === 'block' || rk.flash === 'veto' || rk.guarding) {
        const sig = `risk:${rk.flash}:${rk.lastRun || 0}:${rk.guarding || ''}`;
        if (sig !== lastRiskFlash) {
          lastRiskFlash = sig;
          triggerFx('risk', 'shield', { life: 1.0 });
          speak('risk', 'block', 2200);
        }
        bots.risk.active = true;
      }
      if (rk.status === 'cooldown') bots.risk.active = true;

      if (ex.status === 'buying') {
        bots.executor.active = true;
        bots.executor.action = 1;
        bots.executor.flash = 1;
        if (!bots.executor.fx || bots.executor.fx.kind !== 'zap') {
          triggerFx('executor', 'zap', { side: 'buy', life: 0.85 });
        }
      }

      if (wh.watching) bots.whale.active = true;
      if (wh.lastAlert || wh.flash === 'alert' || wh.flash === 'pulse') {
        bots.whale.active = true;
        if (wh.lastAlert) {
          const wsig = `wh:${typeof wh.lastAlert === 'object' ? wh.lastAlert.ts || wh.lastAlert.symbol : wh.lastAlert}:${wh.lastRun || 0}`;
          if (wsig !== bots._lastWhale) {
            bots._lastWhale = wsig;
            triggerFx('whale', 'ripple', { life: 1.15 });
            speak('whale', 'sell', 3000);
          }
        }
      }

      const act = (state.activity && state.activity[0]) || null;
      const sig = act ? `${act.ts}|${act.type}|${act.symbol}|${act.pnl}` : '';
      if (sig && sig !== lastSig) {
        lastSig = sig;
        const t = (act.type || '').toLowerCase();
        if (t === 'buy') {
          startCoinPass(act.symbol);
          speak('executor', `$${act.symbol}`, 2800);
          triggerFx('executor', 'zap', { side: 'buy', life: 0.9 });
        } else if (t === 'sell' || t === 'tp' || t === 'stopped' || t === 'dust' || t === 'time') {
          const side = (act.pnl != null && act.pnl >= 0) ? 'buy' : 'sell';
          // sell → red zap; winning sell still green-ish for executor
          triggerFx('executor', 'zap', { side: act.pnl != null && act.pnl < 0 ? 'sell' : 'buy', life: 0.9 });
          if (act.pnl != null && act.pnl >= 0) {
            speak('risk', `+${Math.abs(act.pnl).toFixed(1)}`, 2800);
            bots.risk.action = 1;
            bots.risk.flash = 1;
          } else {
            speak('risk', 'cut', 2400);
            bots.risk.action = 1;
            triggerFx('risk', 'shield', { life: 0.7 });
          }
          speak('executor', act.pnl != null && act.pnl < 0 ? 'sell' : 'tp', 2000);
        } else if (t === 'whale_exit' || t === 'whale') {
          triggerFx('whale', 'ripple', { life: 1.2 });
          speak('whale', 'alert', 3000);
        } else if (t === 'risk' && /block|veto|cooldown|loss/i.test(act.detail || '')) {
          triggerFx('risk', 'shield', { life: 1.0 });
          speak('risk', 'block', 2200);
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

    /** Soft body shadow under feet — not a ring/card */
    function footGlow(x, groundY, c, intensity) {
      const gg = ctx.createRadialGradient(x, groundY + 2, 1, x, groundY + 2, 18);
      gg.addColorStop(0, hexAlpha(c, intensity));
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.ellipse(x, groundY + 2, 16, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    function bodyBase(s, c, opts) {
      const skin = opts.skin || '#1a1a24';
      const suit = opts.suit || '#12121a';
      const legSwing = opts.leg || 0;
      // legs
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1.5, 2.2 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-3.2 * s, -6 * s);
      ctx.lineTo(-4.2 * s - legSwing, 1.5 * s);
      ctx.moveTo(3.2 * s, -6 * s);
      ctx.lineTo(4.2 * s + legSwing, 1.5 * s);
      ctx.stroke();
      // boots
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.ellipse(-4.5 * s - legSwing, 2.2 * s, 3.2 * s, 1.4 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(4.5 * s + legSwing, 2.2 * s, 3.2 * s, 1.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      // torso (rounded)
      const tg = ctx.createLinearGradient(-8 * s, -22 * s, 8 * s, -4 * s);
      tg.addColorStop(0, suit);
      tg.addColorStop(1, '#0c0c12');
      ctx.fillStyle = tg;
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1, 1.4 * s);
      roundRect(-7.5 * s, -20 * s, 15 * s, 14 * s, 4 * s);
      ctx.fill();
      ctx.stroke();
      // chest accent stripe
      ctx.fillStyle = hexAlpha(c, 0.35);
      roundRect(-5 * s, -17 * s, 10 * s, 2.2 * s, 1 * s);
      ctx.fill();
      // head
      const hg = ctx.createLinearGradient(-7 * s, -32 * s, 7 * s, -18 * s);
      hg.addColorStop(0, '#222230');
      hg.addColorStop(1, skin);
      ctx.fillStyle = hg;
      ctx.strokeStyle = c;
      roundRect(-7 * s, -31 * s, 14 * s, 12 * s, 5 * s);
      ctx.fill();
      ctx.stroke();
    }

    function drawEyes(s, c, opts) {
      const blink = opts.blink;
      const glow = opts.glow || 0;
      const open = !blink;
      if (open) {
        if (glow > 0) {
          ctx.shadowColor = c;
          ctx.shadowBlur = 6 * glow;
        }
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(-2.8 * s, -25 * s, 1.7 * s, 0, Math.PI * 2);
        ctx.arc(2.8 * s, -25 * s, 1.7 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-2.3 * s, -25.4 * s, 0.6 * s, 0, Math.PI * 2);
        ctx.arc(3.3 * s, -25.4 * s, 0.6 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = c;
        ctx.lineWidth = Math.max(1, 1.3 * s);
        ctx.beginPath();
        ctx.moveTo(-4.2 * s, -25 * s);
        ctx.lineTo(-1.4 * s, -25 * s);
        ctx.moveTo(1.4 * s, -25 * s);
        ctx.lineTo(4.2 * s, -25 * s);
        ctx.stroke();
      }
    }

    function drawScanner(b, s, act) {
      const c = META.scanner.color;
      bodyBase(s, c, { suit: '#0d1528', leg: Math.sin(b.bob * 2) * 1.1 * s });
      // visor band
      ctx.fillStyle = hexAlpha(c, 0.55);
      roundRect(-6.5 * s, -27.5 * s, 13 * s, 4 * s, 1.5 * s);
      ctx.fill();
      drawEyes(s, c, { blink: false, glow: b.radarOn ? 0.6 : 0.2 });
      // dish antenna
      ctx.save();
      ctx.translate(0, -34 * s);
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1.2, 1.6 * s);
      ctx.beginPath();
      ctx.moveTo(0, 3 * s);
      ctx.lineTo(0, 0);
      ctx.stroke();
      const spin = b.radarOn && !reduced ? radarA : 0.4;
      ctx.rotate(spin);
      // dish
      ctx.fillStyle = hexAlpha(c, 0.25);
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.ellipse(0, -1 * s, 7 * s, 3.5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (b.radarOn && !reduced) {
        ctx.fillStyle = hexAlpha(c, 0.28);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 11 * s, -0.35, 0.35);
        ctx.closePath();
        ctx.fill();
        // sweep arcs
        ctx.strokeStyle = hexAlpha(c, 0.45);
        ctx.beginPath();
        ctx.arc(0, 0, 9 * s, -0.9, 0.9);
        ctx.stroke();
      }
      ctx.restore();
      // ping rings
      if (b.ping > 0 && !reduced) {
        const p = 1 - b.ping;
        ctx.strokeStyle = hexAlpha(c, b.ping * 0.7);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, -20 * s, 10 * s + p * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -20 * s, 6 * s + p * 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      // handheld scanner pad
      ctx.fillStyle = '#0a1220';
      ctx.strokeStyle = c;
      ctx.lineWidth = 1;
      roundRect(8 * s, -16 * s - act * 2 * s, 7 * s, 9 * s, 1.5 * s);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = hexAlpha(c, 0.8);
      ctx.fillRect(9.5 * s, -14 * s - act * 2 * s, 4 * s, 1.2 * s);
      ctx.fillRect(9.5 * s, -11.5 * s - act * 2 * s, 3 * s, 1.2 * s);
    }

    function drawAnalyst(b, s, act) {
      const c = META.analyst.color;
      bodyBase(s, c, { suit: '#161022', leg: Math.sin(b.bob * 2) * 0.8 * s });
      // hair / crown ridge
      ctx.fillStyle = '#2a1f3d';
      ctx.beginPath();
      ctx.moveTo(-7 * s, -29 * s);
      ctx.quadraticCurveTo(0, -36 * s - act * s, 7 * s, -29 * s);
      ctx.lineTo(7 * s, -28 * s);
      ctx.lineTo(-7 * s, -28 * s);
      ctx.fill();
      // glasses
      ctx.strokeStyle = c;
      ctx.lineWidth = Math.max(1.2, 1.5 * s);
      ctx.strokeRect(-5.5 * s, -26.5 * s, 4.8 * s, 4 * s);
      ctx.strokeRect(0.7 * s, -26.5 * s, 4.8 * s, 4 * s);
      ctx.beginPath();
      ctx.moveTo(-0.7 * s, -24.5 * s);
      ctx.lineTo(0.7 * s, -24.5 * s);
      ctx.stroke();
      const eyeGlow = (b.fx && b.fx.kind === 'glyphs') || b.active ? 1 : 0.15;
      drawEyes(s, c, { blink: Math.sin(b.bob * 0.55) > 0.94, glow: eyeGlow });
      // floating data glyphs
      if (((b.fx && b.fx.kind === 'glyphs') || b.active) && !reduced) {
        const glyphs = ['∑', 'Δ', 'λ', '¥', '#', '∞'];
        ctx.font = `700 ${Math.max(7, 8 * s)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        for (let i = 0; i < 5; i++) {
          const a = tSec * 2.2 + i * 1.1;
          const gx = Math.cos(a) * (12 + i) * s;
          const gy = -22 * s + Math.sin(a * 1.3) * 8 * s - act * 3 * s;
          ctx.globalAlpha = 0.35 + 0.45 * Math.abs(Math.sin(a));
          ctx.fillStyle = META.analyst.accent;
          ctx.fillText(glyphs[i % glyphs.length], gx, gy);
        }
        ctx.globalAlpha = 1;
      }
      // tablet
      ctx.fillStyle = '#120c1c';
      ctx.strokeStyle = c;
      roundRect(-12 * s - act * s, -15 * s, 8 * s, 10 * s, 1.5 * s);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = hexAlpha(c, 0.9);
      ctx.beginPath();
      ctx.moveTo(-10.5 * s - act * s, -8 * s);
      ctx.lineTo(-9 * s - act * s, -12 * s);
      ctx.lineTo(-7.5 * s - act * s, -9 * s);
      ctx.lineTo(-5.5 * s - act * s, -13 * s);
      ctx.stroke();
      // score popup
      if (b.fx && b.fx.kind === 'score' && b.fx.score != null) {
        const u = clamp(b.fx.t / b.fx.life, 0, 1);
        const rise = easeOut(u) * 14;
        ctx.globalAlpha = 1 - u;
        ctx.font = `800 ${Math.max(10, 12 * s)}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = META.analyst.accent;
        ctx.textAlign = 'center';
        ctx.fillText(String(b.fx.score), 0, -38 * s - rise);
        ctx.globalAlpha = 1;
      }
    }

    function drawRisk(b, s, act) {
      const c = META.risk.color;
      bodyBase(s, c, { suit: '#1a1208', leg: Math.sin(b.bob * 2) * 0.7 * s });
      // helm crest
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(-2 * s, -32 * s);
      ctx.lineTo(0, -37 * s - act * s);
      ctx.lineTo(2 * s, -32 * s);
      ctx.closePath();
      ctx.fill();
      drawEyes(s, c, { blink: Math.sin(b.bob * 0.5 + 1) > 0.95, glow: b.fx && b.fx.kind === 'shield' ? 1 : 0.2 });
      // kite shield
      const ox = -11 * s - act * 1.5 * s;
      const oy = -14 * s;
      const flash = b.fx && b.fx.kind === 'shield' ? (1 - b.fx.t / b.fx.life) : 0;
      ctx.save();
      if (flash > 0) {
        ctx.shadowColor = c;
        ctx.shadowBlur = 14 * flash;
      }
      ctx.fillStyle = hexAlpha(c, 0.22 + flash * 0.45);
      ctx.strokeStyle = flash > 0.2 ? META.risk.accent : c;
      ctx.lineWidth = Math.max(1.4, 1.8 * s);
      ctx.beginPath();
      ctx.moveTo(ox, oy - 9 * s);
      ctx.quadraticCurveTo(ox + 7 * s, oy - 7 * s, ox + 7 * s, oy);
      ctx.quadraticCurveTo(ox + 7 * s, oy + 7 * s, ox, oy + 10 * s);
      ctx.quadraticCurveTo(ox - 7 * s, oy + 7 * s, ox - 7 * s, oy);
      ctx.quadraticCurveTo(ox - 7 * s, oy - 7 * s, ox, oy - 9 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // shield emblem
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(ox, oy - 3 * s);
      ctx.lineTo(ox + 2.5 * s, oy);
      ctx.lineTo(ox, oy + 4 * s);
      ctx.lineTo(ox - 2.5 * s, oy);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // expanding shield ring on flash (no permanent ring)
      if (flash > 0 && !reduced) {
        ctx.strokeStyle = hexAlpha(c, flash * 0.65);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, -14 * s, 14 * s + (1 - flash) * 16, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    function drawExecutor(b, s, act) {
      const c = META.executor.color;
      bodyBase(s, c, { suit: '#07140c', leg: Math.sin(b.bob * 2) * 1.3 * s });
      // cap / visor peak
      ctx.fillStyle = '#0c1f14';
      ctx.strokeStyle = c;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-8 * s, -29 * s);
      ctx.lineTo(8 * s, -29 * s);
      ctx.lineTo(6 * s, -33 * s);
      ctx.lineTo(-6 * s, -33 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      drawEyes(s, c, { blink: Math.sin(b.bob * 0.6) > 0.93, glow: b.fx && b.fx.kind === 'zap' ? 1 : 0.25 });
      // bolt gauntlet
      const side = (b.fx && b.fx.side) || 'buy';
      const zapC = side === 'sell' ? '#ff4d6d' : c;
      ctx.save();
      ctx.translate(10 * s, -18 * s - act * 4 * s);
      if (b.fx && b.fx.kind === 'zap') {
        ctx.shadowColor = zapC;
        ctx.shadowBlur = 10;
      }
      ctx.fillStyle = zapC;
      ctx.beginPath();
      ctx.moveTo(2 * s, -7 * s);
      ctx.lineTo(-3.5 * s, 0.5 * s);
      ctx.lineTo(0.5 * s, 0.5 * s);
      ctx.lineTo(-2 * s, 8 * s);
      ctx.lineTo(4.5 * s, -1 * s);
      ctx.lineTo(1 * s, -1 * s);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // zap streaks
      if (b.fx && b.fx.kind === 'zap' && !reduced) {
        const u = b.fx.t / b.fx.life;
        ctx.strokeStyle = hexAlpha(zapC, 1 - u);
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i++) {
          const ang = -1.2 + i * 0.5 + u;
          ctx.beginPath();
          ctx.moveTo(8 * s, -22 * s);
          ctx.lineTo(8 * s + Math.cos(ang) * 16 * s, -22 * s + Math.sin(ang) * 10 * s);
          ctx.stroke();
        }
      }
    }

    function drawWhale(b, s, act) {
      const c = META.whale.color;
      bodyBase(s, c, { suit: '#06161a', leg: Math.sin(b.bob * 2) * 0.9 * s });
      // hood / dorsal
      ctx.fillStyle = '#0a2228';
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.moveTo(-7 * s, -28 * s);
      ctx.quadraticCurveTo(0, -38 * s, 7 * s, -28 * s);
      ctx.lineTo(5 * s, -28 * s);
      ctx.quadraticCurveTo(0, -34 * s, -5 * s, -28 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // big single watching eye overlay (cyclops lens)
      const pulse = b.fx && b.fx.kind === 'ripple' ? (1 - b.fx.t / b.fx.life) : (b.active ? 0.35 : 0);
      ctx.save();
      if (pulse > 0) {
        ctx.shadowColor = c;
        ctx.shadowBlur = 10 * pulse;
      }
      ctx.fillStyle = '#041014';
      ctx.beginPath();
      ctx.ellipse(0, -24.5 * s, 5.5 * s, 4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(0, -24.5 * s, 2.4 * s + pulse * 0.6 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#041014';
      ctx.beginPath();
      ctx.arc(0.5 * s, -24.5 * s, 1.1 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(-0.6 * s, -25.2 * s, 0.55 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // companion mini-whale (inward / left so right edge doesn't clip)
      const bx = -11 * s;
      const by = -12 * s + Math.sin(tSec * 2.4 + 1) * (reduced ? 0 : 1.8 * s);
      ctx.fillStyle = hexAlpha(c, 0.95);
      ctx.beginPath();
      ctx.ellipse(bx, by, 5 * s, 3 * s, -0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx - 4.5 * s, by);
      ctx.lineTo(bx - 8 * s, by - 3.2 * s);
      ctx.lineTo(bx - 7 * s, by + 3.2 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#041014';
      ctx.beginPath();
      ctx.arc(bx + 2 * s, by - 0.5 * s, 0.9 * s, 0, Math.PI * 2);
      ctx.fill();
      // ripple rings on whale sell
      if (b.fx && b.fx.kind === 'ripple' && !reduced) {
        const u = b.fx.t / b.fx.life;
        for (let i = 0; i < 3; i++) {
          const r = 8 * s + (u + i * 0.2) * 18;
          ctx.strokeStyle = hexAlpha(c, (1 - u) * (0.55 - i * 0.12));
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.ellipse(0, -8 * s, r, r * 0.35, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    function drawAgent(b) {
      const meta = META[b.key];
      const c = meta.color;
      const scale = Math.min(1.55, w / 260); // ~50–56px body, fits 5-up on mobile
      const bob = reduced ? 0 : Math.sin(b.bob) * 2.1;
      const x = b.x * w;
      const groundY = h * 0.72;
      const y = groundY + bob;
      const act = b.action > 0 && !reduced ? Math.sin((1 - b.action) * Math.PI) : 0;

      footGlow(x, groundY, c, b.active || b.flash > 0 ? 0.38 : 0.14);

      ctx.save();
      ctx.translate(x, y);
      if (b.flash > 0) {
        ctx.shadowColor = c;
        ctx.shadowBlur = 7;
      }

      if (b.key === 'scanner') drawScanner(b, scale, act);
      else if (b.key === 'analyst') drawAnalyst(b, scale, act);
      else if (b.key === 'risk') drawRisk(b, scale, act);
      else if (b.key === 'executor') drawExecutor(b, scale, act);
      else if (b.key === 'whale') drawWhale(b, scale, act);

      ctx.restore();

      // name under feet
      ctx.font = '700 8px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = c;
      ctx.fillText(meta.name, x, groundY + 14);

      if (b.speech && b.speechT > 0) {
        const alpha = clamp(b.speechT / 350, 0, 1);
        ctx.globalAlpha = alpha;
        ctx.font = '600 8px Inter, system-ui, sans-serif';
        const tw = Math.min(ctx.measureText(b.speech).width, w * 0.16);
        const pw = tw + 8;
        const px0 = x - pw / 2;
        const py = y - 56 * scale * 0.55;
        ctx.fillStyle = 'rgba(8,8,14,0.82)';
        roundRect(px0, py, pw, 13, 6);
        ctx.fill();
        ctx.fillStyle = '#eee';
        ctx.fillText(b.speech, x, py + 9.5);
        ctx.globalAlpha = 1;
      }
    }

    function drawCoinFlip() {
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
      const y = h * 0.40 - Math.sin(u * Math.PI) * 10;
      coin.spin += 0.35;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(coin.spin);
      const squash = Math.abs(Math.cos(coin.spin));
      ctx.scale(1, 0.35 + 0.65 * squash);
      ctx.fillStyle = '#f5c542';
      ctx.shadowColor = '#f5c542';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.ellipse(0, 0, 5, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8a6a12';
      ctx.font = '700 7px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowBlur = 0;
      ctx.fillText('$', 0, 0.5);
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
        radarA += dt * 2.6;
        for (const k of ORDER) {
          const b = bots[k];
          b.bob += dt * (2.1 + b.home * 0.4);
          b.x = lerp(b.x, b.home, 0.12);
          if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 1.15);
          if (b.action > 0) b.action = Math.max(0, b.action - dt * 0.7);
          if (b.speechT > 0) b.speechT -= dt * 1000;
          if (b.ping > 0) b.ping = Math.max(0, b.ping - dt * 1.4);
          if (b.fx) {
            b.fx.t += dt;
            if (b.fx.t >= b.fx.life) b.fx = null;
          }
        }
        if (coin) {
          coin.prog += dt * 0.72;
          if (coin.prog >= 1) {
            speak('executor', `$${coin.symbol}`, 2000);
            triggerFx('executor', 'zap', { side: 'buy', life: 0.8 });
            coin = null;
          }
        }
      } else {
        for (const k of ORDER) {
          if (bots[k].speechT > 0) bots[k].speechT -= dt * 1000;
        }
      }

      drawStage();
      drawCoinFlip();
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
