'use strict';

/**
 * Viral meme / video detection — free/cheap sources only.
 * X trends (via xbuzz ingest), Google Trends daily/realtime (pytrends-less HTML/JSON),
 * Reddit r/all + r/memes rising (.json), YouTube mostPopular if YOUTUBE_API_KEY set,
 * Apify TikTok/IG sparingly if APIFY_TOKEN set.
 * Matches keywords to new token names/tickers; first quality launch gets strong early bonus,
 * decaying with meme age and clone flood. Feature logged for learner.
 */

const { fetchJson } = require('./http');

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const store = {
  memes: [], // { id, keywords[], source, ts, heat, clones, firstMint }
  lastFetchAt: 0,
  lastError: null,
  sources: { reddit: false, googleTrends: false, youtube: false, apify: false, x: false },
  apiCalls: 0,
};

const STOP = new Set([
  'the','a','an','and','or','to','of','in','on','for','is','it','this','that','with','from','you','your',
  'meme','video','viral','trending','tiktok','instagram','youtube','reddit','watch','new','just','now',
]);

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s$#]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[#$\s]+|[$s]+$/g, ''))
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOP.has(w) && !/^\d+$/.test(w));
}

function upsertMeme({ keywords, source, heat = 1, id }) {
  if (!keywords || !keywords.length) return null;
  const key = (id || keywords.slice(0, 3).join('-')).toLowerCase();
  let row = store.memes.find((m) => m.id === key);
  if (!row) {
    row = { id: key, keywords: [...new Set(keywords)].slice(0, 8), source, ts: Date.now(), heat, clones: 0, firstMint: null };
    store.memes.unshift(row);
  } else {
    row.heat = Math.max(row.heat, heat);
    row.ts = Date.now();
    for (const k of keywords) if (!row.keywords.includes(k)) row.keywords.push(k);
    row.keywords = row.keywords.slice(0, 8);
  }
  if (store.memes.length > 80) store.memes = store.memes.slice(0, 80);
  return row;
}

async function fetchRedditRising() {
  const outs = [];
  for (const sub of ['memes', 'all']) {
    try {
      const d = await fetchJson(`https://old.reddit.com/r/${sub}/rising.json?limit=15`, {
        ttlMs: 120000,
        key: `reddit-rising-${sub}`,
        timeoutMs: 10000,
        headers: { 'User-Agent': 'JEV-Paper/1.0 (meme-radar; contact: paper-bot)' },
      });
      store.apiCalls += 1;
      const children = (d.data && d.data.children) || [];
      for (const c of children) {
        const t = c.data || {};
        const words = tokenize(`${t.title || ''} ${t.link_flair_text || ''}`);
        if (words.length) {
          outs.push(upsertMeme({
            keywords: words.slice(0, 5),
            source: `reddit-r/${sub}`,
            heat: clamp((t.ups || 0) / 5000, 0.6, 2.2),
            id: `rd-${t.id || words[0]}`,
          }));
        }
      }
      store.sources.reddit = true;
    } catch (e) {
      store.lastError = `reddit:${e.message}`;
    }
  }
  return outs.filter(Boolean);
}

/** Google Trends daily / realtime — free RSS/JSON endpoints (best-effort). */
async function fetchGoogleTrends() {
  const outs = [];
  try {
    // Realtime trending searches US (public)
    const d = await fetchJson(
      'https://trends.google.com/trends/api/realtimetrends?hl=en-US&tz=-300&cat=all&fi=0&fs=0&geo=US&ri=300&rs=20&sort=0',
      { ttlMs: 300000, key: 'gtrends-rt', timeoutMs: 12000 }
    );
    store.apiCalls += 1;
    let text = typeof d === 'string' ? d : JSON.stringify(d);
    // endpoint sometimes returns )]}' prefix
    text = text.replace(/^\)\]\}',?\s*/, '');
    let parsed = d;
    try { parsed = typeof d === 'string' ? JSON.parse(text) : d; } catch (_) {}
    const stories = (parsed && parsed.storySummaries && parsed.storySummaries.trendingStories) || [];
    for (const s of stories.slice(0, 15)) {
      const title = s.title || (s.entityNames && s.entityNames.join(' ')) || '';
      const words = tokenize(title);
      if (words.length) {
        outs.push(upsertMeme({
          keywords: words.slice(0, 5),
          source: 'google-trends-rt',
          heat: 1.4,
          id: `gt-${(s.id || words[0]).toString().slice(0, 24)}`,
        }));
      }
    }
    store.sources.googleTrends = outs.length > 0;
  } catch (e) {
    // Fallback: daily trends RSS-like widget
    try {
      const d2 = await fetchJson(
        'https://trends.google.com/trends/hottrends/atom/feed?pn=p1',
        { ttlMs: 300000, key: 'gtrends-atom', timeoutMs: 10000 }
      );
      store.apiCalls += 1;
      const raw = typeof d2 === 'string' ? d2 : JSON.stringify(d2);
      const titles = [...raw.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1]).slice(1, 16);
      for (const title of titles) {
        const words = tokenize(title);
        if (words.length) {
          outs.push(upsertMeme({ keywords: words.slice(0, 4), source: 'google-trends-daily', heat: 1.2, id: `gtd-${words[0]}` }));
        }
      }
      store.sources.googleTrends = outs.length > 0;
    } catch (e2) {
      store.lastError = `gtrends:${e2.message}`;
    }
  }
  return outs.filter(Boolean);
}

