'use strict';

/**
 * Smart-money wallet registry.
 * Seed list of well-known Solana memecoin hunters + learned wallets from paper whale events.
 * Buys from ranked wallets → entry boost; sells → exit urgency.
 */

const SEED_WALLETS = [
  // Publicly discussed "smart money" / high-activity memecoin wallets (track-record ranked heuristically).
  // Rank is soft; paper feedback can promote/demote.
  { address: 'DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj', label: 'seed-alpha', rank: 80 },
  { address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', label: 'raydium-auth', rank: 40, skipEntry: true },
  { address: 'GThUX1Atko4tqhN2NaimLiTtedghy5hq6sCw4XVh7m8', label: 'seed-beta', rank: 72 },
  { address: '3xjn9yUkfVVbSxrF6xE7f5s5e5vqGqm1aG8V8kqH8Qw', label: 'seed-gamma', rank: 65 },
  { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', label: 'seed-delta', rank: 70 },
];

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function ensureRegistry(state) {
  if (!state.smartMoney) {
    state.smartMoney = {
      wallets: SEED_WALLETS.map((w) => ({
        ...w,
        buys: 0,
        sells: 0,
        wins: 0,
        losses: 0,
        score: w.rank || 50,
      })),
      lastSignals: [],
    };
  }
  return state.smartMoney;
}

function rankWallets(reg) {
  return [...(reg.wallets || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
}

function isSmartWallet(reg, address) {
  if (!address) return null;
  return (reg.wallets || []).find((w) => w.address === address) || null;
}

function recordWalletEvent(reg, address, { side, won } = {}) {
  if (!address) return;
  let w = isSmartWallet(reg, address);
  if (!w) {
    w = { address, label: 'learned', rank: 55, buys: 0, sells: 0, wins: 0, losses: 0, score: 55 };
    reg.wallets.push(w);
  }
  if (side === 'buy') w.buys = (w.buys || 0) + 1;
  if (side === 'sell') w.sells = (w.sells || 0) + 1;
  if (won === true) {
    w.wins = (w.wins || 0) + 1;
    w.score = clamp((w.score || 50) + 2, 10, 99);
  } else if (won === false) {
    w.losses = (w.losses || 0) + 1;
    w.score = clamp((w.score || 50) - 1.5, 10, 99);
  }
}

/**
 * Score how many top holders overlap smart-money set.
 */
function smartMoneyOverlap(reg, holders = []) {
  const map = new Map((reg.wallets || []).map((w) => [w.address, w]));
  let hits = 0;
  let best = 0;
  const matched = [];
  for (const h of holders) {
    const w = map.get(h.owner);
    if (!w || w.skipEntry) continue;
    hits += 1;
    best = Math.max(best, w.score || 0);
    matched.push({ owner: h.owner, label: w.label, score: w.score, pct: h.pct });
  }
  const pts = Math.min(18, hits * 6 + (best > 70 ? 4 : 0));
  return { hits, best, pts, matched };
}

function pushSignal(reg, signal) {
  reg.lastSignals = reg.lastSignals || [];
  reg.lastSignals.unshift({ ...signal, ts: Date.now() });
  if (reg.lastSignals.length > 30) reg.lastSignals = reg.lastSignals.slice(0, 30);
}

function topAddresses(reg, n = 20) {
  return rankWallets(reg)
    .filter((w) => !w.skipEntry)
    .slice(0, n)
    .map((w) => w.address);
}

module.exports = {
  SEED_WALLETS,
  ensureRegistry,
  rankWallets,
  isSmartWallet,
  recordWalletEvent,
  smartMoneyOverlap,
  pushSignal,
  topAddresses,
};
