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
  realtimeLaunches,
  realtimeStats,
} = require('./sources');
const { scorePair } = require('./analyst');
const { PRESETS, applyPreset, positionSizeFraction } = require('./strategies');
const { getTopHolders, getTokenSupply, detectSells, detectBuys } = require('./whales');
const { feed } = require('./realtime');
const { ensureWeights, recordClosedTrade, topWeights } = require('./feedback');
const {
  ensureRegistry,
  recordWalletEvent,
  isSmartWallet,
  pushSignal,
  topAddresses,
  smartMoneyOverlap,
} = require('./smartMoney');
const { tagCoin, updateHeatMap, exposureByNarrative } = require('./narratives');
const {
  LANE,
  DEFAULT_LANE_CAPS,
  LANE_DEFAULTS,
  classifyLane,
  laneGates,
  lanePriority,
  laneSizeMult,
  laneRiskProfile,
  exposureByLane,
  laneCapOk,
  bumpLaneStats,
  bondingProgress,
  hasSocials,
} = require('./lanes');
const {
  MODE_TAG,
  AB_ARMS,
  ARM_ORDER,
  emptyArmStats,
  bumpArmStats,
  modeDecision,
  pickArm,
  modeRiskProfile,
  detectSpike,
  estimateSellImpactPct,
  flowNegative,
  buyersFlat,
} = require('./modes');
const { runnerBandAction } = require('./runnerScore');

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
  strategyId: 'ab_harness',
  kellyCap: 0.18,
  maxDailyLossPct: 0.15,
  cooldownMs: 5 * 60e3,
  takeProfitLadder: [
    { mult: 1.5, sellPct: 0.25 },
    { mult: 2.0, sellPct: 0.25 },
  ],
  trailRemainder: true,
  preferGraduating: true,
  preferEarlyLanes: true,
  maxMarketCapUsd: 8_000_000,
  laneCaps: { ...DEFAULT_LANE_CAPS },
  lanes: { ...LANE_DEFAULTS },
  whaleDropPct: 15,
  whalePollMs: 20000,
  scanIntervalMs: 22000,
  priceIntervalMs: 8000,
  lossStreakLimit: 3,
  lossStreakCooldownMs: 12 * 60e3,
  maxNarrativePct: 0.5,
  profitSweepPct: 0.3,
  profitSweepTrigger: 1.35, // equity / starting
  // Live safety caps (enforced even if LIVE_ENABLED flipped — LiveAdapter still stubs)
  liveMaxPerTradeUsd: 25,
  liveMaxDailySpendUsd: 100,
  liveMaxDailyLossUsd: 50,
  liveWalletBalanceCapUsd: 200,
  abHarness: true,
  minRunnerScore: 40,
  riskPerTradePct: 0.002, // 0.20% equity risk budget
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
function short(a) {
  return a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '—';
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


function ensureLaneSettings(state) {
  if (!state || !state.settings) return state;
  const s = state.settings;
  if (s.maxMarketCapUsd == null) s.maxMarketCapUsd = DEFAULTS.maxMarketCapUsd;
  if (s.preferEarlyLanes == null) s.preferEarlyLanes = true;
  s.laneCaps = { ...DEFAULT_LANE_CAPS, ...(s.laneCaps || {}) };
  s.lanes = { ...LANE_DEFAULTS, ...(s.lanes || {}) };
  state.stats = state.stats || emptyStats();
  state.stats.byLane = state.stats.byLane || emptyStats().byLane;
  for (const k of ['FRESH', 'GRAD', 'MOVER']) {
    state.stats.byLane[k] = state.stats.byLane[k] || { trades: 0, buys: 0, pnl: 0, wins: 0, losses: 0 };
  }
  state.stats.byArm = state.stats.byArm || emptyArmStats();
  state.stats.byMode = state.stats.byMode || { SCALP: { trades: 0, pnl: 0, wins: 0, losses: 0 }, RIDE: { trades: 0, pnl: 0, wins: 0, losses: 0 }, MOON: { trades: 0, pnl: 0, wins: 0, losses: 0 } };
  if (s.abHarness == null) s.abHarness = true;
  if (s.minRunnerScore == null) s.minRunnerScore = 40;
  if (s.riskPerTradePct == null) s.riskPerTradePct = 0.002;
  state.scalpWatch = state.scalpWatch || [];
  return state;
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
    whaleEntries: 0,
    avgWhaleLatencyMs: 0,
    _whaleLatencySum: 0,
    lossStreak: 0,
    winStreak: 0,
    sweeps: 0,
    sweptUsd: 0,
    byStrategy: {},
    byLane: { FRESH: { trades: 0, buys: 0, pnl: 0, wins: 0, losses: 0 }, GRAD: { trades: 0, buys: 0, pnl: 0, wins: 0, losses: 0 }, MOVER: { trades: 0, buys: 0, pnl: 0, wins: 0, losses: 0 } },
    byArm: null,
    byMode: { SCALP: { trades: 0, pnl: 0, wins: 0, losses: 0 }, RIDE: { trades: 0, pnl: 0, wins: 0, losses: 0 }, MOON: { trades: 0, pnl: 0, wins: 0, losses: 0 } },
  };
}

