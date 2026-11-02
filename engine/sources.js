'use strict';

const { fetchJson } = require('./http');
const { feed } = require('./realtime');

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';

async function pumpNewTokens() {
  const urls = [
    'https://frontend-api.pump.fun/coins/latest?limit=30',
    'https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false',
  ];
  for (const url of urls) {
    try {
      const d = await fetchJson(url, { ttlMs: 12000, key: `pump-${url.slice(-24)}`, timeoutMs: 10000 });
      const arr = Array.isArray(d) ? d : d.coins || d.data || [];
      return arr
        .map((c) => ({
          mint: c.mint || c.address,
          symbol: c.symbol,
          name: c.name,
          icon: c.image_uri || c.imageUri || c.uri,
          marketCap: Number(c.usd_market_cap || c.market_cap || 0),
          createdAt: c.created_timestamp || c.createdAt,
          complete: !!(c.complete || c.raydium_pool),
          source: 'pump.fun',
        }))
        .filter((x) => x.mint);
    } catch (_) {}
  }
  return [];
}

async function pumpGraduating() {
  const urls = [
    'https://frontend-api.pump.fun/coins/for-you?limit=20',
    'https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=last_trade_timestamp&order=DESC',
  ];
  for (const url of urls) {
    try {
      const d = await fetchJson(url, { ttlMs: 15000, key: `pump-grad-${url.slice(-20)}` });
      const arr = Array.isArray(d) ? d : d.coins || [];
      return arr
        .filter((c) => c && (c.complete || Number(c.usd_market_cap || 0) > 40000))
        .map((c) => ({
          mint: c.mint,
          symbol: c.symbol,
          name: c.name,
          icon: c.image_uri,
          marketCap: Number(c.usd_market_cap || 0),
          graduating: true,
          source: 'pump.grad',
        }))
        .filter((x) => x.mint);
    } catch (_) {}
  }
  return [];
}

/** Merge PumpPortal realtime buffer with REST fallbacks. */
function realtimeLaunches() {
  return feed.drainLaunches({ max: 50 }).map((r) => ({
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    icon: r.icon,
    marketCap: r.marketCap,
    creator: r.creator,
    graduating: !!r.graduating,
    source: r.source,
    ts: r.ts,
  }));
}

function realtimeStats() {
  return feed.stats();
}

async function dexscreenerDiscover() {
  const mints = new Set();
  const icons = new Map();
  const meta = new Map();
  try {
    const boosts = await fetchJson(`${DS}/token-boosts/top/v1`, { ttlMs: 20000, key: 'ds-boosts' });
    for (const b of boosts || []) {
      if (b.chainId === 'solana' && b.tokenAddress) {
        mints.add(b.tokenAddress);
        if (b.icon) icons.set(b.tokenAddress, b.icon.startsWith('http') ? b.icon : `https://cdn.dexscreener.com/cms/images/${b.icon}`);
      }
    }
  } catch (_) {}
  try {
    const profiles = await fetchJson(`${DS}/token-profiles/latest/v1`, { ttlMs: 20000, key: 'ds-profiles' });
    for (const b of profiles || []) {
      if (b.chainId === 'solana' && b.tokenAddress) {
        mints.add(b.tokenAddress);
        if (b.icon) icons.set(b.tokenAddress, b.icon);
      }
    }
  } catch (_) {}
  for (const q of ['pump', 'solana memecoin', 'bonk']) {
    try {
      const d = await fetchJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`, {
        ttlMs: 25000,
        key: `ds-search-${q}`,
      });
      for (const p of d.pairs || []) {
        if (p.chainId !== 'solana') continue;
        const addr = p.baseToken && p.baseToken.address;
        if (!addr) continue;
        mints.add(addr);
        if (p.info && p.info.imageUrl) icons.set(addr, p.info.imageUrl);
        meta.set(addr, { socials: (p.info && p.info.socials) || [], websites: (p.info && p.info.websites) || [] });
      }
    } catch (_) {}
  }
  return { mints: [...mints], icons, meta };
}

async function geckoNewPools() {
  try {
    const d = await fetchJson(`${GT}/networks/solana/new_pools?page=1`, {
      ttlMs: 30000,
      key: 'gt-new',
    });
    const rows = (d.data || []).map((row) => {
      const a = row.attributes || {};
      return {
        mint: (a.base_token_address || a.address || '').split('_').pop(),
        symbol: a.name || a.pool_name,
        liquidity: Number(a.reserve_in_usd || 0),
        source: 'geckoterminal',
      };
    });
    return rows.filter((r) => r.mint && r.mint.length > 20);
  } catch (_) {
    return [];
  }
}

async function rugcheck(mint) {
  try {
    const d = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      ttlMs: 120000,
      key: `rug-${mint}`,
      timeoutMs: 8000,
    });
    const top = (d.topHolders || []).slice(0, 10);
    const topPct = top.reduce((s, h) => s + (Number(h.pct) || 0), 0);
    const risks = d.risks || [];
    const score = Number(d.score) || 0;
    const mintAuth = d.tokenMeta && d.tokenMeta.mintAuthority;
    const freezeAuth = d.tokenMeta && d.tokenMeta.freezeAuthority;
    const lpLocked = !!(d.markets || []).some((m) => m.lp && (m.lp.lpLockedPct || 0) > 80);
    const creator = d.creator || (d.topHolders && d.topHolders[0] && d.topHolders[0].owner) || null;
    return {
      ok: true,
      score,
      topHolderPct: topPct,
      topHoldersDetail: top.map((h) => ({
        owner: h.owner || h.address,
        pct: Number(h.pct) || 0,
        uiAmount: h.uiAmount,
      })),
      mintAuthority: mintAuth || null,
      freezeAuthority: freezeAuth || null,
      mintRenounced: !mintAuth,
      freezeRenounced: !freezeAuth,
      lpLocked,
      creator,
      risks: risks.map((r) => r.name || r).slice(0, 8),
      rugged: score < 1 || risks.some((r) => /rug|honeypot/i.test(String(r.name || r))),
    };
  } catch (_) {
    return { ok: false };
  }
}

async function socialVelocity(pair) {
  const buys = pair.buysH1 || 0;
  const sells = pair.sellsH1 || 1;
  const tx = buys + sells;
  const hasSocial = !!(pair.socials && pair.socials.length);
  const hasWeb = !!(pair.websites && pair.websites.length);
  let score = 0;
  if (tx > 80) score += 30;
  else if (tx > 30) score += 18;
  else if (tx > 10) score += 8;
  if (buys / sells >= 1.4) score += 20;
  if (hasSocial) score += 15;
  if (hasWeb) score += 10;
  if (pair.boosted) score += 15;
  return { score: Math.min(100, score), tx, hasSocial, hasWeb };
}

module.exports = {
  pumpNewTokens,
  pumpGraduating,
  realtimeLaunches,
  realtimeStats,
  dexscreenerDiscover,
  geckoNewPools,
  rugcheck,
  socialVelocity,
  DS,
};
