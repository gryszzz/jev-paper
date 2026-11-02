'use strict';

/**
 * Generalized catalyst engine (free/cheap):
 *  - Celebrity / KOL watchlist posts (X API → Apify fallback)
 *  - Velocity: any account or keyword whose engagement/mention rate spikes
 *  - Match spikes → fresh launches (name/ticker/description/CA) within 0–30m
 *  - Early traction on the coin itself (buyer accel, smart wallets, socials)
 *  - Tight rug posture for famous-name / catalyst coins (caller still runs rugcheck)
 */
const { fetchJson } = require('./http');

const X_BEARER = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_X_ACTOR || 'apidojo/tweet-scraper';

const DEFAULT_WATCH = [
  'realDonaldTrump', 'elonmusk', 'a1lon9', 'solana', 'pumpdotfun',
  'whale_alert', 'lookonchain', 'CryptoDonAlt', 'Ansem', 'blknoiz06',
  'Cointelegraph', 'WatcherGuru', 'Tier10k', 'unusual_whales',
  'MemecoinDaily', 'solanafloor',
];
const WATCHLIST = (process.env.X_CATALYST_HANDLES || process.env.X_KOL_HANDLES || DEFAULT_WATCH.join(','))
  .split(',')
  .map((s) => s.trim().replace(/^@/, ''))
  .filter(Boolean);

const WINDOW_MS = 30 * 60e3;
const MATCH_WINDOW_MS = 30 * 60e3;
const MAX_EVENTS = 200;
const MAX_COINS = 400;
const MAX_KEYWORDS = 300;

const store = {
  events: [], // { id, user, text, ts, likes, rts, replies, engagement, velocity, keywords[], tickers[], cas[], source, watchlisted }
  keywords: {}, // kw -> { counts: [{ts,n}], velocity, spike }
  coins: {}, // mint -> { firstSeen, sources:Set→arr, symbol, name, description, traction, scoredAt }
  matches: {}, // mint -> { score, note, kind, user, ageMin, first:true }
  lastPollAt: 0,
  lastApifyAt: 0,
  lastError: null,
  apiCalls: 0,
  signals: 0,
  authFails: 0,
  mode: X_BEARER ? 'x-api' : APIFY_TOKEN ? 'apify' : 'stub',
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9$]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTickers(text) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,14})/g)) out.add(m[1].toUpperCase());
  return [...out];
}

function extractCAs(text) {
  const out = [];
  const t = String(text || '');
  for (const m of t.matchAll(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g)) {
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(m[1]) && m[1].length >= 32) out.push(m[1]);
  }
  return out;
}

/** Pull memorable keywords / names / phrases (2+ char tokens, drop stopwords). */
function extractKeywords(text) {
  const stop = new Set([
    'the','and','for','you','your','with','this','that','from','have','just','like','will','what',
    'about','they','them','their','been','were','when','where','http','https','www','com','sol',
    'solana','crypto','coin','token','pump','meme','launch','now','new','get','out','all','our',
    'are','was','but','not','can','its','it','is','in','on','to','of','a','an','or','as','at','be',
  ]);
  const raw = norm(text).split(' ').filter((w) => w.length >= 3 && !stop.has(w) && !/^https?/.test(w));
  const kws = [];
  for (let i = 0; i < raw.length; i++) {
    kws.push(raw[i]);
    if (i + 1 < raw.length) kws.push(`${raw[i]} ${raw[i + 1]}`);
  }
  return [...new Set(kws)].slice(0, 24);
}

function bumpKeyword(kw, n = 1, ts = Date.now()) {
  if (!kw) return null;
  const row = store.keywords[kw] || (store.keywords[kw] = { counts: [], velocity: 0, spike: 0 });
  row.counts.push({ ts, n });
  const cut = ts - WINDOW_MS;
  row.counts = row.counts.filter((c) => c.ts >= cut);
  row.velocity = row.counts.reduce((a, c) => a + c.n, 0);
  // Spike: >= 8 mentions in 30m or sudden jump
  const prev = row.counts.filter((c) => c.ts < ts - 5 * 60e3).reduce((a, c) => a + c.n, 0);
  const recent = row.counts.filter((c) => c.ts >= ts - 5 * 60e3).reduce((a, c) => a + c.n, 0);
  row.spike = recent >= 5 && recent >= prev * 2 ? Math.min(20, recent) : row.velocity >= 10 ? Math.min(16, row.velocity) : 0;
  return row;
}

