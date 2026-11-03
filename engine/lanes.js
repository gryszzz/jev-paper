'use strict';

/**
 * New-pair specialist lanes (Tony 2026-11-02):
 *  - SNIPE   <2m   ~small size, fast TP, tight time-stop
 *  - TRACTION 2–60m unique-buyer accel / vol·mcap / holders — ride + moonbag
 *  - MOVER   established residual, ≤20% of slots
 *
 * Legacy FRESH/GRAD aliases still accepted on open positions / journal rows.
 */

const LANE = {
  SNIPE: 'SNIPE',
  TRACTION: 'TRACTION',
  MOVER: 'MOVER',
  // legacy aliases
  FRESH: 'FRESH',
  GRAD: 'GRAD',
};

/** Equity exposure caps — new-pair lanes get ~80%, MOVER ≤20%. */
const DEFAULT_LANE_CAPS = {
  SNIPE: 0.35,
  TRACTION: 0.45,
  MOVER: 0.2,
  FRESH: 0.35, // alias → treat like SNIPE in laneCapOk
  GRAD: 0.45, // alias → TRACTION
};

/** Slot fraction for MOVER/established (≤20%). */
const DEFAULT_MOVER_SLOT_FRAC = 0.2;

const LANE_DEFAULTS = {
  maxMarketCapUsd: 8_000_000,

  // SNIPE (<2m)
  snipeMaxAgeMs: 2 * 60e3,
  snipeMinLiq: 400,
  snipeMaxLiq: 80_000,
  snipeMaxMcap: 250_000,
  snipeBuyPctMult: 0.4, // small size
  snipeTimeStopMs: 6 * 60e3, // tight
  snipeStopPct: -0.12,
  snipeTrailPct: 0.12,
  snipeLadder: [
    { mult: 1.35, sellPct: 0.45 }, // first TP +35%
    { mult: 1.5, sellPct: 0.35 }, // +50%
    { mult: 2.2, sellPct: 0.2 },
  ],
  snipeMinUniqueBuyers: 2,
  snipeMinBuys: 3,
  snipeMinVolume: 200,
  snipeBurstBuyers: 5, // strong early buyer burst
  snipeRequireTrigger: true, // smart/whale OR burst
  top10MaxPctSnipe: 28,

  // TRACTION (2–60m)
  tractionMinAgeMs: 2 * 60e3,
  tractionMaxAgeMs: 60 * 60e3,
  tractionMinLiq: 1500,
  tractionMaxMcap: 1_500_000,
  tractionBuyPctMult: 0.85, // larger
  tractionTimeStopMs: 35 * 60e3,
  tractionStopPct: -0.1,
  tractionTrailPct: 0.16,
  tractionLadder: [
    { mult: 1.6, sellPct: 0.3 },
    { mult: 2.2, sellPct: 0.3 },
    { mult: 3.5, sellPct: 0.25 },
  ],
  tractionMinUniqueBuyers: 6,
  tractionMinBuysM5: 8,
  tractionMinVolumeM5: 1200,
  tractionMinBuyerAccel: 1.15, // buyers growing vs earlier window
  tractionMinVolMcap: 0.08, // vol/mcap rising floor
  tractionMinHolderGrowth: 1, // at least +1 holders hint when present

  // legacy FRESH windows kept for any remaining callers
  freshMaxAgeMs: 25 * 60e3,
  freshMinLiq: 800,
  freshMinUniqueBuyers: 3,
  freshMinBuysM5: 5,
  freshMinVolumeM5: 500,
  freshMaxLiq: 120000,
  freshMaxMcap: 350_000,
  freshBuyPctMult: 0.55,
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
  moverMinLiq: null,
  moverBuyPctMult: 0.65,
  moverMaxAgeMs: 36 * 3600e3,
  moverTimeStopMs: 45 * 60e3,
  gradTimeStopMs: 45 * 60e3,
  top10MaxPctFresh: 30,
  moverSlotFrac: DEFAULT_MOVER_SLOT_FRAC,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function bondingProgress(pair) {
  if (pair == null) return null;
  if (pair.bondingProgress != null && Number.isFinite(Number(pair.bondingProgress))) {
    return clamp(Number(pair.bondingProgress), 0, 1);
  }
  const mc = Number(pair.marketCap) || 0;
  if (pair.complete || pair.raydiumPool) return 1;
  if (mc <= 0) return null;
  return clamp(mc / 85000, 0, 1);
}

function hasSocials(pair) {
  const s = pair.socials || [];
  const w = pair.websites || [];
  return (Array.isArray(s) && s.length > 0) || (Array.isArray(w) && w.length > 0) || !!pair.hasSocials;
}

/** Normalize legacy lane tags onto the specialist set. */
function canonicalLane(lane) {
  if (lane === LANE.FRESH) return LANE.SNIPE;
  if (lane === LANE.GRAD) return LANE.TRACTION;
  if (lane === LANE.SNIPE || lane === LANE.TRACTION || lane === LANE.MOVER) return lane;
  return LANE.MOVER;
}

function isNewPairLane(lane) {
  const c = canonicalLane(lane);
  return c === LANE.SNIPE || c === LANE.TRACTION;
}

function classifyLane(pair, settings = {}) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  const age = pair.ageMs != null ? pair.ageMs : pair.ts ? Date.now() - pair.ts : null;
  const src = String(pair.source || '');
  const progress = bondingProgress(pair);
  const mc = Number(pair.marketCap) || 0;
  const liq = Number(pair.liquidity) || 0;
  const migrated =
    pair.graduating ||
    src.includes('migration') ||
    src.includes('pump.grad') ||
    !!pair.complete ||
    !!pair.raydiumPool;

  // SNIPE: brand-new (<2m), small curve
  if (age != null && age >= 0 && age < cfg.snipeMaxAgeMs) {
    const small = (mc <= 0 || mc <= cfg.snipeMaxMcap) && (liq <= 0 || liq <= cfg.snipeMaxLiq);
    if (small || src.includes('pump') || pair.fromPump) {
      return { lane: LANE.SNIPE, reason: 'snipe-window', progress: progress ?? 0 };
    }
  }

  // TRACTION: 2–60m with growth, or fresh migration still inside window
  if (age != null && age >= cfg.tractionMinAgeMs && age <= cfg.tractionMaxAgeMs) {
    if (migrated) {
      return { lane: LANE.TRACTION, reason: 'fresh-migration', progress: progress ?? 1 };
    }
    if (
      progress != null &&
      progress >= cfg.gradMinProgress &&
      progress < cfg.gradMaxProgress
    ) {
      return { lane: LANE.TRACTION, reason: 'bonding-traction', progress };
    }
    const youngish = mc <= cfg.tractionMaxMcap || src.includes('pump') || pair.fromPump;
    if (youngish) {
      return { lane: LANE.TRACTION, reason: 'traction-window', progress: progress ?? 0 };
    }
  }

  // Late GRAD-style bonding still maps to TRACTION if under 60m age unknown but progressing
  if (
    progress != null &&
    progress >= cfg.gradMinProgress &&
    progress < cfg.gradMaxProgress &&
    (age == null || age <= cfg.tractionMaxAgeMs)
  ) {
    return { lane: LANE.TRACTION, reason: 'bonding-progress', progress };
  }
  if (migrated && age != null && age <= cfg.gradMigratedMaxAgeMs) {
    return { lane: LANE.TRACTION, reason: 'migrated', progress: progress ?? 1 };
  }

  return { lane: LANE.MOVER, reason: 'residual', progress };
}

