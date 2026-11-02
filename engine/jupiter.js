'use strict';

const { fetchJson } = require('./http');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSSqEM2QN1xzybapC8g4wEGGkZwyTDt1';
// Prefer SOL route for memecoins; fall back to USDC notionally via price.
const JUP = 'https://quote-api.jup.ag/v6/quote';

async function jupiterQuote({ mint, side, amountUsd, tokenAmount, markPrice, slippageBps }) {
  const slip = Math.max(50, Math.min(1500, Number(slippageBps) || 100));
  // Approximate input atoms: use USDC 6 decimals as USD proxy for buy size.
  if (side === 'buy') {
    const amount = Math.max(1, Math.round(Number(amountUsd) * 1e6));
    const url = `${JUP}?inputMint=${USDC}&outputMint=${mint}&amount=${amount}&slippageBps=${slip}&onlyDirectRoutes=false`;
    const d = await fetchJson(url, { ttlMs: 5000, key: `jup-buy-${mint}-${amount}` });
    const out = Number(d.outAmount) || 0;
    // unknown decimals — assume 6 for pump tokens when missing
    const decimals = 6;
    const outUi = out / 10 ** decimals;
    const effectivePrice = outUi > 0 ? Number(amountUsd) / outUi : markPrice;
    return {
      inAmount: amount,
      outAmount: out,
      outAmountUi: outUi,
      effectivePrice,
      priceImpactPct: Number(d.priceImpactPct) || 0,
      routeLabel: (d.routePlan && d.routePlan[0] && d.routePlan[0].swapInfo && d.routePlan[0].swapInfo.label) || 'Jupiter',
      priorityFeeSol: 0.0001,
      raw: { impact: d.priceImpactPct },
    };
  }
  // sell: tokenAmount in UI units → atoms
  const decimals = 6;
  const atoms = Math.max(1, Math.round(Number(tokenAmount) * 10 ** decimals));
  const url = `${JUP}?inputMint=${mint}&outputMint=${USDC}&amount=${atoms}&slippageBps=${Math.max(slip, 150)}&onlyDirectRoutes=false`;
  const d = await fetchJson(url, { ttlMs: 5000, key: `jup-sell-${mint}-${atoms}` });
  const out = Number(d.outAmount) || 0;
  const outUi = out / 1e6;
  const effectivePrice = Number(tokenAmount) > 0 ? outUi / Number(tokenAmount) : markPrice;
  return {
    inAmount: atoms,
    outAmount: out,
    outAmountUi: outUi,
    effectivePrice,
    priceImpactPct: Number(d.priceImpactPct) || 0,
    routeLabel: 'Jupiter',
    priorityFeeSol: 0.0001,
  };
}

async function jupiterPrice(mints) {
  if (!mints || !mints.length) return {};
  const ids = mints.slice(0, 50).join(',');
  try {
    const d = await fetchJson(`https://api.jup.ag/price/v2?ids=${ids}`, {
      ttlMs: 4000,
      key: `jup-price-${ids.slice(0, 40)}`,
    });
    return d.data || {};
  } catch (_) {
    return {};
  }
}

module.exports = { jupiterQuote, jupiterPrice, SOL, USDC };
