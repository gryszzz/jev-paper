'use strict';

/**
 * Auto-learning loop (paper only) — provable.
 * - Log every candidate (bought + skipped) with feature vectors
 * - Stamp forward returns at 5m / 15m / 1h / 6h (+ peak/trough / y)
 * - Persist candidates + versioned weights to disk (mirrored via state→Supabase)
 * - Nightly (or forced) logistic refit; promote only if beats CONTROL
 */

const fs = require('fs');
const path = require('path');

const LEARN_DIR = path.join(__dirname, '..', 'data', 'learn');
const CAND_JSONL = path.join(LEARN_DIR, 'candidates.jsonl');
const CAND_SNAP = path.join(LEARN_DIR, 'candidates-latest.json');
const LAST_REFIT = path.join(LEARN_DIR, 'last-refit.json');

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
  'catalyst', 'earlyTraction',
];

function ensureDir() {
  try { fs.mkdirSync(LEARN_DIR, { recursive: true }); } catch (_) {}
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
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
      runnerWeights: null,
      controlExpectancy: 0,
      learnedExpectancy: 0,
      lastPromoteAt: 0,
      lastRejectAt: 0,
      lastError: null,
      lastRefit: null,
      stats: { logged: 0, labeled: 0, trains: 0, promotes: 0, rejects: 0 },
    };
  }
  if (!state.learn.stats) {
    state.learn.stats = { logged: 0, labeled: 0, trains: 0, promotes: 0, rejects: 0 };
  }
  if (state.learn.stats.rejects == null) state.learn.stats.rejects = 0;
  if (!Array.isArray(state.learn.candidates)) state.learn.candidates = [];
  return state.learn;
}

function extractFeatures(pair = {}, ctx = {}) {
  const c = (pair.runnerComponents || ctx.components || {});
  return {
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
    catalyst: Number(ctx.catalyst || pair.catalyst || 0),
    earlyTraction: Number(ctx.earlyTraction || pair.earlyTraction || 0),
  };
}

function appendJsonl(row) {
  ensureDir();
  try {
    fs.appendFileSync(CAND_JSONL, JSON.stringify(row) + '\n');
  } catch (_) {}
}

function snapshotCandidates(L) {
  ensureDir();
  try {
    const slim = (L.candidates || []).slice(0, 400).map((c) => ({
      id: c.id,
      ts: c.ts,
      mint: c.mint,
      symbol: c.symbol,
      decision: c.decision,
      reason: c.reason,
      score: c.score,
      runnerScore: c.runnerScore,
      abArm: c.abArm,
      lane: c.lane,
      entryPrice: c.entryPrice,
      lastPrice: c.lastPrice,
      features: c.features,
      peakMult: c.peakMult,
      troughMult: c.troughMult,
      outcomes: c.outcomes,
      labeled: c.labeled,
      labelHorizon: c.labelHorizon,
      y: c.y,
    }));
    fs.writeFileSync(CAND_SNAP, JSON.stringify({
      at: Date.now(),
      n: slim.length,
      logged: L.stats.logged,
      labeled: L.stats.labeled,
      candidates: slim,
    }));
  } catch (_) {}
}

function writeLastRefit(report) {
  ensureDir();
  try {
    fs.writeFileSync(LAST_REFIT, JSON.stringify(report, null, 2));
  } catch (_) {}
}

