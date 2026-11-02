/* JEV Trading Floor — single neon stage, rAF-driven, no agent card boxes */
(function (global) {
  'use strict';

  const META = {
    scanner: { name: 'Scanner', color: '#5b8cff' },
    analyst: { name: 'Analyst', color: '#a78bfa' },
    risk: { name: 'Risk', color: '#ff9f0a' },
    executor: { name: 'Executor', color: '#00FF66' },
    whale: { name: 'Whale', color: '#22d3ee' },
  };
  // Visual left→right story: scan → score → risk → exec → whale
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

  function createFloor(canvas) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    const bots = {};
    ORDER.forEach((k, i) => {
      bots[k] = {
        key: k,
        home: 0.12 + i * 0.19,
        x: 0.12 + i * 0.19,
        y: 0.62,
        bob: Math.random() * Math.PI * 2,
        speech: '',
        speechT: 0,
        active: false,
        flash: 0,
      };
    });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let running = false;
    let radarA = 0;
    let periA = 0;
    let scoreRing = 0;
    let scoreVal = null;
    let scoreSym = '';
    let coin = null; // { prog 0..1, symbol, phase }
    let bursts = [];
    let pings = [];
    let ripples = [];
    let lastSig = '';
    let agentsSnap = {};

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(280, rect.width || canvas.parentElement?.clientWidth || 400);
      const cssH = 200;
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
      for (let i = 0; i < (n || 10); i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * 90;
        bursts.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 30,
          life: 0.55 + Math.random() * 0.35,
          age: 0,
          c: color,
          r: 2 + Math.random() * 2.5,
        });
      }
    }

    function startCoinPass(symbol) {
      coin = { prog: 0, symbol: symbol || '???', phase: 'hand' };
      speak('scanner', `PASS $${symbol || ''}`, 1800);
    }

    function onState(state) {
      if (!state) return;
      const agents = state.agents || {};
      agentsSnap = agents;

      // speech from live agent lines
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

      // Event signatures → animations
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
        } else if (act.pnl != null && (t === 'sell' || t === 'tp' || t === 'stopped')) {
          const bx = bots.risk.x * w;
          const by = bots.risk.y * h - 20;
          if (act.pnl >= 0) {
            burst(bx, by, '#00FF66', 16);
            speak('risk', `WIN +${Math.abs(act.pnl).toFixed(1)}`, 3200);
          } else {
            burst(bx, by, '#ff453a', 12);
            speak('risk', `CUT $${act.symbol || ''}`, 3200);
          }
        } else if (t === 'whale_exit' || (agents.whale && agents.whale.lastAlert)) {
          const wx = bots.whale.x * w;
          const wy = bots.whale.y * h - 30;
          ripples.push({ x: wx, y: wy, r: 4, life: 1 });
          speak('whale', `ALERT $${(agents.whale.lastAlert && agents.whale.lastAlert.symbol) || act.symbol || ''}`, 3500);
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

      // scanner pings
      const sc = agents.scanner || {};
      if (sc.status === 'scanning' || sc.status === 'streaming' || sc.flash) {
        if (pings.length < 6 && Math.random() < 0.35) {
          pings.push({
            x: bots.scanner.x * w + (Math.random() - 0.5) * 40,
            y: bots.scanner.y * h - 40 - Math.random() * 30,
            life: 1,
          });
        }
      }
    }

    function drawStage() {
      // floor
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#050508');
      g.addColorStop(0.55, '#0a0a10');
      g.addColorStop(1, '#06060a');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // neon stage strip
      const stageY = h * 0.78;
      ctx.fillStyle = 'rgba(0,255,102,0.04)';
      ctx.fillRect(0, stageY - 8, w, 28);
      const neon = ctx.createLinearGradient(0, stageY, w, stageY);
      neon.addColorStop(0, 'rgba(91,140,255,0)');
      neon.addColorStop(0.2, 'rgba(91,140,255,0.55)');
      neon.addColorStop(0.5, 'rgba(0,255,102,0.7)');
      neon.addColorStop(0.8, 'rgba(167,139,250,0.55)');
      neon.addColorStop(1, 'rgba(34,211,238,0)');
      ctx.strokeStyle = neon;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(8, stageY);
      ctx.lineTo(w - 8, stageY);
      ctx.stroke();

      // soft vignette orbs
      softOrb(w * 0.15, h * 0.3, 70, 'rgba(91,140,255,0.12)');
      softOrb(w * 0.5, h * 0.25, 80, 'rgba(0,255,102,0.08)');
      softOrb(w * 0.85, h * 0.35, 70, 'rgba(34,211,238,0.1)');
    }

    function softOrb(x, y, r, c) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawBot(b, dt) {
      const meta = META[b.key];
      const x = b.x * w;
      const bob = reduced ? 0 : Math.sin(b.bob) * 3;
      const y = b.y * h + bob;
      const glow = b.active || b.flash > 0 ? 1 : 0.35;

      // ground glow
      const gg = ctx.createRadialGradient(x, y + 18, 2, x, y + 18, 28);
      gg.addColorStop(0, meta.color + Math.round(glow * 90).toString(16).padStart(2, '0'));
      gg.addColorStop(1, 'transparent');
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.ellipse(x, y + 18, 22, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      // body (higher-detail mini character)
      ctx.save();
      ctx.translate(x, y);
      if (b.flash > 0) {
        ctx.shadowColor = meta.color;
        ctx.shadowBlur = 16;
      }

      // legs
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      const leg = reduced ? 0 : Math.sin(b.bob * 2) * 3;
      ctx.beginPath();
      ctx.moveTo(-4, 8);
      ctx.lineTo(-5 - leg * 0.3, 16);
      ctx.moveTo(4, 8);
      ctx.lineTo(5 + leg * 0.3, 16);
      ctx.stroke();

      // torso
      const tg = ctx.createLinearGradient(-10, -6, 10, 12);
      tg.addColorStop(0, '#1a1a24');
      tg.addColorStop(1, '#0d0d14');
      ctx.fillStyle = tg;
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.6;
      roundRect(-9, -4, 18, 14, 4);
      ctx.fill();
      ctx.stroke();

      // arms
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(-14, 4 + (b.key === 'executor' && b.active ? -4 : 0));
      ctx.moveTo(9, 0);
      ctx.lineTo(14, 4);
      ctx.stroke();

      // head
      const hg = ctx.createLinearGradient(-8, -22, 8, -6);
      hg.addColorStop(0, '#222230');
      hg.addColorStop(1, '#12121a');
      ctx.fillStyle = hg;
      roundRect(-8, -20, 16, 14, 5);
      ctx.fill();
      ctx.stroke();

      // eyes
      const blink = !reduced && Math.sin(b.bob * 0.5 + b.home * 10) > 0.97;
      ctx.fillStyle = meta.color;
      if (!blink) {
        ctx.beginPath();
        ctx.arc(-3, -13, 1.6, 0, Math.PI * 2);
        ctx.arc(3, -13, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(-2.5, -13.5, 0.5, 0, Math.PI * 2);
        ctx.arc(3.5, -13.5, 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-5, -13);
        ctx.lineTo(-1, -13);
        ctx.moveTo(1, -13);
        ctx.lineTo(5, -13);
        ctx.stroke();
      }

      // role props
      if (b.key === 'scanner') drawRadarProp(meta.color);
      if (b.key === 'analyst') drawAnalystProp(meta.color);
      if (b.key === 'risk') drawShieldProp(meta.color, agentsSnap.risk);
      if (b.key === 'executor') drawBoltProp(meta.color, b.active);
      if (b.key === 'whale') drawPeriscope(meta.color);

      ctx.restore();

      // name label (no box)
      ctx.font = '800 9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = meta.color;
      ctx.globalAlpha = 0.95;
      ctx.fillText(meta.name, x, y + 28);
      ctx.globalAlpha = 1;

      // speech bubble float
      if (b.speech && b.speechT > 0) {
        b.speechT -= dt * 1000;
        const alpha = clamp(b.speechT / 400, 0, 1);
        ctx.globalAlpha = alpha;
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(b.speech).width;
        const bx = x;
        const by = y - 34;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        roundRect(bx - tw / 2 - 6, by - 10, tw + 12, 16, 8);
        ctx.fill();
        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = meta.color;
        ctx.fillText(b.speech, bx, by + 2);
        ctx.globalAlpha = 1;
      }

      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 1.2);
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

    function drawRadarProp(c) {
      ctx.save();
      ctx.translate(0, -26);
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.save();
      ctx.rotate(radarA);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, 10);
      rg.addColorStop(0, c + 'aa');
      rg.addColorStop(1, 'transparent');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 10, -0.4, 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.restore();
    }

    function drawAnalystProp(c) {
      ctx.save();
      ctx.translate(14, -8);
      // floating coin + score ring
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 8, -Math.PI / 2, -Math.PI / 2 + scoreRing * Math.PI * 2);
      ctx.strokeStyle = '#00FF66';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#f5c542';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      if (scoreVal != null) {
        ctx.fillStyle = '#fff';
        ctx.font = '800 7px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(scoreVal), 0, 2.5);
      }
      ctx.restore();
    }

    function drawShieldProp(c, risk) {
      ctx.save();
      ctx.translate(-14, -6);
      const ok = !(risk && (risk.flash === 'loss' || risk.flash === 'block' || risk.status === 'cooldown'));
      ctx.fillStyle = ok ? 'rgba(0,255,102,0.2)' : 'rgba(255,69,58,0.25)';
      ctx.strokeStyle = ok ? '#00FF66' : '#ff453a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(7, -5);
      ctx.lineTo(7, 2);
      ctx.lineTo(0, 8);
      ctx.lineTo(-7, 2);
      ctx.lineTo(-7, -5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    function drawBoltProp(c, active) {
      ctx.save();
      ctx.translate(12, -18);
      if (active) {
        ctx.shadowColor = c;
        ctx.shadowBlur = 12;
      }
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(2, -8);
      ctx.lineTo(-4, 0);
      ctx.lineTo(0, 0);
      ctx.lineTo(-2, 8);
      ctx.lineTo(5, -1);
      ctx.lineTo(1, -1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function drawPeriscope(c) {
      ctx.save();
      ctx.translate(0, -24);
      ctx.rotate(periA * 0.15);
      ctx.strokeStyle = c;
      ctx.fillStyle = '#0e1a1f';
      ctx.lineWidth = 1.3;
      roundRect(-6, -6, 14, 8, 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(8, -2);
      ctx.lineTo(14, -2);
      ctx.lineTo(14, 2);
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(14, -2, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function drawCoinToken() {
      if (!coin) return;
      // path: scanner → analyst → risk → executor
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
      const y = lerp(bots[a.k].y, bots[b.k].y, u) * h - 28 - Math.sin(u * Math.PI) * 18;

      ctx.save();
      ctx.translate(x, y);
      ctx.shadowColor = '#f5c542';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#f5c542';
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7a5a10';
      ctx.font = '800 8px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('$', 0, 3);
      ctx.restore();

      // highlight active bots on path
      bots[a.k].active = true;
      if (u > 0.5) bots[b.k].active = true;
    }

    function tick(ts) {
      if (!running) return;
      const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
      last = ts;

      if (!reduced) {
        radarA += dt * 2.2;
        periA = Math.sin(ts / 900) * 0.5;
        scoreRing = scoreVal != null ? clamp(scoreVal / 100, 0, 1) : (scoreRing + dt * 0.15) % 1;

        // patrol / idle motion
        for (const k of ORDER) {
          const b = bots[k];
          b.bob += dt * (2.2 + b.home);
          if (k === 'scanner') {
            const patrol = Math.sin(ts / 1400) * 0.03;
            b.x = lerp(b.x, b.home + (reduced ? 0 : patrol), 0.08);
          } else if (k === 'executor' && (agentsSnap.executor || {}).status === 'buying') {
            b.x = lerp(b.x, b.home + 0.02, 0.2);
          } else {
            b.x = lerp(b.x, b.home, 0.06);
          }
        }

        if (coin) {
          coin.prog += dt * 0.55;
          if (coin.prog >= 1) {
            const ex = bots.executor.x * w;
            const ey = bots.executor.y * h - 20;
            burst(ex, ey, '#00FF66', 14);
            speak('executor', `FILL $${coin.symbol}`, 2500);
            coin = null;
          }
        }
      }

      // particles
      for (const p of pings) p.life -= dt * 1.2;
      pings = pings.filter((p) => p.life > 0);
      for (const r of ripples) {
        r.r += dt * 60;
        r.life -= dt * 0.9;
      }
      ripples = ripples.filter((r) => r.life > 0);
      for (const p of bursts) {
        p.age += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 120 * dt;
      }
      bursts = bursts.filter((p) => p.age < p.life);

      drawStage();

      // pings
      for (const p of pings) {
        ctx.globalAlpha = p.life;
        ctx.strokeStyle = '#5b8cff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (1 - p.life) * 16 + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      for (const r of ripples) {
        ctx.globalAlpha = r.life;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      drawCoinToken();
      for (const k of ORDER) drawBot(bots[k], dt);

      for (const p of bursts) {
        const a = 1 - p.age / p.life;
        ctx.globalAlpha = a;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * a, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // FLOOR label
      ctx.font = '800 9px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#555';
      ctx.textAlign = 'left';
      ctx.fillText('TRADING FLOOR', 10, 14);

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
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    }

    return { start, stop, resize, onState, startCoinPass };
  }

  global.JevFloor = { createFloor };
})(window);