function ingestPost(post = {}) {
  const text = String(post.text || '').slice(0, 400);
  if (!text) return null;
  const ts = post.ts || Date.now();
  const likes = Number(post.likes || post.likeCount || 0);
  const rts = Number(post.rts || post.retweetCount || 0);
  const replies = Number(post.replies || post.replyCount || 0);
  const engagement = likes + rts * 2 + replies;
  const user = String(post.user || post.author || '').replace(/^@/, '');
  const watchlisted = WATCHLIST.some((h) => h.toLowerCase() === user.toLowerCase());
  // Velocity: engagement in first minutes proxy — treat high engagement as spike source
  const ageMin = Math.max(0.5, (Date.now() - ts) / 60000);
  const engPerMin = engagement / ageMin;
  const velocity = engPerMin >= 40 || engagement >= 500 || (watchlisted && engagement >= 50)
    ? Math.min(25, Math.round(engPerMin / 2) + (watchlisted ? 8 : 0))
    : watchlisted ? 6 : engagement >= 80 ? 5 : 0;
  const keywords = extractKeywords(text);
  const tickers = extractTickers(text);
  const cas = extractCAs(text);
  for (const kw of keywords) bumpKeyword(kw, watchlisted ? 2 : 1, ts);
  for (const t of tickers) bumpKeyword(`$${t.toLowerCase()}`, 3, ts);

  const ev = {
    id: post.id || `${user}-${ts}-${text.slice(0, 12)}`,
    user,
    text,
    ts,
    likes,
    rts,
    replies,
    engagement,
    velocity,
    keywords,
    tickers,
    cas,
    source: post.source || 'x',
    watchlisted,
  };
  store.events.unshift(ev);
  if (store.events.length > MAX_EVENTS) store.events = store.events.slice(0, MAX_EVENTS);
  if (velocity > 0 || watchlisted || tickers.length || cas.length) store.signals += 1;
  return ev;
}

/** Ingest mention-rate spike from Reddit / Google Trends / viral module. */
function ingestKeywordSpike(keyword, { heat = 1, source = 'trend', ts = Date.now() } = {}) {
  const kw = norm(keyword);
  if (!kw || kw.length < 3) return null;
  const row = bumpKeyword(kw, Math.max(1, Math.round(heat * 4)), ts);
  if (row && row.spike > 0) {
    store.signals += 1;
    store.events.unshift({
      id: `kw-${kw}-${ts}`,
      user: source,
      text: kw,
      ts,
      likes: 0,
      rts: 0,
      replies: 0,
      engagement: row.velocity,
      velocity: row.spike,
      keywords: [kw],
      tickers: kw.startsWith('$') ? [kw.slice(1).toUpperCase()] : [],
      cas: [],
      source,
      watchlisted: false,
      keywordSpike: true,
    });
    if (store.events.length > MAX_EVENTS) store.events = store.events.slice(0, MAX_EVENTS);
  }
  return row;
}

/**
 * Full new-coin coverage — dedupe every create/pool/boost into one stream.
 * source: pumpportal.new | pumpportal.migration | pump.fun | pumpswap | raydium |
 *         meteora | dexscreener | dexscreener.boost | gecko.new_pool | ...
 */