function earlySnipeTrigger(pair) {
  const smartHits = Number(pair.smartHits || pair.copyHits || 0) || 0;
  const whale = Number(pair.whaleCluster || pair.whaleBuys || 0) || 0;
  const copy = !!(pair.copyHit || pair.smartMoney);
  const unique = Number(pair.uniqueBuyers || pair.buyersM5 || pair.buyers || 0) || 0;
  const buys = Number(pair.buysM5 || pair.buys || 0) || 0;
  const burst = unique >= 5 || buys >= 8 || Number(pair.buyersPerMin || 0) >= 2;
  const ok = smartHits >= 1 || whale >= 1 || copy || burst;
  return {
    ok,
    why: ok
      ? smartHits || copy
        ? 'smart/copy'
        : whale
          ? 'whale'
          : 'buyer-burst'
      : 'no early smart/whale/burst',
  };
}

function laneGates(pair, laneInfo, settings = {}, rug = null) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  const lane = canonicalLane(laneInfo.lane || pair.lane);
  const age = pair.ageMs != null ? pair.ageMs : null;
  const liq = Number(pair.liquidity) || 0;
  const mc = Number(pair.marketCap) || 0;
  const maxMc = settings.maxMarketCapUsd || cfg.maxMarketCapUsd;

  if (mc > maxMc) {
    const ch5 = Number(pair.priceChangeM5) || 0;
    const vol = Number(pair.volumeH1) || 0;
    const breakout = ch5 >= 18 && vol >= liq * 0.8 && age != null && age < 48 * 3600e3;
    if (!breakout) return { ok: false, why: `mcap $${Math.round(mc / 1e6)}M > cap` };
  }

  // Instant rug checks shared by new-pair lanes
  if (lane === LANE.SNIPE || lane === LANE.TRACTION) {
    if (rug) {
      if (rug.mintAuthority || rug.mintRenounced === false) return { ok: false, why: 'mint authority' };
      if (rug.freezeAuthority) return { ok: false, why: 'freeze authority' };
      if (rug.bundled || (rug.bundlePct != null && rug.bundlePct >= 18)) return { ok: false, why: 'bundle%' };
      if (rug.devPct != null && rug.devPct >= 12) return { ok: false, why: `dev ${Math.round(rug.devPct)}%` };
      if (rug.devRugged || rug.devDirty) return { ok: false, why: 'dirty dev' };
    }
    if (pair.sniper && pair.sniper.bundled) return { ok: false, why: 'bundle cluster' };
    if (pair._freshReject || pair.freshQualityOk === false) {
      return { ok: false, why: (pair.freshQualityReasons || ['dup image/name']).join('+') };
    }
  }

  if (lane === LANE.SNIPE) {
    if (age != null && age >= cfg.snipeMaxAgeMs) return { ok: false, why: 'snipe too old' };
    if (liq > 0 && liq < Math.min(cfg.snipeMinLiq, 300) && !pair.fromPump) return { ok: false, why: 'snipe liq dust' };
    const top10 = (rug && (rug.top10Pct || rug.topHolderPct)) || pair.top10Pct;
    if (top10 != null && top10 > Math.max(cfg.top10MaxPctSnipe || 28, 40)) {
      return { ok: false, why: `top10 ${Math.round(top10)}%` };
    }
    const unique = Number(pair.uniqueBuyers || pair.buyersM5 || pair.buyers || 0) || 0;
    const buys = Number(pair.buysM5) || 0;
    const vol = Math.max(Number(pair.volumeM5) || 0, (Number(pair.volumeH1) || 0) * 0.35);
    // Ultra-new pump synthetics: allow through with softer floors if trigger fires
    const trigger = earlySnipeTrigger(pair);
    if (cfg.snipeRequireTrigger !== false && !trigger.ok && age != null && age > 15e3) {
      return { ok: false, why: trigger.why };
    }
    const minBuyers = cfg.snipeMinUniqueBuyers != null ? cfg.snipeMinUniqueBuyers : 2;
    const minBuys = cfg.snipeMinBuys != null ? cfg.snipeMinBuys : 3;
    const minVol = cfg.snipeMinVolume != null ? cfg.snipeMinVolume : 200;
    if (!(unique >= minBuyers || buys >= minBuys || trigger.ok)) {
      return { ok: false, why: `snipe buyers ${unique || buys}<${minBuyers}` };
    }
    if (vol > 0 && vol < minVol && !trigger.ok) {
      return { ok: false, why: `snipe vol $${Math.round(vol)}<${minVol}` };
    }
    return { ok: true, why: `snipe:${trigger.why}` };
  }

  if (lane === LANE.TRACTION) {
    if (age != null && age < cfg.tractionMinAgeMs) return { ok: false, why: 'traction too young' };
    if (age != null && age > cfg.tractionMaxAgeMs) return { ok: false, why: 'traction too old' };
    if (liq > 0 && liq < cfg.tractionMinLiq && !(pair.graduating || String(pair.source || '').includes('migration'))) {
      return { ok: false, why: 'traction liq low' };
    }
    const unique = Number(pair.uniqueBuyers || pair.buyersM5 || pair.buyers || 0) || 0;
    const buys = Number(pair.buysM5) || 0;
    const volM5 = Number(pair.volumeM5) || 0;
    const volH1 = Number(pair.volumeH1) || 0;
    const vol = Math.max(volM5, volH1 * 0.35);
    if (unique < (cfg.tractionMinUniqueBuyers || 6) && buys < (cfg.tractionMinBuysM5 || 8)) {
      return { ok: false, why: `traction buyers ${unique || buys}` };
    }
    if (vol < (cfg.tractionMinVolumeM5 || 1200)) {
      return { ok: false, why: `traction vol $${Math.round(vol)}` };
    }
    // Unique-buyer acceleration (prefer rising)
    const accel =
      Number(pair.buyerAccel) ||
      Number(pair.buyersPerMin) ||
      (age > 0 ? unique / Math.max(age / 60e3, 0.5) : 0);
    const prevUnique = Number(pair.prevUniqueBuyers || pair.uniqueBuyersPrev || 0) || 0;
    if (prevUnique > 0 && unique / prevUnique < (cfg.tractionMinBuyerAccel || 1.15) && accel < 0.4) {
      return { ok: false, why: 'buyer accel flat' };
    }
    // Rising volume/mcap
    if (mc > 0) {
      const ratio = vol / mc;
      const prevRatio = Number(pair.prevVolMcap || 0) || 0;
      if (ratio < (cfg.tractionMinVolMcap || 0.08) && !(pair.graduating || pair.copyHit)) {
        return { ok: false, why: `vol/mcap ${(ratio * 100).toFixed(1)}%` };
      }
      if (prevRatio > 0 && ratio < prevRatio * 0.85 && accel < 0.5) {
        return { ok: false, why: 'vol/mcap fading' };
      }
    }
    // Holder growth when present
    const holders = Number(pair.holders || pair.holderCount || 0) || 0;
    const prevHolders = Number(pair.prevHolders || 0) || 0;
    if (holders > 0 && prevHolders > 0 && holders < prevHolders + (cfg.tractionMinHolderGrowth || 1)) {
      if (accel < 0.35) return { ok: false, why: 'holders flat' };
    }
    return { ok: true, why: 'traction pass' };
  }

  // MOVER residual
  const minLiq = cfg.moverMinLiq != null ? cfg.moverMinLiq : settings.minLiquidity || 25000;
  if (liq < minLiq) return { ok: false, why: 'mover liq' };
  const maxAge = cfg.moverMaxAgeMs != null ? cfg.moverMaxAgeMs : 36 * 3600e3;
  if (age != null && age > maxAge) {
    const ch5 = Number(pair.priceChangeM5) || 0;
    const vol = Number(pair.volumeH1) || 0;
    const breakout = ch5 >= 22 && vol >= Math.max(liq * 0.6, 15000);
    if (!breakout) return { ok: false, why: 'mover too old' };
  }
  return { ok: true, why: 'pass' };
}

