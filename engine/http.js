'use strict';

const cache = new Map();
const backoffUntil = new Map();

async function fetchJson(url, opts = {}) {
  const {
    ttlMs = 10000,
    key = url,
    timeoutMs = 12000,
    method = 'GET',
    headers = {},
    body,
  } = opts;

  const until = backoffUntil.get(key) || 0;
  if (Date.now() < until) {
    const hit = cache.get(key);
    if (hit) return hit.data;
    throw new Error(`backoff ${key}`);
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
      backoffUntil.set(key, Date.now() + 20000);
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const data = await res.json();
    if (method === 'GET' && ttlMs > 0) cache.set(key, { ts: Date.now(), data });
    return data;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchJson };
