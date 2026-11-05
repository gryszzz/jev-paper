'use strict';

/**
 * Persistent traded-mints ledger — survives paper resets AND (via Supabase) redeploys.
 * Block re-entry for TRADE_BLOCK_MS after any buy/exit recorded here.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createCircuit } = require('./circuit');
const ledgerCircuit = createCircuit({ name: 'supabase-ledger', failureThreshold: 3, openMs: 20000, maxOpenMs: 120000, timeoutMs: 8000 });

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'traded-mints.json');
const ROW_ID = process.env.JEV_TRADED_LEDGER_ID || 'traded-ledger';
const TRADE_BLOCK_MS = 24 * 3600e3;
const STALE_SCORED_MS = 60 * 60e3; // on scored board > 60m → penalty
const MAX_ENTRIES = 2000;

let _cache = null; // { mints: { [mint]: { ts, symbol, lastBuy, lastExit, buys } }, scoredFirst: { [mint]: ts } }
let _dirty = false;
let _saveTimer = null;

function empty() {
  return { version: 1, mints: {}, scoredFirst: {}, updatedAt: Date.now() };
}

function resolveSupabaseKey() {
  const direct = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
  if (direct && direct.length >= 80) return direct;
  const a = process.env.JEV_SB_A || '';
  const b = process.env.JEV_SB_B || '';
  const joined = a + b;
  return joined.length >= 80 ? joined : direct;
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = resolveSupabaseKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function fileLoad() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LEDGER_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (raw && raw.mints) return raw;
    }
  } catch (e) {
    console.warn('[tradedLedger] file load', e.message);
  }
  return null;
}

function fileSave(ledger) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger));
  } catch (e) {
    console.warn('[tradedLedger] file save', e.message);
  }
}

async function load() {
  if (_cache) return _cache;
  const sb = supabaseClient();
  if (sb) {
    try {
      const data = await ledgerCircuit.withRetry(async () => {
        const { data, error } = await sb.from('jev_paper_state').select('state').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        return data;
      }, { retries: 1, baseMs: 300 });
      if (data && data.state && data.state.mints) {
        _cache = { ...empty(), ...data.state };
        fileSave(_cache);
        console.log('[tradedLedger] loaded from supabase', Object.keys(_cache.mints).length, 'mints');
        return _cache;
      }
    } catch (e) {
      console.warn('[tradedLedger] supabase load', e.message || e);
    }
  }
  _cache = fileLoad() || empty();
  return _cache;
}

function get() {
  return _cache || fileLoad() || empty();
}

function prune(ledger) {
  const cutoff = Date.now() - TRADE_BLOCK_MS * 2; // keep 48h
  const mints = ledger.mints || {};
  for (const m of Object.keys(mints)) {
    const e = mints[m];
    const last = Math.max(e.lastBuy || 0, e.lastExit || 0, e.ts || 0);
    if (last < cutoff) delete mints[m];
  }
  const keys = Object.keys(mints);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys
      .map((m) => [m, Math.max(mints[m].lastBuy || 0, mints[m].lastExit || 0, mints[m].ts || 0)])
      .sort((a, b) => a[1] - b[1]);
    for (const [m] of sorted.slice(0, keys.length - MAX_ENTRIES)) delete mints[m];
  }
  // prune scoredFirst older than 6h
  const sf = ledger.scoredFirst || {};
  const sfCut = Date.now() - 6 * 3600e3;
  for (const m of Object.keys(sf)) {
    if ((sf[m] || 0) < sfCut) delete sf[m];
  }
  ledger.updatedAt = Date.now();
  return ledger;
}

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flush(false);
  }, 800);
}

async function flush(immediate = false) {
  if (!_cache) return;
  prune(_cache);
  fileSave(_cache);
  const sb = supabaseClient();
  if (!sb) return;
  try {
    await ledgerCircuit.withRetry(async () => {
      const { error } = await sb.from('jev_paper_state').upsert({
        id: ROW_ID,
        state: _cache,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    }, { retries: immediate ? 2 : 1, baseMs: 400 });
    _dirty = false;
  } catch (e) {
    console.warn('[tradedLedger] supabase save', e.message || e);
  }
}

function recordBuy(mint, meta = {}) {
  if (!mint) return;
  const ledger = get();
  _cache = ledger;
  const prev = ledger.mints[mint] || {};
  ledger.mints[mint] = {
    ...prev,
    ts: prev.ts || Date.now(),
    lastBuy: Date.now(),
    symbol: meta.symbol || prev.symbol || '',
    buys: (prev.buys || 0) + 1,
    lane: meta.lane || prev.lane || null,
  };
  scheduleSave();
}

function recordExit(mint, meta = {}) {
  if (!mint) return;
  const ledger = get();
  _cache = ledger;
  const prev = ledger.mints[mint] || {};
  ledger.mints[mint] = {
    ...prev,
    ts: prev.ts || Date.now(),
    lastExit: Date.now(),
    symbol: meta.symbol || prev.symbol || '',
    lastReason: meta.reason || prev.lastReason || null,
  };
  scheduleSave();
}

/** True if mint was bought/exited within TRADE_BLOCK_MS (default 24h). */
function recentlyTraded(mint, blockMs = TRADE_BLOCK_MS) {
  if (!mint) return false;
  const e = get().mints[mint];
  if (!e) return false;
  const last = Math.max(e.lastBuy || 0, e.lastExit || 0, e.ts || 0);
  return Date.now() - last < blockMs;
}

