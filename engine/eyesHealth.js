'use strict';

/**
 * Eyes health registry — per-source live/stale/down + events/min.
 * Sources call hit()/fail() after each poll; list() feeds Stats → Eyes.
 */

const STALE_MS = 90e3;
const DOWN_MS = 5 * 60e3;
const WINDOW_MS = 60e3;

/** @type {Map<string, any>} */
const REG = new Map();

function ensure(id, meta = {}) {
  let row = REG.get(id);
  if (!row) {
    row = {
      id,
      label: meta.label || id,
      group: meta.group || 'misc',
      free: meta.free !== false,
      needsKey: !!meta.needsKey,
      note: meta.note || '',
      ok: 0,
      fail: 0,
      events: 0, // rolling window count
      eventTs: [], // timestamps of event batches
      lastOkAt: 0,
      lastFailAt: 0,
      lastError: null,
      lastCount: 0,
      epm: 0,
      status: 'idle',
    };
    REG.set(id, row);
  } else if (meta.label) {
    row.label = meta.label;
    if (meta.group) row.group = meta.group;
    if (meta.note) row.note = meta.note;
    if (meta.needsKey != null) row.needsKey = meta.needsKey;
  }
  return row;
}

function prune(row, now = Date.now()) {
  const cut = now - WINDOW_MS;
  row.eventTs = (row.eventTs || []).filter((t) => t >= cut);
  row.events = row.eventTs.length;
  row.epm = row.eventTs.length; // approx events in last 60s (batch-level)
}

function hit(id, count = 1, meta = {}) {
  const row = ensure(id, meta);
  const now = Date.now();
  const n = Math.max(0, Number(count) || 0);
  row.ok += 1;
  row.lastOkAt = now;
  row.lastCount = n;
  row.lastError = null;
  for (let i = 0; i < Math.min(n, 200); i++) row.eventTs.push(now);
  prune(row, now);
  return row;
}

function fail(id, err, meta = {}) {
  const row = ensure(id, meta);
  const now = Date.now();
  row.fail += 1;
  row.lastFailAt = now;
  row.lastError = String(err || 'error').slice(0, 120);
  prune(row, now);
  return row;
}

function markBlocked(id, reason, meta = {}) {
  const row = ensure(id, { ...meta, needsKey: meta.needsKey != null ? meta.needsKey : true });
  row.status = 'blocked';
  row.lastError = String(reason || 'blocked').slice(0, 120);
  row.lastFailAt = Date.now();
  return row;
}

function computeStatus(row, now = Date.now()) {
  if (row.needsKey && !row.lastOkAt) return 'blocked';
  if (row.status === 'blocked' && !row.lastOkAt) return 'blocked';
  if (!row.lastOkAt && !row.lastFailAt) return 'idle';
  if (row.lastOkAt && now - row.lastOkAt <= STALE_MS) return 'live';
  if (row.lastOkAt && now - row.lastOkAt <= DOWN_MS) return 'stale';
  if (row.lastFailAt && (!row.lastOkAt || row.lastFailAt > row.lastOkAt)) return 'down';
  if (row.lastOkAt) return 'stale';
  return 'idle';
}

function list() {
  const now = Date.now();
  const out = [];
  for (const row of REG.values()) {
    prune(row, now);
    out.push({
      id: row.id,
      label: row.label,
      group: row.group,
      free: row.free,
      needsKey: row.needsKey,
      note: row.note,
      status: computeStatus(row, now),
      epm: row.epm,
      lastCount: row.lastCount,
      lastOkAt: row.lastOkAt || null,
      lastFailAt: row.lastFailAt || null,
      lastError: row.lastError,
      ok: row.ok,
      fail: row.fail,
      ageSec: row.lastOkAt ? Math.round((now - row.lastOkAt) / 1000) : null,
    });
  }
  out.sort((a, b) => {
    const order = { live: 0, stale: 1, idle: 2, down: 3, blocked: 4 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.label.localeCompare(b.label);
  });
  return out;
}

function summary() {
  const rows = list();
  const live = rows.filter((r) => r.status === 'live').length;
  const stale = rows.filter((r) => r.status === 'stale').length;
  const down = rows.filter((r) => r.status === 'down').length;
  const blocked = rows.filter((r) => r.status === 'blocked').length;
  const epm = rows.reduce((s, r) => s + (r.epm || 0), 0);
  return { sources: rows.length, live, stale, down, blocked, epm, rows };
}

/** Seed known catalog so Stats shows them even before first poll. */
function seedCatalog() {
  const cats = [
    { id: 'pumpportal_ws', label: 'PumpPortal WS (new/migrate)', group: 'realtime', note: 'free WS' },
    { id: 'wallet_watch', label: 'RPC walletWatch (copy)', group: 'realtime', note: 'public RPC WS+poll' },
    { id: 'pump_rest', label: 'pump.fun REST latest', group: 'launch', note: 'CF often blocks' },
    { id: 'pump_koth', label: 'pump.fun king-of-hill', group: 'launch' },
    { id: 'pump_live', label: 'pump.fun currently-live', group: 'launch' },
    { id: 'pump_grad', label: 'pump.fun graduating', group: 'launch' },
    { id: 'ds_profiles', label: 'DexScreener profiles', group: 'dex' },
    { id: 'ds_boosts', label: 'DexScreener boosts', group: 'dex' },
    { id: 'ds_search', label: 'DexScreener search heat', group: 'dex' },
    { id: 'gecko_new', label: 'GeckoTerminal new_pools', group: 'dex' },
    { id: 'gecko_trend', label: 'GeckoTerminal trending', group: 'dex' },
    { id: 'jup_recent', label: 'Jupiter tokens /recent', group: 'aggregator' },
    { id: 'jup_trend', label: 'Jupiter toptrending 5m', group: 'aggregator' },
    { id: 'jup_traded', label: 'Jupiter toptraded 5m', group: 'aggregator' },
    { id: 'ray_launchlab', label: 'Raydium LaunchLab new', group: 'launchpad' },
    { id: 'ray_launchlab_hot', label: 'Raydium LaunchLab hot', group: 'launchpad' },
    { id: 'orca_pools', label: 'Orca whirlpools volume', group: 'dex' },
    { id: 'viral', label: 'Viral (Reddit/Trends/YT)', group: 'social' },
    { id: 'xbuzz', label: 'X buzz / KOL', group: 'social' },
    { id: 'catalyst', label: 'Catalyst watchlist', group: 'social' },
    { id: 'gmgn', label: 'GMGN boards', group: 'smart', note: '403 from many egress' },
    { id: 'birdeye', label: 'Birdeye new listing', group: 'paid', needsKey: true, note: 'API key required' },
    { id: 'solscan', label: 'Solscan new tokens', group: 'paid', needsKey: true, note: 'no free useful feed' },
    { id: 'helius', label: 'Helius enhanced', group: 'paid', needsKey: true, note: 'optional free key' },
    { id: 'onchain_logs', label: 'On-chain program logs', group: 'realtime', note: 'via PumpPortal+Jup+Gecko coverage' },
  ];
  for (const c of cats) ensure(c.id, c);
  markBlocked('birdeye', 'API key required (401)', { label: 'Birdeye new listing', group: 'paid', needsKey: true });
  markBlocked('solscan', 'no free useful new-token feed', { label: 'Solscan new tokens', group: 'paid', needsKey: true });
}

seedCatalog();

module.exports = {
  hit,
  fail,
  markBlocked,
  ensure,
  list,
  summary,
  seedCatalog,
};
