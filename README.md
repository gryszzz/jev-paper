# JEV Paper

Mobile-first PWA for **Solana memecoin paper trading** with four agents (Scanner, Analyst, Executor, Risk).

**PAPER ONLY** — no wallet keys, no real trades. Live prices from the public DexScreener API. Fills apply a configurable slippage+fee haircut (default 2%).

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Agents

- **Scanner** — Solana / pump.fun pairs via DexScreener; keeps liquidity ≥ $38k
- **Analyst** — scores liquidity, volume, buy/sell flow, age
- **Executor** — paper-buys ~20–25% of stack when score ≥ 70 (max 3 positions)
- **Risk** — −6% hard stop and 10% trailing stop on live marks

## Deploy

Render: `npm install` / `npm start`, health check `/api/health`. Free tier spins down when idle.
