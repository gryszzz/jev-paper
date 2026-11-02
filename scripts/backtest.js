'use strict';

/**
 * Free-tier walk-forward backtest on recent pump.fun / DexScreener launches.
 * No paid APIs. Uses:
 *  - pump.fun frontend (latest coins)
 *  - DexScreener pair snapshots (priceChange windows as proxy candles)
 *  - Local PaperAdapter fill sim (Jito + MEV + fail)
 * Writes headlines into RESEARCH_LOG.md and prints JSON summary.
 */

const fs = require('fs');
const path = require('path');
const { fetchJson } = require('../engine/http');
const { runnerScore, runnerBandAction } = require('../engine/runnerScore');
const { dynamicSlippage, simulateMevHazard, simulateJitoFee } = require('../engine/adapters');
const { tagCoin } = require('../engine/narratives');

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'data', 'backtest', 'last-run.json');
const LOG = path.join(ROOT, 'RESEARCH_LOG.md');

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pairFromDs(p) {
  if (!p || p.chainId !== 'solana') return null;
  const mint = p.baseToken && p.baseToken.address;
  if (!mint) return null;
  return {
    mint,
    symbol: (p.baseToken && p.baseToken.symbol) || '???',
    name: (p.baseToken && p.baseToken.name) || 'Unknown',
    marketCap: Number(p.marketCap || p.fdv || 0),
    createdMs: p.pairCreatedAt || Date.now() - 3600e3,
    complete: true,
    bondingProgress: 1,
    graduating: /pump/i.test(String(p.dexId || '')),
    hasSocials: !!(p.info && ((p.info.socials && p.info.socials.length) || (p.info.websites && p.info.websites.length))),
    liquidity: Number(p.liquidity && p.liquidity.usd) || 0,
    volumeH24: Number(p.volume && p.volume.h24) || 0,
    volumeM5: Number(p.volume && p.volume.m5) || 0,
    buysM5: Number(p.txns && p.txns.m5 && p.txns.m5.buys) || 0,
    sellsM5: Number(p.txns && p.txns.m5 && p.txns.m5.sells) || 0,
    buysH1: Number(p.txns && p.txns.h1 && p.txns.h1.buys) || 0,
    sellsH1: Number(p.txns && p.txns.h1 && p.txns.h1.sells) || 0,
    priceChangeM5: Number(p.priceChange && p.priceChange.m5) || 0,
    priceChangeH1: Number(p.priceChange && p.priceChange.h1) || 0,
    priceChangeH6: Number(p.priceChange && p.priceChange.h6) || 0,
    priceChangeH24: Number(p.priceChange && p.priceChange.h24) || 0,
    priceUsd: Number(p.priceUsd) || 0,
    dexId: p.dexId,
    url: p.url,
    ageMs: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : 3600e3,
    source: 'dexscreener',
  };
}

