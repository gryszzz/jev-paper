'use strict';

/**
 * TradeAdapter — paper vs live execution boundary.
 * LIVE is stubbed. Never holds keys in this module; LiveAdapter reads
 * process.env.SOLANA_HOT_WALLET_KEY only when LIVE_ENABLED=true (not implemented to send).
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

class PaperAdapter extends TradeAdapter {
  constructor({ jupiterQuote, fallbackSlippage = 0.02 } = {}) {
    super();
    this.jupiterQuote = jupiterQuote;
    this.fallbackSlippage = fallbackSlippage;
  }
  mode() {
    return 'paper';
  }
  async quoteBuy(mint, amountUsd, markPrice) {
    const usd = Number(amountUsd) || 0;
    if (this.jupiterQuote) {
      try {
        const q = await this.jupiterQuote({ mint, side: 'buy', amountUsd: usd });
        if (q && q.outAmount && q.inAmount) {
          return {
            source: 'jupiter',
            fillPrice: q.effectivePrice,
            tokens: q.outAmountUi,
            impactPct: q.priceImpactPct,
            priorityFeeSol: q.priorityFeeSol || 0,
            route: q.routeLabel || 'jupiter',
          };
        }
      } catch (_) {}
    }
    const slip = this.fallbackSlippage;
    const fillPrice = (markPrice || 0) * (1 + slip);
    return {
      source: 'haircut',
      fillPrice,
      tokens: fillPrice > 0 ? usd / fillPrice : 0,
      impactPct: slip * 100,
      priorityFeeSol: 0.00005,
      route: 'simulated',
    };
  }
  async quoteSell(mint, tokenAmount, markPrice) {
    const tokens = Number(tokenAmount) || 0;
    if (this.jupiterQuote) {
      try {
        const q = await this.jupiterQuote({ mint, side: 'sell', tokenAmount: tokens });
        if (q && q.outAmount) {
          return {
            source: 'jupiter',
            fillPrice: q.effectivePrice,
            proceedsUsd: q.outAmountUi,
            impactPct: q.priceImpactPct,
            priorityFeeSol: q.priorityFeeSol || 0,
            route: q.routeLabel || 'jupiter',
          };
        }
      } catch (_) {}
    }
    const slip = this.fallbackSlippage;
    const fillPrice = (markPrice || 0) * (1 - slip);
    return {
      source: 'haircut',
      fillPrice,
      proceedsUsd: tokens * fillPrice,
      impactPct: slip * 100,
      priorityFeeSol: 0.00005,
      route: 'simulated',
    };
  }
  async buy(mint, amountUsd, opts = {}) {
    const q = await this.quoteBuy(mint, amountUsd, opts.markPrice);
    return { ok: true, paper: true, ...q, amountUsd };
  }
  async sell(mint, tokenAmount, opts = {}) {
    const q = await this.quoteSell(mint, tokenAmount, opts.markPrice);
    return { ok: true, paper: true, ...q, tokenAmount };
  }
}

/**
 * LiveAdapter stub — architected for Jupiter swap + hot wallet.
 * Refuses all sends while LIVE_ENABLED is not true.
 * Does NOT read or log private keys.
 */
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
    // Even if flag is on, this stub never broadcasts until fully implemented + caps pass.
    return { ok: false, error: 'LiveAdapter stub: swaps not implemented. No tx sent.' };
  }
  async quoteBuy(mint, amountUsd) {
    // Quotes can use public Jupiter API without a key
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
  // Always prefer paper until a future release wires LiveAdapter for real.
  if (live) {
    console.warn('[jev] LIVE_ENABLED=true but LiveAdapter is a stub — forcing PaperAdapter');
  }
  return new PaperAdapter(deps);
}

module.exports = { TradeAdapter, PaperAdapter, LiveAdapter, createTradeAdapter };
