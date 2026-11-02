'use strict';

/**
 * TradeAdapter — paper vs live execution boundary.
 * Paper models: dynamic liquidity-based slippage, Jito-style priority fees,
 * and fill latency so paper results carry closer to live.
 * LIVE is stubbed. Never holds keys.
 */

class TradeAdapter {
  async quoteBuy(_mint, _amountUsd) {
    throw new Error('not implemented');
  }
  async quoteSell(_mint, _tokenAmount) {
    throw new Error('not implemented');
  }
  async buy(_mint, _amountUsd, _opts) {
    throw new Error('not implemented');
  }
  async sell(_mint, _tokenAmount, _opts) {
    throw new Error('not implemented');
  }
  mode() {
    return 'unknown';
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/** Dynamic slippage from liquidity + trade size (bps → fraction). */
function dynamicSlippage({ liquidity = 0, amountUsd = 0, side = 'buy', base = 0.02, lane = null } = {}) {
  const liq = Math.max(Number(liquidity) || 0, 1);
  const size = Math.max(Number(amountUsd) || 0, 1);
  const impact = (size / liq) * (side === 'sell' ? 1.35 : 1.0);
  // thin books hurt more
  const thinPenalty = liq < 50000 ? 0.015 : liq < 100000 ? 0.008 : 0;
  let slip = clamp(base * 0.5 + impact * 2.5 + thinPenalty, 0.005, 0.12);
  // Fresh / early graduations: worse fills (more adverse selection + thin curve)
  if (lane === 'FRESH') slip = clamp(slip * 1.65 + 0.012, 0.015, 0.22);
  else if (lane === 'GRAD') slip = clamp(slip * 1.25 + 0.005, 0.01, 0.16);
  return slip;
}

/** Simulate Jito priority fee in SOL based on urgency + congestion proxy. */
function simulateJitoFee({ urgency = 'normal', liquidity = 0 } = {}) {
  // Base tip ladder approximating Jito bundle tips in SOL
  const table = { low: 0.00005, normal: 0.00015, high: 0.0004, panic: 0.001 };
  let fee = table[urgency] || table.normal;
  if (liquidity > 0 && liquidity < 40000) fee *= 1.4; // compete harder on thin books
  return fee;
}

/** Artificial fill latency ms — higher on thin liquidity / high urgency. */
function simulateLatencyMs({ liquidity = 0, urgency = 'normal', lane = null } = {}) {
  let base = urgency === 'panic' ? 180 : urgency === 'high' ? 320 : 450;
  if (lane === 'FRESH') base += 280; // slower discovery / RPC / curve race
  else if (lane === 'GRAD') base += 120;
  const thin = liquidity > 0 && liquidity < 50000 ? 200 : 0;
  const jitter = Math.floor(Math.random() * 120);
  return base + thin + jitter;
}

/**
 * Live-grade paper hazards (FREE sim — no paid infra):
 * - sandwich/MEV adverse selection on thin books & FRESH lane
 * - random failed-tx / dropped landing (priority fee insufficient)
 * - extra slip when competing with Jito searchers
 */
function simulateMevHazard({ liquidity = 0, amountUsd = 0, side = 'buy', lane = null, urgency = 'normal' } = {}) {
  const liq = Math.max(Number(liquidity) || 0, 1);
  const size = Math.max(Number(amountUsd) || 0, 1);
  const thin = liq < 40000;
  let sandwichProb = thin ? 0.12 : liq < 100000 ? 0.05 : 0.02;
  if (lane === 'FRESH') sandwichProb += 0.1;
  else if (lane === 'GRAD') sandwichProb += 0.04;
  if (urgency === 'high' || urgency === 'panic') sandwichProb += 0.03;
  sandwichProb = clamp(sandwichProb, 0, 0.45);

  let failProb = thin ? 0.06 : 0.02;
  if (lane === 'FRESH') failProb += 0.05;
  if (urgency === 'panic') failProb += 0.03;
  failProb = clamp(failProb, 0, 0.25);

  const sandwiched = Math.random() < sandwichProb;
  const failed = Math.random() < failProb;

  // Extra adverse slip if sandwiched (buy pays more / sell gets less)
  let mevSlipExtra = 0;
  if (sandwiched) {
    const impact = clamp((size / liq) * 3.5, 0.008, 0.08);
    mevSlipExtra = impact + (thin ? 0.015 : 0.006);
  }
  return {
    sandwiched,
    failed,
    sandwichProb,
    failProb,
    mevSlipExtra,
    note: failed ? 'tx-fail-sim' : sandwiched ? 'sandwich-sim' : 'clean',
  };
}


class PaperAdapter extends TradeAdapter {
  constructor({ jupiterQuote, fallbackSlippage = 0.02 } = {}) {
    super();
    this.jupiterQuote = jupiterQuote;
    this.fallbackSlippage = fallbackSlippage;
  }
  mode() {
    return 'paper';
  }

  async quoteBuy(mint, amountUsd, markPrice, opts = {}) {
    const usd = Number(amountUsd) || 0;
    const liq = Number(opts.liquidity) || 0;
    const lane = opts.lane || null;
    const dynSlip = dynamicSlippage({
      liquidity: liq,
      amountUsd: usd,
      side: 'buy',
      base: opts.baseSlippage != null ? opts.baseSlippage : this.fallbackSlippage,
      lane,
    });
    const urgency = opts.urgency || (lane === 'FRESH' ? 'high' : 'normal');
    const priorityFeeSol = simulateJitoFee({ urgency, liquidity: liq });
    const latencyMs = simulateLatencyMs({ liquidity: liq, urgency, lane });

    if (this.jupiterQuote) {
      try {
        const q = await this.jupiterQuote({
          mint,
          side: 'buy',
          amountUsd: usd,
          slippageBps: Math.round(dynSlip * 10000),
        });
        if (q && q.outAmount && q.inAmount) {
          // Blend Jupiter impact with our dynamic floor so thin books stay realistic
          const jupImpact = (Number(q.priceImpactPct) || 0) / 100;
          const mev = simulateMevHazard({ liquidity: liq, amountUsd: usd, side: 'buy', lane, urgency });
          const slip = Math.max(dynSlip, jupImpact) + mev.mevSlipExtra;
          const fillPrice = (q.effectivePrice || markPrice) * (1 + Math.max(0, slip - jupImpact) * 0.5);
          return {
            source: 'jupiter+jito-sim',
            fillPrice,
            tokens: fillPrice > 0 ? usd / fillPrice : q.outAmountUi,
            impactPct: slip * 100,
            priorityFeeSol,
            latencyMs: latencyMs + (mev.sandwiched ? 90 : 0),
            route: q.routeLabel || 'jupiter',
            jito: true,
            dynSlippage: dynSlip,
            mev,
            failed: mev.failed,
          };
        }
      } catch (_) {}
    }
    const mev = simulateMevHazard({ liquidity: liq, amountUsd: usd, side: 'buy', lane, urgency });
    const slip = dynSlip + mev.mevSlipExtra;
    const fillPrice = (markPrice || 0) * (1 + slip);
    return {
      source: 'jito-sim',
      fillPrice,
      tokens: fillPrice > 0 ? usd / fillPrice : 0,
      impactPct: slip * 100,
      priorityFeeSol,
      latencyMs: latencyMs + (mev.sandwiched ? 90 : 0),
      route: 'simulated-jito',
      jito: true,
      dynSlippage: dynSlip,
      mev,
      failed: mev.failed,
    };
  }

  async quoteSell(mint, tokenAmount, markPrice, opts = {}) {
    const tokens = Number(tokenAmount) || 0;
    const liq = Number(opts.liquidity) || 0;
    const notional = tokens * (markPrice || 0);
    const dynSlip = dynamicSlippage({
      liquidity: liq,
      amountUsd: notional,
      side: 'sell',
      base: opts.baseSlippage != null ? opts.baseSlippage : this.fallbackSlippage,
      lane: opts.lane || null,
    });
    const urgency = opts.urgency || (opts.reason === 'whale' || opts.reason === 'stop' ? 'high' : 'normal');
    const priorityFeeSol = simulateJitoFee({ urgency, liquidity: liq });
    const latencyMs = simulateLatencyMs({ liquidity: liq, urgency, lane: opts.lane || null });

    if (this.jupiterQuote) {
      try {
        const q = await this.jupiterQuote({
          mint,
          side: 'sell',
          tokenAmount: tokens,
          slippageBps: Math.round(dynSlip * 10000),
        });
        if (q && q.outAmount) {
          const jupImpact = (Number(q.priceImpactPct) || 0) / 100;
          const mev = simulateMevHazard({ liquidity: liq, amountUsd: notional, side: 'sell', lane: opts.lane || null, urgency });
          const slip = Math.max(dynSlip, jupImpact) + mev.mevSlipExtra;
          const fillPrice = (q.effectivePrice || markPrice) * (1 - Math.max(0, slip - jupImpact) * 0.5);
          return {
            source: 'jupiter+jito-sim',
            fillPrice,
            proceedsUsd: tokens * fillPrice,
            impactPct: slip * 100,
            priorityFeeSol,
            latencyMs: latencyMs + (mev.sandwiched ? 70 : 0),
            route: q.routeLabel || 'jupiter',
            jito: true,
            dynSlippage: dynSlip,
            mev,
            failed: mev.failed,
          };
        }
      } catch (_) {}
    }
    const mev = simulateMevHazard({ liquidity: liq, amountUsd: notional, side: 'sell', lane: opts.lane || null, urgency });
    const slip = dynSlip + mev.mevSlipExtra;
    const fillPrice = (markPrice || 0) * (1 - slip);
    return {
      source: 'jito-sim',
      fillPrice,
      proceedsUsd: tokens * fillPrice,
      impactPct: slip * 100,
      priorityFeeSol,
      latencyMs: latencyMs + (mev.sandwiched ? 70 : 0),
      route: 'simulated-jito',
      jito: true,
      dynSlippage: dynSlip,
      mev,
      failed: mev.failed,
    };
  }

  async buy(mint, amountUsd, opts = {}) {
    const q = await this.quoteBuy(mint, amountUsd, opts.markPrice, opts);
    if (q.latencyMs) await new Promise((r) => setTimeout(r, Math.min(q.latencyMs, 800)));
    if (q.failed) {
      return {
        ok: false,
        paper: true,
        error: 'simulated-tx-fail',
        reason: (q.mev && q.mev.note) || 'tx-fail-sim',
        priorityFeeSol: q.priorityFeeSol,
        latencyMs: q.latencyMs,
        mev: q.mev,
        amountUsd,
      };
    }
    return { ok: true, paper: true, ...q, amountUsd };
  }

  async sell(mint, tokenAmount, opts = {}) {
    const q = await this.quoteSell(mint, tokenAmount, opts.markPrice, opts);
    if (q.latencyMs) await new Promise((r) => setTimeout(r, Math.min(q.latencyMs, 800)));
    if (q.failed) {
      return {
        ok: false,
        paper: true,
        error: 'simulated-tx-fail',
        reason: (q.mev && q.mev.note) || 'tx-fail-sim',
        priorityFeeSol: q.priorityFeeSol,
        latencyMs: q.latencyMs,
        mev: q.mev,
        tokenAmount,
      };
    }
    return { ok: true, paper: true, ...q, tokenAmount };
  }
}

class LiveAdapter extends TradeAdapter {
  constructor() {
    super();
    this.enabled = process.env.LIVE_ENABLED === 'true';
  }
  mode() {
    return this.enabled ? 'live-ready-but-blocked' : 'live-disabled';
  }
  _guard() {
    if (process.env.LIVE_ENABLED !== 'true') {
      return { ok: false, error: 'LIVE_ENABLED=false — live trading disabled' };
    }
    return { ok: false, error: 'LiveAdapter stub: swaps not implemented. No tx sent.' };
  }
  async quoteBuy(mint, amountUsd) {
    return { ok: false, error: 'live quote path reserved', mint, amountUsd };
  }
  async quoteSell(mint, tokenAmount) {
    return { ok: false, error: 'live quote path reserved', mint, tokenAmount };
  }
  async buy() {
    return this._guard();
  }
  async sell() {
    return this._guard();
  }
}

function createTradeAdapter(deps = {}) {
  const live = process.env.LIVE_ENABLED === 'true';
  if (live) {
    console.warn('[jev] LIVE_ENABLED=true but LiveAdapter is a stub — forcing PaperAdapter');
  }
  return new PaperAdapter(deps);
}

module.exports = {
  TradeAdapter,
  PaperAdapter,
  LiveAdapter,
  createTradeAdapter,
  dynamicSlippage,
  simulateJitoFee,
  simulateLatencyMs,
  simulateMevHazard,
};