async function fetchLaunchUniverse(limit = 40) {
  const byMint = new Map();
  const queries = ['pump', 'solana', 'bonk', 'meme'];
  for (const q of queries) {
    try {
      const d = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
        ttlMs: 0,
        key: `bt-search-${q}-${Date.now()}`,
        timeoutMs: 15000,
      });
      for (const p of d.pairs || []) {
        const row = pairFromDs(p);
        if (!row) continue;
        // Prefer young-ish, liquid-enough memes
        if (row.liquidity < 8000) continue;
        if (row.marketCap <= 0 || row.marketCap > 5e7) continue;
        const prev = byMint.get(row.mint);
        if (!prev || (row.volumeH24 || 0) > (prev.volumeH24 || 0)) byMint.set(row.mint, row);
      }
    } catch (e) {
      console.warn('[backtest] ds search', q, e.message);
    }
  }
  try {
    const boosts = await fetchJson('https://api.dexscreener.com/token-boosts/top/v1', {
      ttlMs: 0,
      key: `bt-boosts-${Date.now()}`,
    });
    for (const b of boosts || []) {
      if (b.chainId !== 'solana' || !b.tokenAddress) continue;
      if (byMint.has(b.tokenAddress)) continue;
      try {
        const pairs = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${b.tokenAddress}`, {
          ttlMs: 0,
          key: `bt-boost-${b.tokenAddress}`,
        });
        const p = (pairs.pairs || []).find((x) => x.chainId === 'solana');
        const row = pairFromDs(p);
        if (row) byMint.set(row.mint, row);
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[backtest] boosts', e.message);
  }
  // pump.fun optional (often 403 from datacenter IPs)
  for (const url of [
    'https://frontend-api.pump.fun/coins/latest?limit=30',
  ]) {
    try {
      const d = await fetchJson(url, { ttlMs: 0, key: `bt-pump-${Date.now()}`, timeoutMs: 10000 });
      const arr = Array.isArray(d) ? d : d.coins || [];
      for (const c of arr) {
        const mint = c.mint || c.address;
        if (!mint || byMint.has(mint)) continue;
        const mc = Number(c.usd_market_cap || 0);
        byMint.set(mint, {
          mint,
          symbol: c.symbol || '???',
          name: c.name || c.symbol,
          marketCap: mc,
          createdMs: (c.created_timestamp < 1e12 ? c.created_timestamp * 1000 : c.created_timestamp) || Date.now(),
          complete: !!c.complete,
          bondingProgress: c.complete ? 1 : Math.min(1, Number(c.virtual_sol_reserves || 0) / 85),
          hasSocials: !!(c.twitter || c.telegram),
          liquidity: Math.max(mc * 0.12, 10000),
          volumeH24: mc * 0.25,
          buysM5: 20,
          sellsM5: 10,
          priceChangeM5: 8,
          priceChangeH1: 15,
          priceUsd: mc > 0 ? mc / 1e9 : 1e-6,
          ageMs: 10 * 60e3,
          source: 'pump.fun',
        });
      }
    } catch (e) {
      console.warn('[backtest] pump', e.message);
    }
  }
  return [...byMint.values()]
    .sort((a, b) => (b.volumeH24 || 0) - (a.volumeH24 || 0))
    .slice(0, limit);
}

async function enrichFromDex(pair) {
  try {
    const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${pair.mint}`, {
      ttlMs: 60000,
      key: `bt-enr-${pair.mint}`,
    });
    const p = (d.pairs || []).find((x) => x.chainId === 'solana');
    if (!p) return pair;
    return {
      ...pair,
      liquidity: Number(p.liquidity && p.liquidity.usd) || pair.liquidity,
      marketCap: Number(p.marketCap || p.fdv || pair.marketCap),
      volumeH24: Number(p.volume && p.volume.h24) || pair.volumeH24,
      buysM5: Number(p.txns && p.txns.m5 && p.txns.m5.buys) || pair.buysM5,
      sellsM5: Number(p.txns && p.txns.m5 && p.txns.m5.sells) || pair.sellsM5,
      priceChangeM5: Number(p.priceChange && p.priceChange.m5) || 0,
      priceChangeH1: Number(p.priceChange && p.priceChange.h1) || 0,
      priceChangeH6: Number(p.priceChange && p.priceChange.h6) || 0,
      priceChangeH24: Number(p.priceChange && p.priceChange.h24) || 0,
      priceUsd: Number(p.priceUsd) || pair.priceUsd,
      ageMs: p.pairCreatedAt ? Date.now() - p.pairCreatedAt : Date.now() - pair.createdMs,
    };
  } catch (_) {
    return { ...pair, ageMs: Date.now() - pair.createdMs };
  }
}

