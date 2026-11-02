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

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
}

/** Stable-ish image key from URL (IPFS cid / filename / path hash). No pixel download — free/fast. */
function imageKey(url) {
  const u = String(url || '').trim();
  if (!u || u.length < 8) return null;
  const lower = u.toLowerCase();
  // ipfs://CID/... or .../ipfs/CID/...
  let m = lower.match(/ipfs\/([a-z0-9]{46,})/);
  if (m) return 'ipfs:' + m[1];
  m = lower.match(/^ipfs:\/\/([a-z0-9]{46,})/);
  if (m) return 'ipfs:' + m[1];
  // common CDNs — strip query, keep path tail
  try {
    const noq = lower.split('?')[0];
    const parts = noq.split('/').filter(Boolean);
    const tail = parts.slice(-2).join('/');
    if (tail.length >= 8) return 'url:' + tail.slice(0, 96);
  } catch (_) {}
  return 'url:' + lower.slice(0, 96);
}

/**
 * Image + name + ticker dedupe across the batch (and optional history).
 * Original = oldest among same key, or highest liquidity if much larger.
 * Returns Map mint -> { imageReuse, nameDup, tickerDup, isOriginal, qualityPenalty, reasons[] }
 */
function annotateImageAndNameDupes(pairs = [], history = []) {
  const createdOf = (p) =>
    p.pairCreatedAt || p.createdMs || (p.ageMs != null ? Date.now() - p.ageMs : Date.now());
  const all = [...history, ...pairs].filter((p) => p && p.mint);
  const byImg = new Map();
  const byName = new Map();
  const byTick = new Map();
  for (const p of all) {
    const ik = imageKey(p.icon || p.image || p.imageUri);
    if (ik) {
      if (!byImg.has(ik)) byImg.set(ik, []);
      byImg.get(ik).push(p);
    }
    const nk = normalizeName(p.name || p.symbol);
    if (nk && nk.length >= 3) {
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(p);
    }
    const tk = normalizeTicker(p.symbol);
    if (tk && tk.length >= 2) {
      if (!byTick.has(tk)) byTick.set(tk, []);
      byTick.get(tk).push(p);
    }
  }
  function pickOriginal(group) {
    const sorted = [...group].sort((a, b) => createdOf(a) - createdOf(b));
    const oldest = sorted[0];
    const byLiq = [...group].sort((a, b) => (Number(b.liquidity) || 0) - (Number(a.liquidity) || 0));
    const king = byLiq[0];
    if (king && oldest && king.mint !== oldest.mint && (Number(king.liquidity) || 0) > (Number(oldest.liquidity) || 0) * 3) {
      return king;
    }
    return oldest;
  }
  const out = new Map();
  for (const p of pairs) {
    if (!p.mint) continue;
    const reasons = [];
    let imageReuse = false;
    let nameDup = false;
    let tickerDup = false;
    let isOriginal = true;
    let qualityPenalty = 0;

    const ik = imageKey(p.icon || p.image || p.imageUri);
    if (ik && byImg.has(ik) && byImg.get(ik).length > 1) {
      const orig = pickOriginal(byImg.get(ik));
      if (orig && orig.mint !== p.mint) {
        imageReuse = true;
        isOriginal = false;
        qualityPenalty = Math.max(qualityPenalty, 20);
        reasons.push('image-reuse');
      }
    }
    const nk = normalizeName(p.name || p.symbol);
    if (nk && nk.length >= 3 && byName.has(nk) && byName.get(nk).length > 1) {
      const orig = pickOriginal(byName.get(nk));
      if (orig && orig.mint !== p.mint) {
        nameDup = true;
        isOriginal = false;
        qualityPenalty = Math.max(qualityPenalty, 16);
        reasons.push('name-dup');
      }
    }
    const tk = normalizeTicker(p.symbol);
    if (tk && tk.length >= 2 && byTick.has(tk) && byTick.get(tk).length > 1) {
      const orig = pickOriginal(byTick.get(tk));
      if (orig && orig.mint !== p.mint) {
        tickerDup = true;
        isOriginal = false;
        qualityPenalty = Math.max(qualityPenalty, 14);
        reasons.push('ticker-dup');
      }
    }
    out.set(p.mint, { imageReuse, nameDup, tickerDup, isOriginal, qualityPenalty, reasons, imageKey: ik });
  }
  return out;
}

