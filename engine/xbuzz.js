'use strict';

/**
 * X (Twitter) buzz tracker — free/cheap.
 * Priority:
 *  1) Server-side X API if X_BEARER_TOKEN / TWITTER_BEARER_TOKEN set (app server only)
 *  2) Apify X scraper actor if APIFY_TOKEN set
 *  3) Stub / manual ingest otherwise (disabled)
 * Feeds narrative heat + runnerScore narrative/X component.
 *
 * Free-tier discipline: at most ONE X counts request per tick, only for top
 * candidates (cashtag / short CA), with multi-minute cache.
 */

const { fetchJson } = require('./http');

const X_BEARER = (() => {
  const direct = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
  if (direct && direct.length >= 80) return direct;
  const a = process.env.JEV_X_A || '';
  const b = process.env.JEV_X_B || '';
  const joined = a + b;
  return joined.length >= 80 ? joined : direct;
})();
// Real X API Bearer tokens are long JWTs (often start with AAAA...). Short opaque
// strings (API Key / Client ID) produce HTTP 401 Unauthorized.
if (X_BEARER && (X_BEARER.length < 80 || (!X_BEARER.startsWith('AAAA') && X_BEARER.split('.').length < 3))) {
  console.warn('[xbuzz] X_BEARER_TOKEN looks wrong shape (len=' + X_BEARER.length + '). Need OAuth 2.0 App-Only Bearer Token (Developer Portal → Project → App → Keys and tokens → Bearer Token). Not API Key, API Secret, Client ID, or Client Secret.');
}

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_X_ACTOR || 'apidojo/tweet-scraper';
const KOL_HANDLES = (process.env.X_KOL_HANDLES || 'elonmusk,a1lon9,solana,pumpdotfun,whale_alert,lookonchain,CryptoDonAlt,Ansem')
  .split(',')
  .map((s) => s.trim().replace(/^@/, ''))
  .filter(Boolean);


