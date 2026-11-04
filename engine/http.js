'use strict';

const cache = new Map();
const backoffUntil = new Map();
const hostBackoffUntil = new Map();

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return 'unknown'; }
}

function isBackingOff(key, url) {
  const now = Date.now();
  if ((backoffUntil.get(key) || 0) > now) return true;
  if (url && (hostBackoffUntil.get(hostOf(url)) || 0) > now) return true;
  return false;
}

async function fetchJson(url, opts = {}) {
  const {
    ttlMs = 10000,
    key = url,
    timeoutMs = 12000,
    method = 'GET',
    headers = {},
    body,
  } = opts;

  const now = Date.now();
  const host = hostOf(url);
  const until = Math.max(backoffUntil.get(key) || 0, hostBackoffUntil.get(host) || 0);
  if (now < until) {
    const hit = cache.get(key);
    if (hit) return hit.data;
    const err = new Error(`backoff ${key}`);
    err.code = 'BACKOFF';
    throw err;
  }

  if (method === 'GET' && ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'JEV-Paper/1.0',
        ...headers,
      },
      body,
    });
    if (res.status === 429 || res.status >= 500) {
      const cool = /dexscreener/i.test(host) ? 90000 : 30000;
      backoffUntil.set(key, Date.now() + cool);
      if (res.status === 429 && /dexscreener/i.test(host)) {
        hostBackoffUntil.set(host, Date.now() + 45000);
      }
      const err = new Error(`HTTP ${res.status}`);
      err.code = res.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERR';
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const data = await res.json();
    if (method === 'GET' && ttlMs > 0) cache.set(key, { ts: Date.now(), data });
    return data;
  } finally {
    clearTimeout(t);
  }
}

function getCached(key, ttlMs = 0) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (ttlMs > 0 && Date.now() - hit.ts >= ttlMs) return undefined;
  return hit.data;
}

module.exports = { fetchJson, isBackingOff, getCached };