function everTraded(mint) {
  if (!mint) return false;
  return !!(get().mints && get().mints[mint]);
}

function lastTradeTs(mint) {
  const e = get().mints[mint];
  if (!e) return 0;
  return Math.max(e.lastBuy || 0, e.lastExit || 0, e.ts || 0);
}

/** Mark when a mint first appeared on the scored board. */
function noteScored(mint) {
  if (!mint) return;
  const ledger = get();
  _cache = ledger;
  ledger.scoredFirst = ledger.scoredFirst || {};
  if (!ledger.scoredFirst[mint]) {
    ledger.scoredFirst[mint] = Date.now();
    scheduleSave();
  }
}

function scoredAgeMs(mint) {
  const ts = (get().scoredFirst || {})[mint];
  if (!ts) return 0;
  return Date.now() - ts;
}

function isStaleOnBoard(mint, maxMs = STALE_SCORED_MS) {
  return scoredAgeMs(mint) >= maxMs;
}

/** Seed in-memory seenMints / cooldown from ledger after reset. */
function hydrateStateGates(state, blockMs = TRADE_BLOCK_MS) {
  if (!state) return;
  const ledger = get();
  state.seenMints = Array.isArray(state.seenMints) ? state.seenMints : [];
  state.mintCooldown = state.mintCooldown || {};
  const now = Date.now();
  for (const [mint, e] of Object.entries(ledger.mints || {})) {
    const last = Math.max(e.lastBuy || 0, e.lastExit || 0, e.ts || 0);
    const remaining = blockMs - (now - last);
    if (remaining <= 0) continue;
    if (!state.seenMints.includes(mint)) state.seenMints.push(mint);
    // Force a cooldown that survives until the 24h ledger window ends
    const existing = state.mintCooldown[mint];
    const until = now + remaining;
    if (!existing || (existing.until || 0) < until) {
      state.mintCooldown[mint] = {
        until,
        reason: 'ledger-24h',
        stopLoss: false,
        symbol: e.symbol || '',
        allowReclaim: false,
        reentries: 0,
        fromLedger: true,
      };
    }
  }
  if (state.seenMints.length > 800) state.seenMints = state.seenMints.slice(-800);
}

function stats() {
  const ledger = get();
  const now = Date.now();
  let active24h = 0;
  for (const e of Object.values(ledger.mints || {})) {
    const last = Math.max(e.lastBuy || 0, e.lastExit || 0, e.ts || 0);
    if (now - last < TRADE_BLOCK_MS) active24h += 1;
  }
  return {
    total: Object.keys(ledger.mints || {}).length,
    active24h,
    scoredTracked: Object.keys(ledger.scoredFirst || {}).length,
    updatedAt: ledger.updatedAt || 0,
  };
}

module.exports = {
  load,
  flush,
  get,
  recordBuy,
  recordExit,
  recentlyTraded,
  everTraded,
  lastTradeTs,
  noteScored,
  scoredAgeMs,
  isStaleOnBoard,
  hydrateStateGates,
  stats,
  TRADE_BLOCK_MS,
  STALE_SCORED_MS,
};
