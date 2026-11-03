'use strict';

const { fetchJson } = require('./http');
const { feed } = require('./realtime');
const eyesHealth = require('./eyesHealth');

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';

const JUP_TOKENS = process.env.JUPITER_TOKENS_URL || 'https://lite-api.jup.ag/tokens/v2';
const RAY_LAUNCH = 'https://launch-mint-v1.raydium.io';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://pump.fun',
  Referer: 'https://pump.fun/',
};

function mapPumpCoin(c, source) {
  if (!c) return null;
  const mc = Number(c.usd_market_cap || c.market_cap || 0);
  const vSol = Number(c.virtual_sol_reserves || c.virtualSolReserves || 0);
  let bondingProgress = null;
  if (c.complete || c.raydium_pool) bondingProgress = 1;
  else if (vSol > 0) bondingProgress = Math.max(0, Math.min(1, vSol / 85));
  else if (mc > 0) bondingProgress = Math.max(0, Math.min(1, mc / 85000));
  const created = c.created_timestamp || c.createdAt;
  const createdMs = created ? (created < 1e12 ? Number(created) * 1000 : Number(created)) : null;
  const solUsd = Number(process.env.SOL_USD_HINT) || 180;
  const curveLiq = vSol > 0 ? vSol * solUsd * 2 : (mc > 0 ? Math.min(mc * 0.4, 25000) : 0);
  return {
    mint: c.mint || c.address,
    symbol: c.symbol,
    name: c.name,
    icon: c.image_uri || c.imageUri || c.uri,
    marketCap: mc,
    liquidity: curveLiq,
    priceUsd: Number(c.price_usd || c.usd_price || 0) || (mc > 0 ? mc / 1e9 : 0),
    createdAt: created,
    createdMs,
    complete: !!(c.complete || c.raydium_pool),
    raydiumPool: c.raydium_pool || c.raydiumPool || null,
    bondingProgress,
    kingOfHill: !!(c.king_of_the_hill_timestamp || c.kingOfTheHillTimestamp),
    hasSocials: !!(c.twitter || c.telegram || c.website),
    twitter: c.twitter || null,
    telegram: c.telegram || null,
    website: c.website || null,
    description: c.description || c.desc || '',
    creator: c.creator || c.deployer || null,
    fromPump: true,
    source,
  };
}

async function pumpKingOfHill() {
  const urls = [
    'https://frontend-api.pump.fun/coins/king-of-the-hill?includeNsfw=false',
    'https://frontend-api-v3.pump.fun/coins/king-of-the-hill?includeNsfw=false',
  ];
  for (const url of urls) {
    try {
      const d = await fetchJson(url, { ttlMs: 20000, key: 'pump-koth', timeoutMs: 10000, headers: BROWSER });
      const arr = Array.isArray(d) ? d : d ? [d] : [];
      const out = arr.map((c) => mapPumpCoin(c, 'pump.koth')).filter((x) => x && x.mint);
      eyesHealth.hit('pump_koth', out.length);
      return out;
    } catch (e) {
      eyesHealth.fail('pump_koth', e.message);
    }
  }
  return [];
}

async function pumpCurrentlyLive() {
  const urls = [
    'https://frontend-api.pump.fun/coins/currently-live?offset=0&limit=30&includeNsfw=false',
    'https://frontend-api-v3.pump.fun/coins/currently-live?offset=0&limit=30&includeNsfw=false',
  ];
  for (const url of urls) {
    try {
      const d = await fetchJson(url, { ttlMs: 20000, key: 'pump-live', timeoutMs: 10000, headers: BROWSER });
      const arr = Array.isArray(d) ? d : d.coins || d.data || [];
      const out = arr.map((c) => mapPumpCoin(c, 'pump.live')).filter((x) => x && x.mint);
      eyesHealth.hit('pump_live', out.length);
      return out;
    } catch (e) {
      eyesHealth.fail('pump_live', e.message);
    }
  }
  return [];
}

