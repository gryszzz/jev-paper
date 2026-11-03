'use strict';

/**
 * Top-trader / Fomo-style copy signal.
 *
 * Research (2026-11-02):
 *  - fomo.family has NO official public API.
 *  - FomoRadar (fomoradar.io) is a paid third-party JSON API for fomo.family
 *    leaderboards + verified wallets. Optional via FOMORADAR_API_KEY.
 *  - Free path: GMGN public wallet rank quotation endpoint
 *    (tags: smart_degen, kol, smart_money, renowned). Unofficial, fragile —
 *    ToS: do not scrape fomo.family HTML; prefer documented APIs / public JSON only.
 *  - Rate limit: one board ~every 15m, staggered tags, curl UA (Node TLS 403).
 *
 * Promotes ranked wallets into smartMoney, PumpPortal account-trade subscribe
 * prefers copy wallets, cluster buys (≥2 within minutes) get a strong boost.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { fetchJson } = require('./http');
const { ensureRegistry, rankWallets, isSmartWallet } = require('./smartMoney');

const execFileAsync = promisify(execFile);
const GMGN_BASE = 'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets';
const FOMORADAR_BASE = 'https://fomoradar.io/v2';
const GMGN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Tags Tony approved: smart-money + KOL boards (free public JSON). */
const GMGN_TAGS = ['smart_degen', 'kol', 'smart_money'];

const STATS = {
  lastRunAt: 0,
  lastError: null,
  source: null,
  promoted: 0,
  fetched: 0,
  gmgnOk: 0,
  fomoOk: 0,
  tagsOk: {},
  latencyMs: null,
  pruned: 0,
  trackedCopy: 0,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

/** Local promote — avoids circular require with smartWalletMiner. */
function promote(reg, address, { label = 'copy', boost = 2, note } = {}) {
  if (!address || address.length < 32) return null;
  let w = isSmartWallet(reg, address);
  if (!w) {
    w = {
      address,
      label,
      rank: 60,
      buys: 0,
      sells: 0,
      wins: 0,
      losses: 0,
      score: 60,
      mined: true,
      copy: true,
      firstSeen: Date.now(),
      notes: [],
      recent: [],
    };
    reg.wallets.push(w);
  }
  w.score = clamp((w.score || 50) + boost, 10, 99);
  w.mined = true;
  w.copy = true;
  w.label = label || w.label;
  w.lastMinedAt = Date.now();
  if (note) {
    w.notes = w.notes || [];
    w.notes.unshift({ ts: Date.now(), note });
    if (w.notes.length > 8) w.notes = w.notes.slice(0, 8);
  }
  return w;
}

function gmgnHeaders() {
  return {
    Accept: 'application/json',
    'User-Agent': GMGN_UA,
    Referer: 'https://gmgn.ai/',
  };
}

/** GMGN blocks Node TLS fingerprint; prefer curl. Render egress often gets CF HTML — detect + fall through. */
async function fetchGmgnJson(url) {
  const curlArgs = [
    '-sS',
    '--max-time',
    '18',
    '-A',
    GMGN_UA,
    '-H',
    'Accept: application/json,text/plain,*/*',
    '-H',
    'Accept-Language: en-US,en;q=0.9',
    '-H',
    'Referer: https://gmgn.ai/?chain=sol',
    '-H',
    'Origin: https://gmgn.ai',
    '-H',
    'sec-fetch-dest: empty',
    '-H',
    'sec-fetch-mode: cors',
    '-H',
    'sec-fetch-site: same-origin',
    url,
  ];
  try {
    const { stdout } = await execFileAsync('curl', curlArgs, { maxBuffer: 8 * 1024 * 1024 });
    const body = (stdout || '').trim();
    if (!body || body.startsWith('<!') || body.startsWith('<html')) {
      throw new Error(`gmgn html/block: ${body.slice(0, 80)}`);
    }
    const d = JSON.parse(body);
    if (d && (d.code === 0 || d.data)) return d;
    throw new Error(`gmgn curl empty/err: ${body.slice(0, 120)}`);
  } catch (curlErr) {
    try {
      return await fetchJson(url, {
        ttlMs: 0,
        key: `gmgn-node-${Date.now()}`,
        headers: gmgnHeaders(),
        timeoutMs: 12000,
      });
    } catch (e) {
      throw new Error(curlErr.message || e.message);
    }
  }
}

function loadSeedLeaders() {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'data', 'gmgn-copy-seed.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ageH = (Date.now() - (raw.fetchedAt || 0)) / 3600e3;
    const rows = (raw.rows || []).filter((r) => r && r.address && !r.wash);
    return { rows, ageH, fetchedAt: raw.fetchedAt || 0 };
  } catch (_) {
    return { rows: [], ageH: Infinity, fetchedAt: 0 };
  }
}

