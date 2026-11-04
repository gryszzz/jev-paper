'use strict';

/**
 * Free no-key copy/whale watch for tracked wallets.
 * Primary: Solana public RPC websockets (logsSubscribe mentions) spread across
 * publicnode + official mainnet (+ Helius WS only if HELIUS_API_KEY set).
 * Fallback: round-robin getSignaturesForAddress + getTransaction poll.
 * Emits normalized { mint, traderPublicKey, txType, signature, source, solAmount? }.
 */

const WebSocket = require('ws');
const {
  WS_RPCS,
  getSignaturesForAddress,
  getTransaction,
  nextWs,
} = require('./rpc');

const WSOL = 'So11111111111111111111111111111111111111112';
const MAX_WS_WALLETS_PER_CONN = 18; // stay under public RPC sub pressure
const POLL_BATCH = 4;
const POLL_EVERY_MS = 3500;
const SEEN_CAP = 4000;

const STATS = {
  mode: 'idle',
  wsConnected: 0,
  wsEndpoints: [],
  watching: 0,
  pollCursor: 0,
  buys: 0,
  sells: 0,
  lastBuyAt: 0,
  lastBuy: null,
  lastError: null,
  pollCycles: 0,
  wsNotifications: 0,
  helius: !!(process.env.HELIUS_API_KEY),
};

let _handlers = new Set();
let _wallets = [];
let _want = false;
let _conns = []; // { ws, url, wallets, idMap }
let _pollTimer = null;
let _seenSigs = new Set();
let _seenOrder = [];

function scrubUrl(u) {
  return String(u || '')
    .replace(/api-key=[^&]+/gi, 'api-key=***')
    .replace(/^wss?:\/\//, '')
    .split('?')[0];
}

function onTrade(fn) {
  _handlers.add(fn);
  return () => _handlers.delete(fn);
}

function emit(ev) {
  for (const fn of _handlers) {
    try {
      fn(ev);
    } catch (_) {}
  }
}

function rememberSig(sig) {
  if (!sig || _seenSigs.has(sig)) return false;
  _seenSigs.add(sig);
  _seenOrder.push(sig);
  if (_seenOrder.length > SEEN_CAP) {
    const drop = _seenOrder.splice(0, _seenOrder.length - SEEN_CAP);
    for (const d of drop) _seenSigs.delete(d);
  }
  return true;
}

function parseTradeFromTx(tx, watched) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const logs = tx.meta.logMessages || [];
  const buy = logs.some((l) => /Instruction:\s*Buy/i.test(l));
  const sell = logs.some((l) => /Instruction:\s*Sell/i.test(l));
  // also catch generic swap / pump when token delta is clear for watched owner
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const map = new Map();
  for (const p of pre) {
    const amt = Number((p.uiTokenAmount && p.uiTokenAmount.amount) || 0);
    map.set(`${p.accountIndex}:${p.mint}`, { mint: p.mint, owner: p.owner, pre: amt, post: amt });
  }
  for (const p of post) {
    const k = `${p.accountIndex}:${p.mint}`;
    const amt = Number((p.uiTokenAmount && p.uiTokenAmount.amount) || 0);
    const row = map.get(k) || { mint: p.mint, owner: p.owner, pre: 0, post: 0 };
    row.post = amt;
    row.owner = p.owner;
    map.set(k, row);
  }
  const deltas = [...map.values()]
    .map((r) => ({ ...r, d: r.post - r.pre }))
    .filter((r) => r.mint !== WSOL && r.d !== 0);
  if (!deltas.length && !buy && !sell) return null;

  const owned = deltas.filter((r) => r.owner === watched);
  let pick = owned.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  if (!pick) {
    const pumps = deltas.filter((r) => String(r.mint).endsWith('pump'));
    pick = (pumps.length ? pumps : deltas).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
  }
  if (!pick) {
    if (!buy && !sell) return null;
    return null;
  }
  let side;
  if (buy) side = 'buy';
  else if (sell) side = 'sell';
  else side = pick.d > 0 ? 'buy' : 'sell';
  // If we only have owned delta, trust sign
  if (owned.length && pick.owner === watched) side = pick.d > 0 ? 'buy' : 'sell';

  // rough SOL spent/received from fee-payer balance if available
  let solAmount = null;
  try {
    const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
    const idx = keys.findIndex((k) => {
      const pk = typeof k === 'string' ? k : k.pubkey;
      return pk === watched;
    });
    if (idx >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
      const lamports = (tx.meta.preBalances[idx] || 0) - (tx.meta.postBalances[idx] || 0);
      solAmount = Math.abs(lamports) / 1e9;
    }
  } catch (_) {}

  return {
    mint: pick.mint,
    traderPublicKey: watched,
    txType: side,
    solAmount,
    tokenAmount: Math.abs(pick.d),
  };
}