async function jupiterRecent() {
  const urls = [`${JUP_TOKENS}/recent`, 'https://api.jup.ag/tokens/v2/recent'];
  for (const url of urls) {
    try {
      const d = await fetchJson(url, { ttlMs: 25000, key: 'jup-recent', timeoutMs: 12000 });
      const arr = Array.isArray(d) ? d : [];
      const out = arr.map((t) => {
        const created = t.firstPool && t.firstPool.createdAt ? Date.parse(t.firstPool.createdAt) : (t.createdAt ? Date.parse(t.createdAt) : null);
        return {
          mint: t.id || t.address,
          symbol: t.symbol,
          name: t.name,
          icon: t.icon || null,
          marketCap: Number(t.mcap || t.fdv || 0) || 0,
          liquidity: Number(t.liquidity || 0) || 0,
          priceUsd: Number(t.usdPrice || 0) || 0,
          createdMs: Number.isFinite(created) ? created : null,
          creator: t.dev || null,
          launchpad: t.launchpad || null,
          organicScore: t.organicScore,
          holderCount: t.holderCount,
          fromPump: /pump/i.test(String(t.launchpad || '')),
          source: t.launchpad ? `jup.${String(t.launchpad).replace(/\s+/g, '').slice(0, 16)}` : 'jup.recent',
        };
      }).filter((x) => x.mint && x.mint.length > 20);
      eyesHealth.hit('jup_recent', out.length, { label: 'Jupiter tokens /recent', group: 'aggregator' });
      return out;
    } catch (e) {
      eyesHealth.fail('jup_recent', e.message);
    }
  }
  return [];
}

async function jupiterTopTrending(interval = '5m') {
  try {
    const d = await fetchJson(`${JUP_TOKENS}/toptrending/${interval}`, {
      ttlMs: 40000,
      key: `jup-trend-${interval}`,
      timeoutMs: 12000,
    });
    const arr = Array.isArray(d) ? d : [];
    const out = arr.slice(0, 40).map((t) => ({
      mint: t.id || t.address,
      symbol: t.symbol,
      name: t.name,
      icon: t.icon || null,
      marketCap: Number(t.mcap || t.fdv || 0) || 0,
      liquidity: Number(t.liquidity || 0) || 0,
      priceUsd: Number(t.usdPrice || 0) || 0,
      volume24h: Number(t.stats24h && t.stats24h.buyVolume) || 0,
      source: 'jup.trending',
    })).filter((x) => x.mint && x.mint.length > 20);
    eyesHealth.hit('jup_trend', out.length);
    return out;
  } catch (e) {
    eyesHealth.fail('jup_trend', e.message);
    return [];
  }
}

async function jupiterTopTraded(interval = '5m') {
  try {
    const d = await fetchJson(`${JUP_TOKENS}/toptraded/${interval}`, {
      ttlMs: 40000,
      key: `jup-traded-${interval}`,
      timeoutMs: 12000,
    });
    const arr = Array.isArray(d) ? d : [];
    const out = arr.slice(0, 40).map((t) => ({
      mint: t.id || t.address,
      symbol: t.symbol,
      name: t.name,
      icon: t.icon || null,
      marketCap: Number(t.mcap || t.fdv || 0) || 0,
      liquidity: Number(t.liquidity || 0) || 0,
      priceUsd: Number(t.usdPrice || 0) || 0,
      source: 'jup.traded',
    })).filter((x) => x.mint && x.mint.length > 20);
    eyesHealth.hit('jup_traded', out.length);
    return out;
  } catch (e) {
    eyesHealth.fail('jup_traded', e.message);
    return [];
  }
}

async function raydiumLaunchLab({ sort = 'new', size = 30 } = {}) {
  const id = sort === 'hotToken' ? 'ray_launchlab_hot' : 'ray_launchlab';
  try {
    const d = await fetchJson(`${RAY_LAUNCH}/get/list?sort=${encodeURIComponent(sort)}&size=${size}&page=1`, {
      ttlMs: 25000,
      key: `ray-ll-${sort}`,
      timeoutMs: 12000,
    });
    const rows = (d && d.data && d.data.rows) || (d && d.data) || [];
    const arr = Array.isArray(rows) ? rows : [];
    const out = arr.map((r) => {
      const createdMs = Number(r.createAt || r.createdAt || r.startTime || 0) || null;
      const finish = Number(r.finishingRate || 0);
      return {
        mint: r.mint,
        symbol: r.symbol,
        name: r.name,
        icon: r.imgUrl || r.image || null,
        marketCap: Number(r.marketCap || 0) || 0,
        liquidity: Number(r.volumeU || 0) || 0,
        bondingProgress: finish > 1 ? finish / 100 : finish,
        createdMs,
        creator: r.creator || null,
        twitter: r.twitter || null,
        website: r.website || null,
        description: r.description || '',
        platform: (r.platformInfo && (r.platformInfo.name || r.platformInfo.pubKey)) || 'launchlab',
        fromPump: false,
        source: sort === 'hotToken' ? 'ray.launchlab.hot' : 'ray.launchlab',
      };
    }).filter((x) => x.mint && x.mint.length > 20);
    eyesHealth.hit(id, out.length, {
      label: sort === 'hotToken' ? 'Raydium LaunchLab hot' : 'Raydium LaunchLab new',
      group: 'launchpad',
    });
    return out;
  } catch (e) {
    eyesHealth.fail(id, e.message);
    return [];
  }
}

