'use strict';

/**
 * Realtime launch/graduation feed.
 * Free: PumpPortal wss://pumpportal.fun/api/data (subscribeNewToken + subscribeMigration).
 * Optional: HELIUS_API_KEY for enhanced RPC / future laserstream hooks.
 */

const WebSocket = require('ws');

const PUMPPORTAL_WS = process.env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const MAX_BUFFER = 120;
const RECONNECT_MS = 5000;

class RealtimeFeed {
  constructor() {
    this.launches = []; // { mint, symbol, name, creator, source, ts, graduating }
    this.seen = new Set();
    this.ws = null;
    this._alive = false;
    this._want = true;
    this._reconnectTimer = null;
    this._stats = {
      connected: false,
      source: 'pumpportal',
      helius: !!HELIUS_API_KEY,
      launches: 0,
      migrations: 0,
      lastEventAt: 0,
      lastError: null,
      reconnects: 0,
      // Free-tier latency telemetry (PumpPortal WS + optional public RPC WS)
      eventLatencyMs: null,
      avgEventLatencyMs: null,
      lastPingMs: null,
      rpcWsConnected: false,
      freeTier: true,
      paidRequired: false,
    };
    this._latSamples = [];
    this._rpcWs = null;
    this._rpcWant = false;
    this._lastMsgWall = 0;
    this._tokenTradeSubs = new Set();
    this._accountTradeSubs = new Set();
    this._tradeHandlers = new Set();
  }

  start() {
    this._want = true;
    this._connect();
  }

  stop() {
    this._want = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this._alive = false;
    this._stats.connected = false;
    this.stopRpcWalletWatch();
  }

  onTrade(fn) {
    this._tradeHandlers.add(fn);
    return () => this._tradeHandlers.delete(fn);
  }

  /** Subscribe to token trades (metered on PumpPortal after May 2026 — only if key set). */
  watchTokenTrades(mints = []) {
    for (const m of mints) if (m) this._tokenTradeSubs.add(m);
    this._flushSubs();
  }

  watchAccountTrades(wallets = [], { replace = true } = {}) {
    // Prefer current top-copy list under freeCap — do not let stale seeds crowd them out.
    if (replace) this._accountTradeSubs.clear();
    for (const w of wallets) if (w) this._accountTradeSubs.add(w);
    this._flushSubs();
  }

  drainLaunches({ max = 40, sinceTs = 0 } = {}) {
    const out = this.launches.filter((x) => x.ts >= sinceTs).slice(0, max);
    return out;
  }

  recentMints(maxAgeMs = 10 * 60e3) {
    const cut = Date.now() - maxAgeMs;
    return this.launches.filter((x) => x.ts >= cut).map((x) => x.mint);
  }

  stats() {
    const avg = this._latSamples.length
      ? Math.round(this._latSamples.reduce((a, b) => a + b, 0) / this._latSamples.length)
      : null;
    this._stats.avgEventLatencyMs = avg;
    return {
      ...this._stats,
      buffer: this.launches.length,
      heliusConfigured: !!HELIUS_API_KEY,
      freeTier: true,
      paidRequired: false,
      routes: {
        pumpportal: this._stats.connected,
        rpcWs: this._stats.rpcWsConnected,
        heliusOptional: !!HELIUS_API_KEY,
      },
      accountTradeSubs: this._accountTradeSubs.size,
      accountTradeSample: [...this._accountTradeSubs].slice(0, 4).map((a) => String(a).slice(0, 8)),
    };
  }

