'use strict';

const { rugcheck, socialVelocity } = require('./sources');
const { applyWeights, ensureWeights } = require('./feedback');
const { tagCoin, narrativeHeat } = require('./narratives');
const { smartMoneyOverlap } = require('./smartMoney');
const { bondingProgress, hasSocials, LANE } = require('./lanes');
const { runnerScore, runnerBandAction } = require('./runnerScore');

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * Detect bundled/sniper-ish concentration from top holders + age.
 * Heuristic (free data): many top wallets with near-equal % shortly after launch.
 */
function detectBundledSnipers(rug, ageH) {
  const top = (rug && rug.topHoldersDetail) || [];
  if (!top.length) {
    const topPct = (rug && rug.topHolderPct) || 0;
    let sniperRisk = 0;
    if (ageH < 0.5 && topPct > 35) sniperRisk = 12;
    else if (ageH < 2 && topPct > 45) sniperRisk = 10;
    else if (topPct > 55) sniperRisk = 8;
    return { sniperRisk, bundled: topPct > 40 && ageH < 1, note: `top ${Math.round(topPct)}%` };
  }
  const pcts = top.map((h) => Number(h.pct) || 0).filter((x) => x > 0.3);
  if (pcts.length < 3) return { sniperRisk: 0, bundled: false, note: 'sparse' };
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pcts.length;
  const similar = variance < 4 && pcts.length >= 4 && ageH < 2;
  const sniperRisk = similar ? 14 : ageH < 0.25 && pcts[0] > 8 ? 8 : 0;
  return { sniperRisk, bundled: similar, note: similar ? 'bundled-like' : 'ok' };
}

/** Unique buyers / minute proxy from m5 + h1 txn counts. */
function buyersPerMinute(pair) {
  const buysM5 = Number(pair.buysM5) || 0;
  const buysH1 = Number(pair.buysH1) || 0;
  const perMin5 = buysM5 / 5;
  const perMinH1 = buysH1 / 60;
  return Math.max(perMin5, perMinH1 * 0.5);
}