async function orcaVolumePools() {
  try {
    const d = await fetchJson('https://api.orca.so/v2/solana/pools?limit=40&sortBy=volume&sortOrder=desc', {
      ttlMs: 45000,
      key: 'orca-vol',
      timeoutMs: 12000,
    });
    const arr = (d && d.data) || [];
    const out = [];
    for (const p of arr) {
      for (const mint of [p.tokenMintA, p.tokenMintB]) {
        if (!mint || mint === WSOL || mint === USDC) continue;
        if (mint.length < 20) continue;
        out.push({
          mint,
          symbol: null,
          liquidity: Number(p.tvlUsdc || p.liquidity || 0) || 0,
          source: 'orca.volume',
          pool: p.address,
        });
      }
    }
    // dedupe
    const seen = new Set();
    const uniq = [];
    for (const r of out) {
      if (seen.has(r.mint)) continue;
      seen.add(r.mint);
      uniq.push(r);
    }
    eyesHealth.hit('orca_pools', uniq.length);
    return uniq.slice(0, 40);
  } catch (e) {
    eyesHealth.fail('orca_pools', e.message);
    return [];
  }
}

/** Soft probes for known blocked sources (records health only). */
async function probeBlockedSources() {
  try {
    await fetchJson('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=5', {
      ttlMs: 120000,
      key: 'birdeye-probe',
      timeoutMs: 6000,
    });
    eyesHealth.hit('birdeye', 0);
  } catch (e) {
    eyesHealth.markBlocked('birdeye', e.message || '401 key required', { needsKey: true });
  }
  eyesHealth.markBlocked('solscan', 'no free useful new-token feed', { needsKey: true });
  eyesHealth.markBlocked('helius', 'optional free key not configured', { needsKey: true });
}


