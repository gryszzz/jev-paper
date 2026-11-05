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
const ROW_ID = process.env.JEV_STATE_ID || 'paper-usd-100-v2';
const STATE_EPOCH = process.env.JEV_STATE_EPOCH || 'usd-100-v2';
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
    solReserve: 0,
    stateEpoch: state.stateEpoch || STATE_EPOCH,
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
          wallets: (state.smartMoney.wallets || []).slice(0, 80).map((w) => ({
            address: w.address,
            label: w.label,
            rank: w.rank,
            score: w.score,
            buys: w.buys || 0,
            sells: w.sells || 0,
            wins: w.wins || 0,
            losses: w.losses || 0,
            copy: !!w.copy,
            copySource: w.copySource || undefined,
            copyBoard: w.copyBoard || undefined,
            skipEntry: w.skipEntry || undefined,
            mined: !!w.mined,
            fwd7d: w.fwd7d,
            buys7d: w.buys7d,
            cold: w.cold || undefined,
            rugRisk: w.rugRisk || undefined,
            refreshAt: w.refreshAt || undefined,
          })),
          lastSignals: (state.smartMoney.lastSignals || []).slice(0, 12),
          updatedAt: state.smartMoney.updatedAt,
          walletRefresh: state.smartMoney.walletRefresh
            ? {
                lastRefreshAt: state.smartMoney.walletRefresh.lastRefreshAt,
                walletCount: state.smartMoney.walletRefresh.walletCount,
                added: state.smartMoney.walletRefresh.added,
                dropped: state.smartMoney.walletRefresh.dropped,
                lastAdds: (state.smartMoney.walletRefresh.lastAdds || []).slice(0, 8),
                lastDrops: (state.smartMoney.walletRefresh.lastDrops || []).slice(0, 8),
                scored: state.smartMoney.walletRefresh.scored,
                candidates: state.smartMoney.walletRefresh.candidates,
                helius: !!state.smartMoney.walletRefresh.helius,
              }
            : undefined,
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
        const remote = data.state;
        const start = Number(remote.startingBalance) || 100;
        const marks = (remote.positions || []).reduce((sum, x) => sum + (Number(x && x.markValue) || Number(x && x.amountUsd) || 0), 0);
        const eq = (Number(remote.cash) || 0) + marks;
        const epochOk = remote.stateEpoch === STATE_EPOCH;
        const poison = !epochOk || eq > start * 3 || (Number(remote.solReserve) || 0) > start || Math.abs(Number(remote.stats && remote.stats.realizedPnl) || 0) > start * 5;
        if (poison) {
          console.warn('[store] REJECT poisoned remote state', { id: ROW_ID, eq, cash: remote.cash, epoch: remote.stateEpoch, want: STATE_EPOCH });
          // fall through to disk / fresh — do not write poison onto disk
        } else {
          console.log('[store] loaded from supabase · bytes≈', JSON.stringify(remote).length);
          fileSave(remote);
          health.lastLoadAt = Date.now();
          health.lastLoadOk = true;
          return remote;
        }
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
  if (local && local.version) {
    const start = Number(local.startingBalance) || 100;
    const marks = (local.positions || []).reduce((sum, x) => sum + (Number(x && x.markValue) || Number(x && x.amountUsd) || 0), 0);
    const eq = (Number(local.cash) || 0) + marks;
    const epochOk = local.stateEpoch === STATE_EPOCH;
    if (!epochOk || eq > start * 3) {
      console.warn('[store] REJECT poisoned disk state → fresh', { eq, epoch: local.stateEpoch });
      health.lastLoadOk = false;
      return null;
    }
  }
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

async function purgePoisonedRemote(ids) {
  const sb = supabaseClient();
  if (!sb) return { ok: false, error: 'no-supabase' };
  const list = Array.isArray(ids) && ids.length ? ids : ['paper-slim-1', 'default', 'paper-v1'];
  const results = [];
  for (const id of list) {
    try {
      const tomb = {
        version: 2,
        stateEpoch: 'purged',
        cash: 100,
        startingBalance: 100,
        peakBalance: 100,
        solReserve: 0,
        positions: [],
        activity: [],
        tradeJournal: [],
        fillsLog: [],
        equityHistory: [{ t: Date.now(), equity: 100 }],
        stats: { realizedPnl: 0, feesPaidUsd: 0, wins: 0, losses: 0, trades: 0 },
        settings: { startingBalance: 100, running: false, profitSweepEnabled: false },
        updatedAt: Date.now(),
        purgedAt: Date.now(),
        purgeReason: 'phantom-wealth-reset',
      };
      await circuit.withRetry(async () => {
        const { error } = await sb.from('jev_paper_state').upsert({ id, state: tomb, updated_at: new Date().toISOString() });
        if (error) throw error;
      }, { retries: 1, baseMs: 200 });
      results.push({ id, ok: true });
      console.log('[store] purged remote', id);
    } catch (e) {
      results.push({ id, ok: false, error: e.message || String(e) });
      console.warn('[store] purge failed', id, e.message || e);
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = {
  loadState,
  purgePoisonedRemote,
  ROW_ID,
  STATE_EPOCH,
  saveState,
  fileLoad,
  fileSave,
  flushPending,
  slimStateForPersist,
  storeHealth,
};
