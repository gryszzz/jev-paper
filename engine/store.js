'use strict';

/**
 * Slim + resilient paper-state persistence.
 * - Keep full state in memory for calculations.
 * - Persist only essential fields to Supabase (no scored boards, heat maps, whale events…).
 * - Debounce routine saves ~45s; critical trade/position changes flush immediately.
 * - Circuit breaker + timeout + exponential backoff with jitter.
 * - Append-only local history for equity samples (retention capped).
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createCircuit } = require('./circuit');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const EQUITY_JSONL = path.join(HISTORY_DIR, 'equity.jsonl');
const ROW_ID = process.env.JEV_STATE_ID || 'default';
const DEBOUNCE_MS = Math.max(15000, Number(process.env.JEV_PERSIST_MS) || 45000);
const MAX_EQUITY_FILE_BYTES = 2 * 1024 * 1024;

const circuit = createCircuit({ name: 'supabase-state', failureThreshold: 3, openMs: 20000, maxOpenMs: 180000, timeoutMs: 10000 });

const health = {
  lastPersistOkAt: 0,
  lastPersistAttemptAt: 0,
  lastPersistBytes: 0,
  lastPersistError: null,
  lastLoadAt: 0,
  lastLoadOk: false,
  consecutiveFails: 0,
  circuitOpen: false,
};

function fileLoad() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[store] file load', e.message);
  }
  return null;
}

function fileSave(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (e) {
    console.warn('[store] file save', e.message);
  }
}

function supabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: (...args) => fetch(...args) },
  });
}

/** Strip heavy / ephemeral fields before remote upsert. */
function slimStateForPersist(state) {
  if (!state || typeof state !== 'object') return state;
  const activity = Array.isArray(state.activity)
    ? state.activity.filter((a) => a && a.type !== 'sweep').slice(0, 60)
    : [];
  const equityHistory = Array.isArray(state.equityHistory) ? state.equityHistory.slice(-240) : [];
  const tradeJournal = Array.isArray(state.tradeJournal) ? state.tradeJournal.slice(-250) : [];
  const seenMints = Array.isArray(state.seenMints) ? state.seenMints.slice(-400) : [];
  const notifications = Array.isArray(state.notifications) ? state.notifications.slice(0, 20) : [];

  // Positions: drop bulky nested quote blobs if present
  const positions = (state.positions || []).map((p) => {
    if (!p || typeof p !== 'object') return p;
    const {
      mint, symbol, name, entryPrice, mark, qty, costUsd, openedAt, lane, mode, arm,
      peak, trailActive, tpHits, stopPct, features, xBuzz, source, pairAgeSec,
      entryLiq, image, twitter, website, telegram, copyFrom, catalyst,
    } = p;
    return {
      mint, symbol, name, entryPrice, mark, qty, costUsd, openedAt, lane, mode, arm,
      peak, trailActive, tpHits, stopPct,
      features: features && typeof features === 'object'
        ? {
            score: features.score,
            runnerScore: features.runnerScore,
            liquidity: features.liquidity,
            volume: features.volume,
            buyers: features.buyers,
          }
        : undefined,
      xBuzz, source, pairAgeSec, entryLiq, image, twitter, website, telegram, copyFrom, catalyst,
    };
  });

  // Agents: keep status/lastAction only
  const agents = {};
  for (const [k, v] of Object.entries(state.agents || {})) {
    if (!v || typeof v !== 'object') continue;
    agents[k] = {
      status: v.status,
      lastAction: v.lastAction || null,
      flash: v.flash || null,
      latencyMs: v.latencyMs || null,
      lastLatencyMs: v.lastLatencyMs || null,
      sweptUsd: v.sweptUsd,
      guarding: v.guarding,
    };
  }

  // Learn: keep weights/status, drop candidate arrays (on disk separately)
  let learn = null;
  if (state.learn && typeof state.learn === 'object') {
    learn = {
      weightsVersion: state.learn.weightsVersion,
      promotedVersion: state.learn.promotedVersion,
      lastRefitAt: state.learn.lastRefitAt,
      lastPromoteAt: state.learn.lastPromoteAt,
      lastRejectAt: state.learn.lastRejectAt,
      lastError: state.learn.lastError,
      status: state.learn.status,
      labeled: state.learn.labeled,
      weights: state.learn.weights,
      // candidates stay in data/learn/*.jsonl — never ship 100s of full vectors to Supabase
    };
  }

  // mintCooldown: only active entries
  const now = Date.now();
  const mintCooldown = {};
  for (const [m, c] of Object.entries(state.mintCooldown || {})) {
    if (c && (c.until || 0) > now) mintCooldown[m] = c;
  }

  const mintBlacklist = {};
  for (const [m, c] of Object.entries(state.mintBlacklist || {})) {
    if (c && ((c.until || 0) > now || c.forever)) mintBlacklist[m] = c;
  }

  return {
    version: state.version || 1,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt || now,
    cash: state.cash,
    startingBalance: state.startingBalance,
    peakBalance: state.peakBalance,
    dayStartEquity: state.dayStartEquity,
    dayRealizedPnl: state.dayRealizedPnl,
    solReserve: state.solReserve || 0,
    lastSweepEquity: state.lastSweepEquity,
    killSwitch: !!state.killSwitch,
    cooldownUntil: state.cooldownUntil || 0,
    settings: state.settings,
    positions,
    activity,
    agents,
    banner: state.banner,
    stats: state.stats,
    tradeJournal,
    equityHistory,
    seenMints,
    mintCooldown,
    mintBlacklist,
    notifications,
    learn,
    signalWeights: state.signalWeights,
    smartMoney: state.smartMoney
      ? {
          wallets: (state.smartMoney.wallets || []).slice(0, 80),
          lastSignals: (state.smartMoney.lastSignals || []).slice(0, 20),
          updatedAt: state.smartMoney.updatedAt,
        }
      : undefined,
    // Explicitly omit: scored, scanned, whaleWatch, heatMap, full learn.candidates
  };
}