function ingestCoin(coin = {}) {
  const mint = coin.mint || coin.tokenAddress;
  if (!mint) return null;
  const now = Date.now();
  let row = store.coins[mint];
  if (!row) {
    row = store.coins[mint] = {
      mint,
      firstSeen: now,
      sources: [],
      symbol: coin.symbol || '',
      name: coin.name || '',
      description: coin.description || coin.desc || '',
      traction: 0,
      scoredAt: 0,
    };
  }
  const src = coin.source || coin.dexId || 'unknown';
  if (!row.sources.includes(src)) row.sources.push(src);
  if (coin.symbol) row.symbol = coin.symbol;
  if (coin.name) row.name = coin.name;
  if (coin.description || coin.desc) row.description = coin.description || coin.desc;
  // prune
  const keys = Object.keys(store.coins);
  if (keys.length > MAX_COINS) {
    keys.sort((a, b) => (store.coins[a].firstSeen || 0) - (store.coins[b].firstSeen || 0));
    for (const k of keys.slice(0, keys.length - MAX_COINS)) delete store.coins[k];
  }
  return row;
}

/** Early-traction on the coin: buyer accel, smart wallets, social links. 0–20. */
function earlyTraction(pair = {}, ctx = {}) {
  let score = 0;
  const notes = [];
  const buysM5 = Number(pair.buysM5) || 0;
  const buysH1 = Number(pair.buysH1) || 0;
  const perMin5 = buysM5 / 5;
  const perMinH1 = buysH1 / 60;
  const accel = perMin5 - perMinH1;
  if (accel >= 3) { score += 8; notes.push('buyerAccel'); }
  else if (accel >= 1.2) { score += 5; notes.push('buyerUp'); }
  else if (perMin5 >= 2) { score += 3; notes.push('buyers'); }

  const smart = Number(ctx.smartOverlap || pair.smartOverlap || pair.whaleCluster || 0);
  if (smart >= 10) { score += 7; notes.push('smart'); }
  else if (smart >= 4) { score += 4; notes.push('smart'); }

  const hasSocial = !!(pair.hasSocials || (pair.socials && (pair.socials.twitter || pair.socials.telegram || pair.socials.website))
    || pair.twitter || pair.telegram || (pair.websites && pair.websites.length));
  if (hasSocial) { score += 4; notes.push('socials'); }

  const ageMin = (Number(pair.ageMs) || 0) / 60000;
  if (ageMin > 0 && ageMin < 15 && score >= 6) { score += 2; notes.push('early'); }

  score = clamp(score, 0, 20);
  if (pair.mint && store.coins[pair.mint]) {
    store.coins[pair.mint].traction = score;
    store.coins[pair.mint].scoredAt = Date.now();
  }
  return { earlyTraction: score, note: notes.join('+') || 'none' };
}

/**
 * Match pair against catalyst events / keyword spikes.
 * Big boost for first quality match within 0–30m; copycats penalized by caller.
 */