async function pumpNewTokens() {
  const urls = [
    'https://frontend-api.pump.fun/coins/latest?limit=30',
    'https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false',
  ];
  for (const url of urls) {
    try {
      const d = await fetchJson(url, { ttlMs: 12000, key: `pump-${url.slice(-24)}`, timeoutMs: 10000 });
      const arr = Array.isArray(d) ? d : d.coins || d.data || [];
      const mapped = arr
        .map((c) => {
          const mc = Number(c.usd_market_cap || c.market_cap || 0);
          const vSol = Number(c.virtual_sol_reserves || c.virtualSolReserves || 0);
          // ~85 SOL virtual ≈ graduation; fall back to mcap proxy
          let bondingProgress = null;
          if (c.complete || c.raydium_pool) bondingProgress = 1;
          else if (vSol > 0) bondingProgress = Math.max(0, Math.min(1, vSol / 85));
          else if (mc > 0) bondingProgress = Math.max(0, Math.min(1, mc / 85000));
          const created = c.created_timestamp || c.createdAt;
          const createdMs = created
            ? created < 1e12
              ? Number(created) * 1000
              : Number(created)
            : null;
          // Paper curve liq ≈ 2 * virtual SOL * ~$SOL (both sides of the curve)
          const solUsd = Number(process.env.SOL_USD_HINT) || 180;
          const curveLiq = vSol > 0 ? vSol * solUsd * 2 : (mc > 0 ? Math.min(mc * 0.4, 25000) : 0);
          return {
            mint: c.mint || c.address,
            symbol: c.symbol,
            name: c.name,
            icon: c.image_uri || c.imageUri || c.uri,
            marketCap: mc,
            liquidity: curveLiq,
            priceUsd: Number(c.price_usd || c.usd_price || 0) || (mc > 0 ? mc / 1e9 : 0),
            createdAt: created,
            createdMs,
            complete: !!(c.complete || c.raydium_pool),
            raydiumPool: c.raydium_pool || c.raydiumPool || null,
            bondingProgress,
            kingOfHill: !!(c.king_of_the_hill_timestamp || c.kingOfTheHillTimestamp),
            hasSocials: !!(c.twitter || c.telegram || c.website),
            twitter: c.twitter || null,
            telegram: c.telegram || null,
            website: c.website || null,
            description: c.description || c.desc || '',
            creator: c.creator || c.deployer || null,
            fromPump: true,
            source: 'pump.fun',
          };
        })
        .filter((x) => x.mint);
      if (mapped.length) {
        eyesHealth.hit('pump_rest', mapped.length);
        return mapped;
      }
    } catch (e) {
      eyesHealth.fail('pump_rest', e.message);
    }
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
      const d = await fetchJson(url, { ttlMs: 15000, key: `pump-grad-${url.slice(-20)}`, headers: BROWSER });
      const arr = Array.isArray(d) ? d : d.coins || [];
      const mappedGrad = arr
        .filter((c) => {
          if (!c) return false;
          const mc = Number(c.usd_market_cap || 0);
          const vSol = Number(c.virtual_sol_reserves || 0);
          const prog = c.complete ? 1 : vSol > 0 ? vSol / 85 : mc / 85000;
          return c.complete || prog >= 0.65 || mc > 40000;
        })
        .map((c) => mapPumpCoin(c, 'pump.grad'))
        .filter((x) => x && x.mint)
        .map((x) => ({ ...x, graduating: (x.bondingProgress || 0) >= 0.7 || !!x.complete }));
      if (mappedGrad.length) {
        eyesHealth.hit('pump_grad', mappedGrad.length);
        return mappedGrad;
      }
    } catch (e) {
      eyesHealth.fail('pump_grad', e.message);
    }
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
  let nBoost = 0, nProf = 0, nSearch = 0;
  try {
    const boosts = await fetchJson(`${DS}/token-boosts/top/v1`, { ttlMs: 20000, key: 'ds-boosts' });
    for (const b of boosts || []) {
      if (b.chainId === 'solana' && b.tokenAddress) {
        mints.add(b.tokenAddress);
        nBoost++;
        if (b.icon) icons.set(b.tokenAddress, b.icon.startsWith('http') ? b.icon : `https://cdn.dexscreener.com/cms/images/${b.icon}`);
      }
    }
    eyesHealth.hit('ds_boosts', nBoost);
  } catch (e) {
    eyesHealth.fail('ds_boosts', e.message);
  }
  try {
    const profiles = await fetchJson(`${DS}/token-profiles/latest/v1`, { ttlMs: 20000, key: 'ds-profiles' });
    for (const b of profiles || []) {
      if (b.chainId === 'solana' && b.tokenAddress) {
        mints.add(b.tokenAddress);
        nProf++;
        if (b.icon) icons.set(b.tokenAddress, b.icon);
      }
    }
    eyesHealth.hit('ds_profiles', nProf);
  } catch (e) {
    eyesHealth.fail('ds_profiles', e.message);
  }
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
        nSearch++;
        if (p.info && p.info.imageUrl) icons.set(addr, p.info.imageUrl);
        meta.set(addr, { socials: (p.info && p.info.socials) || [], websites: (p.info && p.info.websites) || [] });
      }
    } catch (e) {
      eyesHealth.fail('ds_search', e.message);
    }
  }
  if (nSearch) eyesHealth.hit('ds_search', nSearch);
  return { mints: [...mints], icons, meta };
}

