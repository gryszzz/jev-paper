'use strict';

const { loadState, saveState } = require('./store');
const { fetchJson } = require('./http');
const { createTradeAdapter } = require('./adapters');
const { jupiterQuote } = require('./jupiter');
const {
  pumpNewTokens,
  pumpGraduating,
  dexscreenerDiscover,
  geckoNewPools,
  rugcheck,
} = require('./sources');
const { scorePair } = require('./analyst');
const { PRESETS, applyPreset, positionSizeFraction } = require('./strategies');
const { getTopHolders, getTokenSupply, detectSells } = require('./whales');

const DS = 'https://api.dexscreener.com';

const DEFAULTS = {
  startingBalance: 100,
  minLiquidity: 38000,
  buyPctMin: 0.15,
  buyPctMax: 0.22,
  maxPositions: 3,
  stopPct: -0.06,
  trailPct: 0.1,
  slippage: 0.02,
  minScore: 70,
  strategyId: 'balanced',
  kellyCap: 0.18,
  maxDailyLossPct: 0.15,
  cooldownMs: 5 * 60e3,
  takeProfitLadder: [
    { mult: 1.5, sellPct: 0.25 },
    { mult: 2.0, sellPct: 0.25 },
  ],
  trailRemainder: true,
  preferGraduating: true,
  whaleDropPct: 15,
  whalePollMs: 20000,
  scanIntervalMs: 22000,
  priceIntervalMs: 8000,
  // Live safety caps (enforced even if LIVE_ENABLED flipped — LiveAdapter still stubs)
  liveMaxPerTradeUsd: 25,
  liveMaxDailySpendUsd: 100,
  liveMaxDailyLossUsd: 50,
  liveWalletBalanceCapUsd: 200,
};

function now() {
  return Date.now();
}
function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
}

const MAJORS = new Set(
  [
    'so11111111111111111111111111111111111111112',
    'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwjkxln',
    'es9vmfrsacqj9bbaozznpbrcbheeopwjxqgasknjdkkv',
    'mso1onzjnn9gdhvvhxaqr4udnsrgk45tarfhyztki6u',
    'j1toso1umfqesnvnvzkwrhdyerfzeq64zhaxrvgv7eh',
  ].map((s) => s.toLowerCase())
);
const MAJOR_SYMBOLS = new Set([
  'SOL', 'WSOL', 'USDC', 'USDT', 'USD1', 'ETH', 'WETH', 'BTC', 'WBTC', 'MSOL', 'JITOSOL', 'BSOL',
  'STSOL', 'BONK', 'WIF', 'JUP', 'RAY', 'ORCA', 'PYTH', 'JTO', 'HNT', 'RENDER', 'RNDR',
]);

function isMajor(pair) {
  if (!pair) return true;
  if (MAJORS.has((pair.mint || '').toLowerCase())) return true;
  if (MAJOR_SYMBOLS.has((pair.symbol || '').toUpperCase())) return true;
  if (pair.marketCap && pair.marketCap > 50_000_000) return true;
  return false;
}

function normalizePair(p) {
  if (!p) return null;
  const base = p.baseToken || {};
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  const vol = p.volume || {};
  const tx = p.txns || {};
  const h1 = tx.h1 || {};
  const h24 = tx.h24 || {};
  const m5 = tx.m5 || {};
  const info = p.info || {};
  const ageMs = p.pairCreatedAt ? now() - p.pairCreatedAt : null;
  return {
    mint: base.address,
    symbol: (base.symbol || '???').slice(0, 12),
    name: base.name || base.symbol || 'Unknown',
    icon: info.imageUrl || null,
    priceUsd: Number(p.priceUsd) || 0,
    liquidity: liq,
    volumeM5: Number(vol.m5) || 0,
    volumeH1: Number(vol.h1) || 0,
    volumeH24: Number(vol.h24) || 0,
    buysH1: Number(h1.buys) || 0,
    sellsH1: Number(h1.sells) || 0,
    buysH24: Number(h24.buys) || 0,
    sellsH24: Number(h24.sells) || 0,
    buysM5: Number(m5.buys) || 0,
    sellsM5: Number(m5.sells) || 0,
    fdv: Number(p.fdv) || Number(p.marketCap) || 0,
    marketCap: Number(p.marketCap) || Number(p.fdv) || 0,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    pairCreatedAt: p.pairCreatedAt || null,
    ageMs,
    priceChangeM5: (p.priceChange && p.priceChange.m5) || 0,
    priceChangeH1: (p.priceChange && p.priceChange.h1) || 0,
    priceChangeH24: (p.priceChange && p.priceChange.h24) || 0,
    socials: info.socials || [],
    websites: info.websites || [],
  };
}

function emptyStats() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    realizedPnl: 0,
    bestTrade: 0,
    worstTrade: 0,
    whaleExits: 0,
    avgWhaleLatencyMs: 0,
    _whaleLatencySum: 0,
    byStrategy: {},
  };
}