function lanePriority(lane) {
  const c = canonicalLane(lane);
  if (c === LANE.SNIPE) return 3;
  if (c === LANE.TRACTION) return 2;
  return 1;
}

function laneSizeMult(lane, settings = {}) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  const c = canonicalLane(lane);
  if (c === LANE.SNIPE) return cfg.snipeBuyPctMult != null ? cfg.snipeBuyPctMult : cfg.freshBuyPctMult;
  if (c === LANE.TRACTION) return cfg.tractionBuyPctMult != null ? cfg.tractionBuyPctMult : cfg.gradBuyPctMult;
  return cfg.moverBuyPctMult;
}

function laneRiskProfile(lane, settings = {}) {
  const cfg = { ...LANE_DEFAULTS, ...settings.lanes };
  const c = canonicalLane(lane);
  if (c === LANE.SNIPE) {
    return {
      stopPct: cfg.snipeStopPct,
      trailPct: cfg.snipeTrailPct,
      takeProfitLadder: cfg.snipeLadder || cfg.freshLadder,
      timeStopMs: cfg.snipeTimeStopMs || 6 * 60e3,
      preferMode: 'SCALP',
      moonbagOnlyIfTraction: true,
    };
  }
  if (c === LANE.TRACTION) {
    return {
      stopPct: cfg.tractionStopPct != null ? cfg.tractionStopPct : settings.stopPct,
      trailPct: cfg.tractionTrailPct != null ? cfg.tractionTrailPct : 0.16,
      takeProfitLadder: cfg.tractionLadder || settings.takeProfitLadder,
      timeStopMs: cfg.tractionTimeStopMs || 35 * 60e3,
      preferMode: 'RIDE',
      moonbagOnStrength: true,
    };
  }
  return {
    stopPct: settings.stopPct,
    trailPct: settings.trailPct,
    takeProfitLadder: settings.takeProfitLadder,
    timeStopMs: cfg.moverTimeStopMs || 45 * 60e3,
    preferMode: 'RIDE',
  };
}

