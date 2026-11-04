'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { PaperEngine } = require('./engine/paper');

const PORT = Number(process.env.PORT) || 3000;
const LIVE_ENABLED = process.env.LIVE_ENABLED === 'true'; // still forced paper in engine
const APP_PASSCODE = process.env.APP_PASSCODE || process.env.JEV_PASSCODE || '';
const SESSION_TTL_MS = 7 * 24 * 3600e3;

const app = express();
const engine = new PaperEngine();

/** @type {Map<string, number>} */
const sessions = new Map();

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Passcode gate is PAPER-open; only enforced when LIVE_ENABLED=true and APP_PASSCODE is set. */
function passcodeEnforced() {
  return LIVE_ENABLED && !!APP_PASSCODE;
}

function authRequired(req, res, next) {
  if (!passcodeEnforced()) return next();
  if (req.path === '/api/health' || req.path === '/api/auth/status' || req.path === '/api/auth/login') {
    return next();
  }
  if (!req.path.startsWith('/api/')) return next();
  const cookies = parseCookies(req);
  const token = cookies.jev_session || req.headers['x-jev-session'];
  const exp = token && sessions.get(token);
  if (exp && exp > Date.now()) return next();
  if (token) sessions.delete(token);
  return res.status(401).json({ error: 'auth_required', paper: false, mode: 'LIVE' });
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(authRequired);

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
        return;
      }
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return;
      }
      if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('manifest.json')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
      if (filePath.endsWith('manifest.json')) {
        res.setHeader('Content-Type', 'application/manifest+json');
      }
    },
  })
);

app.get('/api/health', (_req, res) => {
  try {
    // Never await engine.ready() here — Supabase cold start must not block Render health checks.
    if (!engine.state) {
      return res.status(503).json({
        ok: false,
        booting: true,
        paper: true,
        mode: 'PAPER',
        liveEnabled: false,
        envLiveFlag: LIVE_ENABLED,
        ts: Date.now(),
      });
    }
    const h = engine.health ? engine.health() : { ok: true, paper: true };
    const status = h.ok ? 200 : 503;
    res.status(status).json({
      ...h,
      envLiveFlag: LIVE_ENABLED,
      auth: passcodeEnforced(),
      authConfigured: !!APP_PASSCODE,
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, ts: Date.now() });
  }
});

app.get('/api/auth/status', (req, res) => {
  // PAPER mode: never require passcode. LIVE_ENABLED + APP_PASSCODE re-enables the gate.
  if (!passcodeEnforced()) return res.json({ required: false, ok: true, paper: true });
  const cookies = parseCookies(req);
  const token = cookies.jev_session || req.headers['x-jev-session'];
  const exp = token && sessions.get(token);
  res.json({ required: true, ok: !!(exp && exp > Date.now()), paper: false });
});

app.post('/api/auth/login', (req, res) => {
  if (!passcodeEnforced()) return res.json({ ok: true, required: false, paper: true });
  const pass = (req.body && req.body.passcode) || '';
  if (!timingSafeEqualStr(pass, APP_PASSCODE)) {
    return res.status(401).json({ ok: false, error: 'bad_passcode' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    'Set-Cookie',
    `jev_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  res.json({ ok: true, token });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.jev_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'jev_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/state', (_req, res) => {
  res.json(engine.snapshot());
});

app.get('/api/notifications', (_req, res) => {
  res.json({ items: engine.drainNotifications() });
});

app.get('/api/position/:id', (req, res) => {
  const pos = engine.getPosition(req.params.id);
  if (!pos) return res.status(404).json({ error: 'not found' });
  const whales = (engine.state.whaleWatch && engine.state.whaleWatch[pos.mint]) || null;
  res.json({ ...pos, whales });
});

app.post('/api/running', (req, res) => {
  engine.setRunning(!!(req.body && req.body.running));
  res.json(engine.snapshot());
});

app.post('/api/kill', (req, res) => {
  const on = req.body && req.body.kill != null ? !!req.body.kill : true;
  res.json(engine.setKillSwitch(on));
});

app.post('/api/settings', (req, res) => {
  res.json(engine.updateSettings(req.body || {}));
});

app.post('/api/reset', (req, res) => {
  const bal = req.body && req.body.startingBalance;
  res.json(engine.reset(bal));
});

app.get('/api/learning', (_req, res) => {
  res.json(engine.learningReport());
});

app.post('/api/learning/refit', async (req, res) => {
  try {
    const force = !(req.body && req.body.force === false);
    const report = await engine.forceRefit({ force });
    res.json(report);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stats', (_req, res) => {
  try {
    if (!engine.state) return res.status(503).json({ ok: false, booting: true });
    const snap = engine.snapshot ? engine.snapshot() : {};
    const inv = (engine.state && engine.state._wealthInvariant) || null;
    res.json({
      ok: true,
      paper: true,
      mode: 'PAPER',
      startingBalance: snap.startingBalance,
      cash: snap.cash,
      equity: snap.equity,
      realizedPnl: snap.stats && snap.stats.realizedPnl,
      dayRealizedPnl: snap.dayRealizedPnl,
      positions: Array.isArray(snap.positions) ? snap.positions.length : 0,
      tradeStats: snap.tradeStats || null,
      stats: snap.stats || null,
      wealthInvariant: inv,
      stateEpoch: snap.stateEpoch || null,
      solReserve: 0,
      ts: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

engine.start();

// Flush paper state on Render restart / deploy so the last fills hit Supabase
function _shutdownFlush(sig) {
  console.log(`[jev] ${sig} — flushing paper state`);
  try {
    const { flushPending } = require('./engine/store');
    const done = Promise.resolve(engine.persist ? engine.persist(true) : null).then(() => flushPending());
    done.finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  } catch (e) {
    console.warn('[jev] shutdown flush', e && e.message);
    process.exit(0);
  }
}
process.on('SIGTERM', () => _shutdownFlush('SIGTERM'));
process.on('SIGINT', () => _shutdownFlush('SIGINT'));


app.listen(PORT, '0.0.0.0', () => {
  console.log(`[jev] paper PWA on http://0.0.0.0:${PORT} · LIVE_ENABLED=${LIVE_ENABLED} (forced paper)`);
});

// Keep-alive self-ping — ONLY on free/sleeping plans.
// Render Starter ($7) and above stay up 24/7; self-ping wastes CPU. Tony on Starter 2026-11-02.
const RENDER_PLAN = (process.env.RENDER_SERVICE_PLAN || process.env.RENDER_PLAN || '').toLowerCase();
const PAID_RENDER =
  process.env.RENDER_KEEPALIVE === '0' ||
  process.env.DISABLE_KEEPALIVE === '1' ||
  /starter|standard|pro|0\.5c|1c-|2c-|4c-|8c-/.test(RENDER_PLAN);
const KEEPALIVE = PAID_RENDER ? null : (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL);
if (KEEPALIVE) {
  const base = KEEPALIVE.replace(/\/$/, '');
  console.log('[jev] keepalive enabled (free-tier) →', base);
  setInterval(() => {
    fetch(`${base}/api/health`).catch(() => {});
  }, 4 * 60e3);
} else {
  console.log('[jev] keepalive OFF (paid/Starter plan — no self-ping)');
}
