'use strict';

/** Trading lanes: Fresh Launch, About-to-Moon (GRAD), and residual MOVER. */

const LANE = {
  FRESH: 'FRESH',
  GRAD: 'GRAD',
  MOVER: 'MOVER',
};

const DEFAULT_LANE_CAPS = {
  FRESH: 0.45, // fraction of equity open basis
  GRAD: 0.4,
  MOVER: 0.15, // keep established/MOVER slots scarce
};

const LANE_DEFAULTS = {
  maxMarketCapUsd: 8_000_000,
  freshMaxAgeMs: 25 * 60e3,
  freshMinLiq: 5000,
  freshMaxLiq: 120000,
  freshMaxMcap: 350_000,
  freshBuyPctMult: 0.55, // smaller size
  freshTimeStopMs: 18 * 60e3,
  freshStopPct: -0.1,
  freshTrailPct: 0.14,
  freshLadder: [
    { mult: 1.35, sellPct: 0.35 },
    { mult: 1.8, sellPct: 0.35 },
    { mult: 2.5, sellPct: 0.3 },
  ],
  gradMinProgress: 0.7,
  gradMaxProgress: 0.98,
  gradMaxAgeMs: 6 * 3600e3,
  gradMigratedMaxAgeMs: 30 * 60e3,
  gradMinLiq: 15000,
  gradBuyPctMult: 0.75,
  moverMinLiq: null, // use settings.minLiquidity
  moverBuyPctMult: 0.7,
  moverMaxAgeMs: 36 * 3600e3, // skip stale established unless breakout
  moverTimeStopMs: 45 * 60e3,
  gradTimeStopMs: 45 * 60e3,
  top10MaxPctFresh: 30,
};

function bondingProgress(pair) {
  if (pair == null) return null;
  if (pair.bondingProgress != null && Number.isFinite(Number(pair.bondingProgress))) {
    return clamp(Number(pair.bondingProgress), 0, 1);
  }
  // Pump.fun graduation ~$69k–$90k USD mcap historically; use soft proxy
  const mc = Number(pair.marketCap) || 0;
  if (pair.complete || pair.raydiumPool) return 1;
  if (mc <= 0) return null;
  // map 0→0, 85k→1
  return clamp(mc / 85000, 0, 1);
}

function hasSocials(pair) {
  const s = pair.socials || [];
  const w = pair.websites || [];
  return (Array.isArray(s) && s.length > 0) || (Array.isArray(w) && w.length > 0) || !!pair.hasSocials;
}

function classifyLane(pair, settings = {}) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  const age = pair.ageMs != null ? pair.ageMs : pair.ts ? Date.now() - pair.ts : null;
  const src = String(pair.source || '');
  const progress = bondingProgress(pair);
  const mc = Number(pair.marketCap) || 0;
  const migrated =
    pair.graduating ||
    src.includes('migration') ||
    src.includes('pump.grad') ||
    !!pair.complete ||
    !!pair.raydiumPool;

  // GRAD: nearing curve completion OR freshly migrated
  if (migrated && age != null && age <= cfg.gradMigratedMaxAgeMs) {
    return { lane: LANE.GRAD, reason: 'fresh-migration', progress: progress ?? 1 };
  }
  if (
    progress != null &&
    progress >= cfg.gradMinProgress &&
    progress < cfg.gradMaxProgress &&
    (age == null || age <= cfg.gradMaxAgeMs)
  ) {
    return { lane: LANE.GRAD, reason: 'bonding-progress', progress };
  }
  if (pair.graduating && (age == null || age <= cfg.gradMaxAgeMs)) {
    return { lane: LANE.GRAD, reason: 'graduating-flag', progress: progress ?? 0.85 };
  }

  // FRESH: brand new pump launches
  const isPumpNew = src.includes('pump') || src.includes('pumpportal') || pair.boosted === false;
  const young = age != null && age >= 0 && age <= cfg.freshMaxAgeMs;
  const small =
    (mc <= 0 || mc <= cfg.freshMaxMcap) &&
    (Number(pair.liquidity) || 0) <= cfg.freshMaxLiq;
  if (young && small && (src.includes('pumpportal.new') || src.includes('pump.fun') || src === 'pump.fun' || young)) {
    // Prefer WS / pump REST tagged, but also age+size from DEX
    if (src.includes('migration')) {
      /* fall through */
    } else {
      return { lane: LANE.FRESH, reason: young ? 'young-launch' : 'pump-new', progress: progress ?? 0 };
    }
  }
  if (young && (src.includes('pumpportal.new') || src === 'pump.fun' || src.includes('pump.fun'))) {
    return { lane: LANE.FRESH, reason: 'pump-ws', progress: progress ?? 0 };
  }

  return { lane: LANE.MOVER, reason: 'residual', progress };
}

/**
 * Hard gates for a classified pair. Returns { ok, why }.
 */
