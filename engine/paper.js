'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const DS = 'https://api.dexscreener.com';

const DEFAULTS = {
  startingBalance: 100,
  minLiquidity: 38000,
  buyPctMin: 0.2,
  buyPctMax: 0.25,
  maxPositions: 3,
  stopPct: -0.06,
  trailPct: 0.1,
  slippage: 0.02,
  minScore: 70,
  scanIntervalMs: 20000,
  priceIntervalMs: 8000,
};

function now() {
  return Date.now();
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'JEV-Paper/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function emptyState(settings = {}) {
  const starting = Number(settings.startingBalance) || DEFAULTS.startingBalance;
  const s = { ...DEFAULTS, ...settings, running: true };
  return {
    version: 1,
    cash: starting,
    startingBalance: starting,
    peakBalance: starting,
    createdAt: now(),
    updatedAt: now(),
    settings: {
      minLiquidity: s.minLiquidity,
      buyPctMin: s.buyPctMin,
      buyPctMax: s.buyPctMax,
      maxPositions: s.maxPositions,
      stopPct: s.stopPct,
      trailPct: s.trailPct,
      slippage: s.slippage,
      minScore: s.minScore,
      running: true,
    },
    equityHistory: [{ t: now(), equity: starting }],
    positions: [],
    activity: [],
    scanned: [],
    scored: [],
    seenMints: [],
    rejected: [],
    banner: { text: 'JEV paper mode · waiting for Scanner', icon: null, ts: now() },
    agents: {
      scanner: { status: 'idle', pools: 0, recent: [], lastRun: 0 },
      analyst: { status: 'idle', score: null, symbol: null, passed: 0, scored: 0, lastRun: 0 },
      executor: { status: 'idle', trades: 0, lastFill: null, progress: 0, lastRun: 0 },
      risk: { status: 'idle', guarding: null, lastAction: null, lastRun: 0 },
    },
    notifications: [],
  };
}

function loadState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (raw && raw.version === 1) return raw;
    }
  } catch (e) {
    console.error('state load failed', e.message);
  }
  const s = emptyState();
  saveState(s);
  return s;
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    state.updatedAt = now();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch (e) {
    console.error('state save failed', e.message);
  }
}

function equity(state) {
  const pos = state.positions.reduce((sum, p) => sum + (Number(p.markValue) || Number(p.amountUsd) || 0), 0);
  return round(state.cash + pos, 4);
}

function pushEquity(state) {
  const eq = equity(state);
  const hist = state.equityHistory;
  const last = hist[hist.length - 1];
  if (!last || last.equity !== eq || now() - last.t > 15000) {
    hist.push({ t: now(), equity: eq });
  }
  // keep ~24h at ~15s = ~5760; cap 2000
  if (hist.length > 2000) state.equityHistory = hist.slice(-2000);
  if (eq > state.peakBalance) {
    state.peakBalance = eq;
    state._newPeak = true;
  }
  return eq;
}

function addActivity(state, item) {
  state.activity.unshift({
    id: uid('act'),
    ts: now(),
    ...item,
  });
  if (state.activity.length > 200) state.activity = state.activity.slice(0, 200);
}

function setBanner(state, text, icon = null) {
  state.banner = { text, icon, ts: now() };
}

function pairFromTokenPayload(d, mint) {
  const pairs = (d && d.pairs) || [];
  let best = null;
  for (const p of pairs) {
    if (p.chainId !== 'solana') continue;
    const base = p.baseToken || {};
    if (mint && base.address && base.address.toLowerCase() !== mint.toLowerCase()) continue;
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    if (!best || liq > ((best.liquidity && best.liquidity.usd) || 0)) best = p;
  }
  return best;
}

const MAJORS = new Set([
  'so11111111111111111111111111111111111111112', // SOL/WSOL
  'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwjkxln', // USDC
  'es9vmfrsacqj9bbaozznpbrcbheeopwjxqgasknjdkkv', // USDT
  'ejoxxq2dbdyxegzq4asav0e2uetasb5kkaugbzcb4hcw', // USD1 sometimes
  '7vfaxlurfyiqwgzgepns34s1dsnr6wqbdv0nxc92d8qe', // ETH wormhole
  '3nz9jfvtm6prskk9k47gb1tnmhquqmeeinpyxjkertzm', // WBTC
  'mso1onzjnn9gdhvvhxaqr4udnsrgk45tarfhyztki6u', // mSOL
  'j1toso1umfqesnvnvzkwrhdyerfzeq64zhaxrvgv7eh', // jitoSOL
  'bso13r4tasmtoygvydejvmqd9qbjmjvwc7dh7cdgh', // bSOL
  'hz1jovsn2ljdy7x9hlektjqjfqyvs3zhyv4xs9p6pump', // placeholder skip
].map((s) => s.toLowerCase()));