function emptyState(settings = {}) {
  const starting = Number(settings.startingBalance) || DEFAULTS.startingBalance;
  const merged = applyPreset({ ...DEFAULTS, ...settings, running: true }, settings.strategyId || 'ab_harness');
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
      preferEarlyLanes: merged.preferEarlyLanes ?? DEFAULTS.preferEarlyLanes,
      maxMarketCapUsd: merged.maxMarketCapUsd ?? DEFAULTS.maxMarketCapUsd,
      laneCaps: { ...DEFAULT_LANE_CAPS, ...(merged.laneCaps || {}) },
      lanes: { ...LANE_DEFAULTS, ...(merged.lanes || {}) },
      whaleDropPct: merged.whaleDropPct ?? DEFAULTS.whaleDropPct,
      whalePollMs: merged.whalePollMs ?? DEFAULTS.whalePollMs,
      lossStreakLimit: merged.lossStreakLimit ?? DEFAULTS.lossStreakLimit,
      lossStreakCooldownMs: merged.lossStreakCooldownMs ?? DEFAULTS.lossStreakCooldownMs,
      maxNarrativePct: merged.maxNarrativePct ?? DEFAULTS.maxNarrativePct,
      profitSweepPct: merged.profitSweepPct ?? DEFAULTS.profitSweepPct,
      profitSweepTrigger: merged.profitSweepTrigger ?? DEFAULTS.profitSweepTrigger,
      abHarness: merged.abHarness != null ? merged.abHarness : DEFAULTS.abHarness,
      minRunnerScore: merged.minRunnerScore != null ? merged.minRunnerScore : DEFAULTS.minRunnerScore,
      riskPerTradePct: merged.riskPerTradePct != null ? merged.riskPerTradePct : DEFAULTS.riskPerTradePct,
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
      scanner: {
        status: 'idle',
        pools: 0,
        recent: [],
        lastRun: 0,
        feed: 'dex',
        wsConnected: false,
        launches: 0,
        migrations: 0,
        flash: null,
      },
      analyst: {
        status: 'idle',
        score: null,
        symbol: null,
        passed: 0,
        scored: 0,
        lastRun: 0,
        topSignals: [],
        weights: [],
        flash: null,
      },
      executor: {
        status: 'idle',
        trades: 0,
        lastFill: null,
        progress: 0,
        lastRun: 0,
        fillSource: null,
        lastImpact: null,
        lastLatencyMs: null,
        jito: true,
        flash: null,
      },
      risk: {
        status: 'idle',
        guarding: null,
        lastAction: null,
        lastRun: 0,
        lossStreak: 0,
        cooldownUntil: 0,
        narrativeExposure: {},
        sweptUsd: 0,
        flash: null,
      },
      whale: {
        status: 'idle',
        watching: 0,
        lastAlert: null,
        lastRun: 0,
        latencyMs: null,
        holdersPreview: [],
        smartHits: 0,
        entrySignals: 0,
        flash: null,
      },
    },
    heatMap: {},
    solReserve: 0, // profit sweep bucket (paper SOL)
    notifications: [],
  };
}