function exposureByLane(positions) {
  const out = { SNIPE: 0, TRACTION: 0, MOVER: 0, FRESH: 0, GRAD: 0 };
  for (const p of positions || []) {
    const lane = p.lane || LANE.MOVER;
    const c = canonicalLane(lane);
    out[c] = (out[c] || 0) + (Number(p.remainingUsdBasis) || Number(p.amountUsd) || 0);
    // keep raw tag too for UI
    out[lane] = (out[lane] || 0) + (Number(p.remainingUsdBasis) || Number(p.amountUsd) || 0);
  }
  return out;
}

function laneCapOk(lane, positions, equity, settings = {}) {
  const caps = { ...DEFAULT_LANE_CAPS, ...(settings.laneCaps || {}) };
  const c = canonicalLane(lane);
  const exp = exposureByLane(positions);
  const cap = caps[c] != null ? caps[c] : caps[lane] != null ? caps[lane] : 0.35;
  const used = exp[c] || 0;
  return used / Math.max(equity, 1) < cap;
}

/** Max open MOVER slots from maxPositions (≤20%). */
function moverSlotCap(settings = {}) {
  const maxPos = settings.maxPositions || 3;
  const frac =
    (settings.lanes && settings.lanes.moverSlotFrac != null
      ? settings.lanes.moverSlotFrac
      : settings.moverSlotFrac != null
        ? settings.moverSlotFrac
        : DEFAULT_MOVER_SLOT_FRAC);
  return Math.max(0, Math.floor(maxPos * frac + 1e-9));
}

function countByCanonicalLane(positions) {
  const out = { SNIPE: 0, TRACTION: 0, MOVER: 0 };
  for (const p of positions || []) {
    const c = canonicalLane(p.lane || LANE.MOVER);
    out[c] = (out[c] || 0) + 1;
  }
  return out;
}

function bumpLaneStats(stats, lane, { pnl = null, isBuy = false, win = null } = {}) {
  stats.byLane = stats.byLane || {};
  const raw = lane || LANE.MOVER;
  const c = canonicalLane(raw);
  for (const key of [...new Set([raw, c])]) {
    const row = (stats.byLane[key] = stats.byLane[key] || {
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
  }
  return stats.byLane[c];
}

module.exports = {
  LANE,
  DEFAULT_LANE_CAPS,
  DEFAULT_MOVER_SLOT_FRAC,
  LANE_DEFAULTS,
  bondingProgress,
  hasSocials,
  classifyLane,
  canonicalLane,
  isNewPairLane,
  earlySnipeTrigger,
  laneGates,
  lanePriority,
  laneSizeMult,
  laneRiskProfile,
  exposureByLane,
  laneCapOk,
  moverSlotCap,
  countByCanonicalLane,
  bumpLaneStats,
};