async function fetchYoutubePopular() {
  if (!YOUTUBE_API_KEY) return [];
  try {
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=US&maxResults=10&videoCategoryId=24&key=${YOUTUBE_API_KEY}`;
    const d = await fetchJson(url, { ttlMs: 600000, key: 'yt-popular', timeoutMs: 12000 });
    store.apiCalls += 1;
    const outs = [];
    for (const item of d.items || []) {
      const sn = item.snippet || {};
      const words = tokenize(`${sn.title || ''} ${sn.tags ? sn.tags.slice(0, 4).join(' ') : ''}`);
      if (words.length) {
        outs.push(upsertMeme({
          keywords: words.slice(0, 5),
          source: 'youtube-popular',
          heat: 1.3,
          id: `yt-${item.id}`,
        }));
      }
    }
    store.sources.youtube = true;
    return outs.filter(Boolean);
  } catch (e) {
    store.lastError = `youtube:${e.message}`;
    return [];
  }
}

/** Sparingly: Apify TikTok trending — at most 1 run / 6h. */
async function fetchApifySocialSparingly() {
  if (!APIFY_TOKEN) return [];
  if (store._apifyAt && Date.now() - store._apifyAt < 6 * 3600e3) return [];
  try {
    const url = `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=${APIFY_TOKEN}`;
    await fetchJson(url, {
      method: 'POST',
      ttlMs: 0,
      key: `apify-tt-${Date.now()}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashtags: ['meme', 'viral'], resultsPerPage: 5, maxItems: 10 }),
      timeoutMs: 15000,
    });
    store._apifyAt = Date.now();
    store.apiCalls += 1;
    store.sources.apify = true;
    // Results async — keywords from hashtags themselves as weak signal
    return [
      upsertMeme({ keywords: ['viral', 'fyp'], source: 'apify-tiktok-seed', heat: 0.9, id: 'apify-tt-seed' }),
    ].filter(Boolean);
  } catch (e) {
    store.lastError = `apify:${e.message}`;
    return [];
  }
}

function ingestXTrendKeywords(texts = []) {
  for (const t of texts) {
    const words = tokenize(t);
    if (words.length) {
      upsertMeme({ keywords: words.slice(0, 5), source: 'x-trend', heat: 1.5, id: `x-${words[0]}` });
      store.sources.x = true;
    }
  }
}

async function fetchWikiTrending() {
  try {
    const d = await fetchJson(
      'https://en.wikipedia.org/api/rest_v1/feed/featured/' + new Date().toISOString().slice(0,10).replace(/-/g,'/'),
      { ttlMs: 600000, key: 'wiki-featured', timeoutMs: 10000 }
    );
    store.apiCalls += 1;
    const outs = [];
    const news = (d.news && d.news) || [];
    for (const n of news.slice(0, 8)) {
      const title = (n.links && n.links[0] && n.links[0].titles && n.links[0].titles.normalized) || (n.story && n.story) || '';
      const words = tokenize(typeof title === 'string' ? title : '');
      if (words.length) outs.push(upsertMeme({ keywords: words.slice(0, 4), source: 'wiki-featured', heat: 1.1, id: `wiki-${words[0]}` }));
    }
    const most = d.mostread && d.mostread.articles || [];
    for (const a of most.slice(0, 8)) {
      const words = tokenize(a.titles && a.titles.normalized || a.title || '');
      if (words.length) outs.push(upsertMeme({ keywords: words.slice(0, 4), source: 'wiki-mostread', heat: 1.0, id: `wikim-${words[0]}` }));
    }
    if (outs.length) store.sources.googleTrends = true; // reuse slot as "web trends"
    return outs.filter(Boolean);
  } catch (e) {
    store.lastError = `wiki:${e.message}`;
    return [];
  }
}

