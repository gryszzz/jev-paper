'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { PaperEngine } = require('./engine/paper');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const engine = new PaperEngine();

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  },
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, paper: true, ts: Date.now() });
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
  res.json(pos);
});

app.post('/api/running', (req, res) => {
  engine.setRunning(!!(req.body && req.body.running));
  res.json(engine.snapshot());
});

app.post('/api/settings', (req, res) => {
  res.json(engine.updateSettings(req.body || {}));
});

app.post('/api/reset', (req, res) => {
  const bal = req.body && req.body.startingBalance;
  res.json(engine.reset(bal));
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

engine.start();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[jev] paper PWA on http://0.0.0.0:${PORT}`);
});
