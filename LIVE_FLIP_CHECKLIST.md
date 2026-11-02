# Flipping JEV from PAPER → LIVE

LIVE is architected but **disabled**. Do not flip until every item below is done.

## Code / infra (not done yet)
1. Implement `LiveAdapter` for real: Jupiter swap API (`/swap` + serialize), sign with hot wallet, submit via RPC (prefer Jito or priority fees), wait for confirmation, retry/idempotency.
2. Change `createTradeAdapter()` to return `LiveAdapter` only when `LIVE_ENABLED=true` **and** caps pass (today it always forces PaperAdapter).
3. Dedicated Solana **hot wallet** with a small balance; private key **only** in server env `SOLANA_HOT_WALLET_KEY` (never client, never git, never Supabase anon state).
4. Reliable paid RPC (Helius/QuickNode/etc.) via `SOLANA_RPC_URL` — public RPC is not enough for live swaps + whale polls.
5. Optional: Jito block engine endpoint / tip account for landing.

## Env flags & caps (already scaffolded)
- `LIVE_ENABLED=true` (currently `false` on Render)
- Keep `APP_PASSCODE` set (session cookie auth)
- Caps in settings / env: `liveMaxPerTradeUsd`, `liveMaxDailySpendUsd`, `liveMaxDailyLossUsd`, `liveWalletBalanceCapUsd`
- Kill switch must remain reachable and force-pause

## Ops / risk
- Fund hot wallet ≤ `liveWalletBalanceCapUsd`
- Confirm kill switch + daily loss cooldown behavior on a tiny size first
- Separate paper vs live state IDs (`JEV_STATE_ID`) so paper history is not mixed
- Monitoring/alerts on failed swaps, RPC errors, whale false positives
- Legal: real trading risk disclosure; this is still experimental software

## Explicitly never
- Do not put keys in the PWA, localStorage, or anon Supabase rows
- Do not enable live from the client UI alone without server `LIVE_ENABLED`
