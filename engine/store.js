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

const circuit = createCircuit({ name: 'supabase-state', failureThreshold: 3, openMs: 20000, maxOpenMs: 180000, timeoutMs: 8000 });

const health = {
  lastPersistOkAt: 0,          // disk OK counts (paper-authoritative)
  lastRemotePersistOkAt: 0,    // supabase OK
  lastPersistAttemptAt: 0,
  lastPersistBytes: 0,
  lastPersistError: null,
  lastLoadAt: 0,
  lastLoadOk: false,
  consecutiveFails: 0,         // remote fails
  diskFails: 0,
  circuitOpen: false,
  persistMode: 'disk+remote',
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
    const slim = state; // caller usually passes already-slim
    fs.writeFileSync(STATE_PATH, JSON.stringify(slim));
    health.lastPersistOkAt = Date.now();
    health.diskFails = 0;
    return true;
  } catch (e) {
    console.warn('[store] file save', e.message);
    health.diskFails += 1;
    health.lastPersistError = 'disk: ' + (e.message || e);
    return false;
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
    ? state.activity.filter((a) => a && a.type !== 'sweep').slice(0, 40)
    : [];
  const equityHistory = Array.isArray(state.equityHistory) ? state.equityHistory.slice(-60) : [];
  const tradeJournal = Array.isArray(state.tradeJournal) ? state.tradeJournal.slice(-80) : [];
  const seenMints = Array.isArray(state.seenMints) ? state.seenMints.slice(-150) : [];
  const notifications = Array.isArray(state.notifications) ? state.notifications.slice(0, 20) : [];

  // Positions: keep trading fields the engine actually uses (amountUsd/tokens/mark*).
  // Prior slim mapped qty/costUsd/mark which never exist on live positions — restart
  // then loaded hollow rows and broke marks / activity continuity.
  const positions = (state.positions || []).map((p) => {
    if (!p || typeof p !== 'object') return p;
    return {
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      name: p.name,
      icon: p.icon,
      entryPrice: p.entryPrice,
      amountUsd: p.amountUsd,
      remainingUsdBasis: p.remainingUsdBasis != null ? p.remainingUsdBasis : p.amountUsd,
      tokens: p.tokens,
      tokensInitial: p.tokensInitial,
      markPrice: p.markPrice,
      markValue: p.markValue,
      stopPrice: p.stopPrice,
      trailPct: p.trailPct,
      highSinceEntry: p.highSinceEntry,
      trailStop: p.trailStop,
      ladder: Array.isArray(p.ladder) ? p.ladder.slice(0, 8) : undefined,
      trailRemainder: p.trailRemainder,
      openedAt: p.openedAt,
      timeStopAt: p.timeStopAt,
      lane: p.lane,
      score: p.score,
      liquidity: p.liquidity,
      entryLiquidity: p.entryLiquidity,
      marketCap: p.marketCap,
      dexId: p.dexId,
      url: p.url,
      pairAddress: p.pairAddress,
      ageMs: p.ageMs,
      bondingProgress: p.bondingProgress,
      graduating: p.graduating,
      narratives: Array.isArray(p.narratives) ? p.narratives.slice(0, 8) : undefined,
      strategyId: p.strategyId,
      runnerScore: p.runnerScore,
      runnerBand: p.runnerBand,
      abArm: p.abArm,
      tradeMode: p.tradeMode,
      modeLetter: p.modeLetter,
      spikeExit: p.spikeExit,
      spikeSellPct: p.spikeSellPct,
      liquidityShockPct: p.liquidityShockPct,
      allowReentry: p.allowReentry,
      initialsAt2x: p.initialsAt2x,
      initialsTaken: p.initialsTaken,
      moonbagMinFrac: p.moonbagMinFrac,
      reentries: p.reentries,
      fillSource: p.fillSource,
      // keep short price history only
      priceHistory: Array.isArray(p.priceHistory) ? p.priceHistory.slice(-12) : undefined,
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
    version: state.version || 2,
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
    fillsLog: Array.isArray(state.fillsLog) ? state.fillsLog.slice(0, 40) : [],
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
      }, { retries: 1, baseMs: 300 });
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
      health.consecutiveFails += 1;
      health.circuitOpen = circuit.state().open;
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
let _remoteSyncTimer = null;
let _lastRemoteAttemptAt = 0;

function ensureRemoteSyncLoop() {
  if (_remoteSyncTimer) return;
  _remoteSyncTimer = setInterval(() => {
    try {
      const st = circuit.state();
      // Probe / flush when circuit half-open or closed, and we have pending or never synced remote
      if (st.open) return; // wait for half-open window (state() may flip to half-open)
      const needRemote = health.lastRemotePersistOkAt === 0 || health.consecutiveFails > 0 || !!st.halfOpen;
      if (!_pending && !needRemote) return;
      if (Date.now() - _lastRemoteAttemptAt < 5000) return;
      _lastRemoteAttemptAt = Date.now();
      if (_pending) flushPending().catch(() => {});
    } catch (_) {}
  }, 10000); // 10s while recovering — half-open probes must not wait 30s
  if (typeof _remoteSyncTimer.unref === 'function') _remoteSyncTimer.unref();
}

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

  health.lastRemotePersistOkAt = Date.now();
  // disk already stamped lastPersistOkAt in fileSave
  if (!health.lastPersistOkAt) health.lastPersistOkAt = health.lastRemotePersistOkAt;
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
    const cst = circuit.state();
    // While fully open, skip remote (disk already saved). Half-open/closed → probe with backoff.
    if (cst.open) {
      health.circuitOpen = true;
      health.lastPersistError = '[' + (cst.name || 'supabase-state') + '] circuit open';
      _pending = s;
      _pendingImmediate = wantImmediate || _pendingImmediate;
    } else {
      try {
        await _doUpsert(slim);
      } catch (e) {
        const msg = e.message || String(e);
        const isOpen = e.code === 'CIRCUIT_OPEN' || /circuit open/i.test(msg);
        if (!isOpen) health.consecutiveFails += 1;
        health.lastPersistError = msg;
        health.circuitOpen = circuit.state().open;
        console.warn('[store] supabase save', health.lastPersistError);
        // Keep pending so half-open / sync loop can push
        _pending = s;
        _pendingImmediate = wantImmediate || _pendingImmediate;
      }
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
  ensureRemoteSyncLoop();

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
  const remoteConfigured = !!supabaseClient();
  const remoteOk = remoteConfigured && !c.open && health.consecutiveFails < 5;
  return {
    ...health,
    circuitOpen: c.open,
    circuitHalfOpen: !!c.halfOpen,
    circuitFailures: c.failures,
    debounceMs: DEBOUNCE_MS,
    remoteConfigured,
    dbAvailable: remoteOk, // supabase specifically
    diskOk: health.diskFails < 3 && health.lastPersistOkAt > 0,
    persistMode: remoteOk ? 'disk+remote' : (remoteConfigured ? 'disk-degraded' : 'disk-only'),
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
