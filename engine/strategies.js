'use strict';

const PRESETS = {
  safe: {
    id: 'safe',
    label: 'Safe',
    minLiquidity: 80000,
    minScore: 78,
    buyPctMin: 0.08,
    buyPctMax: 0.12,
    maxPositions: 2,
    stopPct: -0.05,
    trailPct: 0.08,
    takeProfitLadder: [
      { mult: 1.5, sellPct: 0.35 },
      { mult: 2.0, sellPct: 0.35 },
    ],
    trailRemainder: true,
    kellyCap: 0.1,
    maxDailyLossPct: 0.08,
    cooldownMs: 10 * 60e3,
    slippage: 0.015,
    preferGraduating: false,
    lossStreakLimit: 3,
    lossStreakCooldownMs: 20 * 60e3,
    maxNarrativePct: 0.4,
    profitSweepPct: 0.35,
    profitSweepTrigger: 1.25,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    minLiquidity: 38000,
    minScore: 70,
    buyPctMin: 0.15,
    buyPctMax: 0.22,
    maxPositions: 3,
    stopPct: -0.06,
    trailPct: 0.1,
    takeProfitLadder: [
      { mult: 1.5, sellPct: 0.25 },
      { mult: 2.0, sellPct: 0.25 },
    ],
    trailRemainder: true,
    kellyCap: 0.18,
    maxDailyLossPct: 0.15,
    cooldownMs: 5 * 60e3,
    slippage: 0.02,
    preferGraduating: true,
    lossStreakLimit: 3,
    lossStreakCooldownMs: 12 * 60e3,
    maxNarrativePct: 0.5,
    profitSweepPct: 0.3,
    profitSweepTrigger: 1.35,
  },
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    minLiquidity: 25000,
    minScore: 62,
    buyPctMin: 0.2,
    buyPctMax: 0.3,
    maxPositions: 4,
    stopPct: -0.08,
    trailPct: 0.12,
    takeProfitLadder: [
      { mult: 1.5, sellPct: 0.2 },
      { mult: 2.0, sellPct: 0.2 },
      { mult: 3.0, sellPct: 0.25 },
    ],
    trailRemainder: true,
    kellyCap: 0.25,
    maxDailyLossPct: 0.25,
    cooldownMs: 2 * 60e3,
    slippage: 0.03,
    preferGraduating: true,
    lossStreakLimit: 4,
    lossStreakCooldownMs: 8 * 60e3,
    maxNarrativePct: 0.6,
    profitSweepPct: 0.25,
    profitSweepTrigger: 1.5,
  },
};

function applyPreset(settings, presetId) {
  const p = PRESETS[presetId] || PRESETS.balanced;
  return {
    ...settings,
    strategyId: p.id,
    minLiquidity: p.minLiquidity,
    minScore: p.minScore,
    buyPctMin: p.buyPctMin,
    buyPctMax: p.buyPctMax,
    maxPositions: p.maxPositions,
    stopPct: p.stopPct,
    trailPct: p.trailPct,
    takeProfitLadder: p.takeProfitLadder,
    trailRemainder: p.trailRemainder,
    kellyCap: p.kellyCap,
    maxDailyLossPct: p.maxDailyLossPct,
    cooldownMs: p.cooldownMs,
    slippage: p.slippage,
    preferGraduating: p.preferGraduating,
    lossStreakLimit: p.lossStreakLimit,
    lossStreakCooldownMs: p.lossStreakCooldownMs,
    maxNarrativePct: p.maxNarrativePct,
    profitSweepPct: p.profitSweepPct,
    profitSweepTrigger: p.profitSweepTrigger,
  };
}

/**
 * Volatility-aware Kelly-capped size.
 * Higher realized vol (from priceChangeH1 abs / liquidity thinness) → smaller size.
 */
function positionSizeFraction(score, settings, opts = {}) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const edge = (s - 50) / 100;
  const kelly = Math.max(0, edge * 0.5);
  const capped = Math.min(settings.kellyCap || 0.18, kelly || settings.buyPctMin);
  const base =
    settings.buyPctMin +
    ((s - settings.minScore) / Math.max(1, 100 - settings.minScore)) *
      (settings.buyPctMax - settings.buyPctMin);
  let frac = Math.max(settings.buyPctMin, Math.min(settings.buyPctMax, Math.max(base, capped * 0.9)));

  const vol = Math.abs(Number(opts.priceChangeH1) || 0);
  const liq = Number(opts.liquidity) || 0;
  let volFactor = 1;
  if (vol > 80) volFactor = 0.55;
  else if (vol > 40) volFactor = 0.7;
  else if (vol > 20) volFactor = 0.85;
  if (liq > 0 && liq < 40000) volFactor *= 0.85;
  frac *= volFactor;

  if (opts.narrativeOverExposed) frac *= 0.5;

  return Math.max(settings.buyPctMin * 0.5, Math.min(settings.buyPctMax, frac));
}

module.exports = { PRESETS, applyPreset, positionSizeFraction };