function emptyState(settings = {}) {
  const starting = Number(settings.startingBalance) || DEFAULTS.startingBalance;
  const merged = applyPreset({ ...DEFAULTS, ...settings, running: true }, settings.strategyId || 'balanced');
  return {
    version: 2,
    cash: starting,
    startingBalance: starting,
    peakBalance: starting,
    createdAt: now(),
    updatedAt: now(),
    mode: 'paper',
    liveEnabled: false,
    killSwitch: false,
    dayKey: new Date().toISOString().slice(0, 10),
    dayStartEquity: starting,
    dayRealizedPnl: 0,
    daySpend: 0,
    cooldownUntil: 0,
    ruggedDevs: [],
    settings: {
      minLiquidity: merged.minLiquidity,
      buyPctMin: merged.buyPctMin,
      buyPctMax: merged.buyPctMax,
      maxPositions: merged.maxPositions,
      stopPct: merged.stopPct,
      trailPct: merged.trailPct,
      slippage: merged.slippage,
      minScore: merged.minScore,
      strategyId: merged.strategyId,
      kellyCap: merged.kellyCap,
      maxDailyLossPct: merged.maxDailyLossPct,
      cooldownMs: merged.cooldownMs,
      takeProfitLadder: merged.takeProfitLadder,
      trailRemainder: merged.trailRemainder,
      preferGraduating: merged.preferGraduating,
      whaleDropPct: merged.whaleDropPct ?? DEFAULTS.whaleDropPct,
      whalePollMs: merged.whalePollMs ?? DEFAULTS.whalePollMs,
      liveMaxPerTradeUsd: DEFAULTS.liveMaxPerTradeUsd,
      liveMaxDailySpendUsd: DEFAULTS.liveMaxDailySpendUsd,
      liveMaxDailyLossUsd: DEFAULTS.liveMaxDailyLossUsd,
      liveWalletBalanceCapUsd: DEFAULTS.liveWalletBalanceCapUsd,
      running: true,
    },
    equityHistory: [{ t: now(), equity: starting }],
    positions: [],
    activity: [],
    scanned: [],
    scored: [],
    seenMints: [],
    rejected: [],
    whaleWatch: {}, // mint -> { holders, supply, updatedAt, events }
    stats: emptyStats(),
    banner: { text: 'JEV paper · Mode: PAPER', icon: null, ts: now() },
    agents: {
      scanner: { status: 'idle', pools: 0, recent: [], lastRun: 0 },
      analyst: { status: 'idle', score: null, symbol: null, passed: 0, scored: 0, lastRun: 0 },
      executor: { status: 'idle', trades: 0, lastFill: null, progress: 0, lastRun: 0 },
      risk: { status: 'idle', guarding: null, lastAction: null, lastRun: 0 },
      whale: {
        status: 'idle',
        watching: 0,
        lastAlert: null,
        lastRun: 0,
        latencyMs: null,
        holdersPreview: [],
      },
    },
    notifications: [],
  };
}

function migrateState(raw) {
  if (!raw) return emptyState();
  if (raw.version === 2) {
    raw.agents = raw.agents || {};
    if (!raw.agents.whale) {
      raw.agents.whale = {
        status: 'idle',
        watching: 0,
        lastAlert: null,
        lastRun: 0,
        latencyMs: null,
        holdersPreview: [],
      };
    }
    raw.whaleWatch = raw.whaleWatch || {};
    raw.stats = raw.stats || emptyStats();
    raw.ruggedDevs = raw.ruggedDevs || [];
    raw.killSwitch = !!raw.killSwitch;
    raw.mode = 'paper';
    raw.liveEnabled = false;
    raw.settings = { ...DEFAULTS, ...raw.settings, takeProfitLadder: raw.settings.takeProfitLadder || DEFAULTS.takeProfitLadder };
    return raw;
  }
  // v1 → v2
  const s = emptyState(raw.settings || {});
  s.cash = raw.cash;
  s.startingBalance = raw.startingBalance;
  s.peakBalance = raw.peakBalance;
  s.positions = raw.positions || [];
  s.activity = raw.activity || [];
  s.equityHistory = raw.equityHistory || s.equityHistory;
  s.seenMints = raw.seenMints || [];
  s.createdAt = raw.createdAt || s.createdAt;
  return s;
}

function equity(state) {
  const pos = state.positions.reduce((sum, p) => sum + (Number(p.markValue) || Number(p.amountUsd) || 0), 0);
  return round(state.cash + pos, 4);
}

function pushEquity(state) {
  const eq = equity(state);
  const hist = state.equityHistory;
  const last = hist[hist.length - 1];
  if (!last || last.equity !== eq || now() - last.t > 15000) {
    hist.push({ t: now(), equity: eq });
  }
  if (hist.length > 2000) state.equityHistory = hist.slice(-2000);
  if (eq > state.peakBalance) {
    state.peakBalance = eq;
    state._newPeak = true;
  }
  return eq;
}

function addActivity(state, item) {
  state.activity.unshift({ id: uid('act'), ts: now(), ...item });
  if (state.activity.length > 250) state.activity = state.activity.slice(0, 250);
}

function setBanner(state, text, icon = null) {
  state.banner = { text, icon, ts: now() };
}

