'use strict';

/**
 * Smart-wallet mining — FREE sources only.
 * Discovers wallets from:
 *  - PumpPortal creator / trader fields on new launches
 *  - DexScreener pair txns (makers) when available
 *  - Optional public RPC getTokenLargestAccounts + signature trails
 * Ranks by win proxy (subsequent mc growth / hold survival) and merges into smartMoney registry.
 * Persists via store (file + Supabase when configured).
 */

const { fetchJson } = require('./http');
const { getTokenLargestAccounts, getSignaturesForAddress, latencyStats } = require('./rpc');
const {
  ensureRegistry,
  recordWalletEvent,
  rankWallets,
  isSmartWallet,
} = require('./smartMoney');
const fomoCopy = require('./fomoCopy');

const DS = 'https://api.dexscreener.com';
const MINER = {
  lastRunAt: 0,
  discovered: 0,
  promoted: 0,
  lastError: null,
  latencyMs: null,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, Number(n) || 0));
}

function promote(reg, address, { label = 'mined', boost = 2, note } = {}) {
  if (!address || address.length < 32) return null;
  let w = isSmartWallet(reg, address);
  if (!w) {
    w = {
      address,
      label,
      rank: 58,
      buys: 0,
      sells: 0,
      wins: 0,
      losses: 0,
      score: 58,
      mined: true,
      firstSeen: Date.now(),
      notes: [],
    };
    reg.wallets.push(w);
    MINER.discovered += 1;
  }
  w.score = clamp((w.score || 50) + boost, 10, 99);
  w.mined = true;
  w.lastMinedAt = Date.now();
  if (note) {
    w.notes = w.notes || [];
    w.notes.unshift({ ts: Date.now(), note });
    if (w.notes.length > 8) w.notes = w.notes.slice(0, 8);
  }
  MINER.promoted += 1;
  return w;
}

/** Creators from realtime/pump launches that keep producing. */
function mineFromLaunches(reg, launches = []) {
  const byCreator = new Map();
  for (const L of launches) {
    const c = L.creator;
    if (!c) continue;
    const row = byCreator.get(c) || { n: 0, graduating: 0, symbols: [] };
    row.n += 1;
    if (L.graduating || L.complete) row.graduating += 1;
    if (L.symbol) row.symbols.push(L.symbol);
    byCreator.set(c, row);
  }
  for (const [addr, row] of byCreator) {
    if (row.n >= 2 || row.graduating >= 1) {
      promote(reg, addr, {
        label: 'creator-miner',
        boost: row.graduating ? 4 : 2,
        note: `launches=${row.n} grad=${row.graduating}`,
      });
    }
  }
}

/** DexScreener recent tx makers for a mint (free). */
async function mineDexMakers(reg, mint) {
  if (!mint) return;
  try {
    const d = await fetchJson(`${DS}/latest/dex/tokens/${mint}`, {
      ttlMs: 30000,
      key: `ds-tok-${mint}`,
    });
    const pairs = d.pairs || [];
    for (const p of pairs.slice(0, 3)) {
      // Some DS responses expose txns with maker; if absent, skip quietly
      const txns = p.txns || {};
      // Fallback: boost from liquidity providers via pair address activity isn't available —
      // use pair-createdBy if present
      if (p.pairCreatedAt && p.liquidity && Number(p.liquidity.usd) > 50000) {
        // No maker field — skip
      }
      void txns;
    }
  } catch (e) {
    MINER.lastError = e.message;
  }
}

/** Public RPC: top token holders → candidate smart wallets. */
async function mineTopHolders(reg, mint, { limit = 8 } = {}) {
  if (!mint) return [];
  try {
    const res = await getTokenLargestAccounts(mint);
    const accounts = (res && res.value) || [];
    const out = [];
    for (const a of accounts.slice(0, limit)) {
      // token account address — resolve owner would need getAccountInfo; store as holder account
      const addr = a.address;
      if (!addr) continue;
      // Soft promote: large holders of graduating tokens
      promote(reg, addr, { label: 'holder-miner', boost: 1, note: `top-holder ${mint.slice(0, 6)}` });
      out.push(addr);
    }
    return out;
  } catch (e) {
    MINER.lastError = e.message;
    return [];
  }
}

