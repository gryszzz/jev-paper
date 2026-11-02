'use strict';

/**
 * Closed-trade feedback loop: reweight analyst signal keys from paper outcomes.
 * Persists inside engine state.weights (caller owns persistence).
 */

const DEFAULT_WEIGHTS = {
  liquidity: 1,
  volume: 1,
  flow: 1.15,
  age: 1,
  'mc/liq': 1,
  momentum: 1.1,
  graduation: 1.2,
  'social/tx': 0.9,
  rugcheck: 1.25,
  concentration: 1.2,
  sniper: 1.15,
  buyers: 1.1,
  pressure: 1.15,
  smartMoney: 1.25,
  narrative: 1,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function ensureWeights(state) {
  if (!state.signalWeights) state.signalWeights = { ...DEFAULT_WEIGHTS };
  if (!state.signalStats) state.signalStats = {};
  return state.signalWeights;
}

/**
 * After a full close, nudge weights for keys that were strong on winners / weak on losers.
 * @param {object} state
 * @param {{ breakdown?: Array<{k:string,v:number}>, pnl:number, pnlPct:number }} trade
 */
function recordClosedTrade(state, trade) {
  const weights = ensureWeights(state);
  const breakdown = trade.breakdown || trade.scoreBreakdown || [];
  if (!breakdown.length) return weights;
  const win = (trade.pnl || 0) > 0 || (trade.pnlPct || 0) > 0;
  const magnitude = clamp(Math.abs(Number(trade.pnlPct) || 0) / 40, 0.05, 0.35);
  const dir = win ? 1 : -1;

  for (const row of breakdown) {
    const k = row.k;
    if (!k || !(k in DEFAULT_WEIGHTS) && weights[k] == null) {
      if (k) weights[k] = 1;
    }
    const contrib = Number(row.v) || 0;
    // Only credit/debit signals that actually moved the score
    if (Math.abs(contrib) < 2) continue;
    const delta = dir * magnitude * (contrib > 0 ? 0.04 : -0.02);
    weights[k] = clamp((weights[k] ?? 1) + delta, 0.4, 2.2);
    state.signalStats[k] = state.signalStats[k] || { n: 0, wins: 0, sumPnl: 0 };
    state.signalStats[k].n += 1;
    if (win) state.signalStats[k].wins += 1;
    state.signalStats[k].sumPnl += Number(trade.pnl) || 0;
  }
  return weights;
}

function applyWeights(breakdown, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  let score = 0;
  const out = [];
  for (const row of breakdown) {
    const factor = w[row.k] != null ? w[row.k] : 1;
    const v = Math.round((Number(row.v) || 0) * factor);
    score += v;
    out.push({ ...row, v, raw: row.v, weight: round2(factor) });
  }
  return { score, breakdown: out };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function topWeights(weights, n = 5) {
  return Object.entries(weights || DEFAULT_WEIGHTS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ k, v: round2(v) }));
}

module.exports = {
  DEFAULT_WEIGHTS,
  ensureWeights,
  recordClosedTrade,
  applyWeights,
  topWeights,
};
