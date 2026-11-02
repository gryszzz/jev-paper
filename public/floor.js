/* JEV Trading Floor v12 — premium sprite bots, rAF, neon stage */
(function (global) {
  'use strict';

  const META = {
    scanner: { name: 'Scanner', color: '#5b8cff', src: '/img/bots/scanner.webp?v=12' },
    analyst: { name: 'Analyst', color: '#a78bfa', src: '/img/bots/analyst.webp?v=12' },
    risk: { name: 'Risk', color: '#ff9f0a', src: '/img/bots/risk.webp?v=12' },
    executor: { name: 'Executor', color: '#00FF66', src: '/img/bots/executor.webp?v=12' },
    whale: { name: 'Whale', color: '#22d3ee', src: '/img/bots/whale.webp?v=12' },
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
  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function createFloor(canvas) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { alpha: false });
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const sprites = {};
    const bots = {};
    ORDER.forEach((k, i) => {
      bots[k] = {
        key: k,
        home: 0.1 + i * 0.2,
        x: 0.1 + i * 0.2,
        y: 0.58,
        bob: Math.random() * Math.PI * 2,
        breath: Math.random() * Math.PI * 2,
        speech: '',
        speechT: 0,
        active: false,
        flash: 0,
        celebrate: 0,
        alert: 0,
        scale: 1,
        shake: 0,
      };
      const img = new Image();
      img.decoding = 'async';
      img.src = META[k].src;
      sprites[k] = img;
    });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let running = false;
    let tSec = 0;
    let radarA = 0;
    let periA = 0;
    let scoreRing = 0;
    let scoreVal = null;
    let scoreSym = '';
    let coin = null;
    let bursts = [];
    let pings = [];
    let ripples = [];
    let particles = [];
    let trails = [];
    let lastSig = '';
    let agentsSnap = {};
    let parallax = 0;

    // ambient particles
    for (let i = 0; i < 28; i++) {
      particles.push({
        x: Math.random(),
        y: Math.random() * 0.7,
        r: 0.6 + Math.random() * 1.6,
        sp: 0.02 + Math.random() * 0.06,
        a: 0.15 + Math.random() * 0.35,
        hue: Math.random(),
      });
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(280, rect.width || canvas.parentElement?.clientWidth || 400);
      const cssH = 230;
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
      b.speech = String(text).slice(0, 22);
      b.speechT = ms || 2800;
    }

    function burst(x, y, color, n) {
      for (let i = 0; i < (n || 12); i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 50 + Math.random() * 110;
        bursts.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 40,
          life: 0.55 + Math.random() * 0.4,
          age: 0,
          c: color,
          r: 2 + Math.random() * 3,
        });
      }
    }

    function startCoinPass(symbol) {
      coin = { prog: 0, symbol: symbol || '???', phase: 'hand' };
      speak('scanner', `PASS $${symbol || ''}`, 1800);
      bots.scanner.active = true;
    }

    function onState(state) {
      if (!state) return;
      const agents = state.agents || {};
      agentsSnap = agents;

      const lines = {
        scanner: (() => {
          const a = agents.scanner || {};
          const last = (a.recent || []).find((x) => x.ok) || (a.recent || [])[0];
          if (last) return `SCAN $${last.symbol}`;
          if (a.wsConnected || a.status === 'streaming') return `LIVE ${a.launches || a.pools || 0}`;
          return a.status === 'scanning' ? 'SCAN…' : '';
        })(),
        analyst: (() => {
          const a = agents.analyst || {};
          if (a.symbol != null && a.score != null) return `${a.score} $${a.symbol}`;
          return a.status === 'scoring' ? 'SCORE…' : '';
        })(),
        risk: (() => {
          const a = agents.risk || {};
          if (a.guarding) return `GUARD $${a.guarding}`;
          if (a.status === 'cooldown') return 'COOLDOWN';
          const la = a.lastAction;
          if (la && la.pnl != null) return la.pnl >= 0 ? `WIN +${Math.abs(la.pnl).toFixed(1)}` : `CUT $${la.symbol || ''}`;
          return '';
        })(),
        executor: (() => {
          const a = agents.executor || {};
          if (a.status === 'buying') return 'FIRING…';
          const f = a.lastFill;
          if (f) return `BUY $${f.symbol}`;
          return '';
        })(),
        whale: (() => {
          const a = agents.whale || {};
          if (a.lastAlert) return `ALERT $${a.lastAlert.symbol || ''}`.trim();
          if (a.watching) return `WATCH ${a.watching}`;
          return '';
        })(),
      };
      for (const k of ORDER) {
        if (lines[k]) speak(k, lines[k], 2600);
        bots[k].active = false;
        const a = agents[k] || {};
        if (a.flash) bots[k].flash = 1;
      }

      const an = agents.analyst || {};
      if (an.score != null) {
        scoreVal = an.score;
        scoreSym = an.symbol || '';
      }

      const sc = agents.scanner || {};
      if (sc.status === 'scanning' || sc.status === 'streaming') bots.scanner.active = true;
      if (an.status === 'scoring') bots.analyst.active = true;
      if ((agents.executor || {}).status === 'buying') bots.executor.active = true;
      if ((agents.whale || {}).watching) bots.whale.active = true;

      const act = (state.activity && state.activity[0]) || null;
      const sig = act ? `${act.ts}|${act.type}|${act.symbol}|${act.pnl}` : '';
      if (sig && sig !== lastSig) {
        lastSig = sig;
        const t = (act.type || '').toLowerCase();
        if (t === 'buy') {
          startCoinPass(act.symbol);
          speak('executor', `BUY $${act.symbol}`, 3200);
          bots.executor.flash = 1;
          bots.executor.active = true;
          bots.executor.celebrate = 1;
        } else if (act.pnl != null && (t === 'sell' || t === 'tp' || t === 'stopped')) {
          const bx = bots.risk.x * w;
          const by = bots.risk.y * h - 36;
          if (act.pnl >= 0) {
            burst(bx, by, '#00FF66', 18);
            speak('risk', `WIN +${Math.abs(act.pnl).toFixed(1)}`, 3200);
            bots.risk.celebrate = 1.2;
            bots.executor.celebrate = 0.9;
          } else {
            burst(bx, by, '#ff453a', 14);
            speak('risk', `CUT $${act.symbol || ''}`, 3200);
            bots.risk.alert = 1;
          }
        } else if (t === 'whale_exit' || (agents.whale && agents.whale.lastAlert)) {
          const wx = bots.whale.x * w;
          const wy = bots.whale.y * h - 40;
          ripples.push({ x: wx, y: wy, r: 4, life: 1 });
          ripples.push({ x: wx, y: wy, r: 2, life: 1.15 });
          speak(
            'whale',
            `ALERT $${(agents.whale.lastAlert && agents.whale.lastAlert.symbol) || act.symbol || ''}`,
            3500
          );
          bots.whale.flash = 1;
          bots.whale.alert = 1.2;
        }
      }

      if (an.status === 'passed' && an.symbol) {
        const passSig = `pass:${an.symbol}:${an.score}`;
        if (passSig !== bots._lastPass) {
          bots._lastPass = passSig;
          if (!coin) startCoinPass(an.symbol);
        }
      }

      if (sc.status === 'scanning' || sc.status === 'streaming' || sc.flash) {
        if (pings.length < 7 && Math.random() < 0.4) {
          pings.push({
            x: bots.scanner.x * w + (Math.random() - 0.5) * 50,
            y: bots.scanner.y * h - 55 - Math.random() * 35,
            life: 1,
          });
        }
      }
    }

    function softOrb(x, y, r, c) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawStage() {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#04040a');
      g.addColorStop(0.45, '#080812');
      g.addColorStop(1, '#030308');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // parallax neon orbs
      const px = Math.sin(parallax) * 8;
      softOrb(w * 0.12 + px, h * 0.28, 78, 'rgba(91,140,255,0.14)');
      softOrb(w * 0.5 - px * 0.5, h * 0.18, 90, 'rgba(0,255,102,0.07)');
      softOrb(w * 0.88 - px, h * 0.32, 72, 'rgba(34,211,238,0.12)');
      softOrb(w * 0.72 + px * 0.3, h * 0.2, 50, 'rgba(167,139,250,0.1)');

      // perspective grid floor
      const horizon = h * 0.52;
      const floorY = h * 0.82;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, horizon, w, h - horizon);
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,255,102,0.08)';
      ctx.lineWidth = 1;
      const vanishX = w * 0.5 + Math.sin(parallax * 0.4) * 12;
      for (let i = -6; i <= 6; i++) {
        const x0 = vanishX + i * 28;
        ctx.beginPath();
        ctx.moveTo(vanishX, horizon);
        ctx.lineTo(x0 + i * 40, h + 10);
        ctx.stroke();
      }
      for (let j = 0; j < 8; j++) {
        const t = j / 8;
        const y = horizon + Math.pow(t, 1.6) * (h - horizon);
        const alpha = 0.04 + t * 0.1;
        ctx.strokeStyle = `rgba(91,140,255,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.restore();

      // neon stage strip
      const stageY = floorY;
      const neon = ctx.createLinearGradient(0, stageY, w, stageY);
      neon.addColorStop(0, 'rgba(91,140,255,0)');
      neon.addColorStop(0.18, 'rgba(91,140,255,0.65)');
      neon.addColorStop(0.5, 'rgba(0,255,102,0.85)');
      neon.addColorStop(0.82, 'rgba(34,211,238,0.65)');
      neon.addColorStop(1, 'rgba(34,211,238,0)');
      ctx.strokeStyle = neon;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(0,255,102,0.45)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(6, stageY);
      ctx.lineTo(w - 6, stageY);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ambient dust
      if (!reduced) {
        for (const p of particles) {
          const hx = p.hue;
          const col =
            hx < 0.33
              ? '91,140,255'
              : hx < 0.66
                ? '0,255,102'
                : '34,211,238';
          ctx.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(tSec * 2 + p.x * 10));
          ctx.fillStyle = `rgb(${col})`;
          ctx.beginPath();
          ctx.arc(((p.x + parallax * 0.02) % 1) * w, p.y * h, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    function drawSpriteBot(b, dt) {
      const meta = META[b.key];
      const img = sprites[b.key];
      const ready = img && img.complete && img.naturalWidth > 0;

      // motion
      const bob = reduced ? 0 : Math.sin(b.bob) * 3.2;
      const breath = reduced ? 1 : 1 + Math.sin(b.breath) * 0.018;
      let shakeX = 0;
      if (b.alert > 0 && !reduced) {
        shakeX = Math.sin(tSec * 48) * 3.5 * b.alert;
      }
      const celeb = b.celebrate > 0 && !reduced ? easeOutBack(clamp(1 - b.celebrate, 0, 1)) : 0;
      const jump = b.celebrate > 0 && !reduced ? Math.sin((1 - b.celebrate) * Math.PI) * 10 : 0;
      const scale = (b.active ? 1.05 : 1) * breath * (1 + (b.celebrate > 0 ? 0.08 * Math.sin((1 - b.celebrate) * Math.PI * 2) : 0));

      const x = b.x * w + shakeX;
      const y = b.y * h + bob - jump;
      const size = Math.min(96, w * 0.22) * scale;

      // soft contact shadow
      ctx.save();
      ctx.globalAlpha = 0.35 + (b.active ? 0.15 : 0);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(x, b.y * h + 42, size * 0.28, 5.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // ground rim glow
      const glowA = b.active || b.flash > 0 || b.celebrate > 0 ? 0.55 : 0.22;
      softOrb(x, b.y * h + 40, size * 0.42, hexAlpha(meta.color, glowA));

      // sprite
      ctx.save();
      ctx.translate(x, y);
      if (b.flash > 0) {
        ctx.shadowColor = meta.color;
        ctx.shadowBlur = 22;
      } else if (b.active) {
        ctx.shadowColor = meta.color;
        ctx.shadowBlur = 12;
      }

      if (ready) {
        ctx.drawImage(img, -size / 2, -size * 0.72, size, size);
      } else {
        // lightweight fallback silhouette while loading
        ctx.fillStyle = meta.color;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(0, -10, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // role FX overlays (radar beam, score ring, bolt spark, peri track)
      if (b.key === 'scanner' && !reduced) drawRadarOverlay(meta.color, size);
      if (b.key === 'analyst') drawScoreOverlay(meta.color, size);
      if (b.key === 'executor' && (b.active || b.celebrate > 0) && !reduced) drawBoltBurst(meta.color, size);
      if (b.key === 'whale' && !reduced) drawPeriTrack(meta.color, size);

      ctx.restore();

      // name label — floating, no box
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = meta.color;
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4;
      ctx.fillText(meta.name, x, b.y * h + 54);
      ctx.shadowBlur = 0;

      // speech bubble
      if (b.speech && b.speechT > 0) {
        b.speechT -= dt * 1000;
        const alpha = clamp(b.speechT / 400, 0, 1);
        ctx.globalAlpha = alpha;
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(b.speech).width;
        const bx = x;
        const by = y - size * 0.78;
        ctx.fillStyle = 'rgba(6,6,12,0.72)';
        roundRect(bx - tw / 2 - 7, by - 11, tw + 14, 17, 9);
        ctx.fill();
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = alpha * 0.9;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = alpha;
        ctx.fillText(b.speech, bx, by + 2);
        ctx.globalAlpha = 1;
      }

      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 1.15);
      if (b.celebrate > 0) b.celebrate = Math.max(0, b.celebrate - dt * 0.85);
      if (b.alert > 0) b.alert = Math.max(0, b.alert - dt * 0.9);
    }

    function hexAlpha(hex, a) {
      const n = hex.replace('#', '');
      const r = parseInt(n.slice(0, 2), 16);
      const g = parseInt(n.slice(2, 4), 16);
      const b = parseInt(n.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
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

    function drawRadarOverlay(c, size) {
      ctx.save();
      ctx.translate(0, -size * 0.55);
      ctx.rotate(radarA);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.28);
      rg.addColorStop(0, hexAlpha(c, 0.45));
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, size * 0.28, -0.35, 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawScoreOverlay(c, size) {
      ctx.save();
      ctx.translate(size * 0.38, -size * 0.15);
      ctx.strokeStyle = hexAlpha(c, 0.7);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 11, -Math.PI / 2, -Math.PI / 2 + scoreRing * Math.PI * 2);
      ctx.strokeStyle = '#00FF66';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      if (scoreVal != null) {
        ctx.fillStyle = '#fff';
        ctx.font = '800 8px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(scoreVal), 0, 3);
      }
      ctx.restore();
    }

    function drawBoltBurst(c, size) {
      ctx.save();
      ctx.translate(size * 0.12, -size * 0.55);
      ctx.shadowColor = c;
      ctx.shadowBlur = 14;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(2, -9);
      ctx.lineTo(-5, 1);
      ctx.lineTo(0, 1);
      ctx.lineTo(-3, 10);
      ctx.lineTo(6, -1);
      ctx.lineTo(1, -1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawPeriTrack(c, size) {
      ctx.save();
      ctx.translate(0, -size * 0.62);
      ctx.rotate(periA * 0.2);
      ctx.strokeStyle = hexAlpha(c, 0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.22, -0.8 + periA, 0.8 + periA);
      ctx.stroke();
      ctx.restore();
    }

    function drawCoinToken() {
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
      const y = lerp(bots[a.k].y, bots[b.k].y, u) * h - 48 - Math.sin(u * Math.PI) * 22;

      // trail sparkles
      if (!reduced && Math.random() < 0.7) {
        trails.push({
          x: x + (Math.random() - 0.5) * 6,
          y: y + (Math.random() - 0.5) * 6,
          life: 1,
          c: '#f5c542',
        });
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.shadowColor = '#f5c542';
      ctx.shadowBlur = 16;
      const grd = ctx.createRadialGradient(0, 0, 1, 0, 0, 9);
      grd.addColorStop(0, '#ffe08a');
      grd.addColorStop(1, '#d4a017');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5a4010';
      ctx.font = '800 9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('$', 0, 3.5);
      ctx.restore();

      bots[a.k].active = true;
      if (u > 0.45) bots[b.k].active = true;
    }

    function tick(ts) {
      if (!running) return;
      const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
      last = ts;
      tSec = ts / 1000;

      if (!reduced) {
        parallax += dt * 0.35;
        radarA += dt * 2.4;
        periA = Math.sin(ts / 850) * 0.55;
        scoreRing = scoreVal != null ? clamp(scoreVal / 100, 0, 1) : (scoreRing + dt * 0.15) % 1;

        for (const p of particles) {
          p.y -= p.sp * dt;
          if (p.y < -0.05) {
            p.y = 0.75;
            p.x = Math.random();
          }
        }

        for (const k of ORDER) {
          const b = bots[k];
          b.bob += dt * (2.1 + b.home);
          b.breath += dt * (1.4 + b.home * 0.5);
          if (k === 'scanner') {
            const patrol = Math.sin(ts / 1500) * 0.028;
            b.x = lerp(b.x, b.home + patrol, 0.07);
          } else if (k === 'executor' && ((agentsSnap.executor || {}).status === 'buying' || b.celebrate > 0)) {
            b.x = lerp(b.x, b.home + 0.015, 0.18);
          } else if (k === 'whale' && b.alert > 0) {
            b.x = lerp(b.x, b.home, 0.2);
          } else {
            b.x = lerp(b.x, b.home, 0.06);
          }
        }

        if (coin) {
          coin.prog += dt * 0.52;
          if (coin.prog >= 1) {
            const ex = bots.executor.x * w;
            const ey = bots.executor.y * h - 36;
            burst(ex, ey, '#00FF66', 16);
            speak('executor', `FILL $${coin.symbol}`, 2500);
            bots.executor.celebrate = 1;
            coin = null;
          }
        }
      }

      for (const p of pings) p.life -= dt * 1.25;
      pings = pings.filter((p) => p.life > 0);
      for (const r of ripples) {
        r.r += dt * 70;
        r.life -= dt * 0.85;
      }
      ripples = ripples.filter((r) => r.life > 0);
      for (const p of bursts) {
        p.age += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 130 * dt;
      }
      bursts = bursts.filter((p) => p.age < p.life);
      for (const t of trails) t.life -= dt * 2.2;
      trails = trails.filter((t) => t.life > 0);

      drawStage();

      for (const p of pings) {
        ctx.globalAlpha = p.life;
        ctx.strokeStyle = '#5b8cff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (1 - p.life) * 18 + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      for (const r of ripples) {
        ctx.globalAlpha = r.life * 0.9;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      for (const t of trails) {
        ctx.globalAlpha = t.life;
        ctx.fillStyle = t.c;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 2.2 * t.life, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      drawCoinToken();
      for (const k of ORDER) drawSpriteBot(bots[k], dt);

      for (const p of bursts) {
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * a, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.font = '800 9px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#4a4a55';
      ctx.textAlign = 'left';
      ctx.fillText('TRADING FLOOR', 10, 14);

      // reduced-motion: idle single frame path still draws sprites once per state
      if (reduced) {
        // slow refresh only
        raf = setTimeout(() => {
          raf = requestAnimationFrame(tick);
        }, 400);
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