function rolloverDay(state) {
  const key = new Date().toISOString().slice(0, 10);
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.dayStartEquity = equity(state);
    state.dayRealizedPnl = 0;
    state.daySpend = 0;
  }
}

class PaperEngine {
  constructor() {
    this.state = null;
    this._ready = this._init();
    this._scanTimer = null;
    this._priceTimer = null;
    this._whaleTimer = null;
    this._busy = false;
    this._whaleBusy = false;
    this._listeners = new Set();
    this.adapter = createTradeAdapter({
      jupiterQuote: (args) => jupiterQuote(args),
      fallbackSlippage: DEFAULTS.slippage,
    });
  }

  async _init() {
    const raw = await loadState();
    this.state = migrateState(raw);
    this.state.mode = 'paper';
    this.state.liveEnabled = false;
    if (process.env.LIVE_ENABLED === 'true') {
      console.warn('[jev] LIVE_ENABLED=true ignored — paper only until LiveAdapter is completed');
    }
    saveState(this.state, { immediate: true });
    return this.state;
  }

  async ready() {
    await this._ready;
    return this;
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit() {
    if (!this.state) return;
    const snap = this.snapshot();
    for (const fn of this._listeners) {
      try {
        fn(snap);
      } catch (_) {}
    }
  }

  persist(immediate = false) {
    if (!this.state) return;
    this.state.updatedAt = now();
    saveState(this.state, { immediate });
  }

  snapshot() {
    const s = this.state;
    if (!s) return { loading: true };
    const eq = equity(s);
    const mult = s.startingBalance > 0 ? eq / s.startingBalance : 1;
    const gain = eq - s.startingBalance;
    const gainPct = s.startingBalance > 0 ? (gain / s.startingBalance) * 100 : 0;
    const newPeak = !!s._newPeak;
    s._newPeak = false;
    const dayPnl = eq - (s.dayStartEquity || s.startingBalance);
    return {
      loading: false,
      cash: round(s.cash, 4),
      equity: round(eq, 4),
      startingBalance: s.startingBalance,
      peakBalance: round(s.peakBalance, 4),
      gain: round(gain, 4),
      gainPct: round(gainPct, 2),
      multiplier: round(mult, 4),
      positions: s.positions,
      activity: s.activity.slice(0, 60),
      agents: s.agents,
      banner: s.banner,
      settings: s.settings,
      equityHistory: s.equityHistory,
      scanned: (s.scanned || []).slice(0, 12),
      scored: (s.scored || []).slice(0, 8),
      whaleWatch: s.whaleWatch,
      stats: s.stats,
      updatedAt: s.updatedAt,
      newPeak,
      paper: true,
      mode: 'PAPER',
      liveEnabled: false,
      killSwitch: !!s.killSwitch,
      dayPnl: round(dayPnl, 4),
      dayRealizedPnl: round(s.dayRealizedPnl || 0, 4),
      cooldownUntil: s.cooldownUntil || 0,
      presets: Object.keys(PRESETS).map((id) => ({ id, label: PRESETS[id].label })),
      adapterMode: this.adapter.mode(),
      disclaimer:
        'PAPER ONLY — Mode: PAPER. No real trades, no wallet keys on client. LIVE_ENABLED=false. Jupiter quotes inform paper fills. Whale Watch uses public RPC holder polls.',
    };
  }

  start() {
    this._ready.then(() => {
      if (this._scanTimer) return;
      console.log('[jev] paper engine starting · adapter=', this.adapter.mode());
      this.tickScan().catch((e) => console.error('scan', e.message));
      this.tickPrices().catch((e) => console.error('prices', e.message));
      this.tickWhales().catch((e) => console.error('whales', e.message));
      this._scanTimer = setInterval(() => {
        this.tickScan().catch((e) => console.error('scan', e.message));
      }, DEFAULTS.scanIntervalMs);
      this._priceTimer = setInterval(() => {
        this.tickPrices().catch((e) => console.error('prices', e.message));
      }, DEFAULTS.priceIntervalMs);
      const whaleMs = (this.state && this.state.settings.whalePollMs) || DEFAULTS.whalePollMs;
      this._whaleTimer = setInterval(() => {
        this.tickWhales().catch((e) => console.error('whales', e.message));
      }, whaleMs);
    });
  }

  stop() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    if (this._priceTimer) clearInterval(this._priceTimer);
    if (this._whaleTimer) clearInterval(this._whaleTimer);
    this._scanTimer = this._priceTimer = this._whaleTimer = null;
  }

  setRunning(running) {
    if (!this.state) return;
    if (this.state.killSwitch && running) {
      setBanner(this.state, 'Kill switch ON — resume blocked until cleared', null);
      this.persist();
      this.emit();
      return this.snapshot();
    }
    this.state.settings.running = !!running;
    setBanner(this.state, running ? 'JEV · agents live (Mode: PAPER)' : 'JEV · paused — Mode: PAPER', null);
    this.persist();
    this.emit();
    return this.snapshot();
  }

