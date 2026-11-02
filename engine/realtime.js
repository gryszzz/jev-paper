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
    };
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

  watchAccountTrades(wallets = []) {
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
    return { ...this._stats, buffer: this.launches.length, heliusConfigured: !!HELIUS_API_KEY };
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
      try {
        ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        ws.send(JSON.stringify({ method: 'subscribeMigration' }));
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
    // Token/account trade streams are metered — only subscribe when PumpPortal key present
    // or HELIUS is configured (future path). Free mode: skip metered subs.
    const pumpKey = process.env.PUMPPORTAL_API_KEY || '';
    if (!pumpKey && !HELIUS_API_KEY) return;
    const tokens = [...this._tokenTradeSubs].slice(0, 40);
    const accounts = [...this._accountTradeSubs].slice(0, 40);
    try {
      if (tokens.length) {
        this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: tokens }));
      }
      if (accounts.length) {
        this.ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: accounts }));
      }
    } catch (_) {}
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
    if (row.graduating) this._stats.migrations += 1;
    else this._stats.launches += 1;
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