function matchPair(pair = {}, { copycatPenalty = 0 } = {}) {
  if (!pair || !pair.mint) return { catalyst: 0, note: 'none', kind: null, directMention: false, rugTight: false };
  const mint = pair.mint;
  const sym = String(pair.symbol || '').toUpperCase();
  const name = norm(pair.name || pair.symbol || '');
  const desc = norm(pair.description || '');
  const created = pair.pairCreatedAt || pair.createdMs || (pair.ageMs != null ? Date.now() - pair.ageMs : store.coins[mint]?.firstSeen || null);
  const ageMin = created ? (Date.now() - created) / 60000 : (Number(pair.ageMs) || 0) / 60000;

  let best = 0;
  let note = 'none';
  let kind = null;
  let user = null;
  let directMention = false;
  let rugTight = false;

  const cut = Date.now() - MATCH_WINDOW_MS;
  for (const ev of store.events) {
    if ((ev.ts || 0) < cut) continue;
    // Direct CA / ticker mention by famous or velocity account
    const caHit = (ev.cas || []).includes(mint);
    const tickerHit = sym && (ev.tickers || []).map((t) => t.toUpperCase()).includes(sym);
    const text = norm(ev.text);
    const nameHit = name && name.length >= 3 && text.includes(name);
    const kwHit = (ev.keywords || []).some((kw) => {
      if (kw.length < 4) return false;
      return (name && name.includes(kw)) || (desc && desc.includes(kw)) || (sym && sym.toLowerCase() === kw.replace(/^\$/, ''));
    });

    if (!(caHit || tickerHit || nameHit || kwHit)) continue;

    // Timing: launch within ~0–30m of post (either side slightly — prefer post first)
    const dtMin = created ? Math.abs(created - ev.ts) / 60000 : ageMin;
    if (dtMin > 30) continue;

    let score = 0;
    if (caHit || (tickerHit && ev.watchlisted)) {
      score = 28;
      directMention = true;
      kind = 'direct';
    } else if (tickerHit) {
      score = 22;
      directMention = true;
      kind = 'ticker';
    } else if (nameHit) {
      score = dtMin <= 5 ? 20 : dtMin <= 15 ? 16 : 12;
      kind = 'name';
    } else {
      score = dtMin <= 5 ? 14 : dtMin <= 15 ? 10 : 7;
      kind = 'keyword';
    }
    if (ev.watchlisted) score += 6;
    if (ev.velocity >= 10) score += 5;
    else if (ev.velocity >= 5) score += 3;
    if (ev.keywordSpike) score += 4;
    // First-mover style: younger = better
    if (ageMin <= 5) score += 4;
    else if (ageMin <= 15) score += 2;
    // Famous-name magnets → mark for tight rugs
    if (ev.watchlisted || directMention || score >= 18) rugTight = true;

    if (score > best) {
      best = score;
      user = ev.user;
      note = `${kind}@${ev.user || ev.source}·${Math.round(dtMin)}m`;
    }
  }

  // Keyword dictionary spikes without a single event match
  if (best < 10) {
    for (const [kw, row] of Object.entries(store.keywords)) {
      if (!row.spike) continue;
      if ((name && name.includes(kw)) || (sym && sym.toLowerCase() === kw.replace(/^\$/, '')) || (desc && desc.includes(kw))) {
        const s = Math.min(18, 8 + row.spike);
        if (s > best) {
          best = s;
          kind = 'trend';
          note = `trend:${kw}·v${row.velocity}`;
          rugTight = true;
        }
      }
    }
  }

  // Copycat haircut
  if (copycatPenalty > 0) {
    best = Math.max(0, best - Math.min(16, copycatPenalty * 0.7));
    if (copycatPenalty >= 8) rugTight = true;
  }

  best = clamp(best, 0, 36);
  const prev = store.matches[mint];
  const first = !prev || (prev.score || 0) < best;
  store.matches[mint] = { score: best, note, kind, user, ageMin, first, directMention, rugTight, ts: Date.now() };
  return {
    catalyst: best,
    note,
    kind,
    user,
    directMention,
    rugTight,
    first,
  };
}

async function pollWatchlistX() {
  if (!X_BEARER || !WATCHLIST.length) return null;
  if (store.authFails >= 2) return null;
  const now = Date.now();
  if (now - (store.lastPollAt || 0) < 180000) return null; // ≥3m between polls
  store.lastPollAt = now;
  // Rotate handles to stay in free rate limits — 5 per poll
  const offset = Math.floor(now / 180000) % Math.max(1, WATCHLIST.length);
  const handles = [];
  for (let i = 0; i < Math.min(5, WATCHLIST.length); i++) {
    handles.push(WATCHLIST[(offset + i) % WATCHLIST.length]);
  }
  const from = handles.map((h) => `from:${h}`).join(' OR ');
  const q = `(${from}) -is:retweet`;
  const url = `https://api.twitter.com/2/tweets/search/recent?max_results=10&query=${encodeURIComponent(q)}&tweet.fields=created_at,author_id,text,public_metrics&expansions=author_id&user.fields=username`;
  try {
    const d = await fetchJson(url, {
      ttlMs: 90000,
      key: `x-catalyst-${handles.join(',')}`,
      headers: { Authorization: `Bearer ${X_BEARER}` },
      timeoutMs: 12000,
    });
    store.apiCalls += 1;
    store.lastError = null;
    store.mode = 'x-api';
    const users = {};
    for (const u of (d.includes && d.includes.users) || []) users[u.id] = u.username;
    const out = [];
    for (const tw of d.data || []) {
      const m = tw.public_metrics || {};
      const ev = ingestPost({
        id: tw.id,
        text: tw.text,
        user: users[tw.author_id] || tw.author_id,
        ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(),
        likes: m.like_count,
        rts: m.retweet_count,
        replies: m.reply_count,
        source: 'x-watch',
      });
      if (ev) out.push(ev);
    }
    return out;
  } catch (e) {
    store.lastError = e.message;
    if (/401|403/.test(String(e.message))) {
      store.authFails = (store.authFails || 0) + 1;
      store.mode = APIFY_TOKEN ? 'apify' : 'viral-fallback';
    }
    return null;
  }
}