  setKillSwitch(on) {
    this.state.killSwitch = !!on;
    if (on) {
      this.state.settings.running = false;
      setBanner(this.state, 'KILL SWITCH — all trading halted (paper)', null);
      addActivity(this.state, {
        type: 'kill',
        symbol: '—',
        agent: 'Risk',
        detail: 'Kill switch engaged',
      });
    } else {
      setBanner(this.state, 'Kill switch cleared — still paused until you resume', null);
    }
    this.persist(true);
    this.emit();
    return this.snapshot();
  }

  reset(startingBalance) {
    const bal = Number(startingBalance);
    const start = Number.isFinite(bal) && bal > 0 ? bal : this.state.startingBalance || 100;
    const strategyId = this.state.settings.strategyId;
    this.state = emptyState({ ...this.state.settings, startingBalance: start, strategyId });
    this.persist(true);
    this.emit();
    return this.snapshot();
  }

  updateSettings(patch = {}) {
    const s = this.state.settings;
    if (patch.strategyId && PRESETS[patch.strategyId]) {
      const next = applyPreset(s, patch.strategyId);
      Object.assign(s, {
        strategyId: next.strategyId,
        minLiquidity: next.minLiquidity,
        minScore: next.minScore,
        buyPctMin: next.buyPctMin,
        buyPctMax: next.buyPctMax,
        maxPositions: next.maxPositions,
        stopPct: next.stopPct,
        trailPct: next.trailPct,
        takeProfitLadder: next.takeProfitLadder,
        trailRemainder: next.trailRemainder,
        kellyCap: next.kellyCap,
        maxDailyLossPct: next.maxDailyLossPct,
        cooldownMs: next.cooldownMs,
        slippage: next.slippage,
        preferGraduating: next.preferGraduating,
      });
    }
    const keys = [
      'minLiquidity', 'buyPctMin', 'buyPctMax', 'maxPositions', 'stopPct', 'trailPct',
      'slippage', 'minScore', 'running', 'kellyCap', 'maxDailyLossPct', 'cooldownMs',
      'whaleDropPct', 'whalePollMs', 'preferGraduating',
      'liveMaxPerTradeUsd', 'liveMaxDailySpendUsd', 'liveMaxDailyLossUsd', 'liveWalletBalanceCapUsd',
    ];
    for (const k of keys) {
      if (patch[k] == null || patch[k] === '') continue;
      if (typeof patch[k] === 'boolean') s[k] = patch[k];
      else if (Number.isFinite(Number(patch[k]))) s[k] = Number(patch[k]);
    }
    if (Array.isArray(patch.takeProfitLadder)) s.takeProfitLadder = patch.takeProfitLadder;
    if (patch.startingBalance != null && Number(patch.startingBalance) > 0) {
      this.state.startingBalance = Number(patch.startingBalance);
    }
    // restart whale timer if interval changed
    if (patch.whalePollMs && this._whaleTimer) {
      clearInterval(this._whaleTimer);
      this._whaleTimer = setInterval(() => {
        this.tickWhales().catch((e) => console.error('whales', e.message));
      }, s.whalePollMs);
    }
    this.persist();
    this.emit();
    return this.snapshot();
  }

  dailyLossHit() {
    const s = this.state;
    rolloverDay(s);
    const eq = equity(s);
    const dd = (s.dayStartEquity - eq) / Math.max(s.dayStartEquity, 1);
    return dd >= (s.settings.maxDailyLossPct || 0.15);
  }

  async fetchPairsForMints(mints) {
    const out = [];
    const chunk = 25;
    for (let i = 0; i < mints.length; i += chunk) {
      const slice = mints.slice(i, i + chunk);
      try {
        const d = await fetchJson(`${DS}/latest/dex/tokens/${slice.join(',')}`, {
          ttlMs: 8000,
          key: `ds-tok-${slice[0]}-${slice.length}`,
        });
        const byMint = new Map();
        for (const p of d.pairs || []) {
          if (p.chainId !== 'solana') continue;
          const n = normalizePair(p);
          if (!n || !n.mint) continue;
          const prev = byMint.get(n.mint);
          if (!prev || n.liquidity > prev.liquidity) byMint.set(n.mint, n);
        }
        out.push(...byMint.values());
      } catch (e) {
        console.warn('tokens batch', e.message);
      }
    }
    return out;
  }

