'use strict';

/**
 * Auto-learning loop (paper only).
 * - Log every candidate (bought + skipped) with features
 * - Stamp outcomes at 5m / 15m / 1h / 6h
 * - Nightly logistic retrain of Runner Score feature weights
 * - Promote versioned weights only if they beat CONTROL on paper expectancy
 * - Grow/prune smart wallets from early buyers of runners
 */

const fs = require('fs');
const path = require('path');

const LEARN_DIR = path.join(__dirname, '..', 'data', 'learn');
const HORIZONS = [
  { key: 'm5', ms: 5 * 60e3 },
  { key: 'm15', ms: 15 * 60e3 },
  { key: 'h1', ms: 60 * 60e3 },
  { key: 'h6', ms: 6 * 3600e3 },
];

const FEATURE_KEYS = [
  'velocity', 'buyerAccel', 'smartCluster', 'holderGrowth', 'turnover',
  'kol', 'deployer', 'narrative', 'structure', 'xBuzz',
  'narrativeFit', 'firstMover', 'tweetToLaunch', 'copycatPenalty',
  'whaleCluster', 'viralMeme', 'boosted', 'liqLog', 'ageMin',
];

function ensureDir() {
  try { fs.mkdirSync(LEARN_DIR, { recursive: true }); } catch (_) {}
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function ensureLearn(state) {
  if (!state.learn) {
    state.learn = {
      candidates: [],
      lastTrainAt: 0,
      lastOutcomeAt: 0,
      weightsVersion: 0,
      promotedVersion: 0,
      pendingWeights: null,
      controlExpectancy: 0,
      learnedExpectancy: 0,
      lastPromoteAt: 0,
      lastError: null,
      stats: { logged: 0, labeled: 0, trains: 0, promotes: 0 },
    };
  }
  if (!state.learn.stats) state.learn.stats = { logged: 0, labeled: 0, trains: 0, promotes: 0 };
  if (!Array.isArray(state.learn.candidates)) state.learn.candidates = [];
  return state.learn;
}

function extractFeatures(pair = {}, ctx = {}) {
  const c = (pair.runnerComponents || ctx.components || {});
  const f = {
    velocity: Number(c.velocity) || 0,
    buyerAccel: Number(c.buyerAccel) || 0,
    smartCluster: Number(c.smartCluster) || 0,
    holderGrowth: Number(c.holderGrowth) || 0,
    turnover: Number(c.turnover) || 0,
    kol: Number(c.kol) || 0,
    deployer: Number(c.deployer) || 0,
    narrative: Number(c.narrative) || 0,
    structure: Number(c.structure) || 0,
    xBuzz: Number(ctx.xBuzzScore || pair.xBuzzScore || 0),
    narrativeFit: Number(ctx.narrativeFit || pair.narrativeFit || 0),
    firstMover: Number(ctx.firstMover || pair.firstMover || 0),
    tweetToLaunch: Number(ctx.tweetToLaunch || pair.tweetToLaunch || 0),
    copycatPenalty: Number(ctx.copycatPenalty || pair.copycatPenalty || 0),
    whaleCluster: Number(ctx.whaleCluster || pair.whaleCluster || 0),
    viralMeme: Number(ctx.viralMeme || pair.viralMeme || 0),
    boosted: pair.boosted ? 1 : 0,
    liqLog: Math.log10(Math.max(1, Number(pair.liquidity) || 1)),
    ageMin: Math.min(1440, (Number(pair.ageMs) || 0) / 60000),
  };
  return f;
}

function logCandidate(state, row) {
  const L = ensureLearn(state);
  const mint = row.mint;
  if (!mint) return null;
  // de-dupe same mint within 10m
  const recent = L.candidates.find((c) => c.mint === mint && Date.now() - c.ts < 10 * 60e3);
  if (recent) {
    recent.decision = row.decision || recent.decision;
    recent.score = row.score != null ? row.score : recent.score;
    Object.assign(recent.features, row.features || {});
    return recent;
  }
  const entry = {
    id: `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    mint,
    symbol: row.symbol || null,
    decision: row.decision || 'skip', // buy | skip
    reason: row.reason || null,
    score: Number(row.score) || 0,
    runnerScore: Number(row.runnerScore) || 0,
    abArm: row.abArm || null,
    lane: row.lane || null,
    entryPrice: Number(row.entryPrice) || Number(row.price) || 0,
    features: { ...extractFeatures(row.pair || row, row.ctx || {}), ...(row.features || {}) },
    peakMult: 1,
    troughMult: 1,
    outcomes: {},
    labeled: false,
    earlyBuyers: row.earlyBuyers || [],
  };
  L.candidates.unshift(entry);
  if (L.candidates.length > 800) L.candidates = L.candidates.slice(0, 800);
  L.stats.logged = (L.stats.logged || 0) + 1;
  return entry;
}

function updatePricePath(cand, price) {
  const entry = cand.entryPrice || 0;
  if (!(entry > 0) || !(price > 0)) return;
  const m = price / entry;
  cand.peakMult = Math.max(cand.peakMult || 1, m);
  cand.troughMult = Math.min(cand.troughMult == null ? 1 : cand.troughMult, m);
}

function stampHorizon(cand, key) {
  const entry = cand.entryPrice || 0;
  const peak = cand.peakMult || 1;
  const trough = cand.troughMult == null ? 1 : cand.troughMult;
  // hit 2x before -50% from entry (trough <= 0.5 after having peaked, or never hit 2x)
  const hit2x = peak >= 2;
  const rugged = trough <= 0.5;
  const label = hit2x && !(rugged && trough < 0.5 && peak < 2) ? 1 : hit2x && !rugged ? 1 : hit2x ? 1 : 0;
  // cleaner: positive if peaked >=2x at any point before being stamped, and trough stayed >0.5 until after 2x
  const y = peak >= 2 && trough > 0.45 ? 1 : 0;
  cand.outcomes[key] = {
    at: Date.now(),
    peakMult: round4(peak),
    troughMult: round4(trough),
    y,
    hit2x,
    rugged,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * priceByMint: Map or object mint -> price
 */
function tickOutcomes(state, priceByMint = {}) {
  const L = ensureLearn(state);
  const now = Date.now();
  let n = 0;
  for (const c of L.candidates) {
    const px = priceByMint[c.mint];
    if (px > 0) {
      if (!c.entryPrice) c.entryPrice = px;
      updatePricePath(c, px);
    }
    for (const h of HORIZONS) {
      if (c.outcomes[h.key]) continue;
      if (now - c.ts >= h.ms) {
        stampHorizon(c, h.key);
        n += 1;
      }
    }
    if (c.outcomes.h6 && !c.labeled) {
      c.labeled = true;
      c.y = c.outcomes.h6.y;
      L.stats.labeled = (L.stats.labeled || 0) + 1;
    }
  }
  L.lastOutcomeAt = now;
  return n;
}

/** Simple L2-regularized logistic regression (batch GD). */
function trainLogistic(rows, keys = FEATURE_KEYS, { iters = 80, lr = 0.08, l2 = 0.02 } = {}) {
  const w = {};
  for (const k of keys) w[k] = 0;
  let b = 0;
  if (rows.length < 12) return { ok: false, reason: 'need>=12 labeled', weights: w, bias: b, n: rows.length };

  const X = rows.map((r) => keys.map((k) => Number((r.features || {})[k]) || 0));
  // standardize lightly
  const mean = keys.map((_, j) => X.reduce((a, row) => a + row[j], 0) / X.length);
  const std = keys.map((_, j) => {
    const v = X.reduce((a, row) => a + (row[j] - mean[j]) ** 2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  const Xs = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  const y = rows.map((r) => (r.y != null ? r.y : (r.outcomes && r.outcomes.h6 && r.outcomes.h6.y) || 0));

  for (let it = 0; it < iters; it++) {
    const grad = keys.map(() => 0);
    let gb = 0;
    for (let i = 0; i < Xs.length; i++) {
      let z = b;
      for (let j = 0; j < keys.length; j++) z += w[keys[j]] * Xs[i][j];
      const p = 1 / (1 + Math.exp(-clamp(z, -20, 20)));
      const err = p - y[i];
      for (let j = 0; j < keys.length; j++) grad[j] += err * Xs[i][j];
      gb += err;
    }
    const n = Xs.length;
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      w[k] -= lr * ((grad[j] / n) + l2 * w[k]);
    }
    b -= lr * (gb / n);
  }
  // accuracy
  let correct = 0;
  for (let i = 0; i < Xs.length; i++) {
    let z = b;
    for (let j = 0; j < keys.length; j++) z += w[keys[j]] * Xs[i][j];
    const pred = z >= 0 ? 1 : 0;
    if (pred === y[i]) correct += 1;
  }
  return {
    ok: true,
    weights: w,
    bias: b,
    mean,
    std,
    keys,
    n: rows.length,
    acc: correct / rows.length,
    positives: y.filter(Boolean).length,
  };
}

function scoreWithLearned(features, model) {
  if (!model || !model.weights) return 0;
  const keys = model.keys || FEATURE_KEYS;
  let z = model.bias || 0;
  for (let j = 0; j < keys.length; j++) {
    const k = keys[j];
    const raw = Number(features[k]) || 0;
    const mean = (model.mean && model.mean[j]) || 0;
    const std = (model.std && model.std[j]) || 1;
    z += (model.weights[k] || 0) * ((raw - mean) / (std || 1));
  }
  return 1 / (1 + Math.exp(-clamp(z, -20, 20)));
}

function persistVersion(model, version) {
  ensureDir();
  const file = path.join(LEARN_DIR, `weights-v${version}.json`);
  fs.writeFileSync(file, JSON.stringify({ version, at: Date.now(), model }, null, 2));
  return file;
}

function expectancy(rows, predFn) {
  // paper proxy: among predicted positives, rate of y=1 minus among predicted negatives
  if (!rows.length) return 0;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const p = predFn(r);
    const y = r.y != null ? r.y : 0;
    if (p >= 0.5 && y === 1) tp++;
    else if (p >= 0.5 && y === 0) fp++;
    else if (p < 0.5 && y === 0) tn++;
    else fn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  return prec * 0.7 + rec * 0.3;
}

function nightlyRetrain(state) {
  const L = ensureLearn(state);
  const now = Date.now();
  // once per ~20h
  if (L.lastTrainAt && now - L.lastTrainAt < 20 * 3600e3) {
    return { ok: false, reason: 'too-soon', nextInMs: 20 * 3600e3 - (now - L.lastTrainAt) };
  }
  const labeled = L.candidates.filter((c) => c.labeled || (c.outcomes && c.outcomes.h6));
  for (const c of labeled) {
    if (c.y == null && c.outcomes && c.outcomes.h6) c.y = c.outcomes.h6.y;
  }
  const model = trainLogistic(labeled);
  L.lastTrainAt = now;
  L.stats.trains = (L.stats.trains || 0) + 1;
  if (!model.ok) {
    L.lastError = model.reason;
    return model;
  }
  const version = (L.weightsVersion || 0) + 1;
  L.weightsVersion = version;
  L.pendingWeights = model;
  try { persistVersion(model, version); } catch (e) { L.lastError = e.message; }

  // CONTROL = always-buy baseline among logged buys; learned = model threshold
  const buys = labeled.filter((c) => c.decision === 'buy');
  const controlRows = buys.length ? buys : labeled;
  const controlExp = expectancy(controlRows, () => 0.6); // naive
  const learnedExp = expectancy(labeled, (r) => scoreWithLearned(r.features, model));
  L.controlExpectancy = round4(controlExp);
  L.learnedExpectancy = round4(learnedExp);

  // Promote only if beats control
  if (learnedExp > controlExp + 0.02 && model.n >= 20) {
    L.promotedVersion = version;
    L.runnerWeights = model;
    L.lastPromoteAt = now;
    L.stats.promotes = (L.stats.promotes || 0) + 1;
    return { ok: true, promoted: true, version, acc: model.acc, n: model.n, learnedExp, controlExp };
  }
  return { ok: true, promoted: false, version, acc: model.acc, n: model.n, learnedExp, controlExp };
}

/** Apply promoted model as additive bonus 0–12 to runner score. */
function learnedBonus(state, features) {
  const L = ensureLearn(state);
  if (!L.runnerWeights || !L.promotedVersion) return 0;
  const p = scoreWithLearned(features, L.runnerWeights);
  return Math.round(clamp((p - 0.5) * 24, -6, 12));
}

function growSmartWalletsFromWinners(state, { promoteFn } = {}) {
  const L = ensureLearn(state);
  const reg = state.smartMoney;
  if (!reg || !promoteFn) return { grown: 0, pruned: 0 };
  let grown = 0;
  let pruned = 0;
  for (const c of L.candidates) {
    if (!c.labeled) continue;
    const y = c.y != null ? c.y : c.outcomes && c.outcomes.h6 && c.outcomes.h6.y;
    const buyers = c.earlyBuyers || [];
    if (y === 1) {
      for (const addr of buyers.slice(0, 8)) {
        promoteFn(reg, addr, { label: 'learn-runner', boost: 3, note: `runner ${c.symbol || c.mint.slice(0, 6)}` });
        grown += 1;
      }
    } else if (y === 0) {
      for (const addr of buyers.slice(0, 8)) {
        const w = (reg.wallets || []).find((x) => x.address === addr);
        if (w && w.mined) {
          w.score = clamp((w.score || 50) - 2, 10, 99);
          w.losses = (w.losses || 0) + 1;
          if (w.score < 35 && (w.wins || 0) < 2) {
            w.pruned = true;
            pruned += 1;
          }
        }
      }
    }
  }
  // drop pruned
  if (pruned) reg.wallets = (reg.wallets || []).filter((w) => !w.pruned || (w.score || 0) >= 40);
  return { grown, pruned };
}

function stats(state) {
  const L = ensureLearn(state);
  return {
    candidates: L.candidates.length,
    labeled: L.stats.labeled || 0,
    logged: L.stats.logged || 0,
    trains: L.stats.trains || 0,
    promotes: L.stats.promotes || 0,
    weightsVersion: L.weightsVersion || 0,
    promotedVersion: L.promotedVersion || 0,
    lastTrainAt: L.lastTrainAt || 0,
    lastOutcomeAt: L.lastOutcomeAt || 0,
    controlExpectancy: L.controlExpectancy,
    learnedExpectancy: L.learnedExpectancy,
    lastError: L.lastError,
    featureKeys: FEATURE_KEYS,
  };
}

module.exports = {
  FEATURE_KEYS,
  HORIZONS,
  ensureLearn,
  extractFeatures,
  logCandidate,
  tickOutcomes,
  nightlyRetrain,
  learnedBonus,
  growSmartWalletsFromWinners,
  scoreWithLearned,
  trainLogistic,
  stats,
};