const MAJOR_SYMBOLS = new Set([
  'SOL', 'WSOL', 'USDC', 'USDT', 'USD1', 'ETH', 'WETH', 'BTC', 'WBTC', 'MSOL', 'JITOSOL', 'BSOL', 'STSOL', 'BONK', 'WIF', 'JUP', 'RAY', 'ORCA', 'PYTH', 'JTO', 'HNT', 'RENDER', 'RNDR'
]);

function isMajor(pair) {
  if (!pair) return true;
  const mint = (pair.mint || '').toLowerCase();
  if (MAJORS.has(mint)) return true;
  const sym = (pair.symbol || '').toUpperCase();
  if (MAJOR_SYMBOLS.has(sym)) return true;
  // huge caps are not "memecoin trencher" targets
  if (pair.marketCap && pair.marketCap > 50_000_000) return true;
  return false;
}

function normalizePair(p) {
  if (!p) return null;
  const base = p.baseToken || {};
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  const vol = p.volume || {};
  const tx = p.txns || {};
  const h1 = tx.h1 || {};
  const h24 = tx.h24 || {};
  const info = p.info || {};
  const ageMs = p.pairCreatedAt ? now() - p.pairCreatedAt : null;
  return {
    mint: base.address,
    symbol: (base.symbol || '???').slice(0, 12),
    name: base.name || base.symbol || 'Unknown',
    icon: info.imageUrl || null,
    priceUsd: Number(p.priceUsd) || 0,
    liquidity: liq,
    volumeH1: Number(vol.h1) || 0,
    volumeH24: Number(vol.h24) || 0,
    buysH1: Number(h1.buys) || 0,
    sellsH1: Number(h1.sells) || 0,
    buysH24: Number(h24.buys) || 0,
    sellsH24: Number(h24.sells) || 0,
    fdv: Number(p.fdv) || Number(p.marketCap) || 0,
    marketCap: Number(p.marketCap) || Number(p.fdv) || 0,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    pairCreatedAt: p.pairCreatedAt || null,
    ageMs,
    priceChangeH1: (p.priceChange && p.priceChange.h1) || 0,
    priceChangeH24: (p.priceChange && p.priceChange.h24) || 0,
  };
}