  async tickScan() {
    await this._ready;
    if (this._busy) return;
    this._busy = true;
    const state = this.state;
    const settings = state.settings;
    try {
      rolloverDay(state);
      state.agents.scanner.status = 'scanning';
      state.agents.scanner.lastRun = now();
      this.emit();

      const [ds, pumpNew, pumpGrad, gecko] = await Promise.all([
        dexscreenerDiscover().catch(() => ({ mints: [], icons: new Map(), meta: new Map() })),
        pumpNewTokens().catch(() => []),
        pumpGraduating().catch(() => []),
        geckoNewPools().catch(() => []),
      ]);

      const mintSet = new Set(ds.mints || []);
      const icons = ds.icons || new Map();
      const graduating = new Set();
      for (const p of pumpNew) if (p.mint) mintSet.add(p.mint);
      for (const p of pumpGrad) {
        if (p.mint) {
          mintSet.add(p.mint);
          graduating.add(p.mint);
        }
      }
      for (const g of gecko) if (g.mint) mintSet.add(g.mint);

      const mints = [...mintSet].slice(0, 80);
      const pairs = await this.fetchPairsForMints(mints);
      for (const p of pairs) {
        if (!p.icon && icons.has(p.mint)) p.icon = icons.get(p.mint);
        if (graduating.has(p.mint)) {
          p.graduating = true;
          p.source = 'pump.grad';
        }
        const meta = ds.meta && ds.meta.get(p.mint);
        if (meta) {
          p.socials = meta.socials || p.socials;
          p.websites = meta.websites || p.websites;
        }
        if (icons.has(p.mint) || (ds.mints || []).includes(p.mint)) p.boosted = true;
      }

      state.agents.scanner.pools = pairs.length;
      const filtered = pairs
        .filter((p) => !isMajor(p) && p.liquidity >= settings.minLiquidity && p.priceUsd > 0)
        .filter((p) => !state.ruggedDevs.includes(p.mint))
        .sort((a, b) => {
          if (settings.preferGraduating) {
            const ag = a.graduating ? 1 : 0;
            const bg = b.graduating ? 1 : 0;
            if (bg !== ag) return bg - ag;
          }
          return b.liquidity - a.liquidity;
        });

      const rejects = pairs
        .filter((p) => p.liquidity > 0 && p.liquidity < settings.minLiquidity)
        .sort((a, b) => b.liquidity - a.liquidity)
        .slice(0, 3)
        .map((p) => ({ symbol: p.symbol, icon: p.icon, tag: `liq $${Math.round(p.liquidity / 1000)}k`, ok: false }));
      const goods = filtered.slice(0, 4).map((p) => ({
        symbol: p.symbol,
        icon: p.icon,
        tag: p.graduating ? 'graduating' : '+ analyst',
        ok: true,
      }));
      state.agents.scanner.recent = [...rejects.slice(0, 2), ...goods].slice(0, 5);
      state.scanned = filtered.slice(0, 20);
      state.agents.scanner.status = 'idle';

      if (!settings.running || state.killSwitch) {
        this.persist();
        this.emit();
        return;
      }

      if (this.dailyLossHit()) {
        state.cooldownUntil = now() + (settings.cooldownMs || 300000);
        settings.running = false;
        setBanner(state, 'Daily loss limit hit — cooldown', null);
        addActivity(state, { type: 'risk', symbol: '—', agent: 'Risk', detail: 'Daily loss limit / cooldown' });
        this.persist();
        this.emit();
        return;
      }
      if (state.cooldownUntil && now() < state.cooldownUntil) {
        this.persist();
        this.emit();
        return;
      }

      state.agents.analyst.status = 'scoring';
      this.emit();
      const scored = [];
      for (const p of filtered.slice(0, 18)) {
        const r = await scorePair(p, settings);
        if (r.blacklistDev && p.mint) {
          if (!state.ruggedDevs.includes(p.mint)) state.ruggedDevs.push(p.mint);
        }
        scored.push({ ...p, ...r });
      }
      scored.sort((a, b) => b.score - a.score);
      state.scored = scored.slice(0, 15);
      state.agents.analyst.scored = (state.agents.analyst.scored || 0) + scored.length;
      state.agents.analyst.lastRun = now();
      const top = scored[0];
      if (top) {
        state.agents.analyst.score = top.score;
        state.agents.analyst.symbol = top.symbol;
        state.agents.analyst.status = top.pass ? 'passed' : 'scoring';
      } else {
        state.agents.analyst.status = 'idle';
      }

      const openMints = new Set(state.positions.map((p) => p.mint));
      const candidates = scored.filter(
        (p) => p.pass && !openMints.has(p.mint) && !state.seenMints.includes(p.mint)
      );

      if (candidates.length && state.positions.length < settings.maxPositions && state.cash > 5) {
        const pick = candidates[0];
        state.agents.analyst.passed = (state.agents.analyst.passed || 0) + 1;
        await this.paperBuy(pick);
      } else {
        state.agents.analyst.status = top ? (top.pass ? 'passed' : 'idle') : 'idle';
      }

      pushEquity(state);
      this.persist();
      this.emit();
    } finally {
      this._busy = false;
    }
  }

