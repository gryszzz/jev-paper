'use strict';

const { fetchJson } = require('./http');

const RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.HELIUS_RPC_URL ||
  'https://api.mainnet-beta.solana.com';

const SYSTEMISH = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'So11111111111111111111111111111111111111112',
]);

/** Heuristic exclude: known burn / LP-ish patterns */
function isExcludedOwner(owner, meta = {}) {
  if (!owner) return true;
  if (SYSTEMISH.has(owner)) return true;
  const o = owner.toLowerCase();
  if (meta.lpAccounts && meta.lpAccounts.has(owner)) return true;
  if (meta.burnAccounts && meta.burnAccounts.has(owner)) return true;
  // Raydium / pump / Meteora program accounts often show as token accounts — we filter by owner set from rugcheck when available
  return false;
}

async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const d = await fetchJson(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ttlMs: 0, // don't cache POSTs via key collision — use unique key
    key: `rpc-${method}-${JSON.stringify(params).slice(0, 80)}-${Date.now() % 8000}`,
    timeoutMs: 12000,
  }).catch(() => null);
  // fetchJson with POST — our http helper may only GET; fallback:
  if (d && d.result !== undefined) return d;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'JEV-Paper/1.0' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Top holders via getTokenLargestAccounts (token accounts, not wallets).
 * We resolve owners with getAccountInfo parsed when possible.
 */
async function getTopHolders(mint, { limit = 12, exclude = {} } = {}) {
  const raw = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  const value = (raw && raw.result && raw.result.value) || [];
  const accounts = value.slice(0, Math.max(limit + 4, 15));
  const holders = [];

  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const tokenAccount = a.address;
    let amount = Number(a.uiAmount) || Number(a.amount) / 10 ** (a.decimals || 6) || 0;
    let owner = null;
    try {
      const info = await rpc('getAccountInfo', [
        tokenAccount,
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      const parsed =
        info &&
        info.result &&
        info.result.value &&
        info.result.value.data &&
        info.result.value.data.parsed;
      owner =
        (parsed && parsed.info && (parsed.info.owner || parsed.info.authority)) || null;
      if (parsed && parsed.info && parsed.info.tokenAmount) {
        amount = Number(parsed.info.tokenAmount.uiAmount) || amount;
      }
    } catch (_) {}

    if (isExcludedOwner(owner, exclude)) continue;
    // Also skip if address itself looks like a pool vault without owner resolve
    holders.push({
      rank: holders.length + 1,
      tokenAccount,
      owner: owner || tokenAccount,
      amount,
      pct: null, // filled by caller with supply
    });
    if (holders.length >= limit) break;
  }
  return holders;
}

async function getTokenSupply(mint) {
  try {
    const raw = await rpc('getTokenSupply', [mint]);
    const v = raw && raw.result && raw.result.value;
    if (!v) return null;
    return Number(v.uiAmount) || Number(v.amount) / 10 ** (v.decimals || 6) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Diff snapshots: detect sells as balance drops > thresholdPct of prior balance
 * or of total supply (whichever caller prefers).
 */
function detectSells(prevHolders, nextHolders, { dropPct = 15, supply } = {}) {
  const prevMap = new Map((prevHolders || []).map((h) => [h.owner, h]));
  const events = [];
  for (const h of nextHolders || []) {
    const prev = prevMap.get(h.owner);
    if (!prev) continue;
    if (!(prev.amount > 0)) continue;
    const drop = prev.amount - h.amount;
    if (drop <= 0) continue;
    const dropOfPosition = (drop / prev.amount) * 100;
    const dropOfSupply = supply > 0 ? (drop / supply) * 100 : 0;
    if (dropOfPosition >= dropPct || dropOfSupply >= dropPct * 0.25) {
      events.push({
        owner: h.owner,
        rank: h.rank || prev.rank,
        prevAmount: prev.amount,
        amount: h.amount,
        soldAmount: drop,
        soldPctOfBag: dropOfPosition,
        soldPctOfSupply: dropOfSupply,
        pctHeld: h.pct,
      });
    }
  }
  // vanished from top list entirely with prior significant bag
  for (const [owner, prev] of prevMap) {
    if (nextHolders.some((h) => h.owner === owner)) continue;
    if (prev.amount <= 0) continue;
    if ((prev.pct || 0) < 0.5 && prev.amount < 1) continue;
    events.push({
      owner,
      rank: prev.rank,
      prevAmount: prev.amount,
      amount: 0,
      soldAmount: prev.amount,
      soldPctOfBag: 100,
      soldPctOfSupply: supply > 0 ? (prev.amount / supply) * 100 : 0,
      pctHeld: 0,
      exitedTop: true,
    });
  }
  return events;
}

module.exports = { getTopHolders, getTokenSupply, detectSells, RPC };

/**
 * Detect buys: new top holders or balance increases above threshold.
 */
function detectBuys(prevHolders, nextHolders, { risePct = 20, supply } = {}) {
  const prevMap = new Map((prevHolders || []).map((h) => [h.owner, h]));
  const events = [];
  for (const h of nextHolders || []) {
    const prev = prevMap.get(h.owner);
    if (!prev) {
      if ((h.pct || 0) >= 0.5 || (supply > 0 && h.amount / supply >= 0.005)) {
        events.push({
          owner: h.owner,
          rank: h.rank,
          prevAmount: 0,
          amount: h.amount,
          boughtAmount: h.amount,
          boughtPctOfSupply: supply > 0 ? (h.amount / supply) * 100 : 0,
          pctHeld: h.pct,
          newEntrant: true,
        });
      }
      continue;
    }
    if (!(prev.amount >= 0)) continue;
    const rise = h.amount - prev.amount;
    if (rise <= 0) continue;
    const riseOfPos = prev.amount > 0 ? (rise / prev.amount) * 100 : 100;
    if (riseOfPos >= risePct) {
      events.push({
        owner: h.owner,
        rank: h.rank,
        prevAmount: prev.amount,
        amount: h.amount,
        boughtAmount: rise,
        boughtPctOfPos: riseOfPos,
        pctHeld: h.pct,
      });
    }
  }
  return events;
}

module.exports.detectBuys = detectBuys;