async function scorePair(pair, settings, ctx = {}) {
  const breakdown = [];
  let score = 0;
  const state = ctx.state;
  const weights = state ? ensureWeights(state) : null;
  const heatMap = ctx.heatMap || {};
  const smartReg = ctx.smartMoney || null;

  const lane = pair.lane || (pair._laneInfo && pair._laneInfo.lane) || null;
  const liq = pair.liquidity || 0;
  let minLiq = settings.minLiquidity || 15000;
  // Absolute floor $15k on GRAD/MOVER to avoid rug fills through %-stops; FRESH slightly softer.
  if (lane === LANE.FRESH) minLiq = Math.max(500, Math.min(minLiq, (settings.lanes && settings.lanes.freshMinLiq) || 800));
  else if (lane === LANE.GRAD) minLiq = Math.max(15000, (settings.lanes && settings.lanes.gradMinLiq) || 15000);
  else minLiq = Math.max(15000, minLiq);
  if (liq < minLiq) {
    return { score: 0, pass: false, breakdown: [{ k: 'liquidity', v: 0, note: `below min $${minLiq}` }], rug: null, lane };
  }
  const liqScore = clamp((Math.log10(Math.max(liq, 1)) - Math.log10(Math.max(minLiq, 1))) / 2, 0, 1) * 16;
  score += liqScore;
  breakdown.push({ k: 'liquidity', v: Math.round(liqScore), note: `$${Math.round(liq / 1000)}k` });

  const vol1 = pair.volumeH1 || 0;
  const volScore = clamp(Math.log10(Math.max(vol1, 1)) / 6, 0, 1) * 12;
  score += volScore;
  breakdown.push({ k: 'volume', v: Math.round(volScore), note: `1h $${Math.round(vol1)}` });

  const buys = pair.buysH1 || 0;
  const sells = Math.max(pair.sellsH1 || 0, 1);
  const ratio = buys / sells;
  const flowScore = clamp((ratio - 0.5) / 1.5, 0, 1) * 10;
  score += flowScore;
  breakdown.push({ k: 'flow', v: Math.round(flowScore), note: `${ratio.toFixed(2)} buy/sell` });

  // Buy/sell pressure (m5 weighted)
  const b5 = pair.buysM5 || 0;
  const s5 = Math.max(pair.sellsM5 || 0, 1);
  const pressure = b5 / s5;
  let pressurePts = clamp((pressure - 0.6) / 1.8, 0, 1) * 10;
  if (pressure < 0.5) pressurePts = 0;
  score += pressurePts;
  breakdown.push({ k: 'pressure', v: Math.round(pressurePts), note: `5m ${pressure.toFixed(2)}x` });

  const bpm = buyersPerMinute(pair);
  let buyerPts = 0;
  if (bpm >= 8) buyerPts = 10;
  else if (bpm >= 3) buyerPts = 7;
  else if (bpm >= 1) buyerPts = 4;
  else buyerPts = 1;
  score += buyerPts;
  breakdown.push({ k: 'buyers', v: buyerPts, note: `${bpm.toFixed(1)}/min` });

  const ageH = pair.ageMs != null ? pair.ageMs / 3600000 : 24;
  let ageScore = 8;
  // Fresh lane: first minutes are the edge — reward ultra-young
  if (lane === LANE.FRESH) {
    if (ageH < 0.02) ageScore = 14;      // < ~1.2m
    else if (ageH < 0.08) ageScore = 16; // < ~5m
    else if (ageH < 0.25) ageScore = 12;
    else if (ageH < 0.5) ageScore = 8;
    else ageScore = 3;
  } else if (lane === LANE.GRAD) {
    if (ageH < 1) ageScore = 12;
    else if (ageH < 6) ageScore = 14;
    else if (ageH < 24) ageScore = 8;
    else ageScore = 4;
  } else {
    if (ageH < 0.05) ageScore = 2;
    else if (ageH < 0.25) ageScore = 10;
    else if (ageH < 6) ageScore = 14;
    else if (ageH < 24) ageScore = 10;
    else if (ageH < 72) ageScore = 6;
    else ageScore = 3;
  }
  score += ageScore;
  breakdown.push({ k: 'age', v: ageScore, note: ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(1)}h` });

  const mc = pair.marketCap || pair.fdv || 0;
  let mcScore = 5;
  if (mc > 0 && liq > 0) {
    const r = mc / liq;
    if (r >= 3 && r <= 12) mcScore = 10;
    else if (r < 3) mcScore = 6;
    else if (r < 25) mcScore = 4;
    else mcScore = 1;
  }
  score += mcScore;
  breakdown.push({ k: 'mc/liq', v: mcScore, note: mc && liq ? `${(mc / liq).toFixed(1)}x` : 'n/a' });

  const ch5 = pair.priceChangeM5 || 0;
  const ch1 = pair.priceChangeH1 || 0;
  let mom = 4;
  if (ch5 > 2 && ch5 < 80 && ch1 > 0) mom = 10;
  else if (ch1 > 5 && ch1 < 150) mom = 8;
  else if (ch1 < -25) mom = 0;
  score += mom;
  breakdown.push({ k: 'momentum', v: mom, note: `5m ${ch5}% / 1h ${ch1}%` });

  if (pair.graduating || pair.source === 'pump.grad' || (pair.source || '').includes('migration')) {
    score += 8;
    breakdown.push({ k: 'graduation', v: 8, note: 'grad / migration' });
  }

  const prog = bondingProgress(pair);
  if (prog != null) {
    let bp = 0;
    if (prog >= 0.7 && prog < 0.95) bp = 12; // about-to-moon sweet spot
    else if (prog >= 0.95) bp = 6;
    else if (prog >= 0.4 && lane === LANE.FRESH) bp = 4;
    if (bp) {
      score += bp;
      breakdown.push({ k: 'bonding', v: bp, note: `${Math.round(prog * 100)}% curve` });
    }
  }
  if (lane === LANE.FRESH) {
    let freshPts = 6;
    if (hasSocials(pair)) freshPts += 3;
    if (bpm >= 2) freshPts += 3;
    if (pressure >= 1.2) freshPts += 2;
    score += freshPts;
    breakdown.push({ k: 'freshLane', v: freshPts, note: hasSocials(pair) ? 'socials+mom' : 'momentum' });
  } else if (lane === LANE.GRAD) {
    score += 5;
    breakdown.push({ k: 'gradLane', v: 5, note: 'about-to-moon' });
  }

  // De-prioritize large established mcaps (soft score hit; hard gate in lanes)
  const maxMc = settings.maxMarketCapUsd || 8_000_000;
  if (mc > maxMc) {
    score -= 18;
    breakdown.push({ k: 'mcapCap', v: -18, note: `$${Math.round(mc / 1e6)}M > cap` });
  } else if (mc > maxMc * 0.6) {
    score -= 6;
    breakdown.push({ k: 'mcapCap', v: -6, note: 'approaching cap' });
  }

  // Novelty: strong bonus for never-seen mints; hard penalty if ledger/seen; stale-board hit
  let tradedLedgerRef = null;
  try { tradedLedgerRef = require('./tradedLedger'); } catch (_) {}
  const seenMem = (ctx.state && Array.isArray(ctx.state.seenMints) && ctx.state.seenMints.includes(pair.mint));
  const seenLedger = tradedLedgerRef ? tradedLedgerRef.everTraded(pair.mint) : false;
  const seen = seenMem || seenLedger;
  const neverSeen = !seen;
  // Novelty only for quality-passing never-seen coins (hard image/name filter upstream).
  // Scale novelty by real traction so empty curve dust doesn't auto-fill FRESH slots.
  const qualityOk = pair.freshQualityOk !== false && !pair._freshReject && !pair.imageReuse && !pair.nameDup;
  const tr0 = Number(pair.freshTraction) || 0;
  const buysM5n = Number(pair.buysM5) || 0;
  const volM5n = Number(pair.volumeM5) || 0;
  const bpmN = Number(pair.buyersPerMin) || 0;
  const hasAnyTraction = tr0 >= 2 || buysM5n >= 2 || volM5n >= 200 || bpmN >= 0.4 ||
    Number(pair.whaleCluster || 0) >= 1 || Number(pair.bondingProgress || 0) >= 0.02;
  if (neverSeen && qualityOk && (lane === LANE.FRESH || pair.source === 'pumpportal' || pair.fromPump)) {
    // Cap novelty so it cannot carry a pass alone (max 12; traction earns the rest)
    let nov = 0;
    if (tr0 >= 8 || (buysM5n >= 12 && volM5n >= 2000)) nov = 12;
    else if (hasAnyTraction) nov = 8;
    else nov = 0; // zero buyers/vol → no novelty points
    if (nov) {
      score += nov;
      breakdown.push({ k: 'novelty', v: nov, note: nov >= 12 ? 'new + strong traction' : 'new + some traction' });
    } else {
      breakdown.push({ k: 'novelty', v: 0, note: 'no novelty without buyers/vol' });
    }
  } else if (neverSeen && qualityOk && lane === LANE.GRAD) {
    score += 14;
    breakdown.push({ k: 'novelty', v: 14, note: 'never-traded grad' });
  } else if (neverSeen && qualityOk && lane === LANE.MOVER && ageH < 6) {
    score += 5;
    breakdown.push({ k: 'novelty', v: 5, note: 'young mover' });
  } else if (seen) {
    score -= 28;
    breakdown.push({ k: 'novelty', v: -28, note: 'already traded (ledger)' });
  } else if (neverSeen && !qualityOk) {
    score -= 10;
    breakdown.push({ k: 'novelty', v: -10, note: 'junk/dupe — no novelty' });
  }
  // Soft socials (never a hard gate): small bonus / mild penalty
  {
    const hasSocial = !!(pair.hasSocials || pair.twitter || pair.telegram ||
      (pair.websites && pair.websites.length) ||
      (pair.socials && (pair.socials.twitter || pair.socials.telegram || (Array.isArray(pair.socials) && pair.socials.length))));
    if (lane === LANE.FRESH || pair.fromPump) {
      if (hasSocial) {
        score += 3;
        breakdown.push({ k: 'socials', v: 3, note: 'optional bonus' });
      } else {
        score -= 2;
        breakdown.push({ k: 'socials', v: -2, note: 'missing (soft)' });
      }
    }
  }
  // Traction priority for FRESH (buyers / vol / smart wallets)
  if (lane === LANE.FRESH) {
    const tr = tr0;
    if (tr >= 8) {
      score += 10;
      breakdown.push({ k: 'traction', v: 10, note: 'unique buyers/vol/smart' });
    } else if (tr >= 4) {
      score += 6;
      breakdown.push({ k: 'traction', v: 6, note: 'early buyers' });
    } else if (tr >= 2) {
      score += 3;
      breakdown.push({ k: 'traction', v: 3, note: 'hints of flow' });
    } else if (!hasAnyTraction) {
      score -= 6;
      breakdown.push({ k: 'traction', v: -6, note: 'zero buyers/vol (soft)' });
    }
  }
  if (tradedLedgerRef && tradedLedgerRef.isStaleOnBoard(pair.mint)) {
    score -= 16;
    breakdown.push({ k: 'staleBoard', v: -16, note: '>60m on scored board' });
  }
  if (lane === LANE.MOVER && ageH > 48) {
    score -= 15;
    breakdown.push({ k: 'staleMover', v: -15, note: `${ageH.toFixed(0)}h old` });
  }

  const social = await socialVelocity(pair);
  const socPts = Math.round((social.score / 100) * 8);
  score += socPts;
  breakdown.push({ k: 'social/tx', v: socPts, note: `${social.tx} tx/h` });

  let rug = null;
  try {
    rug = await rugcheck(pair.mint);
  } catch (_) {}

  let rugPts = 4;
  if (rug && rug.ok) {
    if (rug.rugged) {
      return {
        score: 0,
        pass: false,
        breakdown: [...breakdown, { k: 'rugcheck', v: 0, note: 'rugged / honeypot' }],
        rug,
        blacklistDev: true,
      };
    }
    if (rug.mintRenounced) rugPts += 3;
    else rugPts -= 7;
    if (rug.freezeRenounced) rugPts += 2;
    else rugPts -= 5;
    if (rug.topHolderPct > 40) rugPts -= 8;
    else if (rug.topHolderPct > 25) rugPts -= 4;
    else rugPts += 3;
    if (rug.lpLocked) rugPts += 3;
    // Dev wallet history proxy: mint authority still set + young = bad
    if (!rug.mintRenounced && ageH < 6) rugPts -= 3;
    rugPts = clamp(rugPts, -12, 12);
  }
  score += rugPts;
  breakdown.push({
    k: 'rugcheck',
    v: rugPts,
    note: rug && rug.ok
      ? `mint ${rug.mintRenounced ? 'ok' : 'AUTH'} · top ${Math.round(rug.topHolderPct || 0)}%`
      : 'unavailable',
  });

  // Concentration + sniper/bundled
  const concPct = (rug && rug.topHolderPct) || 0;
  let concPts = 6;
  if (concPct > 50) concPts = 0;
  else if (concPct > 35) concPts = 2;
  else if (concPct > 20) concPts = 5;
  else if (concPct > 0) concPts = 8;
  score += concPts;
  breakdown.push({ k: 'concentration', v: concPts, note: `${Math.round(concPct)}% top` });

  const sniper = detectBundledSnipers(rug, ageH);
  const sniperPts = -sniper.sniperRisk;
  score += sniperPts;
  breakdown.push({ k: 'sniper', v: sniperPts, note: sniper.note });

  // Smart money overlap (if holders passed in ctx)
  let smPts = 0;
  let smMeta = null;
  if (smartReg && ctx.holders && ctx.holders.length) {
    smMeta = smartMoneyOverlap(smartReg, ctx.holders);
    smPts = smMeta.pts;
    score += smPts;
    breakdown.push({
      k: 'smartMoney',
      v: smPts,
      note: smMeta.hits ? `${smMeta.hits} wallets · best ${smMeta.best}` : 'none',
    });
  } else {
    breakdown.push({ k: 'smartMoney', v: 0, note: 'n/a' });
  }

  // Narrative
  const narratives = tagCoin(pair);
  const heat = narrativeHeat(narratives, heatMap);
  const narrPts = Math.round((heat - 1) * 20);
  score += clamp(narrPts, 0, 8);
  breakdown.push({
    k: 'narrative',
    v: clamp(narrPts, 0, 8),
    note: narratives.slice(0, 2).join(',') || 'other',
  });

  // Apply learned weights
  let finalScore = score;
  let finalBreakdown = breakdown;
  if (weights) {
    const applied = applyWeights(breakdown, weights);
    finalScore = applied.score;
    finalBreakdown = applied.breakdown;
  }

  finalScore = clamp(Math.round(finalScore), 0, 100);
  // Lane-specific minScore: FRESH softer but not novelty-carried
  let minScore = settings.minScore || 70;
  if (lane === LANE.FRESH) minScore = Math.max(48, minScore - 12);
  else if (lane === LANE.GRAD) minScore = Math.max(50, minScore - 8);

  const runner = runnerScore(pair, {
    rug,
    smartMoney: smMeta,
    sniper,
    holdersGrowing: ctx.holdersGrowing,
    deployerTier: ctx.deployerTier,
    xBuzzScore: ctx.xBuzzScore || pair.xBuzzScore || 0,
  });
  const bandAct = runnerBandAction(runner.score);
  // Gate: analyst minScore AND runner band (unless runner disabled)
  const requireRunner = settings.abHarness !== false || settings.minRunnerScore != null;
  let minRunner = settings.minRunnerScore != null ? settings.minRunnerScore : 40;
  // FRESH: keep a real runner floor — no free pass for empty curve dust
  if (lane === LANE.FRESH) minRunner = Math.max(28, minRunner - 10);
  else if (lane === LANE.GRAD) minRunner = Math.max(28, minRunner - 8);
  let pass = finalScore >= minScore;
  if (requireRunner) {
    if (runner.veto && lane !== LANE.FRESH) pass = false;
    else if (runner.score < minRunner) pass = false;
  }
  // Novelty cannot carry alone: score excluding novelty must clear a floor
  if (lane === LANE.FRESH || pair.fromPump) {
    const novPts = (finalBreakdown || []).filter((b) => b && b.k === 'novelty').reduce((s, b) => s + (Number(b.v) || 0), 0);
    const scoreExNov = finalScore - novPts;
    const floorExNov = Math.max(40, minScore - 8);
    if (scoreExNov < floorExNov) pass = false;
    // Hard traction for pass (mirrors laneGates)
    const u = Number(pair.uniqueBuyers || pair.buyersM5 || pair.buyers || 0) || 0;
    const b5 = Number(pair.buysM5) || 0;
    const v5 = Math.max(Number(pair.volumeM5) || 0, (Number(pair.volumeH1) || 0) * 0.35);
    if (u < 3 && b5 < 5) pass = false;
    if (v5 < 500) pass = false;
  }

  return {
    score: finalScore,
    pass,
    breakdown: finalBreakdown,
    rug,
    social,
    sniper,
    narratives,
    narrativeHeat: heat,
    buyersPerMin: bpm,
    pressure,
    smartMoney: smMeta,
    lane,
    bondingProgress: prog,
    runnerScore: runner.score,
    runnerBand: runner.band,
    runnerBreakdown: runner.breakdown,
    runnerComponents: runner.components,
    runnerVeto: runner.veto,
    runnerAction: bandAct,
  };
}

module.exports = { scorePair, detectBundledSnipers, buyersPerMinute, runnerScore, runnerBandAction };
