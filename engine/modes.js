'use strict';

/**
 * Trade-mode router + Mode A/B/C profiles (playbook §4–§5).
 * Tags: SCALP (B), RIDE (A hybrid), MOON (C).
 */

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

const MODE_TAG = {
  A: 'RIDE',
  B: 'SCALP',
  C: 'MOON',
};

/** A/B harness arms — Control vs treatments */
const AB_ARMS = {
  CONTROL: {
    id: 'CONTROL',
    label: 'Control',
    minRunner: 0, // use analyst minScore only
    useRunnerGate: false,
    forcedMode: null, // use router from score
    sizeMult: 1,
    risk: {
      stopPct: -0.06,
      trailPct: 0.1,
      takeProfitLadder: [
        { mult: 1.5, sellPct: 0.25 },
        { mult: 2.0, sellPct: 0.25 },
      ],
      trailRemainder: true,
      timeStopMs: null,
      spikeExit: false,
      liquidityShockPct: 0.15,
      allowReentry: false,
      initialsAt2x: false,
    },
  },
  T1: {
    id: 'T1',
    label: 'T1 A+C hybrid',
    minRunner: 55,
    useRunnerGate: true,
    forcedMode: 'A', // spike + initials hybrid → tag RIDE, moonish ladder
    sizeMult: 0.7,
    risk: {
      stopPct: -0.15,
      trailPct: 0.25,
      takeProfitLadder: [
        { mult: 2.0, sellPct: 0.55 },
        { mult: 3.5, sellPct: 0.25 },
      ],
      trailRemainder: true,
      timeStopMs: 45 * 60e3,
      spikeExit: true,
      spikeSellPct: 0.4,
      liquidityShockPct: 0.09,
      allowReentry: false,
      initialsAt2x: true,
      widenStopAfterInitials: true,
    },
  },
  T2: {
    id: 'T2',
    label: 'T2 scalp B',
    minRunner: 40,
    useRunnerGate: true,
    forcedMode: 'B',
    sizeMult: 0.55,
    risk: {
      stopPct: -0.08,
      trailPct: 0.14,
      takeProfitLadder: [
        { mult: 1.35, sellPct: 0.4 },
        { mult: 1.8, sellPct: 0.35 },
      ],
      trailRemainder: true,
      timeStopMs: 12 * 60e3,
      spikeExit: true,
      spikeSellPct: 0.45,
      liquidityShockPct: 0.08,
      allowReentry: true,
      maxReentriesPerHour: 2,
      reentryPullbackMin: 0.08,
      reentryPullbackMax: 0.18,
      reentryStopPct: -0.08,
      initialsAt2x: false,
    },
  },
  T3: {
    id: 'T3',
    label: 'T3 moon C',
    minRunner: 70,
    useRunnerGate: true,
    forcedMode: 'C',
    sizeMult: 0.85,
    risk: {
      stopPct: -0.25,
      trailPct: 0.3,
      takeProfitLadder: [
        { mult: 2.0, sellPct: 0.55 },
        { mult: 3.5, sellPct: 0.25 },
      ],
      trailRemainder: true,
      moonbagMinFrac: 0.15,
      timeStopMs: 24 * 3600e3,
      spikeExit: false,
      liquidityShockPct: 0.1,
      allowReentry: false,
      initialsAt2x: true,
      widenStopAfterInitials: true,
      flatBuyersMs: 6 * 3600e3,
    },
  },
};

const ARM_ORDER = ['CONTROL', 'T1', 'T2', 'T3'];

function emptyArmStats() {
  const out = {};
  for (const id of ARM_ORDER) {
    out[id] = { trades: 0, buys: 0, pnl: 0, wins: 0, losses: 0, expectancy: 0 };
  }
  return out;
}

function bumpArmStats(stats, armId, { pnl = null, isBuy = false, win = null } = {}) {
  stats.byArm = stats.byArm || emptyArmStats();
  const id = armId && AB_ARMS[armId] ? armId : 'CONTROL';
  const row = (stats.byArm[id] = stats.byArm[id] || {
    trades: 0,
    buys: 0,
    pnl: 0,
    wins: 0,
    losses: 0,
    expectancy: 0,
  });
  if (isBuy) {
    row.buys += 1;
  }
  if (pnl != null) {
    row.trades += 1;
    row.pnl = Math.round((row.pnl + pnl) * 10000) / 10000;
    if (win === true) row.wins += 1;
    if (win === false) row.losses += 1;
    row.expectancy = row.trades ? Math.round((row.pnl / row.trades) * 10000) / 10000 : 0;
  }
  return row;
}

/**
 * Mode decision scorecard §4(d) — 0–14 → mode letter.
 */