async function pollApifyFallback() {
  if (!APIFY_TOKEN) return null;
  if (store.authFails < 2 && X_BEARER) return null; // prefer X when healthy
  const now = Date.now();
  if (now - (store.lastApifyAt || 0) < 30 * 60e3) return null;
  store.lastApifyAt = now;
  store.mode = 'apify';
  try {
    const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}`;
    await fetchJson(url, {
      method: 'POST',
      ttlMs: 0,
      key: `apify-catalyst-${now}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twitterHandles: WATCHLIST.slice(0, 8),
        maxItems: 20,
        sort: 'Latest',
      }),
      timeoutMs: 15000,
    });
    store.apiCalls += 1;
    store.lastError = null;
    return true;
  } catch (e) {
    store.lastError = e.message;
    return null;
  }
}

/**
 * Scan recent non-watchlist posts for engagement-velocity spikes and promote them
 * so matchPair can bind famous/viral chatter to new launches.
 */
function engagementVelocityScan() {
  const cut = Date.now() - WINDOW_MS;
  let promoted = 0;
  for (const ev of store.events) {
    if ((ev.ts || 0) < cut) continue;
    if (ev.watchlisted) continue;
    const ageMin = Math.max(0.5, (Date.now() - ev.ts) / 60000);
    const engPerMin = (ev.engagement || 0) / ageMin;
    if (engPerMin >= 25 || (ev.engagement || 0) >= 200) {
      if ((ev.velocity || 0) < 8) {
        ev.velocity = Math.min(25, Math.round(engPerMin / 2) + 5);
        promoted += 1;
        store.signals += 1;
      }
      for (const kw of ev.keywords || []) bumpKeyword(kw, 2, ev.ts);
      for (const t of ev.tickers || []) bumpKeyword(`$${String(t).toLowerCase()}`, 3, ev.ts);
    }
  }
  return promoted;
}

async function tickCatalyst({ viralStats } = {}) {

  await pollWatchlistX().catch(() => {});
  await pollApifyFallback().catch(() => {});
  // Pull keyword spikes from viral module stats if provided
  try {
    const top = (viralStats && viralStats.top) || [];
    for (const m of top.slice(0, 12)) {
      const heat = Number(m.heat) || 0.5;
      for (const kw of m.keywords || []) ingestKeywordSpike(kw, { heat, source: m.source || 'viral' });
    }
  } catch (_) {}
  return stats();
}

function stats() {
  const spikes = Object.entries(store.keywords)
    .filter(([, r]) => r.spike > 0)
    .sort((a, b) => b[1].spike - a[1].spike)
    .slice(0, 10)
    .map(([k, r]) => ({ kw: k, spike: r.spike, velocity: r.velocity }));
  return {
    mode: store.mode,
    watchlist: WATCHLIST.length,
    events: store.events.length,
    coins: Object.keys(store.coins).length,
    matches: Object.keys(store.matches).length,
    signals: store.signals,
    apiCalls: store.apiCalls,
    authFails: store.authFails,
    lastPollAt: store.lastPollAt,
    lastError: store.lastError,
    spikes,
    recent: store.events.slice(0, 5).map((e) => ({
      user: e.user,
      velocity: e.velocity,
      watchlisted: e.watchlisted,
      tickers: e.tickers,
      ts: e.ts,
    })),
  };
}

module.exports = {
  WATCHLIST,
  ingestPost,
  ingestKeywordSpike,
  ingestCoin,
  earlyTraction,
  matchPair,
  tickCatalyst,
  pollWatchlistX,
  engagementVelocityScan,
  stats,
  store,
};
