'use strict';

const { rugcheck, socialVelocity } = require('./sources');

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

async function scorePair(pair, settings) {
  const breakdown = [];
  let score = 0;

  const liq = pair.liquidity || 0;
  if (liq < (settings.minLiquidity || 38000)) {
    return { score: 0, pass: false, breakdown: [{ k: 'liquidity', v: 0, note: 'below min' }], rug: null };
  }
  const liqScore = clamp((Math.log10(liq) - Math.log10(settings.minLiquidity)) / 2, 0, 1) * 18;
  score += liqScore;
  breakdown.push({ k: 'liquidity', v: Math.round(liqScore), note: `$${Math.round(liq / 1000)}k` });

  const vol5 = pair.volumeM5 || pair.volumeH1 / 12 || 0;
  const vol1 = pair.volumeH1 || 0;
  const volScore = clamp(Math.log10(Math.max(vol1, 1)) / 6, 0, 1) * 14;
  score += volScore;
  breakdown.push({ k: 'volume', v: Math.round(volScore), note: `1h $${Math.round(vol1)}` });

  const buys = pair.buysH1 || 0;
  const sells = Math.max(pair.sellsH1 || 0, 1);
  const ratio = buys / sells;
  const flowScore = clamp((ratio - 0.5) / 1.5, 0, 1) * 12;
  score += flowScore;
  breakdown.push({ k: 'flow', v: Math.round(flowScore), note: `${ratio.toFixed(2)} buy/sell` });

  const ageH = pair.ageMs != null ? pair.ageMs / 3600000 : 24;
  let ageScore = 8;
  if (ageH < 0.05) ageScore = 2;
  else if (ageH < 0.25) ageScore = 10;
  else if (ageH < 6) ageScore = 16;
  else if (ageH < 24) ageScore = 12;
  else if (ageH < 72) ageScore = 8;
  else ageScore = 4;
  score += ageScore;
  breakdown.push({ k: 'age', v: ageScore, note: ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(1)}h` });

  // MC / liquidity ratio (healthy ~3-15)
  const mc = pair.marketCap || pair.fdv || 0;
  let mcScore = 6;
  if (mc > 0 && liq > 0) {
    const r = mc / liq;
    if (r >= 3 && r <= 12) mcScore = 12;
    else if (r < 3) mcScore = 7;
    else if (r < 25) mcScore = 5;
    else mcScore = 2;
  }
  score += mcScore;
  breakdown.push({ k: 'mc/liq', v: mcScore, note: mc && liq ? `${(mc / liq).toFixed(1)}x` : 'n/a' });

  // momentum / acceleration
  const ch5 = pair.priceChangeM5 || 0;
  const ch1 = pair.priceChangeH1 || 0;
  let mom = 5;
  if (ch5 > 2 && ch5 < 80 && ch1 > 0) mom = 12;
  else if (ch1 > 5 && ch1 < 150) mom = 9;
  else if (ch1 < -25) mom = 0;
  score += mom;
  breakdown.push({ k: 'momentum', v: mom, note: `5m ${ch5}% / 1h ${ch1}%` });

  if (pair.graduating || pair.source === 'pump.grad') {
    score += 8;
    breakdown.push({ k: 'graduation', v: 8, note: 'early grad / near raydium' });
  }

  const social = await socialVelocity(pair);
  const socPts = Math.round((social.score / 100) * 10);
  score += socPts;
  breakdown.push({ k: 'social/tx', v: socPts, note: `${social.tx} tx/h` });

  let rug = null;
  try {
    rug = await rugcheck(pair.mint);
  } catch (_) {}
  let rugPts = 5;
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
    if (rug.mintRenounced) rugPts += 4;
    else rugPts -= 8;
    if (rug.freezeRenounced) rugPts += 3;
    else rugPts -= 6;
    if (rug.topHolderPct > 40) rugPts -= 10;
    else if (rug.topHolderPct > 25) rugPts -= 5;
    else rugPts += 3;
    if (rug.lpLocked) rugPts += 4;
    rugPts = clamp(rugPts, -15, 14);
  }
  score += rugPts;
  breakdown.push({
    k: 'rugcheck',
    v: rugPts,
    note: rug && rug.ok
      ? `mint ${rug.mintRenounced ? 'ok' : 'AUTH'} · top ${Math.round(rug.topHolderPct || 0)}%`
      : 'unavailable',
  });

  score = clamp(Math.round(score), 0, 100);
  return {
    score,
    pass: score >= (settings.minScore || 70),
    breakdown,
    rug,
    social,
  };
}

module.exports = { scorePair };
