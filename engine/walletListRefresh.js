'use strict';

/**
 * Daily refresh of tracked whale / smart-wallet list.
 * Scores wallets over a rolling 7d window via free RPC (getSignaturesForAddress
 * + getTransaction) or Helius enhanced txs when HELIUS_API_KEY is set, using
 * DexScreener forward returns. Drops cold/rug wallets, mines early buyers of
 * JEV-observed 2x/1h runners + free GMGN/DexScreener top traders, caps ~80,
 * persists compactly on state.smartMoney.
 */

const { fetchJson } = require('./http');
const {
  getSignaturesForAddress,
  getTransaction,
  heliusEnhancedTransactions,
  HELIUS_API_KEY,
} = require('./rpc');
const {
  ensureRegistry,
  rankWallets,
  isSmartWallet,
} = require('./smartMoney');
const fomoCopy = require('./fomoCopy');
const DS = 'https://api.dexscreener.com';
const DAY_MS = 24 * 60 * 60e3;
const WEEK_MS = 7 * DAY_MS;
const REFRESH_EVERY_MS = DAY_MS;
const MAX_WALLETS = 80;
const SCORE_BATCH = 28; // wallets scored per daily pass (RPC budget)
const SIG_LIMIT = 30;
const MINT_PRICE_CACHE = new Map();