/**
 * Fetch GMGN wallet leaderboard for one tag.
 * @param {{ period?: '1d'|'7d'|'30d', tag?: string, limit?: number }} opts
 */
async function fetchGmgnLeaders(opts = {}) {
  const period = opts.period || '7d';
  const tag = opts.tag || 'smart_degen';
  const limit = opts.limit || 40;
  const orderby = period === '1d' ? 'pnl_1d' : period === '30d' ? 'pnl_30d' : 'pnl_7d';
  const url = `${GMGN_BASE}/${period}?tag=${encodeURIComponent(tag)}&orderby=${orderby}&direction=desc`;
  const d = await fetchGmgnJson(url);
  const rank = (d && d.data && d.data.rank) || [];
  return rank.slice(0, limit).map((r, i) => {
    const pnlKey = period === '1d' ? 'pnl_1d' : period === '30d' ? 'pnl_30d' : 'pnl_7d';
    const wrKey = period === '1d' ? 'winrate_1d' : period === '30d' ? 'winrate_30d' : 'winrate_7d';
    const buyKey = period === '1d' ? 'buy_1d' : period === '30d' ? 'buy_30d' : 'buy_7d';
    const tags = Array.isArray(r.tags) ? r.tags : [tag];
    return {
      address: r.address,
      rank: i + 1,
      pnl: Number(r[pnlKey]) || 0,
      winrate: Number(r[wrKey] || r.winrate) || 0,
      buys: Number(r[buyKey] || r.buy) || 0,
      tags,
      name: r.name || r.nickname || '',
      source: 'gmgn',
      board: tag,
      wash: tags.includes('wash_trader'),
    };
  });
}

/** Fetch smart_degen + kol + smart_money boards and merge by address (best rank wins). */
async function fetchGmgnBoards(opts = {}) {
  const period = opts.period || '7d';
  const perTag = opts.perTag || 30;
  const tags = opts.tags || GMGN_TAGS;
  const byAddr = new Map();
  const tagsOk = {};
  for (const tag of tags) {
    try {
      const rows = await fetchGmgnLeaders({ period, tag, limit: perTag });
      tagsOk[tag] = rows.length;
      for (const L of rows) {
        if (!L.address || L.wash) continue; // skip wash_trader tagged
        const prev = byAddr.get(L.address);
        if (!prev || L.rank < prev.rank || (L.board === 'smart_degen' && prev.board !== 'smart_degen')) {
          byAddr.set(L.address, L);
        } else if (prev) {
          prev.boards = [...new Set([...(prev.boards || [prev.board]), L.board])];
          prev.tags = [...new Set([...(prev.tags || []), ...(L.tags || [])])];
        }
      }
      // polite gap between boards
      await new Promise((r) => setTimeout(r, 350));
    } catch (e) {
      tagsOk[tag] = 0;
      STATS.lastError = `${tag}: ${e.message}`;
    }
  }
  STATS.tagsOk = tagsOk;
  return [...byAddr.values()].sort((a, b) => a.rank - b.rank);
}

/**
 * Optional FomoRadar leaderboard (paid). Returns [] when no key.
 */