/** Walk-forward proxy: use multi-horizon priceChange as future returns after entry. */
function simulateTrade(pair, { arm = 'CONTROL', sizeUsd = 10 } = {}) {
  const rs = runnerScore(pair, {});
  const band = runnerBandAction(rs.score);
  if (!band.ok || rs.score < 40) {
    return { skipped: true, reason: 'runner-gate', runnerScore: rs.score, band: rs.band };
  }

  const liq = pair.liquidity || 30000;
  const slip = dynamicSlippage({ liquidity: liq, amountUsd: sizeUsd, side: 'buy', lane: pair.bondingProgress < 1 ? 'FRESH' : 'GRAD' });
  const mev = simulateMevHazard({
    liquidity: liq,
    amountUsd: sizeUsd,
    side: 'buy',
    lane: pair.bondingProgress < 1 ? 'FRESH' : 'MOVER',
  });
  if (mev.failed) {
    return { skipped: true, reason: 'tx-fail-sim', runnerScore: rs.score, mev };
  }

  const entryPx = (pair.priceUsd || 1) * (1 + slip + mev.mevSlipExtra);
  const fee = simulateJitoFee({ urgency: 'high', liquidity: liq }) * 150;

  // Proxy forward returns from Dex windows (walk-forward: treat h1/h6/h24 as paths)
  // Conservative: entry "now", exit using clipped future move with mean-reversion haircut
  const paths = {
    m5: Number(pair.priceChangeM5) || 0,
    h1: Number(pair.priceChangeH1) || 0,
    h6: Number(pair.priceChangeH6) || Number(pair.priceChangeH1) * 1.2 || 0,
    h24: Number(pair.priceChangeH24) || Number(pair.priceChangeH1) * 1.5 || 0,
  };

  // Mode by arm / band
  let holdKey = 'h1';
  let tp = 0.35;
  let sl = -0.22;
  if (arm === 'T1' || rs.band === 'scalp') {
    holdKey = 'm5';
    tp = 0.18;
    sl = -0.12;
  } else if (arm === 'T3' || rs.band === 'moon' || rs.band === 'high') {
    holdKey = 'h6';
    tp = 0.8;
    sl = -0.28;
  } else if (arm === 'T2') {
    holdKey = 'h1';
    tp = 0.45;
    sl = -0.2;
  }

  let fwd = (paths[holdKey] || 0) / 100;
  // Haircut: historical windows already happened — treat as noisy label, shrink 40%
  fwd *= 0.6;
  // Apply TP/SL clipping
  let exitRet = fwd;
  let exitReason = 'time';
  if (fwd >= tp) {
    exitRet = tp;
    exitReason = 'tp';
  } else if (fwd <= sl) {
    exitRet = sl;
    exitReason = 'sl';
  }

  const sellSlip = dynamicSlippage({ liquidity: liq, amountUsd: sizeUsd * (1 + exitRet), side: 'sell' });
  const sellMev = simulateMevHazard({ liquidity: liq, amountUsd: sizeUsd, side: 'sell' });
  const netRet = exitRet - slip - sellSlip - sellMev.mevSlipExtra - fee / sizeUsd;
  const pnl = sizeUsd * netRet;

  return {
    skipped: false,
    symbol: pair.symbol,
    mint: pair.mint,
    runnerScore: rs.score,
    band: rs.band,
    arm,
    entryPx,
    fwdPct: round(fwd * 100, 2),
    netRetPct: round(netRet * 100, 2),
    pnl: round(pnl, 4),
    exitReason,
    sandwiched: !!(mev.sandwiched || sellMev.sandwiched),
    sizeUsd,
    narratives: tagCoin(pair),
  };
}

function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function summarize(trades) {
  const taken = trades.filter((t) => !t.skipped);
  const skipped = trades.filter((t) => t.skipped);
  const wins = taken.filter((t) => t.pnl > 0);
  const losses = taken.filter((t) => t.pnl <= 0);
  const pnl = taken.reduce((a, t) => a + t.pnl, 0);
  const byArm = {};
  for (const t of taken) {
    const a = t.arm || 'CONTROL';
    byArm[a] = byArm[a] || { n: 0, pnl: 0, wins: 0, losses: 0 };
    byArm[a].n += 1;
    byArm[a].pnl += t.pnl;
    if (t.pnl > 0) byArm[a].wins += 1;
    else byArm[a].losses += 1;
  }
  const byBand = {};
  for (const t of taken) {
    byBand[t.band] = byBand[t.band] || { n: 0, pnl: 0 };
    byBand[t.band].n += 1;
    byBand[t.band].pnl += t.pnl;
  }
  return {
    universe: trades.length,
    taken: taken.length,
    skipped: skipped.length,
    wins: wins.length,
    losses: losses.length,
    winRate: taken.length ? round((wins.length / taken.length) * 100, 1) : 0,
    pnl: round(pnl, 4),
    avgPnl: taken.length ? round(pnl / taken.length, 4) : 0,
    sandwiched: taken.filter((t) => t.sandwiched).length,
    byArm,
    byBand,
    skipReasons: skipped.reduce((m, t) => {
      m[t.reason] = (m[t.reason] || 0) + 1;
      return m;
    }, {}),
  };
}

