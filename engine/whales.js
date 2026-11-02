'use strict';

const { rpcCall, getTokenLargestAccounts } = require('./rpc');

const SYSTEMISH = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'So11111111111111111111111111111111111111112',
]);

let _rpcCooldownUntil = 0;
let _last429Log = 0;

function isExcludedOwner(owner, meta = {}) {
  if (!owner) return true;
  if (SYSTEMISH.has(owner)) return true;
  if (meta.lpAccounts && meta.lpAccounts.has(owner)) return true;
  if (meta.burnAccounts && meta.burnAccounts.has(owner)) return true;
  return false;
}

function noteRateLimit(e) {
  if (/429|rate|exhausted|HTTP 429/i.test(String(e && e.message))) {
    _rpcCooldownUntil = Date.now() + 45000;
    if (Date.now() - _last429Log > 60000) {
      _last429Log = Date.now();
      console.warn('whale RPC rate-limited — cooling 45s');
    }
    return true;
  }
  return false;
}

async function getTopHolders(mint, { limit = 12, exclude = {} } = {}) {
  if (Date.now() < _rpcCooldownUntil) {
    const err = new Error('RPC cooldown');
    err.code = 'RPC_COOLDOWN';
    throw err;
  }
  let payload;
  try {
    payload = await getTokenLargestAccounts(mint);
  } catch (e) {
    noteRateLimit(e);
    throw e;
  }
  const accounts = ((payload && payload.value) || payload || []).slice(0, Math.max(limit + 4, 15));
  const holders = [];

  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const tokenAccount = a.address;
    let amount = Number(a.uiAmount) || Number(a.amount) / 10 ** (a.decimals || 6) || 0;
    let owner = null;
    try {
      const info = await rpcCall(
        'getAccountInfo',
        [tokenAccount, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        { ttlMs: 45000, key: `acc:${tokenAccount}` }
      );
      const val = info && info.value;
      const parsed = val && val.data && val.data.parsed;
      owner = (parsed && parsed.info && (parsed.info.owner || parsed.info.authority)) || null;
      if (parsed && parsed.info && parsed.info.tokenAmount) {
        amount = Number(parsed.info.tokenAmount.uiAmount) || amount;
      }
    } catch (e) {
      noteRateLimit(e);
    }

    if (isExcludedOwner(owner, exclude)) continue;
    holders.push({
      rank: holders.length + 1,
      tokenAccount,
      owner: owner || tokenAccount,
      amount,
      pct: null,
    });
    if (holders.length >= limit) break;
  }
  return holders;
}

async function getTokenSupply(mint) {
  if (Date.now() < _rpcCooldownUntil) return null;
  try {
    const result = await rpcCall('getTokenSupply', [mint], { ttlMs: 90000, key: `supply:${mint}` });
    const v = result && result.value;
    if (!v) return null;
    return Number(v.uiAmount) || Number(v.amount) / 10 ** (v.decimals || 6) || null;
  } catch (e) {
    noteRateLimit(e);
    return null;
  }
}

function detectSells(prevHolders, nextHolders, { dropPct = 15, supply } = {}) {
  const prevMap = new Map((prevHolders || []).map((h) => [h.owner, h]));
  const events = [];
  for (const h of nextHolders || []) {
    const prev = prevMap.get(h.owner);
    if (!prev || !(prev.amount > 0)) continue;
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
        soldPctOfPos: dropOfPosition,
        soldPctOfSupply: dropOfSupply,
        pctHeld: h.pct,
      });
    }
  }
  for (const [owner, prev] of prevMap) {
    if ((nextHolders || []).some((h) => h.owner === owner)) continue;
    if (prev.amount <= 0) continue;
    if ((prev.pct || 0) < 0.5 && prev.amount < 1) continue;
    events.push({
      owner,
      rank: prev.rank,
      prevAmount: prev.amount,
      amount: 0,
      soldAmount: prev.amount,
      soldPctOfPos: 100,
      soldPctOfSupply: supply > 0 ? (prev.amount / supply) * 100 : 0,
      pctHeld: 0,
      exitedTop: true,
    });
  }
  return events;
}

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

module.exports = {
  getTopHolders,
  getTokenSupply,
  detectSells,
  detectBuys,
  RPC: 'rotated',
};