  async paperBuy(pair) {
    const state = this.state;
    const settings = state.settings;
    if (state.killSwitch || !settings.running) return null;
    if (state.positions.length >= settings.maxPositions) return null;
    if (!pair.priceUsd || pair.priceUsd <= 0) return null;

    const frac = positionSizeFraction(pair.score, settings);
    const eq = equity(state);
    let spend = round(eq * frac, 2);
    spend = Math.min(spend, round(state.cash * 0.95, 2));
    // Paper still respects live caps as soft training rails
    if (settings.liveMaxPerTradeUsd) spend = Math.min(spend, settings.liveMaxPerTradeUsd);
    if (spend < 2) return null;

    state.agents.executor.status = 'buying';
    state.agents.executor.progress = 0;
    state.agents.executor.lastFill = {
      symbol: pair.symbol,
      amountUsd: spend,
      pct: round(frac * 100, 1),
      icon: pair.icon,
    };
    this.emit();
    for (const step of [30, 65, 100]) {
      await new Promise((r) => setTimeout(r, 100));
      state.agents.executor.progress = step;
      this.emit();
    }

    const fill = await this.adapter.buy(pair.mint, spend, { markPrice: pair.priceUsd });
    const fillPrice = fill.fillPrice || pair.priceUsd * (1 + settings.slippage);
    const tokens = fill.tokens || spend / fillPrice;
    const feeUsd = round((fill.priorityFeeSol || 0) * (pair.solPriceUsd || 150) + spend * 0.0025, 4);
    const netSpend = round(spend + feeUsd * 0.1, 4); // small fee drag on cash
    const stopPrice = fillPrice * (1 + settings.stopPct);
    const ladder = (settings.takeProfitLadder || []).map((r) => ({
      ...r,
      hit: false,
    }));

    const pos = {
      id: uid('pos'),
      mint: pair.mint,
      symbol: pair.symbol,
      name: pair.name,
      icon: pair.icon,
      entryPrice: fillPrice,
      amountUsd: spend,
      remainingUsdBasis: spend,
      tokens,
      tokensInitial: tokens,
      stopPrice,
      trailPct: settings.trailPct,
      highSinceEntry: fillPrice,
      trailStop: fillPrice * (1 - settings.trailPct),
      ladder,
      trailRemainder: !!settings.trailRemainder,
      openedAt: now(),
      score: pair.score,
      scoreBreakdown: pair.breakdown || [],
      markPrice: pair.priceUsd,
      markValue: spend,
      pnl: 0,
      pnlPct: 0,
      liquidity: pair.liquidity,
      marketCap: pair.marketCap,
      volumeH24: pair.volumeH24,
      dexId: pair.dexId,
      url: pair.url,
      pairAddress: pair.pairAddress,
      ageMs: pair.ageMs,
      graduating: !!pair.graduating,
      fillSource: fill.source || 'paper',
      impactPct: fill.impactPct || 0,
      strategyId: settings.strategyId,
      priceHistory: [{ t: now(), price: pair.priceUsd }],
      whaleMeta: { lastPoll: 0, alerted: false },
    };

    state.cash = round(state.cash - netSpend, 4);
    state.daySpend = round((state.daySpend || 0) + spend, 4);
    state.positions.push(pos);
    state.seenMints.push(pair.mint);
    if (state.seenMints.length > 500) state.seenMints = state.seenMints.slice(-500);

    state.agents.executor.trades = (state.agents.executor.trades || 0) + 1;
    state.agents.executor.status = 'filled';
    state.agents.executor.progress = 100;
    state.agents.executor.lastRun = now();
    state.agents.risk.status = 'guarding';
    state.agents.risk.guarding = pair.symbol;
    state.stats.trades = (state.stats.trades || 0) + 1;

    addActivity(state, {
      type: 'buy',
      symbol: pair.symbol,
      icon: pair.icon,
      agent: 'Executor',
      detail: `${round(frac * 100, 0)}% · ${fill.source || 'paper'} · impact ${round(fill.impactPct || 0, 2)}%`,
      amountUsd: spend,
      pnl: null,
      pnlPct: null,
      mint: pair.mint,
    });
    setBanner(
      state,
      `Bought ${pair.symbol} · $${spend.toFixed(2)} (${round(frac * 100, 0)}%) · Mode: PAPER`,
      pair.icon
    );

    // seed whale watch immediately
    this.tickWhales().catch(() => {});

    pushEquity(state);
    this.persist();
    this.emit();
    setTimeout(() => {
      if (state.agents.executor.status === 'filled') {
        state.agents.executor.status = 'idle';
        this.emit();
      }
    }, 2500);
    return pos;
  }