function laneGates(pair, laneInfo, settings = {}, rug = null) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  const lane = laneInfo.lane;
  const age = pair.ageMs != null ? pair.ageMs : null;
  const liq = Number(pair.liquidity) || 0;
  const mc = Number(pair.marketCap) || 0;
  const maxMc = settings.maxMarketCapUsd || cfg.maxMarketCapUsd;

  // Skip large-cap established unless strong breakout
  if (mc > maxMc) {
    const ch5 = Number(pair.priceChangeM5) || 0;
    const vol = Number(pair.volumeH1) || 0;
    const breakout = ch5 >= 18 && vol >= liq * 0.8 && age != null && age < 48 * 3600e3;
    if (!breakout) return { ok: false, why: `mcap $${Math.round(mc / 1e6)}M > cap` };
  }

  if (lane === LANE.FRESH) {
    if (liq > 0 && liq < cfg.freshMinLiq) return { ok: false, why: 'fresh liq low' };
    if (age != null && age > cfg.freshMaxAgeMs) return { ok: false, why: 'fresh too old' };
    const top10 = (rug && (rug.top10Pct || rug.topHolderPct)) || pair.top10Pct;
    if (top10 != null && top10 > cfg.top10MaxPctFresh) return { ok: false, why: `top10 ${Math.round(top10)}%` };
    if (rug && rug.bundled) return { ok: false, why: 'bundled' };
    if (pair.sniper && pair.sniper.bundled) return { ok: false, why: 'bundle cluster' };
    // prefer socials but don't hard-require when WS-fresh (data lag)
    const bpm = Number(pair.buyersPerMin) || 0;
    const buys = Number(pair.buysM5) || 0;
    const sells = Math.max(Number(pair.sellsM5) || 0, 1);
    const ratio = buys / sells;
    if (buys + sells >= 4 && ratio < 0.85) return { ok: false, why: 'weak buy:sell' };
    if (bpm > 0 && bpm < 0.4 && age != null && age > 3 * 60e3) return { ok: false, why: 'buyers/min flat' };
  }

  if (lane === LANE.GRAD) {
    if (liq > 0 && liq < cfg.gradMinLiq) return { ok: false, why: 'grad liq low' };
    const vol = Number(pair.volumeH1) || Number(pair.volumeM5) || 0;
    if (vol <= 0 && !(pair.graduating || String(pair.source || '').includes('migration'))) {
      return { ok: false, why: 'grad no volume' };
    }
  }

  if (lane === LANE.MOVER) {
    const minLiq = cfg.moverMinLiq != null ? cfg.moverMinLiq : settings.minLiquidity || 25000;
    if (liq < minLiq) return { ok: false, why: 'mover liq' };
    const maxAge = cfg.moverMaxAgeMs != null ? cfg.moverMaxAgeMs : 36 * 3600e3;
    if (age != null && age > maxAge) {
      const ch5 = Number(pair.priceChangeM5) || 0;
      const vol = Number(pair.volumeH1) || 0;
      const breakout = ch5 >= 22 && vol >= Math.max(liq * 0.6, 15000);
      if (!breakout) return { ok: false, why: 'mover too old' };
    }
  }

  return { ok: true, why: 'pass' };
}

function lanePriority(lane) {
  if (lane === LANE.FRESH) return 3;
  if (lane === LANE.GRAD) return 2;
  return 1;
}

function laneSizeMult(lane, settings = {}) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  if (lane === LANE.FRESH) return cfg.freshBuyPctMult;
  if (lane === LANE.GRAD) return cfg.gradBuyPctMult;
  return cfg.moverBuyPctMult;
}

function laneRiskProfile(lane, settings = {}) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  if (lane === LANE.FRESH) {
    return {
      stopPct: cfg.freshStopPct,
      trailPct: cfg.freshTrailPct,
      takeProfitLadder: cfg.freshLadder,
      timeStopMs: cfg.freshTimeStopMs || 15 * 60e3,
    };
  }
  if (lane === LANE.GRAD) {
    return {
      stopPct: settings.stopPct,
      trailPct: settings.trailPct != null ? settings.trailPct : 0.16,
      takeProfitLadder: settings.takeProfitLadder,
      timeStopMs: cfg.gradTimeStopMs || 45 * 60e3,
    };
  }
  return {
    stopPct: settings.stopPct,
    trailPct: settings.trailPct,
    takeProfitLadder: settings.takeProfitLadder,
    timeStopMs: cfg.moverTimeStopMs || 45 * 60e3,
  };
}

function exposureByLane(positions) {
  const out = { FRESH: 0, GRAD: 0, MOVER: 0 };
  for (const p of positions || []) {
    const lane = p.lane || LANE.MOVER;
    out[lane] = (out[lane] || 0) + (Number(p.remainingUsdBasis) || Number(p.amountUsd) || 0);
  }
  return out;
}

function laneCapOk(lane, positions, equity, settings = {}) {
  const caps = { ...DEFAULT_LANE_CAPS, ...(settings.laneCaps || {}) };
  const exp = exposureByLane(positions);
  const cap = caps[lane] != null ? caps[lane] : 0.35;
  const used = exp[lane] || 0;
  return used / Math.max(equity, 1) < cap;
}

function bumpLaneStats(stats, lane, { pnl = null, isBuy = false, win = null } = {}) {
  stats.byLane = stats.byLane || {};
  const row = (stats.byLane[lane] = stats.byLane[lane] || {
    trades: 0,
    buys: 0,
    pnl: 0,
    wins: 0,
    losses: 0,
  });
  if (isBuy) {
    row.buys += 1;
    row.trades += 1;
  }
  if (pnl != null) {
    row.pnl = Math.round((row.pnl + pnl) * 10000) / 10000;
    if (win === true) row.wins += 1;
    if (win === false) row.losses += 1;
  }
  return row;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

module.exports = {
  LANE,
  DEFAULT_LANE_CAPS,
  LANE_DEFAULTS,
  bondingProgress,
  hasSocials,
  classifyLane,
  laneGates,
  lanePriority,
  laneSizeMult,
  laneRiskProfile,
  exposureByLane,
  laneCapOk,
  bumpLaneStats,
};
