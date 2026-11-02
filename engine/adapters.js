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
function dynamicSlippage({ liquidity = 0, amountUsd = 0, side = 'buy', base = 0.02 } = {}) {
  const liq = Math.max(Number(liquidity) || 0, 1);
  const size = Math.max(Number(amountUsd) || 0, 1);
  const impact = (size / liq) * (side === 'sell' ? 1.35 : 1.0);
  // thin books hurt more
  const thinPenalty = liq < 50000 ? 0.015 : liq < 100000 ? 0.008 : 0;
  const slip = clamp(base * 0.5 + impact * 2.5 + thinPenalty, 0.005, 0.12);
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
function simulateLatencyMs({ liquidity = 0, urgency = 'normal' } = {}) {
  const base = urgency === 'panic' ? 180 : urgency === 'high' ? 320 : 450;
  const thin = liquidity > 0 && liquidity < 50000 ? 200 : 0;
  const jitter = Math.floor(Math.random() * 120);
  return base + thin + jitter;
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
    const dynSlip = dynamicSlippage({
      liquidity: liq,
      amountUsd: usd,
      side: 'buy',
      base: opts.baseSlippage != null ? opts.baseSlippage : this.fallbackSlippage,
    });
    const urgency = opts.urgency || 'normal';
    const priorityFeeSol = simulateJitoFee({ urgency, liquidity: liq });
    const latencyMs = simulateLatencyMs({ liquidity: liq, urgency });

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
          const slip = Math.max(dynSlip, jupImpact);
          const fillPrice = (q.effectivePrice || markPrice) * (1 + Math.max(0, slip - jupImpact) * 0.5);
          return {
            source: 'jupiter+jito-sim',
            fillPrice,
            tokens: fillPrice > 0 ? usd / fillPrice : q.outAmountUi,
            impactPct: slip * 100,
            priorityFeeSol,
            latencyMs,
            route: q.routeLabel || 'jupiter',
            jito: true,
            dynSlippage: dynSlip,
          };
        }
      } catch (_) {}
    }
    const fillPrice = (markPrice || 0) * (1 + dynSlip);
    return {
      source: 'jito-sim',
      fillPrice,
      tokens: fillPrice > 0 ? usd / fillPrice : 0,
      impactPct: dynSlip * 100,
      priorityFeeSol,
      latencyMs,
      route: 'simulated-jito',
      jito: true,
      dynSlippage: dynSlip,
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
    });
    const urgency = opts.urgency || (opts.reason === 'whale' || opts.reason === 'stop' ? 'high' : 'normal');
    const priorityFeeSol = simulateJitoFee({ urgency, liquidity: liq });
    const latencyMs = simulateLatencyMs({ liquidity: liq, urgency });

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
          const slip = Math.max(dynSlip, jupImpact);
          const fillPrice = (q.effectivePrice || markPrice) * (1 - Math.max(0, slip - jupImpact) * 0.5);
          return {
            source: 'jupiter+jito-sim',
            fillPrice,
            proceedsUsd: tokens * fillPrice,
            impactPct: slip * 100,
            priorityFeeSol,
            latencyMs,
            route: q.routeLabel || 'jupiter',
            jito: true,
            dynSlippage: dynSlip,
          };
        }
      } catch (_) {}
    }
    const fillPrice = (markPrice || 0) * (1 - dynSlip);
    return {
      source: 'jito-sim',
      fillPrice,
      proceedsUsd: tokens * fillPrice,
      impactPct: dynSlip * 100,
      priorityFeeSol,
      latencyMs,
      route: 'simulated-jito',
      jito: true,
      dynSlippage: dynSlip,
    };
  }

  async buy(mint, amountUsd, opts = {}) {
    const q = await this.quoteBuy(mint, amountUsd, opts.markPrice, opts);
    if (q.latencyMs) await new Promise((r) => setTimeout(r, Math.min(q.latencyMs, 800)));
    return { ok: true, paper: true, ...q, amountUsd };
  }

  async sell(mint, tokenAmount, opts = {}) {
    const q = await this.quoteSell(mint, tokenAmount, opts.markPrice, opts);
    if (q.latencyMs) await new Promise((r) => setTimeout(r, Math.min(q.latencyMs, 800)));
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
};