async function fetchFomoRadarLeaders(opts = {}) {
  const key = process.env.FOMORADAR_API_KEY || process.env.FOMO_API_KEY || '';
  if (!key) return [];
  const window = opts.window || '24h';
  const limit = opts.limit || 40;
  const url = `${FOMORADAR_BASE}/leaderboard/${window}?limit=${limit}`;
  const d = await fetchJson(url, {
    ttlMs: 10 * 60e3,
    key: `fomoradar-${window}`,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    timeoutMs: 15000,
  });
  const rows = (d && (d.traders || d.data || d.leaderboard || d)) || [];
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const wallets = t.wallets || t.addresses || [];
    const primary =
      (typeof wallets[0] === 'string' && wallets[0]) ||
      (wallets[0] && (wallets[0].address || wallets[0].wallet)) ||
      t.address ||
      t.wallet ||
      null;
    if (!primary) continue;
    out.push({
      address: primary,
      rank: t.rank || i + 1,
      pnl: Number(t.pnl || t.realized_pnl || 0) || 0,
      winrate: Number(t.winrate || 0) || 0,
      buys: Number(t.trades || t.buys || 0) || 0,
      handle: t.handle || t.username || t.name || '',
      source: 'fomoradar',
      board: 'fomo',
      wallets: wallets
        .map((w) => (typeof w === 'string' ? w : w && (w.address || w.wallet)))
        .filter(Boolean),
    });
  }
  return out;
}

function boostFor(leader) {
  let b = 3;
  if (leader.source === 'fomoradar') b += 2;
  if (leader.board === 'kol') b += 1;
  if (leader.board === 'smart_money' || leader.board === 'smart_degen') b += 1;
  if (leader.rank <= 10) b += 4;
  else if (leader.rank <= 25) b += 2;
  if (leader.pnl >= 0.5) b += 3;
  else if (leader.pnl >= 0.2) b += 2;
  else if (leader.pnl >= 0.05) b += 1;
  if (leader.winrate >= 0.55) b += 2;
  else if (leader.winrate >= 0.45) b += 1;
  if (leader.buys >= 50) b += 1;
  return clamp(b, 2, 14);
}

/** Rolling prune: demote / skip copy wallets with poor recent paper outcomes. */
function pruneCopyWallets(reg) {
  let pruned = 0;
  const now = Date.now();
  for (const w of reg.wallets || []) {
    if (!w.copy && !w.copySource) continue;
    const wins = w.wins || 0;
    const losses = w.losses || 0;
    const n = wins + losses;
    // Soft age: no refresh in 7d and no paper wins → demote
    const stale = w.copyAt && now - w.copyAt > 7 * 24 * 3600e3 && wins === 0;
    if (n >= 5 && wins / n < 0.28) {
      w.score = clamp((w.score || 50) - 10, 10, 99);
      w.skipEntry = (w.score || 0) < 40;
      pruned += 1;
    } else if (losses >= 5 && wins === 0) {
      w.score = clamp((w.score || 50) - 8, 10, 99);
      w.skipEntry = (w.score || 0) < 35;
      pruned += 1;
    } else if (stale) {
      w.score = clamp((w.score || 50) - 4, 10, 99);
      if ((w.score || 0) < 38) w.skipEntry = true;
      pruned += 1;
    }
    // clear skip if recovered
    if ((w.score || 0) >= 55 && n >= 3 && wins / Math.max(1, n) >= 0.45) {
      w.skipEntry = false;
    }
  }
  STATS.pruned = pruned;
  return pruned;
}

/**
 * Ingest GMGN smart-money + KOL boards (and Fomo when keyed) into registry.
 */