function modeDecision(runner, pair = {}, ctx = {}) {
  const score = Number(runner && runner.score) || 0;
  let sum = 0;
  // Runner band
  if (score >= 70) sum += 2;
  else if (score >= 40) sum += 1;
  // Holder quality
  const top10 = Number(ctx.top10) || Number(pair.top10Pct) || 0;
  if (top10 > 0 && top10 < 30) sum += 2;
  else if (top10 < 45) sum += 1;
  // Smart money
  const hits = (ctx.smartHits != null ? ctx.smartHits : (pair.smartMoney && pair.smartMoney.hits)) || 0;
  if (hits >= 2) sum += 2;
  else if (hits >= 1) sum += 1;
  // Narrative
  if ((pair.narratives || []).length && score >= 55) sum += 2;
  else if ((pair.narratives || []).length) sum += 1;
  // Liquidity
  const liq = Number(pair.liquidity) || 0;
  if (liq >= 40000) sum += 2;
  else if (liq >= 10000) sum += 1;
  // Structure / vol
  const ch5 = Math.abs(Number(pair.priceChangeM5) || 0);
  if (ch5 > 0 && ch5 < 35) sum += 2;
  else if (ch5 < 80) sum += 1;
  // Buyer velocity
  const bpm = Number(pair.buyersPerMin) || 0;
  if (bpm >= 3) sum += 2;
  else if (bpm >= 1) sum += 1;

  let mode = 'A';
  if (sum <= 4) mode = 'A';
  else if (sum <= 7) mode = 'B';
  else mode = 'C';
  if (score >= 80 && sum >= 10) mode = 'C';
  if (score < 40) mode = null;
  else if (score < 55) mode = 'B';
  else if (score >= 70 && mode === 'A') mode = 'C';

  return { mode, sum, tag: mode ? MODE_TAG[mode] : null };
}

function pickArm(state) {
  const settings = state.settings || {};
  if (settings.abHarness === false) {
    return AB_ARMS.CONTROL;
  }
  state._abCursor = (state._abCursor || 0) % ARM_ORDER.length;
  const id = ARM_ORDER[state._abCursor];
  state._abCursor = (state._abCursor + 1) % ARM_ORDER.length;
  return AB_ARMS[id];
}

/** Profile risk overrides for a chosen mode letter (when arm doesn't force). */
function modeRiskProfile(mode, runnerScoreVal, armRisk) {
  const base = { ...(armRisk || {}) };
  if (mode === 'B') {
    return {
      ...base,
      stopPct: base.stopPct != null ? base.stopPct : -0.08,
      trailPct: base.trailPct != null ? base.trailPct : 0.14,
      spikeExit: true,
      spikeSellPct: base.spikeSellPct != null ? base.spikeSellPct : 0.4,
      allowReentry: true,
      timeStopMs: base.timeStopMs != null ? base.timeStopMs : 15 * 60e3,
      liquidityShockPct: base.liquidityShockPct != null ? base.liquidityShockPct : 0.08,
    };
  }
  if (mode === 'C') {
    const wide = runnerScoreVal >= 80;
    return {
      ...base,
      stopPct: base.stopPct != null ? base.stopPct : wide ? -0.3 : -0.22,
      trailPct: base.trailPct != null ? base.trailPct : wide ? 0.32 : 0.28,
      takeProfitLadder: base.takeProfitLadder || [
        { mult: 2.0, sellPct: 0.55 },
        { mult: 3.5, sellPct: 0.25 },
      ],
      initialsAt2x: true,
      widenStopAfterInitials: true,
      moonbagMinFrac: 0.15,
      timeStopMs: base.timeStopMs != null ? base.timeStopMs : 24 * 3600e3,
      liquidityShockPct: base.liquidityShockPct != null ? base.liquidityShockPct : 0.1,
    };
  }
  // Mode A / RIDE
  return {
    ...base,
    stopPct: base.stopPct != null ? base.stopPct : -0.12,
    trailPct: base.trailPct != null ? base.trailPct : 0.18,
    spikeExit: true,
    spikeSellPct: base.spikeSellPct != null ? base.spikeSellPct : 0.35,
    takeProfitLadder: base.takeProfitLadder || [
      { mult: 1.75, sellPct: 0.3 },
      { mult: 2.5, sellPct: 0.3 },
    ],
    timeStopMs: base.timeStopMs != null ? base.timeStopMs : 30 * 60e3,
    liquidityShockPct: base.liquidityShockPct != null ? base.liquidityShockPct : 0.09,
  };
}

/**
 * Detect volume/range spike for Mode A/B partial exit.
 * Uses live pair tick vs position history.
 */
function detectSpike(pos, live) {
  if (!live) return false;
  const volM5 = Number(live.volumeM5) || 0;
  const volH1 = Number(live.volumeH1) || Number(pos.volumeH24) / 24 || 0;
  const baseline = Math.max(volH1 / 12, 1);
  const volMult = volM5 / baseline;
  const ch5 = Math.abs(Number(live.priceChangeM5) || 0);
  const lane = pos.lane || 'MOVER';
  const rangeNeed = lane === 'FRESH' ? 12 : 8;
  const hist = pos.priceHistory || [];
  let rangePct = ch5;
  if (hist.length >= 4) {
    const recent = hist.slice(-8).map((h) => h.price);
    const hi = Math.max(...recent);
    const lo = Math.min(...recent);
    const mid = (hi + lo) / 2 || pos.entryPrice;
    rangePct = Math.max(rangePct, ((hi - lo) / mid) * 100);
  }
  return volMult >= 3 && rangePct >= rangeNeed;
}

function estimateSellImpactPct(pos, sellFrac = 1) {
  const liq = Number(pos.liquidity) || 0;
  const notional = (Number(pos.markValue) || Number(pos.remainingUsdBasis) || 0) * sellFrac;
  if (liq <= 0) return 1;
  // crude constant-product impact proxy
  return clamp(notional / liq, 0, 1);
}

function flowNegative(live, pos) {
  if (!live) return false;
  const buys = Number(live.buysM5) || 0;
  const sells = Number(live.sellsM5) || 0;
  if (buys + sells < 3) return false;
  return buys / Math.max(sells, 1) < 0.75;
}

function buyersFlat(live) {
  if (!live) return false;
  const buys = Number(live.buysM5) || 0;
  return buys <= 1 && (Number(live.volumeM5) || 0) < 500;
}

module.exports = {
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
};