function appendEquityHistory(state) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const hist = Array.isArray(state.equityHistory) ? state.equityHistory : [];
    const last = hist[hist.length - 1];
    if (!last) return;
    const line = JSON.stringify({ t: last.t, e: last.equity }) + '\n';
    fs.appendFileSync(EQUITY_JSONL, line);
    const st = fs.statSync(EQUITY_JSONL);
    if (st.size > MAX_EQUITY_FILE_BYTES) {
      const raw = fs.readFileSync(EQUITY_JSONL, 'utf8').split('\n').filter(Boolean);
      const keep = raw.slice(-Math.floor(raw.length / 2));
      fs.writeFileSync(EQUITY_JSONL, keep.join('\n') + '\n');
    }
  } catch (e) {
    // non-fatal
  }
}

async function loadState() {
  const sb = supabaseClient();
  if (sb) {
    try {
      const data = await circuit.withRetry(async () => {
        const { data, error } = await sb.from('jev_paper_state').select('state').eq('id', ROW_ID).maybeSingle();
        if (error) throw error;
        return data;
      }, { retries: 2 });
      if (data && data.state && data.state.version) {
        console.log('[store] loaded from supabase · bytes≈', JSON.stringify(data.state).length);
        fileSave(data.state);
        health.lastLoadAt = Date.now();
        health.lastLoadOk = true;
        return data.state;
      }
    } catch (e) {
      console.warn('[store] supabase load', e.message || e);
      health.lastLoadAt = Date.now();
      health.lastLoadOk = false;
      health.lastPersistError = e.message || String(e);
    }
  }
  const local = fileLoad();
  health.lastLoadAt = Date.now();
  health.lastLoadOk = !!local;
  return local;
}

let _saveTimer = null;
let _pending = null;
let _pendingImmediate = false;
let _flushing = false;

async function _doUpsert(slim) {
  const sb = supabaseClient();
  if (!sb || !slim) return { ok: false, reason: 'no-client' };
  const bytes = Buffer.byteLength(JSON.stringify(slim));
  health.lastPersistAttemptAt = Date.now();
  health.lastPersistBytes = bytes;
  health.circuitOpen = circuit.state().open;

  await circuit.withRetry(async () => {
    const { error } = await sb.from('jev_paper_state').upsert({
      id: ROW_ID,
      state: slim,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }, { retries: 2, baseMs: 500 });

  health.lastPersistOkAt = Date.now();
  health.lastPersistError = null;
  health.consecutiveFails = 0;
  health.circuitOpen = false;
  if (bytes > 400000) {
    console.warn('[store] persist still large', bytes, 'bytes — check slimStateForPersist');
  } else {
    console.log('[store] persist ok', bytes, 'bytes');
  }
  return { ok: true, bytes };
}

async function flushPending() {
  if (_flushing) return;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (!_pending) return;
  _flushing = true;
  const s = _pending;
  const wantImmediate = _pendingImmediate;
  _pending = null;
  _pendingImmediate = false;
  try {
    const slim = slimStateForPersist(s);
    fileSave(slim); // disk mirror is also slim — keeps Render ephemeral disk small
    appendEquityHistory(s);
    try {
      await _doUpsert(slim);
    } catch (e) {
      health.consecutiveFails += 1;
      health.lastPersistError = e.message || String(e);
      health.circuitOpen = circuit.state().open;
      console.warn('[store] supabase save', health.lastPersistError);
      // Keep pending so next flush/retry can push
      _pending = s;
      _pendingImmediate = wantImmediate || _pendingImmediate;
    }
  } finally {
    _flushing = false;
  }
}

/**
 * @param {object} state full in-memory state
 * @param {{ immediate?: boolean }} opts immediate=true for trade/position changes
 */
function saveState(state, { immediate = false } = {}) {
  _pending = state;
  if (immediate) _pendingImmediate = true;

  // Always mirror a slim copy locally quickly (crash safety on same instance)
  try {
    fileSave(slimStateForPersist(state));
  } catch (_) {}

  if (immediate) {
    return flushPending();
  }
  if (_saveTimer) return Promise.resolve();
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushPending().catch(() => {});
  }, DEBOUNCE_MS);
  return Promise.resolve();
}

function storeHealth() {
  const c = circuit.state();
  return {
    ...health,
    circuitOpen: c.open,
    circuitFailures: c.failures,
    debounceMs: DEBOUNCE_MS,
    dbAvailable: !!supabaseClient() && !c.open && health.consecutiveFails < 5,
  };
}

module.exports = {
  loadState,
  saveState,
  fileLoad,
  fileSave,
  flushPending,
  slimStateForPersist,
  storeHealth,
};