function walkForwardFolds(pairs, folds = 3) {
  const sorted = [...pairs].sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
  const foldSize = Math.max(5, Math.floor(sorted.length / folds));
  const results = [];
  const arms = ['CONTROL', 'T1', 'T2', 'T3'];
  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const slice = sorted.slice(start, start + foldSize);
    if (!slice.length) continue;
    const trades = [];
    for (let i = 0; i < slice.length; i++) {
      const arm = arms[i % arms.length];
      trades.push(simulateTrade(slice[i], { arm, sizeUsd: 10 }));
    }
    results.push({ fold: f + 1, n: slice.length, summary: summarize(trades), trades });
  }
  return results;
}

function appendResearchLog(summary, folds) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const lines = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Backtest headlines (free-tier walk-forward)');
  lines.push('');
  lines.push(`**Run:** ${ts} America/New_York · sources: pump.fun + DexScreener (free) · fill sim: Jito+MEV+fail · no paid APIs`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Universe | ${summary.universe} |`);
  lines.push(`| Taken / skipped | ${summary.taken} / ${summary.skipped} |`);
  lines.push(`| Win rate | ${summary.winRate}% (${summary.wins}W/${summary.losses}L) |`);
  lines.push(`| Total PnL (paper $10 ea) | $${summary.pnl} |`);
  lines.push(`| Avg PnL / trade | $${summary.avgPnl} |`);
  lines.push(`| Sandwiched fills | ${summary.sandwiched} |`);
  lines.push('');
  lines.push('### By A/B arm');
  lines.push('');
  for (const [arm, r] of Object.entries(summary.byArm || {})) {
    lines.push(`- **${arm}**: n=${r.n} · pnl=$${round(r.pnl, 2)} · ${r.wins}W/${r.losses}L`);
  }
  lines.push('');
  lines.push('### Walk-forward folds');
  lines.push('');
  for (const f of folds) {
    const s = f.summary;
    lines.push(`- Fold ${f.fold} (n=${f.n}): taken=${s.taken} win=${s.winRate}% pnl=$${s.pnl}`);
  }
  lines.push('');
  lines.push('> Caveat: Dex `priceChange` windows are noisy labels (look-ahead haircut 40%). Treat as research ranking, not live expectancy.');
  lines.push('');

  let body = '';
  try {
    body = fs.readFileSync(LOG, 'utf8');
  } catch (_) {
    body = '# JEV Trencher Research Playbook\n';
  }
  // Replace prior backtest section if present
  const marker = '## Backtest headlines (free-tier walk-forward)';
  const idx = body.indexOf(marker);
  if (idx >= 0) {
    // find previous --- before marker or cut from prior ---
    const cut = body.lastIndexOf('\n---\n', idx);
    body = (cut >= 0 ? body.slice(0, cut) : body.slice(0, idx)).trimEnd();
  }
  fs.writeFileSync(LOG, body + '\n' + lines.join('\n'));
}

async function main() {
  console.log('[backtest] fetching free launch universe…');
  let universe = await fetchLaunchUniverse(36);
  console.log('[backtest] raw', universe.length);
  const enriched = [];
  for (const u of universe) {
    // DexScreener search rows already carry txns/priceChange — only enrich thin rows
    if (u.source === 'dexscreener' && (u.buysM5 || u.priceChangeH1 || u.volumeH24)) {
      enriched.push(u);
    } else {
      enriched.push(await enrichFromDex(u));
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  console.log('[backtest] enriched', enriched.length);

  const folds = walkForwardFolds(enriched, 3);
  const allTrades = folds.flatMap((f) => f.trades);
  const summary = summarize(allTrades);

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify({ at: new Date().toISOString(), summary, folds: folds.map((f) => ({ fold: f.fold, n: f.n, summary: f.summary })), sample: allTrades.filter((t) => !t.skipped).slice(0, 12) }, null, 2)
  );
  appendResearchLog(summary, folds);

  console.log('\n=== BACKTEST HEADLINES ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('wrote', OUT_JSON);
  console.log('updated RESEARCH_LOG.md');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