async function ingestCopyLeaders(state, opts = {}) {
  const t0 = Date.now();
  const reg = ensureRegistry(state);
  let leaders = [];
  const sources = [];
  try {
    const fomo = await fetchFomoRadarLeaders({ window: opts.window || '24h', limit: opts.limit || 40 });
    if (fomo.length) {
      leaders.push(...fomo);
      sources.push('fomoradar');
      STATS.fomoOk += 1;
    }
    const gmgn = await fetchGmgnBoards({
      period: opts.period || '7d',
      perTag: opts.perTag || 28,
      tags: opts.tags || GMGN_TAGS,
    });
    if (gmgn.length) {
      leaders.push(...gmgn);
      sources.push('gmgn');
      STATS.gmgnOk += 1;
    }
    if (!gmgn.length) {
      const seed = loadSeedLeaders();
      if (seed.rows.length) {
        leaders.push(...seed.rows);
        sources.push('gmgn-seed');
        STATS.lastError = (STATS.lastError ? STATS.lastError + '; ' : '') + `live gmgn empty → seed n=${seed.rows.length} ageH=${seed.ageH.toFixed(1)}`;
      } else {
        STATS.lastError = STATS.lastError || 'no leaders';
      }
    } else {
      STATS.lastError = leaders.length ? null : STATS.lastError || 'no leaders';
    }
  } catch (e) {
    STATS.lastError = e.message;
    try {
      const gmgn = await fetchGmgnLeaders({ period: '7d', tag: 'smart_degen', limit: 40 });
      leaders = gmgn.filter((L) => !L.wash);
      sources.push('gmgn');
      STATS.gmgnOk += 1;
      STATS.lastError = null;
    } catch (e2) {
      const seed = loadSeedLeaders();
      if (seed.rows.length) {
        leaders = seed.rows;
        sources.push('gmgn-seed');
        STATS.lastError = `${e2.message}; seed n=${seed.rows.length}`;
      } else {
        STATS.lastError = e2.message;
        leaders = [];
      }
    }
  }

  // Dedupe by address (keep best boost source)
  const best = new Map();
  for (const L of leaders) {
    if (!L.address) continue;
    const prev = best.get(L.address);
    if (!prev || boostFor(L) > boostFor(prev) || L.rank < prev.rank) best.set(L.address, L);
  }
  leaders = [...best.values()];

  let promoted = 0;
  for (const L of leaders) {
    const addrs = L.wallets && L.wallets.length ? L.wallets.slice(0, 3) : [L.address];
    for (const addr of addrs) {
      if (!addr || addr.length < 32) continue;
      const label =
        L.source === 'fomoradar'
          ? `fomo:${L.handle || L.rank}`
          : `gmgn:${L.board || 'top'}:${L.rank}`;
      promote(reg, addr, {
        label,
        boost: boostFor(L),
        note: `${L.source}/${L.board || ''} rank=${L.rank} pnl=${(L.pnl || 0).toFixed(3)} wr=${((L.winrate || 0) * 100).toFixed(0)}%`,
      });
      const w = (reg.wallets || []).find((x) => x.address === addr);
      if (w) {
        w.copySource = L.source;
        w.copyBoard = L.board || null;
        w.copyRank = L.rank;
        w.copyPnl = L.pnl;
        w.copyAt = Date.now();
        w.copy = true;
      }
      promoted += 1;
    }
  }

  pruneCopyWallets(reg);

  if ((reg.wallets || []).length > 160) {
    reg.wallets = rankWallets(reg).slice(0, 140);
  }

  STATS.lastRunAt = Date.now();
  STATS.source = sources.join('+') || null;
  STATS.promoted = promoted;
  STATS.fetched = leaders.length;
  STATS.latencyMs = Date.now() - t0;
  STATS.trackedCopy = (reg.wallets || []).filter((w) => w.copy && !w.skipEntry).length;

  return {
    ...STATS,
    top: leaders.slice(0, 10).map((L) => ({
      address: (L.address || '').slice(0, 8),
      rank: L.rank,
      source: L.source,
      board: L.board || null,
      pnl: L.pnl,
      winrate: L.winrate,
    })),
  };
}

function copyStats() {
  return { ...STATS };
}

/** Prefer copy-tagged wallets for PumpPortal account-trade subscribe. */
function topCopyAddresses(reg, n = 12) {
  const copy = rankWallets(reg).filter((w) => w.copy && !w.skipEntry).map((w) => w.address);
  const rest = rankWallets(reg)
    .filter((w) => !w.skipEntry && !copy.includes(w.address))
    .map((w) => w.address);
  return [...copy, ...rest].slice(0, n);
}

module.exports = {
  fetchGmgnLeaders,
  fetchGmgnBoards,
  fetchFomoRadarLeaders,
  ingestCopyLeaders,
  pruneCopyWallets,
  topCopyAddresses,
  copyStats,
  STATS,
  GMGN_TAGS,
};