function scorePair(pair, settings) {
  // 0-100 heuristic: liquidity, volume, buy pressure, age, size
  let score = 0;
  const reasons = [];

  const liq = pair.liquidity;
  if (liq >= settings.minLiquidity) {
    const liqScore = clamp((Math.log10(liq) - Math.log10(settings.minLiquidity)) / 2, 0, 1) * 25;
    score += liqScore;
    reasons.push(`liq $${Math.round(liq / 1000)}k`);
  } else {
    return { score: 0, reasons: ['below min liquidity'], pass: false };
  }

  const vol = pair.volumeH1 || pair.volumeH24 / 24;
  const volScore = clamp(Math.log10(Math.max(vol, 1)) / 6, 0, 1) * 25;
  score += volScore;
  reasons.push(`vol1h $${Math.round(vol)}`);

  const buys = pair.buysH1;
  const sells = Math.max(pair.sellsH1, 1);
  const ratio = buys / sells;
  const flowScore = clamp((ratio - 0.5) / 1.5, 0, 1) * 20;
  score += flowScore;
  reasons.push(`flow ${ratio.toFixed(2)}`);

  // Prefer young but not brand new (< 5m risky; 15m-12h sweet)
  const ageH = pair.ageMs != null ? pair.ageMs / 3600000 : 24;
  let ageScore = 10;
  if (ageH < 0.1) ageScore = 2;
  else if (ageH < 0.25) ageScore = 8;
  else if (ageH < 6) ageScore = 20;
  else if (ageH < 24) ageScore = 15;
  else if (ageH < 72) ageScore = 10;
  else ageScore = 5;
  score += ageScore;
  reasons.push(`age ${ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(1)}h`}`);

  // Mild boost for positive short momentum, mild penalty for dump
  const ch = pair.priceChangeH1 || 0;
  if (ch > 5 && ch < 200) score += 10;
  else if (ch >= 200) score += 4; // already pumped hard
  else if (ch < -20) score -= 10;
  else score += 5;

  score = clamp(Math.round(score), 0, 100);
  return { score, reasons, pass: score >= settings.minScore };
}

class PaperEngine {
  constructor() {
    this.state = loadState();
    this._scanTimer = null;
    this._priceTimer = null;
    this._busy = false;
    this._listeners = new Set();
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit() {
    const snap = this.snapshot();
    for (const fn of this._listeners) {
      try {
        fn(snap);
      } catch (_) {}
    }
  }

  snapshot() {
    const s = this.state;
    const eq = equity(s);
    const mult = s.startingBalance > 0 ? eq / s.startingBalance : 1;
    const gain = eq - s.startingBalance;
    const gainPct = s.startingBalance > 0 ? (gain / s.startingBalance) * 100 : 0;
    const newPeak = !!s._newPeak;
    s._newPeak = false;
    return {
      cash: round(s.cash, 4),
      equity: round(eq, 4),
      startingBalance: s.startingBalance,
      peakBalance: round(s.peakBalance, 4),
      gain: round(gain, 4),
      gainPct: round(gainPct, 2),
      multiplier: round(mult, 4),
      positions: s.positions,
      activity: s.activity.slice(0, 50),
      agents: s.agents,
      banner: s.banner,
      settings: s.settings,
      equityHistory: s.equityHistory,
      scanned: s.scanned.slice(0, 12),
      scored: s.scored.slice(0, 8),
      updatedAt: s.updatedAt,
      newPeak,
      paper: true,
      disclaimer:
        'PAPER ONLY — no real trades, no wallet keys. Prices from DexScreener. Fills apply a slippage+fee haircut. Most memecoins go to zero; viral 20x nights are not typical.',
    };
  }

  start() {
    if (this._scanTimer) return;
    console.log('[jev] paper engine starting');
    this.tickScan().catch((e) => console.error('scan', e.message));
    this.tickPrices().catch((e) => console.error('prices', e.message));
    this._scanTimer = setInterval(() => {
      this.tickScan().catch((e) => console.error('scan', e.message));
    }, DEFAULTS.scanIntervalMs);
    this._priceTimer = setInterval(() => {
      this.tickPrices().catch((e) => console.error('prices', e.message));
    }, DEFAULTS.priceIntervalMs);
  }

  stop() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    if (this._priceTimer) clearInterval(this._priceTimer);
    this._scanTimer = null;
    this._priceTimer = null;
  }

  setRunning(running) {
    this.state.settings.running = !!running;
    setBanner(
      this.state,
      running ? 'JEV · agents live (paper)' : 'JEV · paused — paper only',
      null
    );
    saveState(this.state);
    this.emit();
  }

  reset(startingBalance) {
    const bal = Number(startingBalance);
    const start = Number.isFinite(bal) && bal > 0 ? bal : this.state.startingBalance || 100;
    this.state = emptyState({ ...this.state.settings, startingBalance: start });
    saveState(this.state);
    this.emit();
    return this.snapshot();
  }

  updateSettings(patch = {}) {
    const s = this.state.settings;
    const keys = [
      'minLiquidity',
      'buyPctMin',
      'buyPctMax',
      'maxPositions',
      'stopPct',
      'trailPct',
      'slippage',
      'minScore',
      'running',
    ];
    for (const k of keys) {
      if (patch[k] != null && patch[k] !== '') s[k] = Number.isFinite(Number(patch[k])) || typeof patch[k] === 'boolean'
        ? (typeof patch[k] === 'boolean' ? patch[k] : Number(patch[k]))
        : s[k];
    }
    if (patch.startingBalance != null && Number(patch.startingBalance) > 0) {
      // only change label for future resets; don't rewrite live cash mid-run unless empty
      this.state.startingBalance = Number(patch.startingBalance);
    }
    saveState(this.state);
    this.emit();
    return this.snapshot();
  }

  async discoverMints() {
    const mints = new Set();
    const icons = new Map();
    try {
      const boosts = await fetchJson(`${DS}/token-boosts/top/v1`);
      for (const b of boosts || []) {
        if (b.chainId === 'solana' && b.tokenAddress) {
          mints.add(b.tokenAddress);
          if (b.icon) icons.set(b.tokenAddress, b.icon.startsWith('http') ? b.icon : `https://cdn.dexscreener.com/cms/images/${b.icon}`);
        }
      }
    } catch (e) {
      console.warn('boosts', e.message);
    }
    try {
      const profiles = await fetchJson(`${DS}/token-profiles/latest/v1`);
      for (const b of profiles || []) {
        if (b.chainId === 'solana' && b.tokenAddress) {
          mints.add(b.tokenAddress);
          if (b.icon) icons.set(b.tokenAddress, b.icon);
        }
      }
    } catch (e) {
      console.warn('profiles', e.message);
    }
    for (const q of ['pump', 'solana', 'bonk']) {
      try {
        const d = await fetchJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`);
        for (const p of d.pairs || []) {
          if (p.chainId !== 'solana') continue;
          const addr = p.baseToken && p.baseToken.address;
          if (addr) {
            mints.add(addr);
            const img = (p.info && p.info.imageUrl) || null;
            if (img) icons.set(addr, img);
          }
        }
      } catch (e) {
        console.warn('search', q, e.message);
      }
    }
    return { mints: [...mints], icons };
  }

  async fetchPairsForMints(mints) {
    const out = [];
    const chunk = 25;
    for (let i = 0; i < mints.length; i += chunk) {
      const slice = mints.slice(i, i + chunk);
      try {
        const d = await fetchJson(`${DS}/latest/dex/tokens/${slice.join(',')}`);
        const byMint = new Map();
        for (const p of d.pairs || []) {
          if (p.chainId !== 'solana') continue;
          const n = normalizePair(p);
          if (!n || !n.mint) continue;
          const prev = byMint.get(n.mint);
          if (!prev || n.liquidity > prev.liquidity) byMint.set(n.mint, n);
        }
        out.push(...byMint.values());
      } catch (e) {
        console.warn('tokens batch', e.message);
      }
    }
    return out;
  }

  async tickScan() {
    if (this._busy) return;
    this._busy = true;
    const state = this.state;
    const settings = state.settings;
    try {
      state.agents.scanner.status = 'scanning';
      state.agents.scanner.lastRun = now();
      this.emit();

      const { mints, icons } = await this.discoverMints();
      const pairs = await this.fetchPairsForMints(mints);
      for (const p of pairs) {
        if (!p.icon && icons.has(p.mint)) p.icon = icons.get(p.mint);
      }

      state.agents.scanner.pools = pairs.length;
      const filtered = pairs
        .filter((p) => !isMajor(p) && p.liquidity >= settings.minLiquidity && p.priceUsd > 0)
        .sort((a, b) => b.liquidity - a.liquidity);

      // recent card list: mix of filtered + some rejected for color
      const rejects = pairs
        .filter((p) => p.liquidity > 0 && p.liquidity < settings.minLiquidity)
        .sort((a, b) => b.liquidity - a.liquidity)
        .slice(0, 3)
        .map((p) => ({
          symbol: p.symbol,
          icon: p.icon,
          tag: `liq $${Math.round(p.liquidity / 1000)}k`,
          ok: false,
        }));
      const goods = filtered.slice(0, 4).map((p) => ({
        symbol: p.symbol,
        icon: p.icon,
        tag: '+ analyst',
        ok: true,
      }));
      state.agents.scanner.recent = [...rejects.slice(0, 2), ...goods].slice(0, 5);
      state.scanned = filtered.slice(0, 20);
      state.agents.scanner.status = 'idle';

      if (!settings.running) {
        saveState(state);
        this.emit();
        return;
      }

      // Analyst
      state.agents.analyst.status = 'scoring';
      this.emit();
      const scored = [];
      for (const p of filtered.slice(0, 25)) {
        const r = scorePair(p, settings);
        scored.push({ ...p, ...r });
      }
      scored.sort((a, b) => b.score - a.score);
      state.scored = scored.slice(0, 15);
      state.agents.analyst.scored = (state.agents.analyst.scored || 0) + scored.length;
      const top = scored[0];
      if (top) {
        state.agents.analyst.score = top.score;
        state.agents.analyst.symbol = top.symbol;
        state.agents.analyst.status = top.pass ? 'passed' : 'scoring';
      } else {
        state.agents.analyst.status = 'idle';
      }

      const openMints = new Set(state.positions.map((p) => p.mint));
      const candidates = scored.filter(
        (p) => p.pass && !openMints.has(p.mint) && !state.seenMints.includes(p.mint)
      );

      if (candidates.length && state.positions.length < settings.maxPositions && state.cash > 5) {
        const pick = candidates[0];
        state.agents.analyst.passed = (state.agents.analyst.passed || 0) + 1;
        await this.paperBuy(pick);
      } else {
        state.agents.analyst.status = top ? (top.pass ? 'passed' : 'idle') : 'idle';
      }

      pushEquity(state);
      saveState(state);
      this.emit();
    } finally {
      this._busy = false;
    }
  }

  async paperBuy(pair) {
    const state = this.state;
    const settings = state.settings;
    if (state.positions.length >= settings.maxPositions) return null;
    if (!pair.priceUsd || pair.priceUsd <= 0) return null;

    const pct =
      settings.buyPctMin +
      Math.random() * Math.max(0, settings.buyPctMax - settings.buyPctMin);
    const eq = equity(state);
    let spend = round(eq * pct, 2);
    spend = Math.min(spend, round(state.cash * 0.95, 2));
    if (spend < 2) return null;

    // simulate fill progress
    state.agents.executor.status = 'buying';
    state.agents.executor.progress = 0;
    state.agents.executor.lastFill = {
      symbol: pair.symbol,
      amountUsd: spend,
      pct: round(pct * 100, 1),
      icon: pair.icon,
    };
    this.emit();
    for (const step of [35, 70, 100]) {
      await new Promise((r) => setTimeout(r, 120));
      state.agents.executor.progress = step;
      this.emit();
    }

    const slip = settings.slippage;
    const fillPrice = pair.priceUsd * (1 + slip); // buy worse
    const tokens = spend / fillPrice;
    const stopPrice = fillPrice * (1 + settings.stopPct);
    const trailAnchor = fillPrice;

    const pos = {
      id: uid('pos'),
      mint: pair.mint,
      symbol: pair.symbol,
      name: pair.name,
      icon: pair.icon,
      entryPrice: fillPrice,
      amountUsd: spend,
      tokens,
      stopPrice,
      trailPct: settings.trailPct,
      highSinceEntry: fillPrice,
      trailStop: fillPrice * (1 - settings.trailPct),
      openedAt: now(),
      score: pair.score,
      markPrice: pair.priceUsd,
      markValue: spend,
      pnl: 0,
      pnlPct: 0,
      liquidity: pair.liquidity,
      marketCap: pair.marketCap,
      volumeH24: pair.volumeH24,
      dexId: pair.dexId,
      url: pair.url,
      pairAddress: pair.pairAddress,
      ageMs: pair.ageMs,
      priceHistory: [{ t: now(), price: pair.priceUsd }],
    };

    state.cash = round(state.cash - spend, 4);
    state.positions.push(pos);
    state.seenMints.push(pair.mint);
    if (state.seenMints.length > 500) state.seenMints = state.seenMints.slice(-500);

    state.agents.executor.trades = (state.agents.executor.trades || 0) + 1;
    state.agents.executor.status = 'filled';
    state.agents.executor.progress = 100;
    state.agents.executor.lastRun = now();
    state.agents.risk.status = 'guarding';
    state.agents.risk.guarding = pair.symbol;

    addActivity(state, {
      type: 'buy',
      symbol: pair.symbol,
      icon: pair.icon,
      agent: 'Executor',
      detail: `${round(pct * 100, 0)}% of stack`,
      amountUsd: spend,
      pnl: null,
      pnlPct: null,
      mint: pair.mint,
    });
    setBanner(state, `Bought ${pair.symbol} · $${spend.toFixed(2)} (${round(pct * 100, 0)}% stack)`, pair.icon);

    pushEquity(state);
    saveState(state);
    this.emit();

    // cool status
    setTimeout(() => {
      if (state.agents.executor.status === 'filled') {
        state.agents.executor.status = 'idle';
        this.emit();
      }
    }, 2500);

    return pos;
  }

  async tickPrices() {
    const state = this.state;
    if (!state.positions.length) {
      pushEquity(state);
      saveState(state);
      this.emit();
      return;
    }

    const mints = [...new Set(state.positions.map((p) => p.mint))];
    let pairs = [];
    try {
      pairs = await this.fetchPairsForMints(mints);
    } catch (e) {
      console.warn('price tick', e.message);
      return;
    }
    const byMint = new Map(pairs.map((p) => [p.mint, p]));
    const settings = state.settings;
    const closed = [];

    for (const pos of state.positions) {
      const live = byMint.get(pos.mint);
      if (!live || !live.priceUsd) continue;
      const px = live.priceUsd;
      pos.markPrice = px;
      pos.markValue = round(pos.tokens * px, 4);
      pos.pnl = round(pos.markValue - pos.amountUsd, 4);
      pos.pnlPct = round(((px - pos.entryPrice) / pos.entryPrice) * 100, 2);
      pos.liquidity = live.liquidity || pos.liquidity;
      pos.marketCap = live.marketCap || pos.marketCap;
      pos.volumeH24 = live.volumeH24 || pos.volumeH24;
      pos.icon = pos.icon || live.icon;
      pos.priceHistory = pos.priceHistory || [];
      pos.priceHistory.push({ t: now(), price: px });
      if (pos.priceHistory.length > 240) pos.priceHistory = pos.priceHistory.slice(-240);

      if (px > pos.highSinceEntry) {
        pos.highSinceEntry = px;
        pos.trailStop = px * (1 - pos.trailPct);
      }

      state.agents.risk.guarding = pos.symbol;
      state.agents.risk.status = 'guarding';
      state.agents.risk.lastRun = now();

      if (!settings.running) continue;

      // hard stop
      if (px <= pos.stopPrice) {
        closed.push({ pos, reason: 'stop', label: 'Risk -6% stop' });
        continue;
      }
      // trailing stop (only once we've moved enough that trail > entry stop effectively)
      if (px <= pos.trailStop && pos.highSinceEntry >= pos.entryPrice * (1 + pos.trailPct * 0.5)) {
        closed.push({ pos, reason: 'trail', label: 'Risk trailing stop' });
      }
    }

    for (const c of closed) {
      await this.paperSell(c.pos, c.reason, c.label);
    }

    pushEquity(state);
    saveState(state);
    this.emit();
  }

  async paperSell(pos, reason, label) {
    const state = this.state;
    const settings = state.settings;
    const idx = state.positions.findIndex((p) => p.id === pos.id);
    if (idx < 0) return null;

    const px = pos.markPrice || pos.entryPrice;
    const slip = settings.slippage;
    const fillPrice = px * (1 - slip); // sell worse
    const proceeds = round(pos.tokens * fillPrice, 4);
    const pnl = round(proceeds - pos.amountUsd, 4);
    const pnlPct = round((pnl / pos.amountUsd) * 100, 2);

    state.cash = round(state.cash + proceeds, 4);
    state.positions.splice(idx, 1);

    state.agents.risk.lastAction = {
      symbol: pos.symbol,
      reason,
      pnl,
      pnlPct,
      icon: pos.icon,
    };
    state.agents.risk.status = state.positions.length ? 'guarding' : 'idle';
    state.agents.risk.guarding = state.positions[0] ? state.positions[0].symbol : null;

    addActivity(state, {
      type: reason === 'stop' ? 'stopped' : 'sell',
      symbol: pos.symbol,
      icon: pos.icon,
      agent: label || 'Risk',
      detail: reason === 'stop' ? 'hard stop' : 'trailing stop',
      amountUsd: proceeds,
      pnl,
      pnlPct,
      mint: pos.mint,
    });

    const sign = pnl >= 0 ? '+' : '';
    setBanner(
      state,
      `${reason === 'stop' ? 'Stopped' : 'Sold'} ${pos.symbol} · ${sign}$${Math.abs(pnl).toFixed(2)} (${sign}${pnlPct}%)`,
      pos.icon
    );

    state.notifications.unshift({
      id: uid('n'),
      ts: now(),
      title: `${reason === 'stop' ? 'Stopped' : 'Sold'} ${pos.symbol}`,
      body: `${sign}$${Math.abs(pnl).toFixed(2)} (${sign}${pnlPct}%)`,
      icon: pos.icon,
      symbol: pos.symbol,
      pnl,
      pnlPct,
    });
    if (state.notifications.length > 20) state.notifications = state.notifications.slice(0, 20);

    pushEquity(state);
    saveState(state);
    this.emit();
    return { proceeds, pnl, pnlPct };
  }

  drainNotifications() {
    const n = this.state.notifications || [];
    this.state.notifications = [];
    saveState(this.state);
    return n;
  }

  getPosition(idOrMint) {
    return (
      this.state.positions.find((p) => p.id === idOrMint || p.mint === idOrMint) ||
      null
    );
  }
}

module.exports = { PaperEngine, equity, DEFAULTS };