async function geckoNewPools() {
  try {
    const d = await fetchJson(`${GT}/networks/solana/new_pools?page=1&include=base_token`, {
      ttlMs: 30000,
      key: 'gt-new',
    });
    const tokenMeta = new Map();
    for (const inc of d.included || []) {
      if (inc.type === 'token' && inc.attributes) {
        tokenMeta.set(inc.id, inc.attributes);
      }
    }
    const rows = (d.data || []).map((row) => {
      const a = row.attributes || {};
      const rel = row.relationships || {};
      const dexId = String((rel.dex && rel.dex.data && rel.dex.data.id) || a.dex_id || '').toLowerCase();
      const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
      const tm = (baseId && tokenMeta.get(baseId)) || {};
      let mint = (tm.address || (baseId || '').replace(/^solana_/, '') || '').trim();
      if (!mint || mint.length < 20) {
        mint = (a.base_token_address || '').split('_').pop() || '';
      }
      let source = 'gecko.new_pool';
      if (/pump/.test(dexId)) source = 'pumpswap';
      else if (/raydium|launchlab|bonk/.test(dexId)) source = 'raydium';
      else if (/meteora|dbc|damm/.test(dexId)) source = 'meteora';
      else if (/orca/.test(dexId)) source = 'orca';
      else if (/moonshot|moonit/.test(dexId)) source = 'moonshot';
      return {
        mint,
        symbol: tm.symbol || (a.name || '').split('/')[0].trim(),
        name: tm.name || a.name || a.pool_name,
        icon: tm.image_url || null,
        liquidity: Number(a.reserve_in_usd || 0),
        marketCap: Number(a.market_cap_usd || a.fdv_usd || 0) || 0,
        priceUsd: Number(a.base_token_price_usd || 0) || 0,
        createdAt: a.pool_created_at || null,
        dexId: dexId || null,
        source,
      };
    });
    const out = rows.filter((r) => r.mint && r.mint.length > 20);
    eyesHealth.hit('gecko_new', out.length, { label: 'GeckoTerminal new_pools', group: 'dex' });
    return out;
  } catch (e) {
    eyesHealth.fail('gecko_new', e.message);
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


async function geckoTrendingPools() {
  try {
    const d = await fetchJson(`${GT}/networks/solana/trending_pools?page=1&include=base_token`, {
      ttlMs: 45000,
      key: 'gt-trend',
    });
    const tokenMeta = new Map();
    for (const inc of d.included || []) {
      if (inc.type === 'token' && inc.attributes) tokenMeta.set(inc.id, inc.attributes);
    }
    const out = (d.data || [])
      .map((row) => {
        const a = row.attributes || {};
        const rel = row.relationships || {};
        const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
        const tm = (baseId && tokenMeta.get(baseId)) || {};
        const mint = (tm.address || (baseId || '').replace(/^solana_/, '') || (a.base_token_address || '').split('_').pop() || '').trim();
        return {
          mint,
          symbol: tm.symbol || a.name || a.pool_name,
          name: tm.name || a.name,
          icon: tm.image_url || null,
          liquidity: Number(a.reserve_in_usd || 0),
          volume24h: Number(a.volume_usd && a.volume_usd.h24) || Number(a.h24_volume_usd || 0),
          source: 'gecko-trending',
        };
      })
      .filter((r) => r.mint && r.mint.length > 20);
    eyesHealth.hit('gecko_trend', out.length);
    return out;
  } catch (e) {
    eyesHealth.fail('gecko_trend', e.message);
    return [];
  }
}

/** DexScreener community takeovers + boosted already covered; add token orders / search heat. */
async function dexscreenerTrending() {
  const out = [];
  try {
    const d = await fetchJson(`${DS}/token-boosts/latest/v1`, { ttlMs: 30000, key: 'ds-boost-latest' });
    for (const b of d || []) {
      if (b.chainId === 'solana' && b.tokenAddress) {
        out.push({ mint: b.tokenAddress, symbol: b.description || b.amount, source: 'ds-boost-latest', icon: b.icon });
      }
    }
  } catch (e) {
    eyesHealth.fail('ds_boosts', e.message);
  }
  try {
    // Free search heat for solana trending-ish queries
    for (const q of ['solana trending', 'pump.fun']) {
      const d = await fetchJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`, {
        ttlMs: 40000,
        key: `ds-trend-${q}`,
      });
      for (const p of (d.pairs || []).slice(0, 12)) {
        if (p.chainId !== 'solana') continue;
        const mint = p.baseToken && p.baseToken.address;
        if (!mint) continue;
        out.push({
          mint,
          symbol: p.baseToken.symbol,
          liquidity: Number(p.liquidity && p.liquidity.usd) || 0,
          volume24h: Number(p.volume && p.volume.h24) || 0,
          source: 'ds-search-heat',
          telegram: ((p.info && p.info.socials) || []).find((s) => /telegram/i.test(s.type || s.url || '')),
        });
      }
    }
  } catch (e) {
    eyesHealth.fail('ds_search', e.message);
  }
  if (out.length) eyesHealth.hit('ds_boosts', out.length);
  return out;
}

/** Free telegram/alpha proxy: extract telegram links from DexScreener socials on pairs. */
function telegramMentionsFromPairs(pairs = []) {
  const hits = [];
  for (const p of pairs) {
    const socials = p.socials || (p.info && p.info.socials) || [];
    for (const s of socials) {
      const url = String(s.url || s.link || '');
      if (/t\.me|telegram/i.test(url) || /telegram/i.test(String(s.type || ''))) {
        hits.push({
          mint: p.mint || (p.baseToken && p.baseToken.address),
          symbol: p.symbol || (p.baseToken && p.baseToken.symbol),
          telegram: url || s.type,
          source: 'dex-telegram',
        });
      }
    }
  }
  return hits;
}



module.exports = {
  pumpNewTokens,
  pumpGraduating,
  pumpKingOfHill,
  pumpCurrentlyLive,
  realtimeLaunches,
  realtimeStats,
  dexscreenerDiscover,
  dexscreenerTrending,
  geckoNewPools,
  geckoTrendingPools,
  jupiterRecent,
  jupiterTopTrending,
  jupiterTopTraded,
  raydiumLaunchLab,
  orcaVolumePools,
  probeBlockedSources,
  telegramMentionsFromPairs,
  rugcheck,
  socialVelocity,
  DS,
};