  /** Optional Helius enhanced RPC URL when key present. */
  heliusRpcUrl() {
    if (!HELIUS_API_KEY) return null;
    return `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  }

  _connect() {
    if (!this._want) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = PUMPPORTAL_WS;
    this._connectStartedAt = Date.now();
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 15000 });
    } catch (e) {
      this._stats.lastError = e.message;
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this._alive = true;
      this._stats.connected = true;
      this._stats.lastError = null;
      this._stats.lastPingMs = Date.now() - (this._connectStartedAt || Date.now());
      try {
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        ws.send(JSON.stringify({ method: 'subscribeMigration' }));
        // Free PumpPortal: subscribeTokenTrade / subscribeAccountTrade for tracked sets when free
        this._flushSubs();
      } catch (e) {
        this._stats.lastError = e.message;
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        this._handleMessage(msg);
      } catch (_) {}
    });

    ws.on('close', () => {
      this._alive = false;
      this._stats.connected = false;
      this.ws = null;
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this._stats.lastError = (err && err.message) || 'ws error';
    });
  }

  _scheduleReconnect() {
    if (!this._want) return;
    if (this._reconnectTimer) return;
    this._stats.reconnects += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_MS);
  }

  _flushSubs() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Free-first: PumpPortal subscribeTokenTrade/subscribeAccountTrade for SMALL tracked sets.
    // Cap hard so we never depend on a paid PumpPortal plan. Optional HELIUS free-tier WS
    // is used separately via startRpcWalletWatch for logsSubscribe/accountSubscribe.
    const pumpKey = process.env.PUMPPORTAL_API_KEY || '';
    const freeCap = pumpKey || HELIUS_API_KEY ? 40 : 16; // free path: prefer ≤16 copy wallets
    const tokens = [...this._tokenTradeSubs].slice(0, freeCap);
    const accounts = [...this._accountTradeSubs].slice(0, freeCap);
    try {
      // PumpPortal gates token/account trade subs behind a funded API key (≥0.02 SOL).
      // Without a key, skip and rely on free RPC logsSubscribe via startRpcWalletWatch.
      if (pumpKey) {
        if (tokens.length) {
          this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: tokens }));
        }
        if (accounts.length) {
          this.ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: accounts }));
        }
        this._stats.accountTradeMode = 'pumpportal-key';
      } else {
        this._stats.accountTradeMode = 'rpc-only';
        this._stats.accountTradeNote =
          'PumpPortal account-trade needs API key; using free RPC wallet watch';
      }
    } catch (_) {}
  }

  /**
   * Optional free public/Helius-free RPC websocket for logsSubscribe on tracked wallets.
   * No paid dependency — skips silently if WS endpoints fail.
   */
  startRpcWalletWatch(wallets = []) {
    this._rpcWant = true;
    this._rpcWatchWallets = [...new Set((wallets || []).filter(Boolean))].slice(0, 12);
    this._connectRpcWs();
  }

  stopRpcWalletWatch() {
    this._rpcWant = false;
    if (this._rpcWs) {
      try { this._rpcWs.close(); } catch (_) {}
      this._rpcWs = null;
    }
    this._stats.rpcWsConnected = false;
  }

  _connectRpcWs() {
    if (!this._rpcWant) return;
    if (this._rpcWs && (this._rpcWs.readyState === WebSocket.OPEN || this._rpcWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    let nextWs;
    try {
      nextWs = require('./rpc').nextWs;
    } catch (_) {
      return;
    }
    const url = nextWs && nextWs();
    if (!url) return;
    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 12000 });
    } catch (e) {
      this._stats.lastError = e.message;
      return;
    }
    this._rpcWs = ws;
    ws.on('open', () => {
      this._stats.rpcWsConnected = true;
      let id = 1;
      for (const w of this._rpcWatchWallets || []) {
        try {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: id++,
            method: 'logsSubscribe',
            params: [{ mentions: [w] }, { commitment: 'confirmed' }],
          }));
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: id++,
            method: 'accountSubscribe',
            params: [w, { encoding: 'base64', commitment: 'confirmed' }],
          }));
        } catch (_) {}
      }
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.method === 'logsNotification' || msg.method === 'accountNotification') {
          this._stats.lastEventAt = Date.now();
          for (const fn of this._tradeHandlers) {
            try { fn({ source: 'rpc-ws', ...msg }); } catch (_) {}
          }
        }
      } catch (_) {}
    });
    ws.on('close', () => {
      this._stats.rpcWsConnected = false;
      this._rpcWs = null;
      if (this._rpcWant) {
        setTimeout(() => this._connectRpcWs(), 8000);
      }
    });
    ws.on('error', () => {
      this._stats.rpcWsConnected = false;
    });
  }

  _pushLaunch(ev) {
    const mint = ev.mint || ev.token || ev.address;
    if (!mint || this.seen.has(mint)) return;
    this.seen.add(mint);
    if (this.seen.size > 2000) {
      const drop = [...this.seen].slice(0, 500);
      for (const d of drop) this.seen.delete(d);
    }
    const row = {
      mint,
      symbol: (ev.symbol || ev.ticker || '???').slice(0, 12),
      name: ev.name || ev.symbol || 'Unknown',
      creator: ev.traderPublicKey || ev.creator || ev.dev || null,
      icon: ev.uri || ev.image || null,
      marketCap: Number(ev.marketCapSol || ev.marketCap || 0),
      source: ev.graduating || ev.txType === 'migrate' ? 'pumpportal.migration' : 'pumpportal.new',
      graduating: !!(ev.graduating || ev.txType === 'migrate' || ev.method === 'migration'),
      ts: Date.now(),
      rawTxType: ev.txType || ev.method || null,
    };
    this.launches.unshift(row);
    if (this.launches.length > MAX_BUFFER) this.launches = this.launches.slice(0, MAX_BUFFER);
    this._stats.lastEventAt = row.ts;
    // Approximate event latency vs wall clock (PumpPortal doesn't send server ts reliably)
    const lat = Math.max(0, Date.now() - (this._lastMsgWall || Date.now()));
    this._lastMsgWall = Date.now();
    // Use inter-arrival as a soft latency proxy + handshake ping
    const sample = this._stats.lastPingMs != null ? this._stats.lastPingMs : 80;
    this._stats.eventLatencyMs = sample;
    this._latSamples.push(sample);
    if (this._latSamples.length > 30) this._latSamples.shift();
    if (row.graduating) this._stats.migrations += 1;
    else this._stats.launches += 1;
    void lat;
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // PumpPortal shapes vary: new token often has mint + symbol; migration has txType
    const txType = msg.txType || msg.method || '';
    if (
      msg.mint ||
      msg.token ||
      txType === 'create' ||
      txType === 'migrate' ||
      msg.pool ||
      msg.bondingCurveKey
    ) {
      const isTrade =
        txType === 'buy' ||
        txType === 'sell' ||
        msg.txType === 'buy' ||
        msg.txType === 'sell' ||
        (msg.tokenAmount != null && msg.solAmount != null && !msg.name);
      if (isTrade) {
        for (const fn of this._tradeHandlers) {
          try {
            fn(msg);
          } catch (_) {}
        }
        return;
      }
      this._pushLaunch({
        ...msg,
        graduating: txType === 'migrate' || /migrat/i.test(String(txType)),
      });
    }
  }
}

const feed = new RealtimeFeed();

module.exports = { RealtimeFeed, feed, HELIUS_API_KEY, PUMPPORTAL_WS };
