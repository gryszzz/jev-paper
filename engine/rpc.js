'use strict';

/**
 * Free/cheap Solana RPC rotator.
 * - Public endpoints (round-robin + health backoff)
 * - Optional HELIUS_API_KEY (free-tier OK) prepended when set
 * - Aggressive GET-style JSON-RPC caching via http-style Map
 * No paid plan required.
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

const PUBLIC_RPCS = [
  process.env.SOLANA_RPC_URL,
  HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null,
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
  'https://solana.drpc.org',
].filter(Boolean);

const WS_RPCS = [
  process.env.SOLANA_WS_URL,
  HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null,
  'wss://solana-rpc.publicnode.com',
  'wss://api.mainnet-beta.solana.com',
].filter(Boolean);

const cache = new Map();
const badUntil = new Map();
let cursor = 0;
const latencySamples = [];
const MAX_LAT_SAMPLES = 40;

function markLatency(ms, ok, url) {
  latencySamples.push({ ms, ok: !!ok, url, ts: Date.now() });
  if (latencySamples.length > MAX_LAT_SAMPLES) latencySamples.shift();
}

function latencyStats() {
  const ok = latencySamples.filter((x) => x.ok);
  const avg = ok.length ? ok.reduce((a, b) => a + b.ms, 0) / ok.length : null;
  const last = latencySamples[latencySamples.length - 1] || null;
  const p95 = (() => {
    if (!ok.length) return null;
    const sorted = ok.map((x) => x.ms).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  })();
  return {
    samples: latencySamples.length,
    avgMs: avg != null ? Math.round(avg) : null,
    p95Ms: p95 != null ? Math.round(p95) : null,
    lastMs: last ? last.ms : null,
    lastOk: last ? last.ok : null,
    lastUrl: last ? last.url.replace(/api-key=[^&]+/, 'api-key=***') : null,
    helius: !!HELIUS_API_KEY,
    endpoints: PUBLIC_RPCS.length,
  };
}

function nextRpc() {
  const now = Date.now();
  for (let i = 0; i < PUBLIC_RPCS.length; i++) {
    cursor = (cursor + 1) % PUBLIC_RPCS.length;
    const url = PUBLIC_RPCS[cursor];
    if ((badUntil.get(url) || 0) > now) continue;
    return url;
  }
  return PUBLIC_RPCS[0];
}

function nextWs() {
  return WS_RPCS[cursor % WS_RPCS.length] || WS_RPCS[0] || null;
}

async function rpcCall(method, params = [], { ttlMs = 0, key = null, timeoutMs = 12000 } = {}) {
  const cacheKey = key || `rpc:${method}:${JSON.stringify(params).slice(0, 120)}`;
  if (ttlMs > 0) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(4, PUBLIC_RPCS.length); attempt++) {
    const url = nextRpc();
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const ms = Date.now() - t0;
      if (res.status === 429 || res.status >= 500) {
        badUntil.set(url, Date.now() + 30000);
        markLatency(ms, false, url);
        lastErr = new Error(`RPC HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        markLatency(ms, false, url);
        lastErr = new Error(json.error.message || 'rpc error');
        continue;
      }
      markLatency(ms, true, url);
      if (ttlMs > 0) cache.set(cacheKey, { ts: Date.now(), data: json.result });
      return json.result;
    } catch (e) {
      markLatency(Date.now() - t0, false, url);
      badUntil.set(url, Date.now() + 15000);
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('rpc exhausted');
}

async function getSignaturesForAddress(address, { limit = 25 } = {}) {
  return rpcCall(
    'getSignaturesForAddress',
    [address, { limit }],
    { ttlMs: 20000, key: `sigs:${address}:${limit}` }
  );
}

async function getTransaction(signature) {
  return rpcCall(
    'getTransaction',
    [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
    { ttlMs: 60000, key: `tx:${signature}` }
  );
}

async function getTokenLargestAccounts(mint) {
  return rpcCall('getTokenLargestAccounts', [mint], {
    ttlMs: 25000,
    key: `largest:${mint}`,
  });
}

module.exports = {
  PUBLIC_RPCS,
  WS_RPCS,
  HELIUS_API_KEY,
  nextRpc,
  nextWs,
  rpcCall,
  getSignaturesForAddress,
  getTransaction,
  getTokenLargestAccounts,
  latencyStats,
};
