'use strict';

/**
 * Eyes everywhere — status + feature helpers.
 * Sources: PumpPortal, DexScreener, GeckoTerminal, Jupiter, X/Apify, Telegram proxy, Viral.
 */

const { jupiterPrice } = require('./jupiter');
const { realtimeStats } = require('./sources');
const xbuzz = require('./xbuzz');
const viral = require('./viral');
const catalyst = require('./catalyst');

function normalizeTicker(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Group same-name / same-ticker clones. Prefer first-seen or highest liquidity.
 * Returns map mint -> { groupId, isOriginal, copycatPenalty 0–20, clones }
 */
function annotateCopycats(pairs = []) {
  const byTicker = new Map();
  const sorted = [...pairs].sort((a, b) => {
    const aa = a.pairCreatedAt || a.createdMs || a.ageMs != null ? Date.now() - (a.ageMs || 0) : 0;
    const ba = b.pairCreatedAt || b.createdMs || b.ageMs != null ? Date.now() - (b.ageMs || 0) : 0;
    // older first
    const aCreated = a.pairCreatedAt || a.createdMs || (a.ageMs != null ? Date.now() - a.ageMs : Date.now());
    const bCreated = b.pairCreatedAt || b.createdMs || (b.ageMs != null ? Date.now() - b.ageMs : Date.now());
    return aCreated - bCreated;
  });
  for (const p of sorted) {
    const t = normalizeTicker(p.symbol);
    if (!t || t.length < 2) continue;
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t).push(p);
  }
  const out = new Map();
  for (const [t, group] of byTicker) {
    if (group.length < 2) {
      const p = group[0];
      if (p && p.mint) out.set(p.mint, { groupId: t, isOriginal: true, copycatPenalty: 0, clones: 1 });
      continue;
    }
    // original = earliest; also consider highest liq as "real" if much larger
    const byLiq = [...group].sort((a, b) => (Number(b.liquidity) || 0) - (Number(a.liquidity) || 0));
    const original = group[0];
    const liqKing = byLiq[0];
    const prefer = (Number(liqKing.liquidity) || 0) > (Number(original.liquidity) || 0) * 3 ? liqKing : original;
    for (let i = 0; i < group.length; i++) {
      const p = group[i];
      const isOrig = p.mint === prefer.mint;
      let penalty = 0;
      if (!isOrig) {
        penalty = 12;
        // volume can redeem a clone
        const vol = Number(p.volumeH1) || Number(p.volumeM5) * 12 || 0;
        const oVol = Number(prefer.volumeH1) || 0;
        if (vol > oVol * 1.5 && vol > 20000) penalty = 4;
        else if (vol > 50000) penalty = 6;
        else penalty = Math.min(20, 10 + i * 2);
      }
      out.set(p.mint, { groupId: t, isOriginal: isOrig, copycatPenalty: penalty, clones: group.length });
    }
  }
  return out;
}

/**
 * Whale/smart-wallet cluster: 2+ tracked wallets buy same mint within window.
 * buyEvents: [{ mint, wallet, ts }]
 */
function whaleClusterScore(buyEvents = [], { windowMs = 3 * 60e3 } = {}) {
  const byMint = new Map();
  const now = Date.now();
  for (const e of buyEvents) {
    if (!e.mint || !e.wallet) continue;
    if (now - (e.ts || now) > windowMs * 2) continue;
    if (!byMint.has(e.mint)) byMint.set(e.mint, []);
    byMint.get(e.mint).push(e);
  }
  const scores = new Map();
  for (const [mint, evs] of byMint) {
    // unique wallets in rolling window
    const recent = evs.filter((e) => now - (e.ts || 0) <= windowMs);
    const wallets = new Set(recent.map((e) => e.wallet));
    const n = wallets.size;
    let score = 0;
    if (n >= 4) score = 18;
    else if (n >= 3) score = 14;
    else if (n >= 2) score = 10;
    scores.set(mint, { whaleCluster: score, wallets: n, note: `${n}w/${Math.round(windowMs / 60000)}m` });
  }
  return scores;
}

/** Tweet-to-launch: KOL tweet phrase matched to launch within minutes. */
function tweetToLaunchScore(pair, tweets = [], { maxAgeMs = 12 * 60e3 } = {}) {
  if (!tweets.length || !pair) return { tweetToLaunch: 0, note: 'none' };
  const created = pair.pairCreatedAt || pair.createdMs || (pair.ageMs != null ? Date.now() - pair.ageMs : null);
  if (!created) return { tweetToLaunch: 0, note: 'no-age' };
  const sym = normalizeTicker(pair.symbol);
  const name = String(pair.name || '').toLowerCase();
  let best = 0;
  let note = 'none';
  for (const tw of tweets) {
    const dt = created - (tw.ts || 0);
    if (dt < 0 || dt > maxAgeMs) continue; // tweet must precede launch by <= maxAge
    const text = String(tw.text || '').toLowerCase();
    const hitSym = sym && text.includes(sym);
    const words = name.split(/\s+/).filter((w) => w.length >= 4);
    const hitName = words.some((w) => text.includes(w));
    if (hitSym || hitName) {
      const mins = dt / 60000;
      const score = mins <= 2 ? 16 : mins <= 5 ? 12 : mins <= 12 ? 8 : 4;
      if (tw.kol) {
        const boosted = score + 4;
        if (boosted > best) {
          best = boosted;
          note = `kol@${tw.user || '?'}·${Math.round(mins)}m`;
        }
      } else if (score > best) {
        best = score;
        note = `tw·${Math.round(mins)}m`;
      }
    }
  }
  return { tweetToLaunch: Math.min(20, best), note };
}

async function jupiterPriceCheck(mints = []) {
  try {
    const slice = mints.filter(Boolean).slice(0, 20);
    if (!slice.length) return { ok: true, n: 0, prices: {} };
    const prices = await jupiterPrice(slice);
    return { ok: true, n: Object.keys(prices || {}).length, prices: prices || {} };
  } catch (e) {
    return { ok: false, error: e.message, prices: {} };
  }
}

function status(extra = {}) {
  return {
    pumpportal: realtimeStats(),
    xBuzz: xbuzz.stats(),
    viral: viral.stats(),
    catalyst: catalyst.stats(),
    jupiter: extra.jupiter || null,
    dexscreener: extra.dexscreener || null,
    gecko: extra.gecko || null,
    telegram: extra.telegram || null,
    learn: extra.learn || null,
    liveEnabled: false,
    freeTier: true,
  };
}

module.exports = {
  annotateCopycats,
  whaleClusterScore,
  tweetToLaunchScore,
  jupiterPriceCheck,
  status,
  normalizeTicker,
};
