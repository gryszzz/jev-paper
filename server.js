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

function authRequired(req, res, next) {
  if (!APP_PASSCODE) return next(); // open if no passcode configured
  if (req.path === '/api/health' || req.path === '/api/auth/status' || req.path === '/api/auth/login') {
    return next();
  }
  if (!req.path.startsWith('/api/')) return next();
  const cookies = parseCookies(req);
  const token = cookies.jev_session || req.headers['x-jev-session'];
  const exp = token && sessions.get(token);
  if (exp && exp > Date.now()) return next();
  if (token) sessions.delete(token);
  return res.status(401).json({ error: 'auth_required', paper: true, mode: 'PAPER' });
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
  res.json({
    ok: true,
    paper: true,
    mode: 'PAPER',
    liveEnabled: false,
    envLiveFlag: LIVE_ENABLED,
    auth: !!APP_PASSCODE,
    ts: Date.now(),
  });
});

app.get('/api/auth/status', (req, res) => {
  if (!APP_PASSCODE) return res.json({ required: false, ok: true });
  const cookies = parseCookies(req);
  const token = cookies.jev_session || req.headers['x-jev-session'];
  const exp = token && sessions.get(token);
  res.json({ required: true, ok: !!(exp && exp > Date.now()) });
});

app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSCODE) return res.json({ ok: true, required: false });
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

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

engine.start();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[jev] paper PWA on http://0.0.0.0:${PORT} · LIVE_ENABLED=${LIVE_ENABLED} (forced paper)`);
});

// Keep-alive self-ping (Render free spin-down)
const KEEPALIVE = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
if (KEEPALIVE) {
  const base = KEEPALIVE.replace(/\/$/, '');
  setInterval(() => {
    fetch(`${base}/api/health`).catch(() => {});
  }, 4 * 60e3);
}