const store = {
  byTicker: {}, // symbol -> { mentions1h, mentions24h, kolPosts, velocity, lastAt, samples }
  tweets: [], // recent KOL / search tweets for tweet-to-launch
  enabled: !!(X_BEARER || APIFY_TOKEN),
  mode: X_BEARER ? 'x-api' : APIFY_TOKEN ? 'apify' : 'stub',
  lastError: null,
  lastRunAt: 0,
  lastQuery: null,
  apiCalls: 0,
  signals: 0,
  authFails: 0,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function ensure(sym) {
  const k = String(sym || '').toUpperCase();
  if (!store.byTicker[k]) {
    store.byTicker[k] = {
      symbol: k,
      mentions1h: 0,
      mentions24h: 0,
      kolPosts: 0,
      velocity: 0,
      lastAt: 0,
      samples: [],
    };
  }
  return store.byTicker[k];
}

/** Manual / Apify / parent ingest hook. */
function ingestMentions({ symbol, mint, mentions = 1, kol = false, ts = Date.now() } = {}) {
  const row = ensure(symbol || (mint && mint.slice(0, 6)));
  row.mentions1h += mentions;
  row.mentions24h += mentions;
  if (kol) row.kolPosts += 1;
  row.samples.push({ ts, mentions, kol: !!kol });
  if (row.samples.length > 80) row.samples = row.samples.slice(-80);
  const cut = Date.now() - 15 * 60e3;
  const recent = row.samples.filter((s) => s.ts >= cut).reduce((a, s) => a + (s.mentions || 0), 0);
  row.velocity = recent;
  row.lastAt = ts;
  if (mentions > 0) store.signals += 1;
  return row;
}

function pushTweet(tw) {
  if (!tw || !tw.text) return;
  store.tweets.unshift({
    text: String(tw.text).slice(0, 280),
    user: tw.user || tw.author || null,
    ts: tw.ts || Date.now(),
    kol: !!tw.kol,
  });
  if (store.tweets.length > 100) store.tweets = store.tweets.slice(0, 100);
}

function recentTweets(maxAgeMs = 30 * 60e3) {
  const cut = Date.now() - maxAgeMs;
  return store.tweets.filter((t) => t.ts >= cut);
}

function decay() {
  const cut1h = Date.now() - 3600e3;
  const cut24 = Date.now() - 86400e3;
  for (const row of Object.values(store.byTicker)) {
    row.samples = (row.samples || []).filter((s) => s.ts >= cut24);
    row.mentions1h = row.samples.filter((s) => s.ts >= cut1h).reduce((a, s) => a + (s.mentions || 0), 0);
    row.mentions24h = row.samples.reduce((a, s) => a + (s.mentions || 0), 0);
    row.kolPosts = row.samples.filter((s) => s.kol).length;
    const cut15 = Date.now() - 15 * 60e3;
    row.velocity = row.samples.filter((s) => s.ts >= cut15).reduce((a, s) => a + (s.mentions || 0), 0);
  }
}

/** 0–5 narrative/X score contribution for a pair. */
function xBuzzScore(pair) {
  decay();
  const sym = String((pair && pair.symbol) || '').toUpperCase();
  const row = store.byTicker[sym];
  if (!row) return { score: 0, note: 'no-x', enabled: store.enabled, mode: store.mode };
  let score = 0;
  if (row.velocity >= 12) score = 5;
  else if (row.velocity >= 6) score = 4;
  else if (row.velocity >= 3) score = 3;
  else if (row.mentions1h >= 5) score = 2;
  else if (row.mentions24h >= 3) score = 1;
  if (row.kolPosts >= 2) score = Math.min(5, score + 1);
  return {
    score: clamp(score, 0, 5),
    note: `v${row.velocity}/1h${row.mentions1h}/kol${row.kolPosts}`,
    enabled: store.enabled,
    mode: store.mode,
    row,
  };
}

function sanitizeTicker(t) {
  return String(t || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 16);
}

/**
 * One cashtag counts query. Cached ~3 minutes. Returns total recent count.
 */
async function pollOneCashtag(symbol, mint) {
  if (!X_BEARER) return null;
  const tick = sanitizeTicker(symbol);
  if (!tick || tick.length < 2) return null;
  // Prefer cashtag; optionally OR short CA prefix (min 6 chars) for contract chatter
  let q = `$${tick}`;
  const ca = mint && String(mint).length >= 8 ? String(mint).slice(0, 8) : null;
  if (ca) q = `($${tick} OR ${ca})`;
  q = `${q} -is:retweet lang:en`;
  const url = `https://api.twitter.com/2/tweets/counts/recent?query=${encodeURIComponent(q)}&granularity=hour`;
  const key = `x-counts-${tick}-${ca || 'x'}`;
  try {
    const d = await fetchJson(url, {
      ttlMs: 180000, // 3 min cache — free-tier friendly
      key,
      headers: { Authorization: `Bearer ${X_BEARER}` },
      timeoutMs: 12000,
    });
    store.lastRunAt = Date.now();
    store.lastError = null;
    store.lastQuery = tick;
    store.apiCalls += 1;
    const buckets = Array.isArray(d.data) ? d.data : [];
    const total =
      (d.meta && Number(d.meta.total_tweet_count)) ||
      buckets.reduce((a, b) => a + (Number(b.tweet_count) || 0), 0);
    // Last 2 hour buckets ≈ "velocity" proxy
    const recent = buckets.slice(-2).reduce((a, b) => a + (Number(b.tweet_count) || 0), 0);
    const mentions = Math.max(recent, Math.min(total, 40));
    if (mentions > 0) {
      ingestMentions({ symbol: tick, mint, mentions: Math.min(mentions, 25), ts: Date.now() });
    } else {
      // still register ticker so UI shows we queried
      ensure(tick).lastAt = Date.now();
    }
    return { symbol: tick, total, recent, mentions };
  } catch (e) {
    store.lastError = e.message;
    store.lastRunAt = Date.now();
    if (/401|403/.test(String(e.message))) store.authFails = (store.authFails || 0) + 1;
    return null;
  }
}

/** Apify actor run (rate-limited). */
async function triggerApifyScrape(tickers = [], opts = {}) {
  if (!APIFY_TOKEN || !tickers.length) return { ok: false, reason: 'APIFY_TOKEN unset or no tickers' };
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}`;
  try {
    const body = JSON.stringify({
      searchTerms: tickers.slice(0, 5).map((t) => `$${sanitizeTicker(t)}`),
      twitterHandles: opts.kol ? KOL_HANDLES.slice(0, 5) : undefined,
      maxItems: 30,
      maxTweets: 30,
      addUserInfo: true,
    });
    const d = await fetchJson(url, {
      method: 'POST',
      ttlMs: 0,
      key: `apify-run-${Date.now()}`,
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: 20000,
    });
    store.lastRunAt = Date.now();
    store.lastError = null;
    return { ok: true, runId: d.data && d.data.id, mode: 'apify' };
  } catch (e) {
    store.lastError = e.message;
    return { ok: false, reason: e.message };
  }
}

/**
 * symbols: string[] OR { symbol, mint }[]
 * Free-tier: at most 1 X API call per invocation, round-robin through top candidates.
 */
async function tickBuzz(symbols = []) {
  decay();
  store.enabled = !!(X_BEARER || APIFY_TOKEN);
  store.mode = X_BEARER ? 'x-api' : APIFY_TOKEN ? 'apify' : 'stub';
  if (!store.enabled) return stats();

  const items = (symbols || [])
    .map((s) => (typeof s === 'string' ? { symbol: s, mint: null } : s))
    .filter((s) => s && sanitizeTicker(s.symbol).length >= 2)
    .slice(0, 8);
  if (!items.length) return stats();

  const xAuthBroken = store.authFails >= 2;
  if (X_BEARER && !xAuthBroken) {
    const now = Date.now();
    let pick = items.find((it) => {
      const row = store.byTicker[sanitizeTicker(it.symbol).toUpperCase()];
      return !row || !row.lastAt || now - row.lastAt > 180000;
    });
    if (!pick) pick = items[0];
    await pollOneCashtag(pick.symbol, pick.mint);
    // Also filtered KOL search once / 10m when bearer works
    if (store.authFails < 1 && now - (store._kolAt || 0) > 600000) {
      store._kolAt = now;
      await pollKolFiltered().catch(() => {});
    }
    if (store.authFails < 2) return stats();
  }

  if (APIFY_TOKEN && Date.now() - (store.lastRunAt || 0) > 30 * 60e3) {
    store.mode = 'apify';
    await triggerApifyScrape(items.map((i) => i.symbol), { kol: true });
  }
  return stats();
}

/** Filtered search on watched KOL accounts (X API). */
async function pollKolFiltered() {
  if (!X_BEARER || !KOL_HANDLES.length) return null;
  const from = KOL_HANDLES.slice(0, 6).map((h) => `from:${h}`).join(' OR ');
  const q = `(${from}) (coin OR solana OR pump OR meme) -is:retweet`;
  const url = `https://api.twitter.com/2/tweets/search/recent?max_results=10&query=${encodeURIComponent(q)}&tweet.fields=created_at,author_id,text`;
  try {
    const d = await fetchJson(url, {
      ttlMs: 120000,
      key: 'x-kol-filtered',
      headers: { Authorization: `Bearer ${X_BEARER}` },
      timeoutMs: 12000,
    });
    store.apiCalls += 1;
    store.lastError = null;
    for (const tw of d.data || []) {
      pushTweet({ text: tw.text, user: tw.author_id, ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(), kol: true });
      store.signals += 1;
    }
    return d.data || [];
  } catch (e) {
    store.lastError = e.message;
    if (/401|403/.test(String(e.message))) store.authFails = (store.authFails || 0) + 1;
    return null;
  }
}