const REFRESH = {
  lastRefreshAt: 0,
  nextDueAt: 0,
  walletCount: 0,
  added: 0,
  dropped: 0,
  scored: 0,
  candidates: 0,
  lastError: null,
  lastAdds: [],
  lastDrops: [],
  helius: !!HELIUS_API_KEY,
  latencyMs: null,
  running: false,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function compactWallet(w) {
  if (!w || !w.address) return null;
  return {
    address: w.address,
    label: w.label || 'tracked',
    rank: Math.round(w.rank || w.score || 50),
    score: Math.round(clamp(w.score || 50, 10, 99) * 10) / 10,
    buys: w.buys || 0,
    sells: w.sells || 0,
    wins: w.wins || 0,
    losses: w.losses || 0,
    copy: !!w.copy,
    copySource: w.copySource || undefined,
    copyBoard: w.copyBoard || undefined,
    skipEntry: w.skipEntry || undefined,
    mined: !!w.mined,
    firstSeen: w.firstSeen || undefined,
    lastMinedAt: w.lastMinedAt || undefined,
    fwd7d: w.fwd7d != null ? Math.round(w.fwd7d * 100) / 100 : undefined,
    buys7d: w.buys7d || undefined,
    cold: w.cold || undefined,
    rugRisk: w.rugRisk || undefined,
    refreshAt: w.refreshAt || undefined,
  };
}

async function dexForwardReturn(mint) {
  if (!mint) return null;
  const hit = MINT_PRICE_CACHE.get(mint);
  if (hit && Date.now() - hit.ts < 10 * 60e3) return hit;
  try {
    const d = await fetchJson(`${DS}/latest/dex/tokens/${mint}`, {
      ttlMs: 60000,
      key: `ds-fwd-${mint}`,
      timeoutMs: 10000,
    });
    const pairs = (d && d.pairs) || [];
    const sol = pairs
      .filter((p) => (p.chainId || '').toLowerCase() === 'solana')
      .sort((a, b) => (Number(b.liquidity && b.liquidity.usd) || 0) - (Number(a.liquidity && a.liquidity.usd) || 0));
    const p = sol[0] || pairs[0];
    if (!p) {
      MINT_PRICE_CACHE.set(mint, { ts: Date.now(), h1: null, h6: null, h24: null });
      return MINT_PRICE_CACHE.get(mint);
    }
    const pc = p.priceChange || {};
    const row = {
      ts: Date.now(),
      h1: pc.h1 != null ? Number(pc.h1) : null,
      h6: pc.h6 != null ? Number(pc.h6) : null,
      h24: pc.h24 != null ? Number(pc.h24) : null,
      liq: Number(p.liquidity && p.liquidity.usd) || 0,
      ageMs: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null,
    };
    MINT_PRICE_CACHE.set(mint, row);
    if (MINT_PRICE_CACHE.size > 400) {
      const keys = [...MINT_PRICE_CACHE.keys()].slice(0, 150);
      for (const k of keys) MINT_PRICE_CACHE.delete(k);
    }
    return row;
  } catch (_) {
    return null;
  }
}

function buysFromHeliusEnhanced(txs, wallet) {
  const out = [];
  if (!Array.isArray(txs)) return out;
  const weekAgo = Date.now() - WEEK_MS;
  for (const tx of txs) {
    const ts = (tx.timestamp ? tx.timestamp * 1000 : tx.blockTime ? tx.blockTime * 1000 : 0) || 0;
    if (ts && ts < weekAgo) continue;
    const events = tx.events || {};
    const swap = events.swap || null;
    // tokenTransfers: positive amount to wallet = buy
    const transfers = tx.tokenTransfers || [];
    for (const t of transfers) {
      if (!t || t.toUserAccount !== wallet) continue;
      const mint = t.mint;
      if (!mint || mint === 'So11111111111111111111111111111111111111112') continue;
      out.push({ mint, ts: ts || Date.now(), source: 'helius' });
    }
    if (swap && swap.tokenOutputs) {
      for (const o of swap.tokenOutputs) {
        const mint = o.mint;
        if (!mint || mint === 'So11111111111111111111111111111111111111112') continue;
        out.push({ mint, ts: ts || Date.now(), source: 'helius-swap' });
      }
    }
  }
  // dedupe by mint+minute
  const seen = new Set();
  return out.filter((b) => {
    const k = `${b.mint}:${Math.floor((b.ts || 0) / 60000)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function buysFromRpc(wallet) {
  const out = [];
  const weekAgoSec = Math.floor((Date.now() - WEEK_MS) / 1000);
  // Lazy require avoids circular load with walletWatch.js
  const { parseTradeFromTx } = require('./walletWatch');
  let sigs;
  try {
    sigs = await getSignaturesForAddress(wallet, { limit: SIG_LIMIT });
  } catch (_) {
    return out;
  }
  for (const s of sigs || []) {
    if (!s || s.err || !s.signature) continue;
    if (s.blockTime && s.blockTime < weekAgoSec) continue;
    let tx;
    try {
      tx = await getTransaction(s.signature);
    } catch (_) {
      continue;
    }
    const parsed = parseTradeFromTx(tx, wallet);
    if (!parsed || parsed.txType !== 'buy' || !parsed.mint) continue;
    out.push({
      mint: parsed.mint,
      ts: (s.blockTime || 0) * 1000 || Date.now(),
      source: 'rpc',
    });
  }
  return out;
}

async function collectBuys7d(wallet) {
  if (HELIUS_API_KEY) {
    const enh = await heliusEnhancedTransactions(wallet, { limit: SIG_LIMIT, type: 'SWAP' });
    if (enh && enh.length) {
      const buys = buysFromHeliusEnhanced(enh, wallet);
      if (buys.length) return buys;
    }
  }
  return buysFromRpc(wallet);
}

async function scoreWallet(wallet) {
  const buys = await collectBuys7d(wallet);
  if (!buys.length) {
    return {
      address: wallet,
      buys7d: 0,
      fwd7d: 0,
      winRate: 0,
      scoreDelta: -8,
      cold: true,
      rugRisk: false,
    };
  }
  let wins = 0;
  let losses = 0;
  let sumFwd = 0;
  let nFwd = 0;
  let deepRugs = 0;
  const uniq = [...new Map(buys.map((b) => [b.mint, b])).values()].slice(0, 12);
  for (const b of uniq) {
    const fwd = await dexForwardReturn(b.mint);
    if (!fwd) continue;
    // Prefer shorter horizon as "forward" proxy from buy time; h1 then h6 then h24
    const ret =
      fwd.h1 != null ? fwd.h1 : fwd.h6 != null ? fwd.h6 : fwd.h24 != null ? fwd.h24 : null;
    if (ret == null || Number.isNaN(ret)) continue;
    sumFwd += ret;
    nFwd += 1;
    if (ret >= 15) wins += 1;
    else if (ret <= -40) {
      losses += 1;
      deepRugs += 1;
    } else if (ret < 0) losses += 1;
  }
  const avg = nFwd ? sumFwd / nFwd : 0;
  const winRate = wins + losses ? wins / (wins + losses) : 0;
  const cold = buys.length < 2 && nFwd < 1;
  const rugRisk = deepRugs >= 2 && winRate < 0.25;
  let scoreDelta = 0;
  scoreDelta += clamp(avg / 10, -12, 18);
  scoreDelta += (winRate - 0.45) * 20;
  scoreDelta += Math.min(6, buys.length * 0.4);
  if (cold) scoreDelta -= 10;
  if (rugRisk) scoreDelta -= 18;
  return {
    address: wallet,
    buys7d: buys.length,
    fwd7d: avg,
    winRate,
    scoreDelta,
    cold,
    rugRisk,
  };
}

/** Early buyers of a mint via first signatures (free RPC). */
async function earlyBuyersOfMint(mint, { limit = 12 } = {}) {
  if (!mint) return [];
  let sigs;
  try {
    sigs = await getSignaturesForAddress(mint, { limit: 40 });
  } catch (_) {
    return [];
  }
  // oldest first among recent window
  const ordered = [...(sigs || [])]
    .filter((s) => s && s.signature && !s.err)
    .sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0))
    .slice(0, 20);
  const buyers = [];
  const seen = new Set();
  for (const s of ordered) {
    if (buyers.length >= limit) break;
    let tx;
    try {
      tx = await getTransaction(s.signature);
    } catch (_) {
      continue;
    }
    if (!tx || !tx.meta || tx.meta.err) continue;
    const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
    const feePayer = keys[0];
    const payer = typeof feePayer === 'string' ? feePayer : feePayer && feePayer.pubkey;
    // Prefer owners who gained the mint
    const pre = tx.meta.preTokenBalances || [];
    const post = tx.meta.postTokenBalances || [];
    const preMap = new Map(pre.map((p) => [`${p.owner}:${p.mint}`, Number((p.uiTokenAmount && p.uiTokenAmount.amount) || 0)]));
    for (const p of post) {
      if (p.mint !== mint) continue;
      const owner = p.owner;
      if (!owner || owner.length < 32) continue;
      const before = preMap.get(`${owner}:${mint}`) || 0;
      const after = Number((p.uiTokenAmount && p.uiTokenAmount.amount) || 0);
      if (after > before && !seen.has(owner)) {
        seen.add(owner);
        buyers.push(owner);
      }
    }
    if (payer && payer.length >= 32 && !seen.has(payer)) {
      // weak signal — only if token delta missed
      if (!buyers.length) {
        seen.add(payer);
        buyers.push(payer);
      }
    }
  }
  return buyers;
}

/** Collect JEV-observed runner mints: 2x+ within ~1h. */
function collectRunnerMints(state) {
  const out = new Map();
  const journal = state.tradeJournal || [];
  for (const t of journal) {
    if (!t || !t.mint) continue;
    const pct = Number(t.pnlPct);
    const hold = Number(t.holdMs) || 0;
    if (pct >= 100 && hold > 0 && hold <= 60 * 60e3) {
      out.set(t.mint, { mint: t.mint, reason: 'journal-2x', pct });
    }
  }
  for (const p of [...(state.scanned || []), ...(state.scored || [])]) {
    if (!p || !p.mint) continue;
    const h1 = Number(p.priceChangeH1 != null ? p.priceChangeH1 : p.changeH1);
    const age = p.ageMs != null ? p.ageMs : null;
    if (h1 >= 100 && (age == null || age <= 3 * 60 * 60e3)) {
      out.set(p.mint, { mint: p.mint, reason: 'scan-2x-h1', pct: h1 });
    }
  }
  // DexScreener boosts already on pairs
  for (const p of state.positions || []) {
    if (!p || !p.mint) continue;
    if (Number(p.pnlPct) >= 100 && Number(p.heldMs || p.holdMs || 0) <= 60 * 60e3) {
      out.set(p.mint, { mint: p.mint, reason: 'open-2x', pct: p.pnlPct });
    }
  }
  return [...out.values()].slice(0, 10);
}

async function mineDexTopTraders(mint) {
  // DexScreener free token endpoint — no explicit top-trader list; use pair txns makers if present
  const addrs = [];
  try {
    const d = await fetchJson(`${DS}/token-boosts/top/v1`, {
      ttlMs: 120000,
      key: 'ds-boosts-top',
      timeoutMs: 10000,
    });
    // Some responses are arrays of boosted tokens — extract if any trader fields exist
    const rows = Array.isArray(d) ? d : [];
    for (const r of rows.slice(0, 20)) {
      if (r && r.tokenAddress && mint && r.tokenAddress === mint) {
        // no wallet — skip
      }
      void r;
    }
  } catch (_) {}
  try {
    const d = await fetchJson(`${DS}/orders/v1/solana/${mint}`, {
      ttlMs: 60000,
      key: `ds-orders-${mint}`,
      timeoutMs: 8000,
    });
    // paid-order style payload may include wallets; best-effort
    const rows = Array.isArray(d) ? d : [];
    for (const r of rows) {
      const a = r && (r.wallet || r.owner || r.maker);
      if (a && String(a).length >= 32) addrs.push(String(a));
    }
  } catch (_) {}
  return [...new Set(addrs)];
}

function promoteCandidate(reg, address, { label, boost, note, copy } = {}) {
  if (!address || address.length < 32) return null;
  let w = isSmartWallet(reg, address);
  const created = !w;
  if (!w) {
    w = {
      address,
      label: label || 'refresh',
      rank: 60,
      score: 60,
      buys: 0,
      sells: 0,
      wins: 0,
      losses: 0,
      mined: true,
      firstSeen: Date.now(),
    };
    reg.wallets.push(w);
  }
  w.score = clamp((w.score || 50) + (boost || 3), 10, 99);
  w.mined = true;
  w.lastMinedAt = Date.now();
  w.label = label || w.label;
  if (copy) w.copy = true;
  if (note) {
    w.notes = w.notes || [];
    w.notes.unshift({ ts: Date.now(), note: String(note).slice(0, 80) });
    if (w.notes.length > 4) w.notes = w.notes.slice(0, 4);
  }
  return { wallet: w, created };
}

/**
 * Run daily list refresh against state.smartMoney.
 * @returns {Promise<object>} REFRESH snapshot
 */
async function runDailyRefresh(state, { force = false } = {}) {
  if (!state) return { ...REFRESH, lastError: 'no-state' };
  if (REFRESH.running) return { ...REFRESH, lastError: 'already-running' };
  const due =
    force ||
    !REFRESH.lastRefreshAt ||
    Date.now() - REFRESH.lastRefreshAt >= REFRESH_EVERY_MS ||
    !(state.smartMoney && state.smartMoney.walletRefresh && state.smartMoney.walletRefresh.lastRefreshAt) ||
    Date.now() - (state.smartMoney.walletRefresh.lastRefreshAt || 0) >= REFRESH_EVERY_MS;
  if (!due) {
    REFRESH.nextDueAt = (REFRESH.lastRefreshAt || Date.now()) + REFRESH_EVERY_MS;
    return { ...REFRESH, skipped: true };
  }

  REFRESH.running = true;
  REFRESH.helius = !!HELIUS_API_KEY;
  const t0 = Date.now();
  const added = [];
  const dropped = [];
  try {
    const reg = ensureRegistry(state);
    // 1) Pull free GMGN / Fomo leaders (best-effort)
    try {
      await fomoCopy.ingestCopyLeaders(state, { period: '7d', perTag: 20 });
    } catch (e) {
      REFRESH.lastError = e.message;
    }

    // 2) Score existing tracked (non-skip) wallets
    const tracked = rankWallets(reg).filter((w) => !w.skipEntry);
    const toScore = tracked.slice(0, SCORE_BATCH);
    let scoredN = 0;
    for (const w of toScore) {
      try {
        const s = await scoreWallet(w.address);
        scoredN += 1;
        w.buys7d = s.buys7d;
        w.fwd7d = s.fwd7d;
        w.cold = !!s.cold;
        w.rugRisk = !!s.rugRisk;
        w.refreshAt = Date.now();
        w.score = clamp((w.score || 50) + s.scoreDelta, 10, 99);
        if (s.cold || s.rugRisk || (w.score || 0) < 28) {
          w._drop = true;
        }
      } catch (e) {
        REFRESH.lastError = e.message;
      }
    }
    REFRESH.scored = scoredN;

    // Drop cold / rug
    const keep = [];
    for (const w of reg.wallets || []) {
      if (w.skipEntry) {
        keep.push(w);
        continue;
      }
      if (w._drop) {
        dropped.push((w.address || '').slice(0, 8));
        continue;
      }
      delete w._drop;
      keep.push(w);
    }
    reg.wallets = keep;

    // 3) Candidates from JEV runners (2x in 1h) early buyers
    const runners = collectRunnerMints(state);
    let candN = 0;
    for (const r of runners) {
      const buyers = await earlyBuyersOfMint(r.mint, { limit: 8 });
      for (const addr of buyers.slice(0, 6)) {
        const res = promoteCandidate(reg, addr, {
          label: 'runner-early',
          boost: 5,
          note: `early ${r.reason} ${r.pct}%`,
          copy: true,
        });
        if (res && res.created) {
          added.push(addr.slice(0, 8));
          candN += 1;
        }
      }
      const dexTraders = await mineDexTopTraders(r.mint);
      for (const addr of dexTraders.slice(0, 4)) {
        const res = promoteCandidate(reg, addr, {
          label: 'ds-trader',
          boost: 3,
          note: 'dexscreener-order',
          copy: true,
        });
        if (res && res.created) {
          added.push(addr.slice(0, 8));
          candN += 1;
        }
      }
    }
    REFRESH.candidates = candN;

    // 4) Cap ~80 compact
    reg.wallets = rankWallets(reg)
      .map(compactWallet)
      .filter(Boolean)
      .slice(0, MAX_WALLETS);
    // re-attach skipEntry seeds that might have been compacted away
    reg.updatedAt = Date.now();
    reg.walletRefresh = {
      lastRefreshAt: Date.now(),
      walletCount: reg.wallets.length,
      added: added.length,
      dropped: dropped.length,
      lastAdds: added.slice(0, 12),
      lastDrops: dropped.slice(0, 12),
      scored: scoredN,
      candidates: candN,
      helius: !!HELIUS_API_KEY,
    };

    REFRESH.lastRefreshAt = Date.now();
    REFRESH.nextDueAt = REFRESH.lastRefreshAt + REFRESH_EVERY_MS;
    REFRESH.walletCount = reg.wallets.length;
    REFRESH.added = added.length;
    REFRESH.dropped = dropped.length;
    REFRESH.lastAdds = added.slice(0, 12);
    REFRESH.lastDrops = dropped.slice(0, 12);
    REFRESH.latencyMs = Date.now() - t0;
    if (!REFRESH.lastError) REFRESH.lastError = null;
  } catch (e) {
    REFRESH.lastError = e.message;
  } finally {
    REFRESH.running = false;
  }
  return { ...REFRESH };
}

function refreshStats(state) {
  const wr =
    (state && state.smartMoney && state.smartMoney.walletRefresh) || null;
  return {
    lastRefreshAt: wr ? wr.lastRefreshAt : REFRESH.lastRefreshAt || 0,
    nextDueAt: REFRESH.nextDueAt || (REFRESH.lastRefreshAt ? REFRESH.lastRefreshAt + REFRESH_EVERY_MS : 0),
    walletCount:
      wr && wr.walletCount != null
        ? wr.walletCount
        : state && state.smartMoney
          ? (state.smartMoney.wallets || []).length
          : REFRESH.walletCount,
    added: wr ? wr.added : REFRESH.added,
    dropped: wr ? wr.dropped : REFRESH.dropped,
    lastAdds: (wr && wr.lastAdds) || REFRESH.lastAdds || [],
    lastDrops: (wr && wr.lastDrops) || REFRESH.lastDrops || [],
    scored: wr ? wr.scored : REFRESH.scored,
    candidates: wr ? wr.candidates : REFRESH.candidates,
    lastError: REFRESH.lastError,
    helius: !!HELIUS_API_KEY,
    latencyMs: REFRESH.latencyMs,
    running: REFRESH.running,
    everyMs: REFRESH_EVERY_MS,
  };
}

function needsRefresh(state) {
  const last =
    (state && state.smartMoney && state.smartMoney.walletRefresh && state.smartMoney.walletRefresh.lastRefreshAt) ||
    REFRESH.lastRefreshAt ||
    0;
  return !last || Date.now() - last >= REFRESH_EVERY_MS;
}

module.exports = {
  runDailyRefresh,
  refreshStats,
  needsRefresh,
  scoreWallet,
  collectRunnerMints,
  earlyBuyersOfMint,
  compactWallet,
  MAX_WALLETS,
  REFRESH,
};