async function ingestSignature(sig, watched, source) {
  if (!rememberSig(sig)) return null;
  let tx;
  try {
    tx = await getTransaction(sig);
  } catch (e) {
    STATS.lastError = e.message;
    return null;
  }
  const parsed = parseTradeFromTx(tx, watched);
  if (!parsed || !parsed.mint) return null;
  const ev = {
    ...parsed,
    signature: sig,
    source,
    ts: Date.now(),
    // aliases for paper/_onRealtimeTrade consumers
    wallet: parsed.traderPublicKey,
    side: parsed.txType,
  };
  if (ev.txType === 'buy') {
    STATS.buys += 1;
    STATS.lastBuyAt = Date.now();
    STATS.lastBuy = {
      wallet: watched.slice(0, 8),
      mint: String(parsed.mint).slice(0, 8),
      source,
      ts: Date.now(),
    };
  } else {
    STATS.sells += 1;
  }
  emit(ev);
  return ev;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function closeConns() {
  for (const c of _conns) {
    try {
      c.ws.close();
    } catch (_) {}
  }
  _conns = [];
  STATS.wsConnected = 0;
  STATS.wsEndpoints = [];
}

function openConn(url, wallets) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 12000 });
    } catch (e) {
      STATS.lastError = e.message;
      return resolve(null);
    }
    const conn = { ws, url, wallets, idMap: new Map(), subToWallet: new Map() };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch (_) {}
        resolve(null);
      }
    }, 14000);

    ws.on('open', () => {
      let id = 1;
      for (const w of wallets) {
        const subId = id++;
        conn.idMap.set(subId, w);
        try {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: subId,
              method: 'logsSubscribe',
              params: [{ mentions: [w] }, { commitment: 'confirmed' }],
            })
          );
        } catch (_) {}
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(conn);
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.id != null && msg.result != null && conn.idMap.has(msg.id)) {
          conn.subToWallet.set(msg.result, conn.idMap.get(msg.id));
          return;
        }
        if (msg.method !== 'logsNotification') return;
        STATS.wsNotifications += 1;
        const val = msg.params && msg.params.result && msg.params.result.value;
        const sub = msg.params && msg.params.subscription;
        const sig = val && val.signature;
        if (!sig || (val && val.err)) return;
        const watched =
          conn.subToWallet.get(sub) ||
          // fallback: any wallet mentioned in logs (rare)
          wallets[0];
        if (!watched) return;
        // soft filter: prefer buy/sell log lines before fetching tx
        const logs = (val && val.logs) || [];
        const interesting = !logs.length || logs.some((l) => /Instruction:\s*(Buy|Sell)|pump|swap/i.test(l));
        if (!interesting) return;
        ingestSignature(sig, watched, `rpc-ws:${url.replace(/^wss?:\/\//, '').split('/')[0]}`).catch(() => {});
      } catch (_) {}
    });

    ws.on('close', () => {
      STATS.wsConnected = _conns.filter((c) => c.ws.readyState === WebSocket.OPEN).length;
      if (_want) {
        setTimeout(() => {
          if (!_want) return;
          // reconnect this shard
          openConn(url, wallets).then((c) => {
            if (c) {
              _conns.push(c);
              STATS.wsConnected = _conns.filter((x) => x.ws.readyState === WebSocket.OPEN).length;
            }
          });
        }, 10000);
      }
    });

    ws.on('error', (err) => {
      STATS.lastError = (err && err.message) || 'ws error';
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

async function startWsShards(wallets) {
  closeConns();
  const endpoints = [...WS_RPCS];
  // Prefer Helius WS when key present (already in WS_RPCS); put helius hosts first.
  endpoints.sort((a, b) => {
    const ah = /helius/i.test(a) ? 0 : 1;
    const bh = /helius/i.test(b) ? 0 : 1;
    return ah - bh;
  });
  if (!endpoints.length) {
    // force at least publicnode
    endpoints.push('wss://solana-rpc.publicnode.com', 'wss://api.mainnet-beta.solana.com');
  }
  const shards = chunk(wallets, MAX_WS_WALLETS_PER_CONN);
  const opened = [];
  for (let i = 0; i < shards.length; i++) {
    const url = endpoints[i % endpoints.length];
    const conn = await openConn(url, shards[i]);
    if (conn) {
      opened.push(conn);
      STATS.wsEndpoints.push(url.replace(/^wss?:\/\//, '').split('/')[0]);
    } else {
      // try alternate endpoint for this shard
      const alt = endpoints[(i + 1) % endpoints.length];
      if (alt !== url) {
        const conn2 = await openConn(alt, shards[i]);
        if (conn2) {
          opened.push(conn2);
          STATS.wsEndpoints.push(alt.replace(/^wss?:\/\//, '').split('/')[0]);
        }
      }
    }
  }
  _conns = opened;
  STATS.wsConnected = opened.length;
  STATS.mode = opened.length ? 'ws+poll' : 'poll-only';
}

async function pollOnce() {
  if (!_want || !_wallets.length) return;
  STATS.pollCycles += 1;
  const n = _wallets.length;
  for (let i = 0; i < POLL_BATCH; i++) {
    const idx = (STATS.pollCursor + i) % n;
    const w = _wallets[idx];
    if (!w) continue;
    try {
      const sigs = await getSignaturesForAddress(w, { limit: 8 });
      for (const s of sigs || []) {
        if (!s || s.err || !s.signature) continue;
        // only fresh (15 min) to catch live copy
        if (s.blockTime && Date.now() / 1000 - s.blockTime > 15 * 60) continue;
        if (_seenSigs.has(s.signature)) continue;
        await ingestSignature(s.signature, w, 'rpc-poll');
      }
    } catch (e) {
      STATS.lastError = e.message;
    }
  }
  STATS.pollCursor = (STATS.pollCursor + POLL_BATCH) % n;
}

function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_EVERY_MS);
  // kick immediately
  pollOnce().catch(() => {});
}

async function start(wallets = []) {
  _want = true;
  _wallets = [...new Set((wallets || []).filter((w) => w && w.length >= 32))];
  STATS.watching = _wallets.length;
  if (!_wallets.length) {
    STATS.mode = 'idle';
    return STATS;
  }
  await startWsShards(_wallets);
  startPolling();
  return stats();
}

function stop() {
  _want = false;
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
  closeConns();
  STATS.mode = 'stopped';
}

function refresh(wallets = []) {
  const next = [...new Set((wallets || []).filter((w) => w && w.length >= 32))];
  const same =
    next.length === _wallets.length && next.every((w, i) => w === _wallets[i]);
  if (same && _want) return Promise.resolve(stats());
  return start(next);
}

function dailyRefresh(state, opts) {
  const { runDailyRefresh } = require('./walletListRefresh');
  return runDailyRefresh(state, opts);
}

function listRefreshStats(state) {
  const { refreshStats } = require('./walletListRefresh');
  return refreshStats(state);
}

function needsListRefresh(state) {
  const { needsRefresh } = require('./walletListRefresh');
  return needsRefresh(state);
}

function stats() {
  let list = null;
  try {
    list = listRefreshStats();
  } catch (_) {}
  return {
    ...STATS,
    helius: !!(process.env.HELIUS_API_KEY),
    wsEndpoints: (STATS.wsEndpoints || []).map(scrubUrl),
    nextWsHint: scrubUrl(STATS.nextWsHint || nextWs()),
    seen: _seenSigs.size,
    handlers: _handlers.size,
    listRefresh: list,
  };
}

module.exports = {
  start,
  stop,
  refresh,
  onTrade,
  stats,
  dailyRefresh,
  listRefreshStats,
  needsListRefresh,
  parseTradeFromTx, // test helper
  STATS,
};