async function tickViral({ force = false } = {}) {
  if (!force && store.lastFetchAt && Date.now() - store.lastFetchAt < 3 * 60e3) {
    return stats();
  }
  store.lastFetchAt = Date.now();
  await Promise.all([
    fetchRedditRising(),
    fetchGoogleTrends(),
    fetchYoutubePopular(),
    fetchWikiTrending(),
  ]);
  // Apify sparse — fire-and-forget cadence
  if (Math.random() < 0.15) await fetchApifySocialSparingly();
  decayMemes();
  return stats();
}

function decayMemes() {
  const now = Date.now();
  for (const m of store.memes) {
    const ageH = (now - m.ts) / 3600e3;
    m.heat = clamp((m.heat || 1) * Math.exp(-ageH / 6), 0.2, 2.5);
    if (m.clones > 3) m.heat *= 0.85;
    if (m.clones > 8) m.heat *= 0.7;
  }
  store.memes = store.memes.filter((m) => m.heat >= 0.25 && now - m.ts < 36 * 3600e3);
}

/**
 * Match coin symbol/name to fresh viral memes.
 * Returns { score 0–18, firstMover bonus, meme, note }
 */
function matchViral(pair = {}) {
  decayMemes();
  const text = `${pair.symbol || ''} ${pair.name || ''}`.toLowerCase();
  if (text.length < 2) return { score: 0, viralMeme: 0, firstMover: 0, note: 'none' };
  let best = null;
  let bestHits = 0;
  for (const m of store.memes) {
    let hits = 0;
    for (const k of m.keywords) {
      if (k.length >= 3 && text.includes(k)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = m;
    }
  }
  if (!best || bestHits < 1) return { score: 0, viralMeme: 0, firstMover: 0, note: 'no-match' };

  const ageMin = (Date.now() - best.ts) / 60000;
  let firstMover = 0;
  if (!best.firstMint) {
    best.firstMint = pair.mint || 'pending';
    firstMover = 10; // strong early bonus for first quality match
  } else if (best.firstMint === pair.mint) {
    firstMover = 8;
  } else {
    best.clones = (best.clones || 0) + 1;
    firstMover = Math.max(0, 4 - best.clones);
  }
  // Decay with age
  const ageDecay = ageMin < 30 ? 1 : ageMin < 120 ? 0.7 : ageMin < 360 ? 0.4 : 0.2;
  const cloneDecay = best.clones > 5 ? 0.4 : best.clones > 2 ? 0.7 : 1;
  const score = Math.round(clamp(best.heat * 6 * bestHits * ageDecay * cloneDecay + firstMover * 0.5, 0, 18));
  return {
    score,
    viralMeme: score,
    firstMover,
    meme: { id: best.id, keywords: best.keywords, source: best.source, heat: best.heat, clones: best.clones },
    note: `${best.id}·h${bestHits}·c${best.clones}·age${Math.round(ageMin)}m`,
  };
}

function stats() {
  return {
    memes: store.memes.length,
    top: store.memes.slice(0, 8).map((m) => ({
      id: m.id,
      keywords: m.keywords,
      source: m.source,
      heat: Math.round(m.heat * 100) / 100,
      clones: m.clones,
      ageMin: Math.round((Date.now() - m.ts) / 60000),
    })),
    sources: { ...store.sources },
    lastFetchAt: store.lastFetchAt,
    lastError: store.lastError,
    apiCalls: store.apiCalls,
    youtubeKey: !!YOUTUBE_API_KEY,
    apify: !!APIFY_TOKEN,
  };
}

module.exports = {
  tickViral,
  matchViral,
  ingestXTrendKeywords,
  stats,
  store,
  tokenize,
};