function logCandidate(state, row) {
  const L = ensureLearn(state);
  const mint = row.mint;
  if (!mint) return null;
  const recent = L.candidates.find((c) => c.mint === mint && Date.now() - c.ts < 10 * 60e3);
  if (recent) {
    recent.decision = row.decision || recent.decision;
    recent.reason = row.reason || recent.reason;
    recent.score = row.score != null ? row.score : recent.score;
    Object.assign(recent.features, row.features || {});
    return recent;
  }
  const entry = {
    id: `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    mint,
    symbol: row.symbol || null,
    decision: row.decision || 'skip',
    reason: row.reason || null,
    score: Number(row.score) || 0,
    runnerScore: Number(row.runnerScore) || 0,
    abArm: row.abArm || null,
    lane: row.lane || null,
    entryPrice: Number(row.entryPrice) || Number(row.price) || 0,
    lastPrice: Number(row.price) || Number(row.entryPrice) || 0,
    features: { ...extractFeatures(row.pair || row, row.ctx || {}), ...(row.features || {}) },
    peakMult: 1,
    troughMult: 1,
    outcomes: {},
    labeled: false,
    labelHorizon: null,
    y: null,
    earlyBuyers: row.earlyBuyers || [],
  };
  L.candidates.unshift(entry);
  if (L.candidates.length > 200) L.candidates = L.candidates.slice(0, 200);
  L.stats.logged = (L.stats.logged || 0) + 1;
  appendJsonl({
    op: 'log',
    at: entry.ts,
    id: entry.id,
    mint: entry.mint,
    symbol: entry.symbol,
    decision: entry.decision,
    reason: entry.reason,
    score: entry.score,
    runnerScore: entry.runnerScore,
    lane: entry.lane,
    abArm: entry.abArm,
    entryPrice: entry.entryPrice,
    features: entry.features,
  });
  if (L.stats.logged % 5 === 0) snapshotCandidates(L);
  return entry;
}

function updatePricePath(cand, price) {
  const entry = cand.entryPrice || 0;
  if (!(price > 0)) return;
  cand.lastPrice = price;
  if (!(entry > 0)) {
    cand.entryPrice = price;
    return;
  }
  const m = price / entry;
  cand.peakMult = Math.max(cand.peakMult || 1, m);
  cand.troughMult = Math.min(cand.troughMult == null ? 1 : cand.troughMult, m);
}

function stampHorizon(cand, key) {
  const entry = cand.entryPrice || 0;
  const last = cand.lastPrice || entry;
  const peak = cand.peakMult || 1;
  const trough = cand.troughMult == null ? 1 : cand.troughMult;
  const mult = entry > 0 && last > 0 ? last / entry : 1;
  const ret = round4(mult - 1);
  const hit2x = peak >= 2;
  const rugged = trough <= 0.5;
  // runner label: peaked ≥2x without collapsing below ~0.45x
  const y = peak >= 2 && trough > 0.45 ? 1 : 0;
  cand.outcomes[key] = {
    at: Date.now(),
    peakMult: round4(peak),
    troughMult: round4(trough),
    lastPrice: last || null,
    mult: round4(mult),
    ret,
    y,
    hit2x,
    rugged,
  };
  appendJsonl({
    op: 'outcome',
    at: Date.now(),
    id: cand.id,
    mint: cand.mint,
    horizon: key,
    ret,
    mult: round4(mult),
    peakMult: round4(peak),
    troughMult: round4(trough),
    y,
  });
}

function applyBestLabel(cand, L) {
  // Prefer longer horizons when available
  const order = ['h6', 'h1', 'm15', 'm5'];
  for (const h of order) {
    if (cand.outcomes[h]) {
      const was = cand.labeled;
      cand.y = cand.outcomes[h].y;
      cand.labelHorizon = h;
      cand.labeled = true;
      if (!was) L.stats.labeled = (L.stats.labeled || 0) + 1;
      return h;
    }
  }
  return null;
}

function tickOutcomes(state, priceByMint = {}) {
  const L = ensureLearn(state);
  const now = Date.now();
  let n = 0;
  const getPx = (mint) => {
    if (!mint) return null;
    if (priceByMint instanceof Map) return priceByMint.get(mint);
    return priceByMint[mint];
  };
  for (const c of L.candidates) {
    const px = getPx(c.mint);
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
    // progressive labeling: stamp label as soon as m5 exists; upgrade when longer arrives
    if (c.outcomes.m5 || c.outcomes.m15 || c.outcomes.h1 || c.outcomes.h6) {
      applyBestLabel(c, L);
    }
  }
  L.lastOutcomeAt = now;
  if (n > 0) snapshotCandidates(L);
  return n;
}

function trainLogistic(rows, keys = FEATURE_KEYS, { iters = 80, lr = 0.08, l2 = 0.02, minN = 12 } = {}) {
  const w = {};
  for (const k of keys) w[k] = 0;
  let b = 0;
  if (rows.length < minN) {
    return { ok: false, reason: `need>=${minN} labeled`, weights: w, bias: b, n: rows.length };
  }

  const X = rows.map((r) => keys.map((k) => Number((r.features || {})[k]) || 0));
  const mean = keys.map((_, j) => X.reduce((a, row) => a + row[j], 0) / X.length);
  const std = keys.map((_, j) => {
    const v = X.reduce((a, row) => a + (row[j] - mean[j]) ** 2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  const Xs = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  const y = rows.map((r) => (r.y != null ? r.y : 0));

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
  let correct = 0;
  for (let i = 0; i < Xs.length; i++) {
    let z = b;
    for (let j = 0; j < keys.length; j++) z += w[keys[j]] * Xs[i][j];
    if ((z >= 0 ? 1 : 0) === y[i]) correct += 1;
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

function persistVersion(model, version, meta = {}) {
  ensureDir();
  const file = path.join(LEARN_DIR, `weights-v${version}.json`);
  fs.writeFileSync(file, JSON.stringify({ version, at: Date.now(), meta, model }, null, 2));
  return file;
}

function expectancy(rows, predFn) {
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

function collectLabeled(L, { allowPartial = true } = {}) {
  const out = [];
  for (const c of L.candidates) {
    if (allowPartial) applyBestLabel(c, L);
    if (!c.labeled && !(c.outcomes && (c.outcomes.h6 || c.outcomes.h1 || c.outcomes.m15 || c.outcomes.m5))) continue;
    if (c.y == null && c.outcomes) {
      applyBestLabel(c, L);
    }
    if (c.labeled || c.y != null) out.push(c);
  }
  return out;
}

/**
 * @param {object} state
 * @param {{ force?: boolean, minN?: number }} [opts]
 */
function nightlyRetrain(state, opts = {}) {
  const force = !!opts.force;
  const minN = opts.minN != null ? opts.minN : (force ? 8 : 12);
  const L = ensureLearn(state);
  const now = Date.now();
  if (!force && L.lastTrainAt && now - L.lastTrainAt < 20 * 3600e3) {
    return { ok: false, reason: 'too-soon', nextInMs: 20 * 3600e3 - (now - L.lastTrainAt) };
  }

  // Ensure any due horizons are stamped before train (caller should also tickOutcomes)
  const labeled = collectLabeled(L, { allowPartial: true });
  const horizonCounts = { m5: 0, m15: 0, h1: 0, h6: 0 };
  for (const c of labeled) {
    if (c.labelHorizon && horizonCounts[c.labelHorizon] != null) horizonCounts[c.labelHorizon] += 1;
  }

  const model = trainLogistic(labeled, FEATURE_KEYS, { minN });
  L.lastTrainAt = now;
  L.stats.trains = (L.stats.trains || 0) + 1;

  if (!model.ok) {
    L.lastError = model.reason;
    const report = {
      ok: false,
      reason: model.reason,
      at: now,
      force,
      sampleCount: labeled.length,
      logged: L.stats.logged,
      horizonCounts,
      weightsVersion: L.weightsVersion || 0,
      promotedVersion: L.promotedVersion || 0,
      status: 'insufficient-data',
    };
    L.lastRefit = report;
    writeLastRefit(report);
    snapshotCandidates(L);
    return report;
  }

  const version = (L.weightsVersion || 0) + 1;
  L.weightsVersion = version;
  L.pendingWeights = model;
  let weightsFile = null;
  try {
    weightsFile = persistVersion(model, version, { force, horizonCounts, n: model.n, acc: model.acc });
  } catch (e) {
    L.lastError = e.message;
  }

  const buys = labeled.filter((c) => c.decision === 'buy');
  const controlRows = buys.length >= Math.min(4, labeled.length) ? buys : labeled;
  const controlExp = expectancy(controlRows, () => 0.6);
  const learnedExp = expectancy(labeled, (r) => scoreWithLearned(r.features, model));
  L.controlExpectancy = round4(controlExp);
  L.learnedExpectancy = round4(learnedExp);

  const margin = 0.02;
  const promoteOk = learnedExp > controlExp + margin && model.n >= minN;
  let status = 'rejected';
  if (promoteOk) {
    L.promotedVersion = version;
    L.runnerWeights = model;
    L.lastPromoteAt = now;
    L.stats.promotes = (L.stats.promotes || 0) + 1;
    status = 'promoted';
  } else {
    L.lastRejectAt = now;
    L.stats.rejects = (L.stats.rejects || 0) + 1;
    status = 'rejected';
  }

  const topWeights = Object.entries(model.weights || {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 8)
    .map(([k, v]) => ({ k, w: round4(v) }));

  const report = {
    ok: true,
    at: now,
    force,
    status,
    promoted: status === 'promoted',
    version,
    weightsVersion: version,
    promotedVersion: L.promotedVersion || 0,
    sampleCount: model.n,
    labeled: labeled.length,
    logged: L.stats.logged,
    acc: round4(model.acc),
    positives: model.positives,
    learnedExpectancy: round4(learnedExp),
    controlExpectancy: round4(controlExp),
    margin,
    horizonCounts,
    labelHorizonsUsed: [...new Set(labeled.map((c) => c.labelHorizon).filter(Boolean))],
    weightsFile: weightsFile ? path.basename(weightsFile) : null,
    topWeights,
    decisions: {
      buys: labeled.filter((c) => c.decision === 'buy').length,
      skips: labeled.filter((c) => c.decision === 'skip').length,
    },
  };
  L.lastRefit = report;
  L.lastError = null;
  writeLastRefit(report);
  snapshotCandidates(L);
  appendJsonl({ op: 'refit', ...report });
  return report;
}

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
  if (pruned) reg.wallets = (reg.wallets || []).filter((w) => !w.pruned || (w.score || 0) >= 40);
  return { grown, pruned };
}

function listWeightFiles() {
  ensureDir();
  try {
    return fs.readdirSync(LEARN_DIR)
      .filter((f) => /^weights-v\d+\.json$/.test(f))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

function stats(state) {
  const L = ensureLearn(state);
  const labeledNow = (L.candidates || []).filter((c) => c.labeled).length;
  const withOutcomes = (L.candidates || []).filter((c) => c.outcomes && Object.keys(c.outcomes).length).length;
  return {
    candidates: L.candidates.length,
    labeled: Math.max(L.stats.labeled || 0, labeledNow),
    logged: L.stats.logged || 0,
    trains: L.stats.trains || 0,
    promotes: L.stats.promotes || 0,
    rejects: L.stats.rejects || 0,
    withOutcomes,
    weightsVersion: L.weightsVersion || 0,
    promotedVersion: L.promotedVersion || 0,
    lastTrainAt: L.lastTrainAt || 0,
    lastOutcomeAt: L.lastOutcomeAt || 0,
    lastPromoteAt: L.lastPromoteAt || 0,
    lastRejectAt: L.lastRejectAt || 0,
    controlExpectancy: L.controlExpectancy,
    learnedExpectancy: L.learnedExpectancy,
    lastError: L.lastError,
    lastRefit: L.lastRefit,
    status: L.lastRefit
      ? L.lastRefit.status
      : (L.promotedVersion ? 'promoted' : (L.weightsVersion ? 'rejected' : 'idle')),
    featureKeys: FEATURE_KEYS,
    disk: {
      candidatesJsonl: fs.existsSync(CAND_JSONL),
      candidatesSnap: fs.existsSync(CAND_SNAP),
      lastRefit: fs.existsSync(LAST_REFIT),
      weightFiles: listWeightFiles().slice(0, 8),
    },
  };
}

function learningReport(state) {
  const L = ensureLearn(state);
  const s = stats(state);
  const recent = (L.candidates || []).slice(0, 12).map((c) => ({
    id: c.id,
    ts: c.ts,
    symbol: c.symbol,
    mint: (c.mint || '').slice(0, 8),
    decision: c.decision,
    reason: c.reason,
    score: c.score,
    labeled: !!c.labeled,
    labelHorizon: c.labelHorizon,
    y: c.y,
    outcomes: c.outcomes,
    features: c.features,
  }));
  return {
    ...s,
    horizons: HORIZONS.map((h) => h.key),
    recentCandidates: recent,
    evidence: {
      persistence: 'disk data/learn/* + state.learn via Supabase jev_paper_state',
      promoteRule: 'learnedExpectancy > controlExpectancy + 0.02',
      labels: 'progressive m5→m15→h1→h6; y=1 if peak≥2x and trough>0.45',
      nightlyHourEt: 4,
    },
  };
}

module.exports = {
  FEATURE_KEYS,
  HORIZONS,
  LEARN_DIR,
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
  learningReport,
  snapshotCandidates,
};