  async tickPrices() {
    await this._ready;
    const state = this.state;
    if (!state.positions.length) {
      pushEquity(state);
      this.persist();
      this.emit();
      return;
    }

    const mints = [...new Set(state.positions.map((p) => p.mint))];
    let pairs = [];
    try {
      pairs = await this.fetchPairsForMints(mints);
    } catch (e) {
      console.warn('price tick', e.message);
      return;
    }
    const byMint = new Map(pairs.map((p) => [p.mint, p]));
    const settings = state.settings;
    const closes = []; // { pos, reason, label, sellPct }

    for (const pos of state.positions) {
      const live = byMint.get(pos.mint);
      if (!live || !live.priceUsd) continue;
      const px = live.priceUsd;
      pos.markPrice = px;
      pos.markValue = round(pos.tokens * px, 4);
      pos.pnl = round(pos.markValue - pos.remainingUsdBasis, 4);
      pos.pnlPct = pos.entryPrice ? round(((px - pos.entryPrice) / pos.entryPrice) * 100, 2) : 0;
      pos.liquidity = live.liquidity || pos.liquidity;
      pos.marketCap = live.marketCap || pos.marketCap;
      pos.volumeH24 = live.volumeH24 || pos.volumeH24;
      pos.icon = pos.icon || live.icon;
      pos.priceHistory = pos.priceHistory || [];
      pos.priceHistory.push({ t: now(), price: px });
      if (pos.priceHistory.length > 240) pos.priceHistory = pos.priceHistory.slice(-240);

      if (px > pos.highSinceEntry) {
        pos.highSinceEntry = px;
        pos.trailStop = px * (1 - pos.trailPct);
      }

      state.agents.risk.guarding = pos.symbol;
      state.agents.risk.status = 'guarding';
      state.agents.risk.lastRun = now();

      if (!settings.running || state.killSwitch) continue;

      if (px <= pos.stopPrice) {
        closes.push({ pos, reason: 'stop', label: 'Risk hard stop', sellPct: 1 });
        continue;
      }

      // laddered take profits
      pos.ladder = pos.ladder || [];
      for (const rung of pos.ladder) {
        if (rung.hit) continue;
        if (px >= pos.entryPrice * rung.mult) {
          rung.hit = true;
          closes.push({
            pos,
            reason: 'tp',
            label: `Risk TP ${rung.mult}x`,
            sellPct: rung.sellPct,
            rungMult: rung.mult,
          });
        }
      }

      const remainingFrac = pos.tokens / Math.max(pos.tokensInitial || pos.tokens, 1e-12);
      if (
        pos.trailRemainder &&
        remainingFrac > 0.05 &&
        px <= pos.trailStop &&
        pos.highSinceEntry >= pos.entryPrice * (1 + pos.trailPct * 0.5)
      ) {
        closes.push({ pos, reason: 'trail', label: 'Risk trailing stop', sellPct: 1 });
      }
    }

    // dedupe full closes
    const seen = new Set();
    for (const c of closes) {
      const key = `${c.pos.id}:${c.reason}:${c.rungMult || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.paperSell(c.pos, c.reason, c.label, c.sellPct || 1);
    }

    pushEquity(state);
    this.persist();
    this.emit();
  }

  async paperSell(pos, reason, label, sellPct = 1) {
    const state = this.state;
    const idx = state.positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) return null;

    const pct = clamp(Number(sellPct) || 1, 0.01, 1);
    const tokensToSell = pos.tokens * pct;
    if (tokensToSell <= 0) return null;

    const fill = await this.adapter.sell(pos.mint, tokensToSell, { markPrice: pos.markPrice || pos.entryPrice });
    const fillPrice = fill.fillPrice || (pos.markPrice || pos.entryPrice) * (1 - state.settings.slippage);
    const proceeds = round(fill.proceedsUsd != null ? fill.proceedsUsd : tokensToSell * fillPrice, 4);
    const basis = round(pos.remainingUsdBasis * pct, 4);
    const pnl = round(proceeds - basis, 4);
    const pnlPct = basis > 0 ? round((pnl / basis) * 100, 2) : 0;

    state.cash = round(state.cash + proceeds, 4);
    state.dayRealizedPnl = round((state.dayRealizedPnl || 0) + pnl, 4);

    pos.tokens = round(pos.tokens - tokensToSell, 8);
    pos.remainingUsdBasis = round(pos.remainingUsdBasis - basis, 4);
    pos.amountUsd = pos.remainingUsdBasis;
    pos.markValue = round(pos.tokens * (pos.markPrice || fillPrice), 4);

    const fullClose = pct >= 0.999 || pos.tokens < 1e-8;
    if (fullClose) {
      state.positions.splice(idx, 1);
      delete state.whaleWatch[pos.mint];
    }

    state.agents.risk.lastAction = {
      symbol: pos.symbol,
      reason,
      pnl,
      pnlPct,
      icon: pos.icon,
    };
    state.agents.risk.status = state.positions.length ? 'guarding' : 'idle';
    state.agents.risk.guarding = state.positions[0] ? state.positions[0].symbol : null;

    // stats
    if (fullClose || reason === 'tp') {
      state.stats.realizedPnl = round((state.stats.realizedPnl || 0) + pnl, 4);
      if (pnl >= 0) state.stats.wins = (state.stats.wins || 0) + 1;
      else state.stats.losses = (state.stats.losses || 0) + 1;
      state.stats.bestTrade = Math.max(state.stats.bestTrade || 0, pnl);
      state.stats.worstTrade = Math.min(state.stats.worstTrade || 0, pnl);
      const sid = pos.strategyId || state.settings.strategyId || 'balanced';
      state.stats.byStrategy[sid] = state.stats.byStrategy[sid] || { trades: 0, pnl: 0, wins: 0 };
      state.stats.byStrategy[sid].trades += 1;
      state.stats.byStrategy[sid].pnl = round(state.stats.byStrategy[sid].pnl + pnl, 4);
      if (pnl >= 0) state.stats.byStrategy[sid].wins += 1;
    }
    if (reason === 'whale') {
      state.stats.whaleExits = (state.stats.whaleExits || 0) + 1;
    }

    const type =
      reason === 'stop' ? 'stopped' : reason === 'whale' ? 'whale_exit' : reason === 'tp' ? 'tp' : 'sell';
    addActivity(state, {
      type,
      symbol: pos.symbol,
      icon: pos.icon,
      agent: label || (reason === 'whale' ? 'Whale Watch' : 'Risk'),
      detail:
        reason === 'whale'
          ? label
          : reason === 'tp'
            ? `ladder ${pct * 100}%`
            : reason === 'stop'
              ? 'hard stop'
              : 'trailing stop',
      amountUsd: proceeds,
      pnl,
      pnlPct,
      mint: pos.mint,
    });

    const sign = pnl >= 0 ? '+' : '';
    setBanner(
      state,
      `${reason === 'whale' ? 'Whale exit' : reason === 'stop' ? 'Stopped' : reason === 'tp' ? 'TP' : 'Sold'} ${pos.symbol} · ${sign}$${Math.abs(pnl).toFixed(2)} (${sign}${pnlPct}%)`,
      pos.icon
    );

    state.notifications.unshift({
      id: uid('n'),
      ts: now(),
      title: `${reason === 'whale' ? 'Whale exit' : reason === 'stop' ? 'Stopped' : 'Sold'} ${pos.symbol}`,
      body: `${sign}$${Math.abs(pnl).toFixed(2)} (${sign}${pnlPct}%)`,
      icon: pos.icon,
      symbol: pos.symbol,
      pnl,
      pnlPct,
    });
    if (state.notifications.length > 20) state.notifications = state.notifications.slice(0, 20);

    pushEquity(state);
    this.persist();
    this.emit();
    return { proceeds, pnl, pnlPct };
  }

  async tickWhales() {
    await this._ready;
    if (this._whaleBusy) return;
    this._whaleBusy = true;
    const state = this.state;
    const settings = state.settings;
    const dropPct = settings.whaleDropPct || 15;
    try {
      const positions = state.positions.slice();
      state.agents.whale.watching = positions.length;
      state.agents.whale.lastRun = now();
      if (!positions.length) {
        state.agents.whale.status = 'idle';
        state.agents.whale.holdersPreview = [];
        this.persist();
        this.emit();
        return;
      }
      state.agents.whale.status = 'watching';
      this.emit();

      const preview = [];
      for (const pos of positions) {
        const t0 = now();
        let supply = (state.whaleWatch[pos.mint] && state.whaleWatch[pos.mint].supply) || null;
        try {
          if (!supply) supply = await getTokenSupply(pos.mint);
          const holders = await getTopHolders(pos.mint, { limit: 10 });
          for (const h of holders) {
            h.pct = supply > 0 ? round((h.amount / supply) * 100, 3) : null;
          }
          const prev = (state.whaleWatch[pos.mint] && state.whaleWatch[pos.mint].holders) || [];
          const events = detectSells(prev, holders, { dropPct, supply });
          const latencyMs = now() - t0;
          state.whaleWatch[pos.mint] = {
            symbol: pos.symbol,
            icon: pos.icon,
            supply,
            holders,
            updatedAt: now(),
            events: [...events, ...((state.whaleWatch[pos.mint] && state.whaleWatch[pos.mint].events) || [])].slice(0, 20),
            latencyMs,
          };
          preview.push({
            symbol: pos.symbol,
            mint: pos.mint,
            icon: pos.icon,
            holders: holders.slice(0, 5).map((h) => ({
              rank: h.rank,
              owner: h.owner,
              pct: h.pct,
              amount: h.amount,
            })),
            latencyMs,
          });

          if (events.length && settings.running && !state.killSwitch) {
            const ev = events[0];
            const detail = `Whale exit: holder #${ev.rank || '?'} sold ${round(ev.soldPctOfBag, 1)}%`;
            state.agents.whale.lastAlert = {
              symbol: pos.symbol,
              detail,
              latencyMs,
              ts: now(),
              owner: ev.owner,
            };
            state.agents.whale.latencyMs = latencyMs;
            state.stats._whaleLatencySum = (state.stats._whaleLatencySum || 0) + latencyMs;
            const n = (state.stats.whaleExits || 0) + 1;
            state.stats.avgWhaleLatencyMs = round(state.stats._whaleLatencySum / n, 0);
            addActivity(state, {
              type: 'whale_alert',
              symbol: pos.symbol,
              icon: pos.icon,
              agent: 'Whale Watch',
              detail: `${detail} · ${latencyMs}ms`,
              mint: pos.mint,
            });
            // still have position?
            if (state.positions.find((p) => p.id === pos.id)) {
              await this.paperSell(pos, 'whale', detail, 1);
            }
          }
        } catch (e) {
          console.warn('whale', pos.symbol, e.message);
        }
      }
      state.agents.whale.holdersPreview = preview;
      state.agents.whale.status = 'watching';
      this.persist();
      this.emit();
    } finally {
      this._whaleBusy = false;
    }
  }

  drainNotifications() {
    const n = this.state.notifications || [];
    this.state.notifications = [];
    this.persist();
    return n;
  }

  getPosition(idOrMint) {
    return (
      this.state.positions.find((p) => p.id === idOrMint || p.mint === idOrMint) || null
    );
  }
}

module.exports = { PaperEngine, equity, DEFAULTS, PRESETS };