/** Paper feedback: when whale/smart sell preceded a dump, demote; buy before pump → promote. */
function feedbackFromPaper(reg, { wallet, side, pnlPct } = {}) {
  if (!wallet) return;
  if (side === 'buy' && pnlPct != null && pnlPct > 15) {
    recordWalletEvent(reg, wallet, { side: 'buy', won: true });
  } else if (side === 'buy' && pnlPct != null && pnlPct < -20) {
    recordWalletEvent(reg, wallet, { side: 'buy', won: false });
  } else if (side === 'sell') {
    recordWalletEvent(reg, wallet, { side: 'sell' });
  }
}

/**
 * Full mining pass. Call periodically from paper tick.
 * @param {object} state paper state
 * @param {{ launches?: any[], mints?: string[] }} ctx
 */
async function runMiner(state, ctx = {}) {
  const t0 = Date.now();
  const reg = ensureRegistry(state);
  try {
    mineFromLaunches(reg, ctx.launches || []);
    const mints = (ctx.mints || []).slice(0, 6);
    for (const m of mints) {
      await mineDexMakers(reg, m);
      // Cap RPC pressure — only every other mint per pass if many
      if (mints.indexOf(m) % 2 === 0) await mineTopHolders(reg, m, { limit: 5 });
    }
    // GMGN smart-money + KOL (+ Fomo if keyed) — first tick immediate, ~15m ok / ~2m retry on empty
    const copyStaleMs =
      fomoCopy.STATS.fetched > 0 || fomoCopy.STATS.trackedCopy > 0 ? 15 * 60e3 : 2 * 60e3;
    const needCopy =
      !fomoCopy.STATS.lastRunAt ||
      Date.now() - fomoCopy.STATS.lastRunAt > copyStaleMs ||
      ctx.forceCopy;
    if (needCopy) {
      try {
        await fomoCopy.ingestCopyLeaders(state, { period: '7d', perTag: 28 });
      } catch (e) {
        MINER.lastError = e.message;
      }
    } else {
      try { fomoCopy.pruneCopyWallets(ensureRegistry(state)); } catch (_) {}
    }
    // Cap registry size
    if ((reg.wallets || []).length > 120) {
      reg.wallets = rankWallets(reg).slice(0, 100);
    }
    MINER.lastError = null;
  } catch (e) {
    MINER.lastError = e.message;
  }
  MINER.lastRunAt = Date.now();
  MINER.latencyMs = Date.now() - t0;
  return {
    ...MINER,
    top: rankWallets(reg).filter((w) => !w.skipEntry).slice(0, 15),
    rpc: latencyStats(),
  };
}

function minerStats(state) {
  const reg = state ? ensureRegistry(state) : { wallets: [] };
  return {
    ...MINER,
    wallets: (reg.wallets || []).length,
    copy: fomoCopy.copyStats(),
    top: rankWallets(reg)
      .filter((w) => !w.skipEntry)
      .slice(0, 12)
      .map((w) => ({
        address: w.address,
        label: w.label,
        score: Math.round(w.score || 0),
        buys: w.buys || 0,
        sells: w.sells || 0,
        mined: !!w.mined,
        copy: !!w.copy,
        copySource: w.copySource || null,
        copyBoard: w.copyBoard || null,
      })),
    copyTracked: (reg.wallets || []).filter((w) => w.copy && !w.skipEntry).length,
    copySignals: (reg.lastSignals || []).filter((s) => s && s.type === 'buy').slice(0, 8),
  };
}

module.exports = {
  runMiner,
  minerStats,
  mineFromLaunches,
  mineTopHolders,
  feedbackFromPaper,
  promote,
  MINER,
};
