'use strict';

/**
 * X (Twitter) buzz tracker — free/cheap.
 * Priority:
 *  1) Server-side X API if X_BEARER_TOKEN / TWITTER_BEARER_TOKEN set (app server only)
 *  2) Apify X scraper actor if APIFY_TOKEN set
 *  3) Stub / manual ingest otherwise (disabled)
 * Feeds narrative heat + runnerScore narrative/X component.
 */

const { fetchJson } = require('./http');

const X_BEARER = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_X_ACTOR || 'apidojo/tweet-scraper';

const store = {
  byTicker: {}, // symbol -> { mentions1h, mentions24h, kolPosts, velocity, lastAt, samples }
  enabled: !!(X_BEARER || APIFY_TOKEN),
  mode: X_BEARER ? 'x-api' : APIFY_TOKEN ? 'apify' : 'stub',
  lastError: null,
  lastRunAt: 0,
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
  // velocity = mentions in last ~15m proxy vs baseline
  const cut = Date.now() - 15 * 60e3;
  const recent = row.samples.filter((s) => s.ts >= cut).reduce((a, s) => a + (s.mentions || 0), 0);
  row.velocity = recent;
  row.lastAt = ts;
  return row;
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

async function pollXApi(tickers = []) {
  if (!X_BEARER || !tickers.length) return [];
  const q = tickers
    .slice(0, 8)
    .map((t) => `"$${t}"`)
    .join(' OR ');
  const url = `https://api.twitter.com/2/tweets/counts/recent?query=${encodeURIComponent(q)}&granularity=hour`;
  try {
    const d = await fetchJson(url, {
      ttlMs: 120000,
      key: `x-counts-${q.slice(0, 40)}`,
      headers: { Authorization: `Bearer ${X_BEARER}` },
    });
    store.lastRunAt = Date.now();
    store.lastError = null;
    return d.data || [];
  } catch (e) {
    store.lastError = e.message;
    return [];
  }
}

/** Apify actor run (async fire-and-forget style; results via webhook/manual ingest preferred). */
async function triggerApifyScrape(tickers = []) {
  if (!APIFY_TOKEN || !tickers.length) return { ok: false, reason: 'APIFY_TOKEN unset or no tickers' };
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${APIFY_TOKEN}`;
  try {
    const body = JSON.stringify({
      searchTerms: tickers.slice(0, 10).map((t) => `$${t}`),
      maxTweets: 40,
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

async function tickBuzz(symbols = []) {
  decay();
  if (X_BEARER) {
    await pollXApi(symbols);
    return stats();
  }
  if (APIFY_TOKEN && symbols.length) {
    // Rate-limit: at most once / 30m
    if (Date.now() - (store.lastRunAt || 0) > 30 * 60e3) {
      await triggerApifyScrape(symbols);
    }
  }
  return stats();
}

function stats() {
  decay();
  const top = Object.values(store.byTicker)
    .sort((a, b) => (b.velocity || 0) - (a.velocity || 0))
    .slice(0, 12);
  return {
    enabled: store.enabled,
    mode: store.mode,
    lastRunAt: store.lastRunAt,
    lastError: store.lastError,
    tickers: Object.keys(store.byTicker).length,
    top,
  };
}

module.exports = {
  ingestMentions,
  xBuzzScore,
  tickBuzz,
  triggerApifyScrape,
  stats,
  store,
};
