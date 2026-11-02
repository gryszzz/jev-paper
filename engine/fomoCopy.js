'use strict';

/**
 * Top-trader / Fomo-style copy signal.
 *
 * Research (2026-11-02):
 *  - fomo.family has NO official public API.
 *  - FomoRadar (fomoradar.io) is a paid third-party JSON API for fomo.family
 *    leaderboards + verified wallets. Optional via FOMORADAR_API_KEY.
 *  - Free path: GMGN public wallet rank quotation endpoint
 *    (tag=smart_degen / etc). Unofficial, fragile — ToS: do not scrape
 *    fomo.family HTML; prefer documented APIs / public JSON only.
 *
 * Promotes ranked wallets into smartMoney via smartWalletMiner.promote,
 * with performance pruning left to runMiner's rank/cap + paper feedback.
 */

const { fetchJson } = require('./http');
const { ensureRegistry, rankWallets, isSmartWallet } = require('./smartMoney');

const GMGN_BASE = 'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets';
const FOMORADAR_BASE = 'https://fomoradar.io/v2';

const STATS = {
  lastRunAt: 0,
  lastError: null,
  source: null,
  promoted: 0,
  fetched: 0,
  gmgnOk: 0,
  fomoOk: 0,
  latencyMs: null,
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
    'User-Agent': 'Mozilla/5.0 (compatible; JEV-Paper/1.0)',
    Referer: 'https://gmgn.ai/',
  };
}

/**
 * Fetch GMGN smart_degen (or other tag) wallet leaderboard.
 * @param {{ period?: '1d'|'7d'|'30d', tag?: string, limit?: number }} opts
 */
async function fetchGmgnLeaders(opts = {}) {
  const period = opts.period || '7d';
  const tag = opts.tag || 'smart_degen';
  const limit = opts.limit || 40;
  const orderby = period === '1d' ? 'pnl_1d' : period === '30d' ? 'pnl_30d' : 'pnl_7d';
  const url = `${GMGN_BASE}/${period}?tag=${encodeURIComponent(tag)}&orderby=${orderby}&direction=desc`;
  const d = await fetchJson(url, {
    ttlMs: 10 * 60e3,
    key: `gmgn-wallets-${period}-${tag}`,
    headers: gmgnHeaders(),
    timeoutMs: 15000,
  });
  const rank = (d && d.data && d.data.rank) || [];
  return rank.slice(0, limit).map((r, i) => {
    const pnlKey = period === '1d' ? 'pnl_1d' : period === '30d' ? 'pnl_30d' : 'pnl_7d';
    const wrKey = period === '1d' ? 'winrate_1d' : period === '30d' ? 'winrate_30d' : 'winrate_7d';
    const buyKey = period === '1d' ? 'buy_1d' : period === '30d' ? 'buy_30d' : 'buy_7d';
    return {
      address: r.address,
      rank: i + 1,
      pnl: Number(r[pnlKey]) || 0,
      winrate: Number(r[wrKey] || r.winrate) || 0,
      buys: Number(r[buyKey] || r.buy) || 0,
      tags: r.tags || [tag],
      name: r.name || r.nickname || '',
      source: 'gmgn',
    };
  });
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
      wallets: wallets
        .map((w) => (typeof w === 'string' ? w : w && (w.address || w.wallet)))
        .filter(Boolean),
    });
  }
  return out;
}

/**
 * Score boost from leaderboard metrics (higher PnL / winrate → larger promote).
 */
function boostFor(leader) {
  let b = 3;
  if (leader.source === 'fomoradar') b += 2; // verified fomo board
  if (leader.rank <= 10) b += 4;
  else if (leader.rank <= 25) b += 2;
  if (leader.pnl >= 0.5) b += 3;
  else if (leader.pnl >= 0.2) b += 2;
  else if (leader.pnl >= 0.05) b += 1;
  if (leader.winrate >= 0.55) b += 2;
  else if (leader.winrate >= 0.45) b += 1;
  if (leader.buys >= 50) b += 1;
  return clamp(b, 2, 12);
}

/**
 * Ingest leaders into smartMoney registry. Prefer FomoRadar when keyed, else GMGN.
 */
async function ingestCopyLeaders(state, opts = {}) {
  const t0 = Date.now();
  const reg = ensureRegistry(state);
  let leaders = [];
  let source = null;
  try {
    const fomo = await fetchFomoRadarLeaders({ window: opts.window || '24h', limit: opts.limit || 40 });
    if (fomo.length) {
      leaders = fomo;
      source = 'fomoradar';
      STATS.fomoOk += 1;
    } else {
      const gmgn = await fetchGmgnLeaders({
        period: opts.period || '7d',
        tag: opts.tag || 'smart_degen',
        limit: opts.limit || 40,
      });
      leaders = gmgn;
      source = 'gmgn';
      STATS.gmgnOk += 1;
    }
    STATS.lastError = null;
  } catch (e) {
    STATS.lastError = e.message;
    // Fallback: try the other source once
    try {
      if (source !== 'gmgn') {
        leaders = await fetchGmgnLeaders({ period: '7d', tag: 'smart_degen', limit: 40 });
        source = 'gmgn';
        STATS.gmgnOk += 1;
        STATS.lastError = null;
      }
    } catch (e2) {
      STATS.lastError = e2.message;
      leaders = [];
    }
  }

  let promoted = 0;
  for (const L of leaders) {
    const addrs = L.wallets && L.wallets.length ? L.wallets.slice(0, 3) : [L.address];
    for (const addr of addrs) {
      if (!addr || addr.length < 32) continue;
      const label =
        L.source === 'fomoradar'
          ? `fomo:${L.handle || L.rank}`
          : `gmgn-top${L.rank}`;
      promote(reg, addr, {
        label,
        boost: boostFor(L),
        note: `${L.source} rank=${L.rank} pnl=${(L.pnl || 0).toFixed(3)} wr=${((L.winrate || 0) * 100).toFixed(0)}%`,
      });
      // Tag for copy-signal filtering
      const w = (reg.wallets || []).find((x) => x.address === addr);
      if (w) {
        w.copySource = L.source;
        w.copyRank = L.rank;
        w.copyPnl = L.pnl;
        w.copyAt = Date.now();
      }
      promoted += 1;
    }
  }

  // Soft prune: demote stale copy wallets that never win (paper feedback handles most)
  for (const w of reg.wallets || []) {
    if (!w.copySource) continue;
    if ((w.losses || 0) >= 5 && (w.wins || 0) === 0) {
      w.score = clamp((w.score || 50) - 8, 10, 99);
      w.skipEntry = (w.score || 0) < 35;
    }
  }

  if ((reg.wallets || []).length > 140) {
    reg.wallets = rankWallets(reg).slice(0, 120);
  }

  STATS.lastRunAt = Date.now();
  STATS.source = source;
  STATS.promoted = promoted;
  STATS.fetched = leaders.length;
  STATS.latencyMs = Date.now() - t0;
  return {
    ...STATS,
    top: leaders.slice(0, 8).map((L) => ({
      address: (L.address || '').slice(0, 8),
      rank: L.rank,
      source: L.source,
      pnl: L.pnl,
      winrate: L.winrate,
    })),
  };
}

function copyStats() {
  return { ...STATS };
}

module.exports = {
  fetchGmgnLeaders,
  fetchFomoRadarLeaders,
  ingestCopyLeaders,
  copyStats,
  STATS,
};
