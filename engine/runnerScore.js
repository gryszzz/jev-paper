'use strict';

/**
 * Runner Score v1 — playbook §1.3
 * Causal features only; hard vetoes → score 0.
 */

const { bondingProgress, hasSocials } = require('./lanes');

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function buyersPerMinute(pair) {
  const buysM5 = Number(pair.buysM5) || 0;
  const buysH1 = Number(pair.buysH1) || 0;
  return Math.max(buysM5 / 5, (buysH1 / 60) * 0.5);
}

/**
 * @returns {{
 *   score: number,
 *   components: Object,
 *   penalties: number,
 *   veto: string|null,
 *   band: 'skip'|'scalp'|'standard'|'moon'|'high',
 *   breakdown: Array
 * }}
 */
function runnerScore(pair, ctx = {}) {
  const rug = ctx.rug || pair.rug || null;
  const smart = ctx.smartMoney || pair.smartMoney || null;
  const sniper = ctx.sniper || pair.sniper || null;
  const ageMs = pair.ageMs != null ? pair.ageMs : null;
  const ageSec = ageMs != null ? ageMs / 1000 : 3600;
  const ageH = ageSec / 3600;
  const lane = pair.lane || (pair._laneInfo && pair._laneInfo.lane) || null;
  const mcap = Number(pair.marketCap) || Number(pair.fdv) || 0;
  const liq = Number(pair.liquidity) || 0;
  const volM5 = Number(pair.volumeM5) || 0;
  const volH1 = Number(pair.volumeH1) || 0;
  const vol15 = volM5 * 3 || volH1 * 0.25;
  const buysM5 = Number(pair.buysM5) || 0;
  const sellsM5 = Math.max(Number(pair.sellsM5) || 0, 1);
  const buysH1 = Number(pair.buysH1) || 0;
  const sellsH1 = Math.max(Number(pair.sellsH1) || 0, 1);
  const bpm = buyersPerMinute(pair);
  const prog = bondingProgress(pair);
  const top10 = (rug && (rug.top10Pct || rug.topHolderPct)) || pair.top10Pct || 0;
  const components = {
    velocity: 0,
    buyerAccel: 0,
    smartCluster: 0,
    holderGrowth: 0,
    turnover: 0,
    kol: 0,
    deployer: 0,
    narrative: 0,
    structure: 0,
  };
  const breakdown = [];
  let penalties = 0;
  let veto = null;

  // ——— Hard vetoes ———
  if (rug && rug.ok) {
    if (rug.rugged) veto = 'rugged';
    else if (rug.mintRenounced === false || (rug.mintAuthority != null && rug.mintAuthority !== '')) {
      // mintRenounced false = authority live
      if (rug.mintRenounced === false) veto = 'mint_authority';
    }
    if (!veto && rug.freezeRenounced === false) veto = 'freeze_authority';
    if (!veto && rug.transferHook) veto = 'transfer_hook';
    if (!veto && rug.sellSimFail) veto = 'sell_sim_fail';
  }
  if (!veto && sniper && sniper.bundled && ageH < 0.5) {
    // soft — only hard if also high top10
    if (top10 > 40) veto = 'bundle_cluster';
  }
  if (veto) {
    return {
      score: 0,
      components,
      penalties: 40,
      veto,
      band: 'skip',
      breakdown: [{ k: 'veto', v: 0, note: veto }],
    };
  }

  // ——— A. Velocity 0–22 ———
  let velocity = 0;
  const tradesProxy = buysM5 + Number(pair.sellsM5 || 0);
  if (prog != null && prog >= 0.2) {
    if (tradesProxy > 0 && tradesProxy <= 50) velocity = 22;
    else if (tradesProxy <= 100) velocity = 16;
    else if (tradesProxy <= 300) velocity = 8;
  }
  if (!velocity) {
    if (ageSec <= 180 && mcap > 0 && volM5 >= 0.4 * mcap) velocity = 20;
    else if (ageSec <= 180 && volM5 >= 0.2 * Math.max(mcap, liq, 1)) velocity = 16;
    else if (ageSec <= 600 && bpm >= 2) velocity = 12;
    else if (ageSec <= 600 && bpm >= 1) velocity = 8;
    else if (mcap > 0 && ageSec > 0) {
      const vel = mcap / Math.max(ageSec, 1);
      if (vel > 200) velocity = 10;
      else if (vel > 50) velocity = 6;
    }
  }
  components.velocity = clamp(velocity, 0, 22);
  breakdown.push({ k: 'velocity', v: components.velocity, note: `age ${Math.round(ageSec)}s · bpm ${bpm.toFixed(1)}` });

  // ——— B. Buyer acceleration 0–18 ———
  let buyerAccel = 0;
  const uniqueProxy5m = buysM5; // DexScreener lacks unique wallets — use buys as proxy
  if (uniqueProxy5m >= 40) buyerAccel += 14;
  else if (uniqueProxy5m >= 21) buyerAccel += 10;
  else if (uniqueProxy5m >= 10) buyerAccel += 6;
  else if (uniqueProxy5m >= 5) buyerAccel += 3;
  const bpmH1 = buysH1 / 60;
  if (bpmH1 > 0 && bpm >= 1.5 * bpmH1) buyerAccel += 4;
  const buyShare = buysM5 / Math.max(buysM5 + Number(pair.sellsM5 || 0), 1);
  if (buyShare >= 0.6) buyerAccel += 3;
  else if (buyShare >= 0.55) buyerAccel += 1;
  components.buyerAccel = clamp(buyerAccel, 0, 18);
  breakdown.push({ k: 'buyerAccel', v: components.buyerAccel, note: `buys5m ${buysM5}` });

  // ——— C. Smart-wallet cluster 0–18 ———
  let smartCluster = 0;
  const hits = (smart && smart.hits) || 0;
  if (hits >= 3) smartCluster = 18;
  else if (hits >= 2) smartCluster = 12;
  else if (hits >= 1) smartCluster = 8;
  if (smart && smart.pts >= 8 && hits >= 2) smartCluster = Math.min(18, smartCluster + 4);
  components.smartCluster = clamp(smartCluster, 0, 18);
  breakdown.push({ k: 'smartCluster', v: components.smartCluster, note: hits ? `${hits} wallets` : 'thin' });

  // ——— D. Holder growth 0–12 ———
  let holderGrowth = 0;
  const holdersGrowing = ctx.holdersGrowing; // optional
  if (holdersGrowing === true && (pair.priceChangeM5 || 0) > 0) holderGrowth = 10;
  else if (top10 > 0 && top10 < 25 && (pair.priceChangeM5 || 0) > 0) holderGrowth = 8;
  else if (top10 > 0 && top10 < 35) holderGrowth = 5;
  else if (top10 > 45) holderGrowth = 1;
  else holderGrowth = 3;
  if (top10 > 0 && top10 < 30 && holdersGrowing !== false) holderGrowth = Math.min(12, holderGrowth + 2);
  components.holderGrowth = clamp(holderGrowth, 0, 12);
  breakdown.push({ k: 'holderGrowth', v: components.holderGrowth, note: `top10 ${Math.round(top10)}%` });

  // ——— E. Turnover 0–10 ———
  let turnover = 0;
  const turn = mcap > 0 ? vol15 / mcap : 0;
  const bs = buysH1 / sellsH1;
  if (turn >= 0.15 && turn <= 1.5 && bs >= 1.2) turnover = 9;
  else if (turn >= 0.08 && turn <= 2 && bs >= 1.0) turnover = 6;
  else if (turn > 3 && uniqueProxy5m < 10) turnover = 1;
  else if (turn > 0.05) turnover = 3;
  // surge gate analog: buy vol vs mcap gain
  const ch5 = Number(pair.priceChangeM5) || 0;
  if (ch5 > 5 && mcap > 0 && volM5 >= 0.03 * mcap * (ch5 / 100)) {
    turnover = Math.max(turnover, 6);
  }
  components.turnover = clamp(turnover, 0, 10);
  breakdown.push({ k: 'turnover', v: components.turnover, note: `vol/mc ${(turn * 100).toFixed(0)}%` });

  // ——— F. KOL 0–8 (proxy via smart money / social) ———
  let kol = 0;
  if (hits >= 2) kol = 4;
  if (hits >= 3) kol = 6;
  components.kol = clamp(kol, 0, 8);
  breakdown.push({ k: 'kol', v: components.kol, note: hits ? 'sm-proxy' : 'none' });

  // ——— G. Deployer 0–7 (thin without MadeOnSol) ———
  let deployer = 1; // unranked default
  if (rug && rug.ok) {
    if (rug.mintRenounced && rug.freezeRenounced) deployer = 3;
    if (ctx.deployerTier === 'elite') deployer = 7;
    else if (ctx.deployerTier === 'good') deployer = 5;
    else if (ctx.deployerTier === 'rising') deployer = 3;
    else if (ctx.deployerTier === 'cold') deployer = 0;
  }
  components.deployer = clamp(deployer, 0, 7);
  breakdown.push({ k: 'deployer', v: components.deployer, note: ctx.deployerTier || 'unranked' });

  // ——— H. Narrative / X 0–5 ———
  let narrative = 0;
  if (hasSocials(pair) && components.buyerAccel >= 6) narrative = 3;
  else if (hasSocials(pair)) narrative = 1;
  if ((pair.narratives || []).length && components.buyerAccel >= 8) narrative = Math.min(5, narrative + 2);
  // Free X buzz hook (Apify / bearer / ingest) — never required
  const xb = Number(pair.xBuzzScore != null ? pair.xBuzzScore : (ctx.xBuzzScore || 0)) || 0;
  if (xb > 0) narrative = Math.min(5, Math.max(narrative, xb));
  components.narrative = clamp(narrative, 0, 5);
  breakdown.push({
    k: 'narrative',
    v: components.narrative,
    note: xb ? `x-buzz ${xb}` : hasSocials(pair) ? 'socials' : 'none',
  });

  // ——— I. Structure 0–5 ———
  let structure = 0;
  const ch1 = Number(pair.priceChangeH1) || 0;
  if (ch5 > 0 && ch5 < 40 && ch1 > ch5 && bpm >= 1) structure = 4;
  else if (ch5 > 80) structure = 0; // vertical candle
  else if (ch5 > 0 && ch1 > 0) structure = 2;
  components.structure = clamp(structure, 0, 5);
  breakdown.push({ k: 'structure', v: components.structure, note: `5m ${ch5}%` });

  // ——— Penalties ———
  if (sniper && sniper.bundled) penalties += 20;
  else if (sniper && sniper.sniperRisk >= 10) penalties += 12;
  if (top10 > 45 && ageH < 0.5) penalties += 12;
  if (uniqueProxy5m < 10 && turn > 1.5) penalties += 20;
  if (ctx.deployerTier === 'cold') penalties += 15;
  if (rug && rug.ok && !rug.mintRenounced) penalties += 10;
  if (buysM5 + Number(pair.sellsM5 || 0) >= 8 && buysM5 / sellsM5 < 0.7) penalties += 8;
  penalties = clamp(penalties, 0, 40);
  if (penalties) breakdown.push({ k: 'penalty', v: -penalties, note: 'risks' });

  let score = 0;
  for (const v of Object.values(components)) score += v;
  score = clamp(Math.round(score - penalties), 0, 100);

  let band = 'skip';
  // Recalibrated for free-data score distribution (was 40/55/70/80 — T arms never filled)
  if (score >= 65 && penalties === 0) band = 'high';
  else if (score >= 52) band = 'moon';
  else if (score >= 42) band = 'standard';
  else if (score >= 30) band = 'scalp';

  return { score, components, penalties, veto: null, band, breakdown };
}

function runnerBandAction(score) {
  if (score < 30) return { ok: false, modeHint: null, sizeMult: 0 };
  if (score < 42) return { ok: true, modeHint: 'B', sizeMult: 0.5 };
  if (score < 52) return { ok: true, modeHint: 'A', sizeMult: 0.85 };
  if (score < 65) return { ok: true, modeHint: 'C', sizeMult: 1 };
  return { ok: true, modeHint: 'C', sizeMult: 1, wideTrail: true };
}

module.exports = { runnerScore, runnerBandAction, buyersPerMinute };