function migrateState(raw) {
  if (!raw) return emptyState();
  if (raw.version === 2) {
    raw.agents = raw.agents || {};
    const empty = emptyState();
    for (const k of Object.keys(empty.agents)) {
      raw.agents[k] = { ...empty.agents[k], ...(raw.agents[k] || {}) };
    }
    raw.whaleWatch = raw.whaleWatch || {};
    raw.stats = { ...emptyStats(), ...(raw.stats || {}) };
    raw.stats.byArm = raw.stats.byArm || emptyArmStats();
    raw.stats.byMode = raw.stats.byMode || emptyStats().byMode;
    raw.scalpWatch = raw.scalpWatch || [];
    if (raw.settings) {
      if (raw.settings.abHarness == null) raw.settings.abHarness = true;
      if (raw.settings.minRunnerScore == null) raw.settings.minRunnerScore = 40;
    }
    raw.ruggedDevs = raw.ruggedDevs || [];
    raw.killSwitch = !!raw.killSwitch;
    raw.mode = 'paper';
    raw.liveEnabled = false;
    raw.heatMap = raw.heatMap || {};
    raw.solReserve = raw.solReserve || 0;
    ensureWeights(raw);
    ensureRegistry(raw);
    raw.settings = {
      ...DEFAULTS,
      ...raw.settings,
      takeProfitLadder: (raw.settings && raw.settings.takeProfitLadder) || DEFAULTS.takeProfitLadder,
    };
    return ensureLaneSettings(raw);
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
    this._tradeUnsub = null;
  }

  async _init() {
    const raw = await loadState();
    this.state = migrateState(raw);
    this.state = ensureLaneSettings(this.state);
    this.state.mode = 'paper';
    this.state.liveEnabled = false;
    ensureWeights(this.state);
    ensureRegistry(this.state);
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
      solReserve: round(s.solReserve || 0, 4),
      heatMap: s.heatMap || {},
      signalWeights: topWeights(s.signalWeights, 6),
      smartMoneyTop: (ensureRegistry(s).wallets || []).slice().sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,5),
      realtime: realtimeStats(),
      disclaimer:
        'PAPER ONLY — Mode: PAPER. PumpPortal WS + DexScreener fallback. Jito-sim fills. Whale Watch RPC + smart-money. LIVE_ENABLED=false. Optional HELIUS_API_KEY for faster RPC.',
    };
  }

  start() {
    this._ready.then(() => {
      if (this._scanTimer) return;
      console.log('[jev] paper engine starting · adapter=', this.adapter.mode());
      try {
        feed.start();
        // Prefer Helius RPC when key present
        const hUrl = feed.heliusRpcUrl();
        if (hUrl) {
          process.env.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || hUrl;
          console.log('[jev] HELIUS_API_KEY detected — using Helius RPC');
        }
        const reg = ensureRegistry(this.state);
        feed.watchAccountTrades(topAddresses(reg, 15));
        this._tradeUnsub = feed.onTrade((msg) => this._onRealtimeTrade(msg));
      } catch (e) {
        console.warn('[jev] realtime feed', e.message);
      }
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
    try {
      if (this._tradeUnsub) this._tradeUnsub();
      feed.stop();
    } catch (_) {}
  }

  _onRealtimeTrade(msg) {
    const state = this.state;
    if (!state) return;
    const mint = msg.mint || msg.token;
    const wallet = msg.traderPublicKey || msg.owner || msg.account;
    const side = (msg.txType || msg.side || '').toLowerCase();
    if (!mint || !wallet) return;
    const reg = ensureRegistry(state);
    const smart = isSmartWallet(reg, wallet);
    const pos = state.positions.find((p) => p.mint === mint);
    if (smart && (side === 'sell' || side === 'sells') && pos && state.settings.running && !state.killSwitch) {
      const detail = `Smart-money sell · ${smart.label || 'wallet'} via WS`;
      state.agents.whale.lastAlert = { symbol: pos.symbol, detail, latencyMs: 50, ts: now(), owner: wallet };
      state.agents.whale.flash = 'alert';
      state.agents.whale.latencyMs = 50;
      pushSignal(reg, { type: 'sell', mint, wallet, symbol: pos.symbol });
      this.paperSell(pos, 'whale', detail, 1).catch(() => {});
    }
    if (smart && (side === 'buy' || side === 'buys') && !smart.skipEntry) {
      pushSignal(reg, { type: 'buy', mint, wallet, symbol: msg.symbol });
      state.agents.whale.entrySignals = (state.agents.whale.entrySignals || 0) + 1;
      state.agents.whale.flash = 'entry';
      recordWalletEvent(reg, wallet, { side: 'buy' });
      // Mark mint as smart-entry candidate for next scan
      state._smartEntryMints = state._smartEntryMints || {};
      state._smartEntryMints[mint] = { wallet, score: smart.score, ts: now() };
    }
  }

  maybeProfitSweep() {
    const state = this.state;
    const settings = state.settings;
    const eq = equity(state);
    const trigger = settings.profitSweepTrigger || 1.35;
    const start = state.startingBalance || 100;
    if (eq < start * trigger) return;
    if (state.cash < 10) return;
    const pct = settings.profitSweepPct || 0.3;
    // Sweep a slice of free cash into paper SOL reserve (locks gains)
    const sweep = round(state.cash * pct, 4);
    if (sweep < 2) return;
    state.cash = round(state.cash - sweep, 4);
    state.solReserve = round((state.solReserve || 0) + sweep, 4);
    state.stats.sweeps = (state.stats.sweeps || 0) + 1;
    state.stats.sweptUsd = round((state.stats.sweptUsd || 0) + sweep, 4);
    state.agents.risk.sweptUsd = state.stats.sweptUsd;
    state.agents.risk.flash = 'profit';
    state.agents.risk.lastAction = { symbol: 'SOL', reason: 'sweep', pnl: sweep, pnlPct: 0 };
    addActivity(state, {
      type: 'sweep',
      symbol: 'SOL',
      agent: 'Risk',
      detail: `Profit sweep ${round(pct * 100, 0)}% → reserve`,
      amountUsd: sweep,
      pnl: sweep,
      pnlPct: 0,
    });
    setBanner(state, `Swept $${sweep.toFixed(2)} to SOL reserve · Mode: PAPER`, null);
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
        preferEarlyLanes: next.preferEarlyLanes,
        maxMarketCapUsd: next.maxMarketCapUsd,
        lossStreakLimit: next.lossStreakLimit,
        lossStreakCooldownMs: next.lossStreakCooldownMs,
        maxNarrativePct: next.maxNarrativePct,
        profitSweepPct: next.profitSweepPct,
        profitSweepTrigger: next.profitSweepTrigger,
        abHarness: next.abHarness,
        minRunnerScore: next.minRunnerScore,
      });
    }
    const keys = [
      'minLiquidity', 'buyPctMin', 'buyPctMax', 'maxPositions', 'stopPct', 'trailPct',
      'slippage', 'minScore', 'running', 'kellyCap', 'maxDailyLossPct', 'cooldownMs',
      'whaleDropPct', 'whalePollMs', 'preferGraduating', 'preferEarlyLanes', 'maxMarketCapUsd',
      'lossStreakLimit', 'lossStreakCooldownMs', 'maxNarrativePct', 'profitSweepPct', 'profitSweepTrigger',
      'abHarness', 'minRunnerScore', 'riskPerTradePct',
      'liveMaxPerTradeUsd', 'liveMaxDailySpendUsd', 'liveMaxDailyLossUsd', 'liveWalletBalanceCapUsd',
    ];
    for (const k of keys) {
      if (patch[k] == null || patch[k] === '') continue;
      if (typeof patch[k] === 'boolean') s[k] = patch[k];
      else if (Number.isFinite(Number(patch[k]))) s[k] = Number(patch[k]);
    }
    if (Array.isArray(patch.takeProfitLadder)) s.takeProfitLadder = patch.takeProfitLadder;
    if (patch.laneCaps && typeof patch.laneCaps === 'object') {
      s.laneCaps = { ...DEFAULT_LANE_CAPS, ...s.laneCaps, ...patch.laneCaps };
    }
    if (patch.lanes && typeof patch.lanes === 'object') {
      s.lanes = { ...LANE_DEFAULTS, ...s.lanes, ...patch.lanes };
    }
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

      const rt = realtimeLaunches();
      const rtStats = realtimeStats();
      state.agents.scanner.wsConnected = !!rtStats.connected;
      state.agents.scanner.launches = rtStats.launches || 0;
      state.agents.scanner.migrations = rtStats.migrations || 0;
      state.agents.scanner.feed = rtStats.connected ? 'pumpportal+dex' : 'dex-fallback';

      const [ds, pumpNew, pumpGrad, gecko] = await Promise.all([
        dexscreenerDiscover().catch(() => ({ mints: [], icons: new Map(), meta: new Map() })),
        pumpNewTokens().catch(() => []),
        pumpGraduating().catch(() => []),
        geckoNewPools().catch(() => []),
      ]);

      const mintSet = new Set(ds.mints || []);
      const icons = ds.icons || new Map();
      const graduating = new Set();
      const creators = new Map();
      for (const r of rt) {
        if (r.mint) {
          mintSet.add(r.mint);
          if (r.graduating) graduating.add(r.mint);
          if (r.creator) creators.set(r.mint, r.creator);
          if (r.symbol && r.icon) icons.set(r.mint, r.icon);
        }
      }
      const pumpMeta = new Map(); // mint -> enriched pump fields
      for (const p of pumpNew) {
        if (!p.mint) continue;
        mintSet.add(p.mint);
        pumpMeta.set(p.mint, { ...p, source: p.source || 'pump.fun' });
      }
      for (const p of pumpGrad) {
        if (!p.mint) continue;
        mintSet.add(p.mint);
        graduating.add(p.mint);
        const prev = pumpMeta.get(p.mint) || {};
        pumpMeta.set(p.mint, { ...prev, ...p, graduating: true, source: p.source || 'pump.grad' });
      }
      for (const r of rt) {
        if (!r.mint) continue;
        const prev = pumpMeta.get(r.mint) || {};
        pumpMeta.set(r.mint, {
          ...prev,
          ...r,
          source: r.source || prev.source,
          graduating: !!(r.graduating || prev.graduating),
        });
      }
      for (const g of gecko) if (g.mint) mintSet.add(g.mint);
      // Boost smart-money entry mints
      for (const m of Object.keys(state._smartEntryMints || {})) mintSet.add(m);

      const mints = [...mintSet].slice(0, 80);
      const pairs = await this.fetchPairsForMints(mints);
      for (const p of pairs) {
        if (!p.icon && icons.has(p.mint)) p.icon = icons.get(p.mint);
        const pm = pumpMeta.get(p.mint);
        if (pm) {
          if (pm.source) p.source = pm.source;
          if (pm.bondingProgress != null) p.bondingProgress = pm.bondingProgress;
          if (pm.hasSocials) p.hasSocials = true;
          if (pm.creator) p.creator = pm.creator;
          if (pm.complete) p.complete = true;
          if (pm.raydiumPool) p.raydiumPool = pm.raydiumPool;
          if (pm.createdMs && !p.pairCreatedAt) {
            p.pairCreatedAt = pm.createdMs;
            p.ageMs = now() - pm.createdMs;
          }
          if (pm.graduating) {
            p.graduating = true;
            graduating.add(p.mint);
          }
          if (!p.icon && pm.icon) p.icon = pm.icon;
          if (!p.marketCap && pm.marketCap) p.marketCap = pm.marketCap;
        }
        if (graduating.has(p.mint)) {
          p.graduating = true;
          if (!p.source || p.source === 'dex') p.source = 'pump.grad';
        }
        const meta = ds.meta && ds.meta.get(p.mint);
        if (meta) {
          p.socials = meta.socials || p.socials;
          p.websites = meta.websites || p.websites;
        }
        if (icons.has(p.mint) || (ds.mints || []).includes(p.mint)) p.boosted = true;
        // classify lane early
        const info = classifyLane(p, settings);
        p.lane = info.lane;
        p._laneInfo = info;
        if (info.progress != null && p.bondingProgress == null) p.bondingProgress = info.progress;
        p.buyersPerMin = (Number(p.buysM5) || 0) / 5;
      }

      state.agents.scanner.pools = pairs.length;
      const laneExp = exposureByLane(state.positions);
      state.agents.scanner.laneExposure = laneExp;

      const filtered = pairs
        .filter((p) => !isMajor(p) && p.priceUsd > 0)
        .filter((p) => !state.ruggedDevs.includes(p.mint))
        .filter((p) => {
          const g = laneGates(p, p._laneInfo || classifyLane(p, settings), settings);
          p._laneGate = g;
          if (!g.ok) return false;
          // lane-specific liquidity floor (gates handle FRESH/GRAD/MOVER)
          if (p.lane === LANE.MOVER && p.liquidity < (settings.minLiquidity || 25000)) return false;
          if (p.lane === LANE.FRESH && p.liquidity > 0 && p.liquidity < ((settings.lanes && settings.lanes.freshMinLiq) || 2500)) return false;
          if (p.lane === LANE.GRAD && p.liquidity > 0 && p.liquidity < ((settings.lanes && settings.lanes.gradMinLiq) || 8000)) return false;
          return true;
        })
        .sort((a, b) => {
          if (settings.preferEarlyLanes !== false) {
            const dp = lanePriority(b.lane) - lanePriority(a.lane);
            if (dp) return dp;
          } else if (settings.preferGraduating) {
            const ag = a.graduating ? 1 : 0;
            const bg = b.graduating ? 1 : 0;
            if (bg !== ag) return bg - ag;
          }
          // prefer faster bonding velocity / younger within lane
          if (a.lane === LANE.FRESH || b.lane === LANE.FRESH) {
            const aa = a.ageMs != null ? a.ageMs : 1e15;
            const ba = b.ageMs != null ? b.ageMs : 1e15;
            if (aa !== ba) return aa - ba;
          }
          return (b.volumeH1 || 0) - (a.volumeH1 || 0);
        });

      const rejects = pairs
        .filter((p) => p._laneGate && !p._laneGate.ok)
        .slice(0, 3)
        .map((p) => ({ symbol: p.symbol, icon: p.icon, tag: p._laneGate.why || 'skip', ok: false }));
      const goods = filtered.slice(0, 4).map((p) => ({
        symbol: p.symbol,
        icon: p.icon,
        tag: p.lane || (p.graduating ? 'GRAD' : 'scan'),
        ok: true,
      }));
      state.agents.scanner.recent = [...rejects.slice(0, 2), ...goods].slice(0, 5);
      state.scanned = filtered.slice(0, 20);
      state.heatMap = updateHeatMap(filtered.slice(0, 40));
      state.agents.scanner.status = rtStats.connected ? 'streaming' : 'idle';
      if (rt.length) state.agents.scanner.flash = 'pulse';

      if (!settings.running || state.killSwitch) {
        this.persist();
        this.emit();
        return;
      }

      if (this.dailyLossHit()) {
        state.agents.risk.flash = 'block';
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
      const reg = ensureRegistry(state);
      const narrExp = exposureByNarrative(state.positions);
      state.agents.risk.narrativeExposure = narrExp;
      const scored = [];
      for (const p of filtered.slice(0, 18)) {
        if (!p.lane) {
          const info = classifyLane(p, settings);
          p.lane = info.lane;
          p._laneInfo = info;
        }
        let holders = [];
        try {
          // light holder peek for smart-money overlap on top candidates only
          if (scored.length < 6) {
            holders = await getTopHolders(p.mint, { limit: 8 });
          }
        } catch (_) {}
        const r = await scorePair(p, settings, {
          state,
          heatMap: state.heatMap,
          smartMoney: reg,
          holders,
        });
        if (r.blacklistDev && p.mint) {
          if (!state.ruggedDevs.includes(p.mint)) state.ruggedDevs.push(p.mint);
        }
        // Smart-money entry boost
        const se = state._smartEntryMints && state._smartEntryMints[p.mint];
        if (se && now() - se.ts < 15 * 60e3) {
          r.score = Math.min(100, r.score + 8);
          r.breakdown = [...(r.breakdown || []), { k: 'smartMoney', v: 8, note: 'WS buy signal' }];
          r.pass = r.score >= (settings.minScore || 70);
        }
        scored.push({ ...p, ...r, narratives: r.narratives || tagCoin(p) });
      }
      scored.sort((a, b) => b.score - a.score);
      state.scored = scored.slice(0, 15);
      state.agents.analyst.scored = (state.agents.analyst.scored || 0) + scored.length;
      state.agents.analyst.lastRun = now();
      state.agents.analyst.weights = topWeights(state.signalWeights, 4);
      const top = scored[0];
      if (top) {
        state.agents.analyst.score = top.score;
        state.agents.analyst.symbol = top.symbol;
        state.agents.analyst.topSignals = (top.breakdown || []).slice().sort((a,b)=>b.v-a.v).slice(0,3);
        state.agents.analyst.status = top.pass ? 'passed' : 'scoring';
        state.agents.analyst.flash = top.pass ? 'pulse' : null;
      } else {
        state.agents.analyst.status = 'idle';
      }

      const openMints = new Set(state.positions.map((p) => p.mint));
      const eqNow = equity(state);
      const candidates = scored.filter((p) => {
        if (!p.pass || openMints.has(p.mint) || state.seenMints.includes(p.mint)) return false;
        // per-narrative exposure cap
        const tags = p.narratives || tagCoin(p);
        const maxNarr = settings.maxNarrativePct || 0.5;
        for (const t of tags) {
          const exp = (narrExp[t] || 0) / Math.max(eqNow, 1);
          if (exp >= maxNarr) {
            p.narrativeOverExposed = true;
            return false;
          }
        }
        const lane = p.lane || LANE.MOVER;
        if (!laneCapOk(lane, state.positions, eqNow, settings)) {
          p.laneCapHit = true;
          return false;
        }
        return true;
      });
      // Prefer FRESH/GRAD over MOVER when scores are close
      candidates.sort((a, b) => {
        if (settings.preferEarlyLanes !== false) {
          const dp = lanePriority(b.lane) - lanePriority(a.lane);
          if (dp && Math.abs((b.score || 0) - (a.score || 0)) < 12) return dp;
        }
        return (b.score || 0) - (a.score || 0);
      });

      // loss-streak cooldown already handled above; also block if streak cooldown
      if (state.stats.lossStreak >= (settings.lossStreakLimit || 3) && state.cooldownUntil > now()) {
        state.agents.risk.status = 'cooldown';
        state.agents.risk.lossStreak = state.stats.lossStreak;
      } else if (candidates.length && state.positions.length < settings.maxPositions && state.cash > 5) {
        const pick = candidates[0];
        state.agents.analyst.passed = (state.agents.analyst.passed || 0) + 1;
        await this.paperBuy(pick);
      } else {
        state.agents.analyst.status = top ? (top.pass ? 'passed' : 'idle') : 'idle';
      }

      this.maybeProfitSweep();

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
    if (state.killSwitch || !settings.running) {
      if (state.killSwitch) state.agents.risk.flash = 'block';
      return null;
    }
    if (state.positions.length >= settings.maxPositions) return null;
    if (!pair.priceUsd || pair.priceUsd <= 0) return null;

    const narrExp = exposureByNarrative(state.positions);
    const tags = pair.narratives || tagCoin(pair);
    const eq = equity(state);
    let over = false;
    for (const t of tags) {
      if ((narrExp[t] || 0) / Math.max(eq, 1) >= (settings.maxNarrativePct || 0.5) * 0.85) over = true;
    }
    const lane = pair.lane || (classifyLane(pair, settings).lane);
    pair.lane = lane;
    if (!laneCapOk(lane, state.positions, eq, settings)) {
      addActivity(state, {
        type: 'skip',
        symbol: pair.symbol,
        icon: pair.icon,
        agent: 'Risk',
        detail: `${lane} lane cap hit`,
        mint: pair.mint,
      });
      return null;
    }
    // A/B harness arm + runner mode
    const arm = settings.abHarness === false ? AB_ARMS.CONTROL : pickArm(state);
    const rScore = Number(pair.runnerScore) || 0;
    if (arm.useRunnerGate && rScore < (arm.minRunner || 40)) {
      addActivity(state, {
        type: 'skip',
        symbol: pair.symbol,
        icon: pair.icon,
        agent: 'Analyst',
        detail: `${arm.id} skip · runner ${rScore} < ${arm.minRunner}`,
        mint: pair.mint,
        lane,
        abArm: arm.id,
        runnerScore: rScore,
      });
      return null;
    }
    const decision = modeDecision(
      { score: rScore },
      { ...pair, buyersPerMin: pair.buyersPerMin },
      { top10: (pair.rug && (pair.rug.top10Pct || pair.rug.topHolderPct)) || 0, smartHits: (pair.smartMoney && pair.smartMoney.hits) || 0 }
    );
    let modeLetter = arm.forcedMode || decision.mode || 'A';
    if (!arm.useRunnerGate && settings.abHarness === false) {
      // pure control: no mode tagging beyond RIDE default ladder
      modeLetter = 'A';
    }
    if (arm.id === 'CONTROL') modeLetter = modeLetter || 'A';
    const modeTag = MODE_TAG[modeLetter] || 'RIDE';
    const modeRisk = modeRiskProfile(modeLetter, rScore, arm.risk);
    const laneRisk = laneRiskProfile(lane, settings);
    // Merge: arm/mode overrides lane for treatment; control keeps lane + settings
    const risk =
      arm.id === 'CONTROL'
        ? { ...laneRisk, spikeExit: false, liquidityShockPct: 0.15, allowReentry: false }
        : {
            stopPct: modeRisk.stopPct,
            trailPct: modeRisk.trailPct,
            takeProfitLadder: modeRisk.takeProfitLadder || laneRisk.takeProfitLadder,
            timeStopMs: modeRisk.timeStopMs != null ? modeRisk.timeStopMs : laneRisk.timeStopMs,
            ...modeRisk,
          };

    let frac = positionSizeFraction(pair.score, settings, {
      priceChangeH1: pair.priceChangeH1,
      liquidity: pair.liquidity,
      narrativeOverExposed: over,
    });
    frac *= laneSizeMult(lane, settings);
    frac *= arm.sizeMult != null ? arm.sizeMult : 1;
    if (pair.runnerAction && pair.runnerAction.sizeMult) frac *= pair.runnerAction.sizeMult;
    // Playbook sizing: cap notional by riskPerTradePct / |stop|
    const stopAbs = Math.abs(risk.stopPct != null ? risk.stopPct : settings.stopPct || 0.06);
    const riskBudget = eq * (settings.riskPerTradePct || 0.002);
    const riskCapFrac = stopAbs > 0 ? riskBudget / (eq * stopAbs) : frac;
    frac = Math.min(frac, Math.max(0.04, riskCapFrac));
    // Tighten until expectancy proven
    frac = Math.min(frac, settings.buyPctMax != null ? Math.min(settings.buyPctMax, 0.15) : 0.15);
    let spend = round(eq * frac, 2);
    spend = Math.min(spend, round(state.cash * 0.95, 2));
    if (settings.liveMaxPerTradeUsd) spend = Math.min(spend, settings.liveMaxPerTradeUsd);
    if (spend < 2) return null;

    state.agents.executor.status = 'buying';
    state.agents.executor.progress = 0;
    state.agents.executor.jito = true;
    state.agents.executor.lastFill = {
      symbol: pair.symbol,
      amountUsd: spend,
      pct: round(frac * 100, 1),
      icon: pair.icon,
    };
    this.emit();
    for (const step of [30, 65, 100]) {
      await new Promise((r) => setTimeout(r, 80));
      state.agents.executor.progress = step;
      this.emit();
    }

    const fill = await this.adapter.buy(pair.mint, spend, {
      markPrice: pair.priceUsd,
      liquidity: pair.liquidity,
      baseSlippage: settings.slippage,
      urgency: lane === LANE.FRESH || pair.graduating ? 'high' : 'normal',
      lane,
    });
    const fillPrice = fill.fillPrice || pair.priceUsd * (1 + settings.slippage);
    const tokens = fill.tokens || spend / fillPrice;
    const feeUsd = round((fill.priorityFeeSol || 0) * (pair.solPriceUsd || 150) + spend * 0.0025, 4);
    const netSpend = round(spend + feeUsd, 4); // full priority fee drag
    const stopPct = risk.stopPct != null ? risk.stopPct : settings.stopPct;
    const trailPct = risk.trailPct != null ? risk.trailPct : settings.trailPct;
    const stopPrice = fillPrice * (1 + stopPct);
    const ladderSrc = risk.takeProfitLadder || settings.takeProfitLadder || [];
    const ladder = ladderSrc.map((r) => ({
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
      trailPct,
      highSinceEntry: fillPrice,
      trailStop: fillPrice * (1 - trailPct),
      ladder,
      trailRemainder: !!settings.trailRemainder,
      openedAt: now(),
      timeStopAt: risk.timeStopMs ? now() + risk.timeStopMs : null,
      lane,
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
      bondingProgress: pair.bondingProgress != null ? pair.bondingProgress : bondingProgress(pair),
      graduating: !!pair.graduating,
      fillSource: fill.source || 'paper',
      impactPct: fill.impactPct || 0,
      latencyMs: fill.latencyMs || 0,
      priorityFeeSol: fill.priorityFeeSol || 0,
      jito: !!fill.jito,
      dynSlippage: fill.dynSlippage || null,
      narratives: tags,
      strategyId: settings.strategyId,
      priceHistory: [{ t: now(), price: pair.priceUsd }],
      whaleMeta: { lastPoll: 0, alerted: false },
      runnerScore: rScore,
      runnerBand: pair.runnerBand || null,
      runnerBreakdown: pair.runnerBreakdown || [],
      abArm: arm.id,
      tradeMode: modeTag,
      modeLetter,
      spikeExit: !!risk.spikeExit,
      spikeSellPct: risk.spikeSellPct != null ? risk.spikeSellPct : 0.4,
      liquidityShockPct: risk.liquidityShockPct != null ? risk.liquidityShockPct : 0.1,
      allowReentry: !!risk.allowReentry,
      initialsAt2x: !!risk.initialsAt2x,
      widenStopAfterInitials: !!risk.widenStopAfterInitials,
      moonbagMinFrac: risk.moonbagMinFrac || 0,
      initialsTaken: false,
      spikeSoldAt: null,
      reentries: 0,
      flowNegSince: null,
      buyersFlatSince: null,
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
    state.agents.executor.fillSource = fill.source || 'jito-sim';
    state.agents.executor.lastImpact = round(fill.impactPct || 0, 2);
    state.agents.executor.lastLatencyMs = fill.latencyMs || 0;
    state.agents.executor.flash = 'pulse';
    state.agents.risk.status = 'guarding';
    state.agents.risk.guarding = pair.symbol;
    state.stats.trades = (state.stats.trades || 0) + 1;
    // watch mint trades on WS when keyed
    try {
      feed.watchTokenTrades([pair.mint]);
    } catch (_) {}

    bumpLaneStats(state.stats, lane, { isBuy: true });
    bumpArmStats(state.stats, arm.id, { isBuy: true });
    addActivity(state, {
      type: 'buy',
      symbol: pair.symbol,
      icon: pair.icon,
      agent: 'Executor',
      detail: `${lane} · ${modeTag} · ${arm.id} · R${rScore} · ${round(frac * 100, 0)}% · ${fill.source || 'jito-sim'}`,
      amountUsd: spend,
      pnl: null,
      pnlPct: null,
      mint: pair.mint,
      lane,
      abArm: arm.id,
      tradeMode: modeTag,
      runnerScore: rScore,
    });
    setBanner(
      state,
      `Bought ${pair.symbol} [${lane}/${modeTag}/${arm.id}] R${rScore} · $${spend.toFixed(2)} · PAPER`,
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
    const watchMints = (state.scalpWatch || []).map((w) => w && w.mint).filter(Boolean);
    if (!state.positions.length && !watchMints.length) {
      pushEquity(state);
      this.persist();
      this.emit();
      return;
    }

    const mints = [...new Set(state.positions.map((p) => p.mint).concat(watchMints))];
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

      // Liquidity shock — impact-based exit (all modes)
      const shockLim = pos.liquidityShockPct != null ? pos.liquidityShockPct : 0.1;
      const impactEst = estimateSellImpactPct(pos, 1);
      if (impactEst >= shockLim || (pos.liquidity > 0 && live.liquidity > 0 && live.liquidity < pos.liquidity * 0.35)) {
        closes.push({ pos, reason: 'liq_shock', label: 'Risk liquidity shock', sellPct: 1 });
        continue;
      }

      // Flow / buyer time-stops (playbook §5)
      if (flowNegative(live, pos)) {
        pos.flowNegSince = pos.flowNegSince || now();
      } else {
        pos.flowNegSince = null;
      }
      if (buyersFlat(live)) {
        pos.buyersFlatSince = pos.buyersFlatSince || now();
      } else {
        pos.buyersFlatSince = null;
      }
      const modeTag = pos.tradeMode || 'RIDE';
      if (pos.flowNegSince && now() - pos.flowNegSince >= 120000) {
        const cut = modeTag === 'MOON' ? 0.35 : 0.5;
        closes.push({ pos, reason: 'flow', label: 'Risk neg-flow cut', sellPct: cut });
      }
      if (pos.buyersFlatSince && now() - pos.buyersFlatSince >= 5 * 60e3 && modeTag !== 'MOON') {
        closes.push({ pos, reason: 'time', label: 'Risk flat-buyers exit', sellPct: 1 });
        continue;
      }

      if (px <= pos.stopPrice) {
        closes.push({ pos, reason: 'stop', label: 'Risk hard stop', sellPct: 1 });
        continue;
      }
      if (pos.timeStopAt && now() >= pos.timeStopAt) {
        closes.push({ pos, reason: 'time', label: `Risk time-stop (${pos.lane || 'FRESH'}/${modeTag})`, sellPct: 1 });
        continue;
      }

      // Mode A/B spike partial
      if (pos.spikeExit && !pos.spikeSoldAt && detectSpike(pos, live)) {
        const sp = pos.spikeSellPct != null ? pos.spikeSellPct : 0.4;
        pos.spikeSoldAt = now();
        // tighten trail after spike
        pos.trailStop = Math.max(pos.entryPrice, pos.highSinceEntry * (1 - pos.trailPct * 0.5));
        closes.push({ pos, reason: 'spike', label: `Risk spike TP ${modeTag}`, sellPct: sp });
        if (pos.allowReentry) {
          state.scalpWatch = state.scalpWatch || [];
          state.scalpWatch.push({
            mint: pos.mint,
            symbol: pos.symbol,
            icon: pos.icon,
            localHigh: pos.highSinceEntry,
            arm: pos.abArm,
            runnerScore: pos.runnerScore,
            mode: pos.tradeMode,
            sizeUsd: pos.remainingUsdBasis * (1 - sp),
            expiresAt: now() + 60 * 60e3,
            reentries: pos.reentries || 0,
            cooldownUntil: now() + 60000,
          });
        }
      }

      // laddered take profits (+ Mode C initials @ 2x)
      pos.ladder = pos.ladder || [];
      for (const rung of pos.ladder) {
        if (rung.hit) continue;
        if (px >= pos.entryPrice * rung.mult) {
          rung.hit = true;
          let sellPct = rung.sellPct;
          // moonbag floor
          const rem = pos.tokens / Math.max(pos.tokensInitial || pos.tokens, 1e-12);
          if (pos.moonbagMinFrac && rem - sellPct < pos.moonbagMinFrac) {
            sellPct = Math.max(0, rem - pos.moonbagMinFrac);
          }
          if (sellPct <= 0.01) continue;
          if (pos.initialsAt2x && rung.mult >= 2 && !pos.initialsTaken) {
            pos.initialsTaken = true;
            if (pos.widenStopAfterInitials) {
              pos.stopPrice = Math.min(pos.stopPrice, pos.entryPrice * 0.5); // effectively disable tight SL
              pos.trailPct = Math.max(pos.trailPct, 0.25);
            }
          }
          closes.push({
            pos,
            reason: 'tp',
            label: `Risk TP ${rung.mult}x ${modeTag}`,
            sellPct,
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
        closes.push({ pos, reason: 'trail', label: `Risk trailing stop ${modeTag}`, sellPct: 1 });
      }
    }

    // Mode B re-entry: reclaim after spike scalp
    if (settings.running && !state.killSwitch && state.scalpWatch && state.scalpWatch.length) {
      const keep = [];
      for (const w of state.scalpWatch) {
        if (!w || now() > (w.expiresAt || 0)) continue;
        if (w.cooldownUntil && now() < w.cooldownUntil) {
          keep.push(w);
          continue;
        }
        if ((w.reentries || 0) >= 2) continue;
        if (state.positions.some((p) => p.mint === w.mint)) {
          keep.push(w);
          continue;
        }
        const live = byMint.get(w.mint);
        if (!live || !live.priceUsd) {
          keep.push(w);
          continue;
        }
        const pullback = w.localHigh ? (w.localHigh - live.priceUsd) / w.localHigh : 0;
        const reclaim = live.priceUsd >= (w.localHigh || 0) * 0.97;
        const bpmOk = (Number(live.buysM5) || 0) / 5 >= 0.5;
        const flowOk = (Number(live.buysM5) || 0) >= (Number(live.sellsM5) || 0);
        if (pullback >= 0.08 && pullback <= 0.22 && reclaim && bpmOk && flowOk && state.cash > 5) {
          // synthesize a pair for re-buy
          const pair = {
            ...live,
            score: 70,
            runnerScore: w.runnerScore || 45,
            runnerBand: 'scalp',
            lane: live.lane || 'MOVER',
            breakdown: [{ k: 'reentry', v: 10, note: 'mode-B reclaim' }],
            narratives: [],
          };
          // Force T2-like sizing via temporary arm cursor — tag on activity after buy
          const before = state.positions.length;
          const pos = await this.paperBuy(pair);
          if (pos) {
            pos.tradeMode = 'SCALP';
            pos.modeLetter = 'B';
            pos.abArm = w.arm || 'T2';
            pos.allowReentry = true;
            pos.reentries = (w.reentries || 0) + 1;
            pos.stopPct = -0.08;
            pos.stopPrice = pos.entryPrice * 0.92;
            // don't re-queue
            continue;
          }
        }
        keep.push(w);
      }
      state.scalpWatch = keep.slice(-30);
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

    const urgency =
      reason === 'whale' || reason === 'stop' || reason === 'liq_shock' ? 'high' : reason === 'trail' || reason === 'spike' ? 'normal' : 'normal';
    const fill = await this.adapter.sell(pos.mint, tokensToSell, {
      markPrice: pos.markPrice || pos.entryPrice,
      liquidity: pos.liquidity,
      baseSlippage: state.settings.slippage,
      urgency,
      reason,
      lane: pos.lane || null,
    });
    const fillPrice = fill.fillPrice || (pos.markPrice || pos.entryPrice) * (1 - state.settings.slippage);
    const proceeds = round(fill.proceedsUsd != null ? fill.proceedsUsd : tokensToSell * fillPrice, 4);
    const feeDrag = round((fill.priorityFeeSol || 0) * 150, 4);
    const basis = round(pos.remainingUsdBasis * pct, 4);
    const pnl = round(proceeds - basis - feeDrag * 0.25, 4);
    const pnlPct = basis > 0 ? round((pnl / basis) * 100, 2) : 0;

    state.cash = round(state.cash + proceeds - feeDrag * 0.25, 4);
    state.dayRealizedPnl = round((state.dayRealizedPnl || 0) + pnl, 4);
    state.agents.executor.lastImpact = round(fill.impactPct || 0, 2);
    state.agents.executor.lastLatencyMs = fill.latencyMs || 0;
    state.agents.executor.fillSource = fill.source || 'jito-sim';
    if (pnl > 0) {
      state.agents.executor.flash = 'profit';
      state.agents.risk.flash = 'profit';
    } else if (pnl < 0) {
      state.agents.executor.flash = 'loss';
      state.agents.risk.flash = 'loss';
    }

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

    // stats + feedback loop
    if (fullClose || reason === 'tp') {
      state.stats.realizedPnl = round((state.stats.realizedPnl || 0) + pnl, 4);
      if (pnl >= 0) {
        state.stats.wins = (state.stats.wins || 0) + 1;
        state.stats.winStreak = (state.stats.winStreak || 0) + 1;
        state.stats.lossStreak = 0;
      } else {
        state.stats.losses = (state.stats.losses || 0) + 1;
        state.stats.lossStreak = (state.stats.lossStreak || 0) + 1;
        state.stats.winStreak = 0;
        const lim = state.settings.lossStreakLimit || 3;
        if (state.stats.lossStreak >= lim) {
          state.cooldownUntil = now() + (state.settings.lossStreakCooldownMs || state.settings.cooldownMs || 300000);
          state.agents.risk.status = 'cooldown';
          state.agents.risk.lossStreak = state.stats.lossStreak;
          state.agents.risk.cooldownUntil = state.cooldownUntil;
          addActivity(state, {
            type: 'risk',
            symbol: '—',
            agent: 'Risk',
            detail: `Loss streak ${state.stats.lossStreak} → cooldown`,
          });
        }
      }
      state.agents.risk.lossStreak = state.stats.lossStreak || 0;
      state.stats.bestTrade = Math.max(state.stats.bestTrade || 0, pnl);
      state.stats.worstTrade = Math.min(state.stats.worstTrade || 0, pnl);
      const sid = pos.strategyId || state.settings.strategyId || 'ab_harness';
      state.stats.byStrategy[sid] = state.stats.byStrategy[sid] || { trades: 0, pnl: 0, wins: 0 };
      state.stats.byStrategy[sid].trades += 1;
      state.stats.byStrategy[sid].pnl = round(state.stats.byStrategy[sid].pnl + pnl, 4);
      if (pnl >= 0) state.stats.byStrategy[sid].wins += 1;
      bumpLaneStats(state.stats, pos.lane || LANE.MOVER, { pnl, win: pnl >= 0 });
      bumpArmStats(state.stats, pos.abArm || 'CONTROL', { pnl, win: pnl >= 0 });
      const mt = pos.tradeMode || 'RIDE';
      state.stats.byMode = state.stats.byMode || {};
      state.stats.byMode[mt] = state.stats.byMode[mt] || { trades: 0, pnl: 0, wins: 0, losses: 0 };
      state.stats.byMode[mt].trades += 1;
      state.stats.byMode[mt].pnl = round(state.stats.byMode[mt].pnl + pnl, 4);
      if (pnl >= 0) state.stats.byMode[mt].wins += 1;
      else state.stats.byMode[mt].losses += 1;
      if (fullClose) {
        recordClosedTrade(state, {
          breakdown: pos.scoreBreakdown,
          pnl,
          pnlPct,
        });
        state.agents.analyst.weights = topWeights(state.signalWeights, 4);
      }
    }
    if (reason === 'whale') {
      state.stats.whaleExits = (state.stats.whaleExits || 0) + 1;
    }
    if (fullClose) this.maybeProfitSweep();

    const type =
      reason === 'stop' || reason === 'time' || reason === 'liq_shock'
        ? 'stopped'
        : reason === 'whale'
          ? 'whale_exit'
          : reason === 'tp' || reason === 'spike'
            ? 'tp'
            : reason === 'flow'
              ? 'sell'
              : 'sell';
    const modeBit = pos.tradeMode ? ` · ${pos.tradeMode}` : '';
    const armBit = pos.abArm ? ` · ${pos.abArm}` : '';
    const rBit = pos.runnerScore != null ? ` · R${pos.runnerScore}` : '';
    addActivity(state, {
      type,
      symbol: pos.symbol,
      icon: pos.icon,
      agent: label || (reason === 'whale' ? 'Whale Watch' : 'Risk'),
      detail:
        reason === 'whale'
          ? label
          : reason === 'tp'
            ? `${pos.lane || ''} ladder ${Math.round(pct * 100)}%${modeBit}${armBit}${rBit}`.trim()
            : reason === 'spike'
              ? `${pos.lane || ''} spike ${Math.round(pct * 100)}%${modeBit}${armBit}`.trim()
              : reason === 'liq_shock'
                ? `${pos.lane || ''} liq shock${modeBit}${armBit}`.trim()
                : reason === 'flow'
                  ? `${pos.lane || ''} neg-flow${modeBit}`.trim()
                  : reason === 'stop'
                    ? `${pos.lane || ''} hard stop${modeBit}${armBit}${rBit}`.trim()
                    : reason === 'time'
                      ? `${pos.lane || 'FRESH'} time-stop${modeBit}`
                      : `${pos.lane || ''} trailing stop${modeBit}${armBit}`.trim(),
      amountUsd: proceeds,
      pnl,
      pnlPct,
      mint: pos.mint,
      lane: pos.lane || null,
      abArm: pos.abArm || null,
      tradeMode: pos.tradeMode || null,
      runnerScore: pos.runnerScore != null ? pos.runnerScore : null,
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
          const buyEvents = detectBuys(prev, holders, { risePct: 25, supply });
          const latencyMs = now() - t0;
          const reg = ensureRegistry(state);
          const overlap = smartMoneyOverlap(reg, holders);
          state.agents.whale.smartHits = overlap.hits;
          state.whaleWatch[pos.mint] = {
            symbol: pos.symbol,
            icon: pos.icon,
            supply,
            holders,
            updatedAt: now(),
            events: [...events, ...((state.whaleWatch[pos.mint] && state.whaleWatch[pos.mint].events) || [])].slice(0, 20),
            buyEvents: buyEvents.slice(0, 10),
            smartMoney: overlap,
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
              smart: !!isSmartWallet(reg, h.owner),
            })),
            latencyMs,
          });

          // Smart-money buy on open position → hold / trail tighten note
          for (const be of buyEvents) {
            const sm = isSmartWallet(reg, be.owner);
            if (sm && !sm.skipEntry) {
              recordWalletEvent(reg, be.owner, { side: 'buy' });
              pushSignal(reg, { type: 'buy', mint: pos.mint, wallet: be.owner, symbol: pos.symbol });
              state.agents.whale.entrySignals = (state.agents.whale.entrySignals || 0) + 1;
              state.agents.whale.flash = 'entry';
              state.stats.whaleEntries = (state.stats.whaleEntries || 0) + 1;
              addActivity(state, {
                type: 'whale_entry',
                symbol: pos.symbol,
                icon: pos.icon,
                agent: 'Whale Watch',
                detail: `Smart buy · ${sm.label || short(be.owner)} · #${be.rank}`,
                mint: pos.mint,
              });
            }
          }

          if (events.length && settings.running && !state.killSwitch) {
            const ev = events[0];
            const sm = isSmartWallet(reg, ev.owner);
            if (sm) recordWalletEvent(reg, ev.owner, { side: 'sell' });
            const detail = sm
              ? `Smart-money exit: ${sm.label || 'wallet'} sold ${round(ev.soldPctOfBag, 1)}%`
              : `Whale exit: holder #${ev.rank || '?'} sold ${round(ev.soldPctOfBag, 1)}%`;
            state.agents.whale.lastAlert = {
              symbol: pos.symbol,
              detail,
              latencyMs,
              ts: now(),
              owner: ev.owner,
            };
            state.agents.whale.latencyMs = latencyMs;
            state.agents.whale.flash = 'alert';
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