function stats() {
  decay();
  const top = Object.values(store.byTicker)
    .sort((a, b) => (b.velocity || 0) - (a.velocity || 0))
    .slice(0, 12);
  const tokenPresent = !!X_BEARER;
  const tokenShapeOk = tokenPresent && X_BEARER.length >= 80 && (X_BEARER.startsWith('AAAA') || X_BEARER.split('.').length >= 3);
  return {
    enabled: store.enabled,
    mode: store.mode,
    lastRunAt: store.lastRunAt,
    lastError: store.lastError,
    lastQuery: store.lastQuery,
    apiCalls: store.apiCalls,
    signals: store.signals,
    authFails: store.authFails || 0,
    tokenPresent,
    tokenLen: tokenPresent ? X_BEARER.length : 0,
    tokenShapeOk,
    tokenHint: !tokenPresent
      ? 'missing X_BEARER_TOKEN'
      : !tokenShapeOk
        ? 'need OAuth 2.0 App-Only Bearer Token (Developer Portal → Project → App → Keys and tokens → Bearer Token). Not API Key, API Secret, Client ID, or Client Secret. Expect len≥80, often starts with AAAA'
        : (store.authFails >= 1 ? 'bearer rejected (401/403) — check project access + credits' : 'ok'),
    tickers: Object.keys(store.byTicker).length,
    top,
  };
}

module.exports = {
  ingestMentions,
  xBuzzScore,
  tickBuzz,
  triggerApifyScrape,
  recentTweets,
  pushTweet,
  pollKolFiltered,
  stats,
  store,
  KOL_HANDLES,
};