/**
 * FRESH quality gate.
 * HARD fail: reused image or duplicate name/ticker (unless original).
 * Soft: socials = small bonus/mild penalty only — NEVER hard-require.
 * Traction priority: unique buyers / buysM5 / volume / smart wallets.
 */
function freshQuality(pair = {}, { history = [] } = {}) {
  const reasons = [];
  let pass = true;
  let softPenalty = 0;
  let softBonus = 0;

  // Hard: junk symbol
  const sym = normalizeTicker(pair.symbol);
  if (!sym || sym.length < 2 || sym === 'unk' || sym === '???') {
    pass = false;
    reasons.push('bad-ticker');
  }

  // Hard flags from prior annotate (caller may set)
  if (pair.imageReuse || (pair._quality && pair._quality.imageReuse)) {
    pass = false;
    reasons.push('image-reuse');
  }
  if (pair.nameDup || (pair._quality && pair._quality.nameDup)) {
    pass = false;
    reasons.push('name-dup');
  }
  if (pair.tickerDup || (pair._quality && pair._quality.tickerDup)) {
    if (!(pair.isOriginal || (pair._quality && pair._quality.isOriginal))) {
      pass = false;
      reasons.push('ticker-dup');
    }
  }
  if ((pair.copycatPenalty || 0) >= 12 && !pair.isOriginal) {
    pass = false;
    reasons.push('copycat');
  }

  // Soft: socials — bonus if present, mild penalty if missing (NOT a gate)
  const hasSocial = !!(
    pair.hasSocials ||
    pair.twitter ||
    pair.telegram ||
    (pair.websites && pair.websites.length) ||
    (pair.socials && (pair.socials.twitter || pair.socials.telegram || pair.socials.website ||
      (Array.isArray(pair.socials) && pair.socials.length)))
  );
  if (hasSocial) softBonus += 3;
  else softPenalty += 2;

  // Soft: description
  const desc = String(pair.description || pair.desc || '').trim();
  if (desc.length >= 12) softBonus += 3;
  else if (desc.length === 0) softPenalty += 2;

  // Traction priority (soft fail only when clearly dead — not a social proxy)
  const buysM5 = Number(pair.buysM5) || 0;
  const uniqueBuyers = Number(pair.uniqueBuyers || pair.buyers || pair.buyersM5) || 0;
  const volM5 = Number(pair.volumeM5) || 0;
  const bpm = Number(pair.buyersPerMin) || (buysM5 / 5);
  const smart = Number(pair.whaleCluster || pair.smartOverlap || 0);
  const ageMin = (Number(pair.ageMs) || 0) / 60000;

  let traction = 0;
  if (uniqueBuyers >= 12 || buysM5 >= 20) traction += 10;
  else if (uniqueBuyers >= 6 || buysM5 >= 10) traction += 7;
  else if (uniqueBuyers >= 3 || buysM5 >= 5) traction += 4;
  else if (buysM5 >= 2 || bpm >= 0.5) traction += 2;
  if (volM5 >= 5000) traction += 5;
  else if (volM5 >= 1000) traction += 3;
  if (smart >= 4) traction += 6;
  else if (smart >= 2) traction += 3;

  // Ultra-young (<2m) with no DS stats yet: don't hard-fail on zero buyers (indexing lag)
  // But if age > 5m and still ~0 activity → soft reject for FRESH quality
  if (ageMin >= 5 && traction < 2 && buysM5 < 2 && volM5 < 200 && smart < 1) {
    softPenalty += 8;
    reasons.push('no-traction');
    // Hard only when clearly abandoned junk past 12m with zero activity
    if (ageMin >= 12 && buysM5 === 0 && volM5 < 50) {
      pass = false;
      reasons.push('dead-fresh');
    }
  }

  softBonus += Math.min(8, Math.round(traction * 0.4));

  return {
    pass,
    reasons: [...new Set(reasons)],
    softPenalty,
    softBonus,
    traction,
    hasSocial,
    qualityOk: pass,
  };
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
  annotateImageAndNameDupes,
  freshQuality,
  imageKey,
  normalizeTicker,
  normalizeName,
  whaleClusterScore,
  tweetToLaunchScore,
  jupiterPriceCheck,
  status,
};
