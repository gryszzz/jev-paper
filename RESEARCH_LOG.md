# JEV Trencher Research Playbook

**Status:** paper-only · LIVE stays OFF without Tony’s explicit go  
**Written:** 2026-11-02 (America/New_York)  
**Sources:** Marino et al. arXiv 2602.14860; Kamat et al. arXiv 2607.02823; mahad1z/memecoin-survival; CoinGecko 18.7M tokens; Bitquery buyer/bundle studies; MadeOnSol methodology + cap-table; Fullport / Altrady exit frameworks; three.ws 254-trade autopsy; Jumpbit Aug–Oct’26; JEV engine (`analyst.js`, `lanes.js`, `strategies.js`) as of this write.

---

## 0. Base-rate reality (why filters beat hope)

| Finding | Number | Source |
|---|---|---|
| Pump.fun graduation (Sep–Oct 2025) | **0.63%** (4,338 / 655,770) | Marino et al. |
| Pump.fun graduation (May–Jun 2026) | **0.198%** (1,651 / 832,941) | Kamat et al. |
| Dead ≤5 min / ≤1h / ≤24h / ≤7d | **57% / 75% / 89% / 97%** | mahad1z survival |
| Unique traders first 5m ≥21 → median remaining life | **~18h vs ~40m** | mahad1z |
| Tokens dead on launch day | **68.7%** of 18.67M | CoinGecko |
| Ordinary Solana meme buyers lose after 2 weeks | **74%**, median −$13; top 1% take **56%** of gains | Bitquery |
| Buy-everything 1,411 launches | mean −31% / −62% / −56% at 1h/6h/24h | Arrow Algo |
| Dev bundles in launch block | **21%** of coins; snipers **28%**; bundled inventory PnL ≫ sniper PnL | Bitquery |
| Median time-to-grad (grads only) | **~4.4 min**, ~457 curve steps | Marino et al. |
| Fast liquidity (few trades to vSol) | **strongest graduation predictor** | Marino et al. |
| Bot-dominated activity past mid-curve | **lower** graduation odds | Marino et al. |

**Implication for JEV:** optimize avoid-bad-trades + bank winners early. Default size as if most positions → 0. Current paper book (~$53.5 from $100, multiple −99% rugs) matches the base rate when filters/exits are soft.

---

## 1. TOP PRIORITY — Runner detection & Runner Score

### 1.1 What “runner” means (operational)

Use MadeOnSol’s labeled outcome (validated for deployer `runner_rate`):

- **Dump:** peak mcap reached **&lt; 15 min** after deploy  
- **Runner:** peak mcap reached **≥ 60 min** after deploy  
- Middle band 15–60 min: unlabeled / excluded for training labels  

For paper A/B, also track proxy labels available without MadeOnSol:

- `runner_proxy_A`: max unrealized multiple ≥ **3×** and position held ≥ **30 min** before peak  
- `runner_proxy_B`: graduated AND post-grad peak ≥ **2×** grad mcap within 2h  
- Negative: peak &lt; 1.3× within 15 min, or hard rug (−90% from entry)

### 1.2 Leading indicators (evidence-ranked)

| Rank | Indicator | Evidence | Direction |
|---|---|---|---|
| 1 | **Liquidity velocity** — few swaps to reach a given vSol / mcap | Marino: strongest predictor | Fast = good |
| 2 | **Unique buyer acceleration** (esp. first 5 min) | mahad1z HR; MadeOnSol buyer quality | Accelerating unique wallets |
| 3 | **Early-buyer quality / smart-wallet clustering** | MadeOnSol cap-table; Marino top traders | ≥2 independent alpha wallets, not bundled |
| 4 | **Non-bot share** | Marino: high bot → worse past mid-curve | Prefer non-bot ≥30–70% |
| 5 | **Holder growth rate + distribution** | survival + MadeOnSol dump clusters | Rising holders, top10 not exploding |
| 6 | **Volume / mcap (turnover) paid for by buys** | MadeOnSol surge gates: buy vol ≥3% of mcap gain | High turnover with buy bias |
| 7 | **KOL early buys (rank 2–10)** | MadeOnSol: KOL in first ranks = pre-call signal | Positive but call-dependent |
| 8 | **Deployer tier / runner_rate** | MadeOnSol elite/good + runner_rate | Prefer non-instant-bond deployers |
| 9 | **Narrative / meta fit + X velocity** | Kamat Telegram HR large but regime-fragile; social as confirm only | Confirm, never alone |
| 10 | **Chart structure** — higher lows, volume breakout after shake | Trader consensus (X); no academic edge alone | Secondary confirmation |

**Hard negatives (veto before score):** launch-block bundles / `is_bundle`, high `bot_confidence` cohort, mint/freeze authority, failed sell sim, top10 &gt; ~45% young, deployer cold / dump-cluster wallets.

### 1.3 Runner Score v1 (0–100) — concrete weights

Compute only from **information available at decision time** (causal). Clamp each component 0–max, sum, then apply vetoes → 0.

```
RUNNER_SCORE =
  + velocity_pts          # 0–22
  + buyer_accel_pts       # 0–18
  + smart_cluster_pts     # 0–18
  + holder_growth_pts     # 0–12
  + turnover_pts          # 0–10
  + kol_pts               # 0–8
  + deployer_pts          # 0–7
  + narrative_pts         # 0–5
  + structure_pts         # 0–5   (optional; 0 if no 1m candles)
  − penalty_pts           # 0–40
```

#### Component rules (paper defaults)

**A. Velocity (0–22)** — Marino #1  
- Define `trades_to_progress` = swaps needed to reach current curve progress (or mcap for post-grad).  
- Curve lane: if progress ≥20% with ≤50 trades → 22; ≤100 → 16; ≤300 → 8; else 0.  
- Proxy without curve tape: `mcap_usd / max(age_sec, 1)` and `vol_1m / mcap`.  
  - age ≤180s AND vol_m5 ≥ 0.4× mcap → 18–22  
  - age ≤600s AND accelerating vol → 10–14  

**B. Buyer acceleration (0–18)** — mahad1z  
- `unique_buyers_5m` ≥ 21 → +10; ≥ 40 → +14  
- `buyers_per_min` now ≥ 1.5× buyers_per_min of prior 5m window → +4  
- new-buyer share of last 20 buys ≥ 60% → +0–4  

**C. Smart-wallet cluster (0–18)** — MadeOnSol / Marino  
- Count clean early buyers: `!bundle`, `bot_confidence != high`, `tokens_traded ≥ 20`, win_rate ≥ 0.5  
- ≥3 clean alpha in first 20 → 18  
- ≥2 → 12  
- 1 + size ≥ 2× that wallet’s typical size → 8  
- 0 scored → 0 (thin table: hold score pending 2–3 min re-poll; do not treat as pass)  
- Coordinated: ≥2 alpha buys within 10s, **not** same bundle → +4 bonus (cap 18)

**D. Holder growth (0–12)**  
- holders growing ≥15%/5m while price up → 8–12  
- top10 (ex LP) **falling or flat** while holders rise → bonus  
- top10 rising while price pumps → 0–3 only  

**E. Turnover / volume-mcap (0–10)**  
- `vol_15m / mcap` ∈ [0.15, 1.5] AND buy/sell ≥ 1.2 → 8–10  
- Outside band (too quiet or wash-like &gt;3 with unique buyers flat) → 0–3  
- MadeOnSol surge gate analog: buy volume ≥ 3% of mcap gain over window → required for ≥6 pts  

**F. KOL (0–8)**  
- 1 KOL in first 10 buyers → 4  
- ≥2 KOLs ranks 2–10 → 8  
- KOL-only with thin other history → cap at 4 (setup, not organic)

**G. Deployer (0–7)**  
- elite + runner_rate ≥ 0.3 (labeled≥3) → 7  
- good → 5  
- rising (non-instant) → 3  
- unranked → 1  
- cold / instant-bond-only → 0 and add penalty  

**H. Narrative / X (0–5)** — confirm only  
- cashtag/unique authors accelerating 5m→15m AND on-chain buyer accel already positive → 3–5  
- social spike without buyer accel → 0 (promotion)  
- has Telegram/Twitter on metadata → +1 max (Kamat effect is fragile; don’t overfit)

**I. Structure (0–5)** — needs 1m OHLCV  
- ≥2 higher lows after first impulse + volume on breakout reclaim → 5  
- single vertical candle, no base → 0  

#### Penalties (subtract, floor 0)

| Condition | Penalty |
|---|---|
| Bundle share of first 20 ≥ 30% | −20 |
| Bot_confidence high ≥ 50% of first 20 | −15 |
| Dev / linked sell into rally | −25 (veto-ish) |
| Mint or freeze authority live | **hard veto → score 0** |
| Sell simulation fail / transfer hook | **hard veto** |
| Top10 &gt; 45% and age &lt; 30m | −12 |
| Deployer dump-cluster / cold | −15 |
| Wash: high vol, unique buyers &lt; 10 | −20 |

#### Decision thresholds (paper)

| Runner Score | Action |
|---|---|
| **&lt; 40** | Skip / watch only |
| **40–54** | Scalp-only eligible (Mode B), half size |
| **55–69** | Standard entry; prefer Mode A/B |
| **≥ 70** | Moonbag-eligible (Mode C); full lane size |
| **≥ 80 + no penalties** | “High conviction runner” — Mode C defaults, wider trail |

Log every scored mint with component breakdown for walk-forward weight learning (same pattern as `feedback.js` weights).

### 1.4 Paper backtest protocol for Runner Score

1. **Universe:** all FRESH + GRAD candidates JEV already scans; snapshot features at first time score ≥ 40 (and at fixed landmarks: 30s, 1m, 3m, 5m age).  
2. **Labels:** MadeOnSol dump/runner if available; else `runner_proxy_A/B` + peak multiple / time-to-peak.  
3. **Metrics:** AUC / PR-AUC for runner vs dump; precision@top-decile; expectancy of “buy when score≥T” with Mode A/B/C exits; **exclude top 1% trades** in a robustness column.  
4. **Walk-forward:** train weights on week N, test week N+1; freeze list of alpha wallets from prior 14d only (Marino-style).  
5. **Ablations:** drop each component; report lift vs velocity-only and vs current `analyst.js` score≥70.  
6. **Success bar to promote weights:** out-of-sample PR-AUC ≥ baseline+0.05 **and** expectancy &gt; 0 after fees/slippage **and** max DD better than current paper book.

---

## 2. Entry signals (non-runner checklist)

Use Runner Score as primary; keep these as gates:

```
curve_progress 20–80% preferred (test late-curve lane separately)
net SOL flow + over 15s / 60s / 180s
unique_buyers_5m ≥ 21 (start; recalibrate)
top10 non-LP < 35–45%
≥2 independent smart wallets still holding
organic_volume = vol × unique_buyer_share × retention × diversity
```

**Do not** hardcode UTC/ET hour edges until walk-forward proves them.

Current JEV `analyst.js` already scores liquidity, vol, flow, pressure, buyers/min, age, sniper heuristic, social, smartMoney — **extend it with Runner Score components rather than replacing overnight**.

---

## 3. Rug / scam detection (hard exclusions)

1. Mint / freeze authority ≠ null; Token-2022 hooks / permanent delegate  
2. Launch-block / same-block bundles (Bitquery: 21% have dev in block 0)  
3. Cap table: bundle_flags or high bot_confidence dominating first 20  
4. Creator history: many launches, low bond rate, instant bonds only, dump clusters  
5. Wash: high vol / low unique buyers; round-trip same wallets  
6. Sellability: simulate tiny buy+sell on exact route before size  
7. Post-grad: LP ownership / depth at 1–5–10% impact (curve LP is protocol-owned; still dumpable inventory)

**JEV gap today:** `-6%` hard stops still allow −99% rugs (WWIII, KOROSUKE) when liquidity vanishes — need **pre-entry veto + impact-based exit**, not tighter % alone.

---

## 4. Trade-management playbooks (a–d)

### (a) Spike / wick / volume-spike exits

**When:** 1–5m candle range ≥ 2–3× median; volume ≥ 3× baseline; unique-buyer accel stalls; sell prints into wick; price impact worsening.

**Rules (params):**
```
spike_vol_mult >= 3.0 vs 15m median
spike_range_pct >= 12% (FRESH) / 8% (GRAD/MOVER)
on trigger: sell 30–50% of remaining
move stop to max(entry, peak * (1 - 0.5*trail))
no rebuy for cooldown_ms = 45–90s
```

**Paper test:** A/B vs no-spike-exit; measure capture ratio (exit price / peak) and expectancy.

### (b) Scalp runners — sell spike, re-enter pullback

**When:** Runner Score 40–69 **or** structure = higher lows + smart money still net long + liquidity OK for round-trips.

**Rules:**
```
SELL into spike per (a) leaving 40–60% cash from that name
WAIT pullback: −8% to −18% from local high OR into VWAP/prior HL
RE-ENTER only if ALL:
  - reclaim of pullback high or 1m close > prior high
  - buyers_per_min recovering (≥ 0.8× pre-spike)
  - net flow positive on last 60s
  - Runner Score still ≥ 40
SIZE: re-entry ≤ original risk budget; max 2 re-entries per mint per hour
HARD STOP on re-entry: −6% to −10% from re-entry (lane-dependent)
ABORT mode if smart-money cluster exits or holders stall
```

**Paper test:** Mode B vs hold-through; count re-entry win rate separately; cap fees (each round trip costs ~1.25% curve + slip).

### (c) Moonbag — take initials @ ~2×, wide trail

**When:** Runner Score ≥ 70, clean cap table, deployer not dumping, narrative still expanding, liquidity survives first shake.

**Rules (aligns Fullport + three.ws autopsy):**
```
at 2.0× entry: sell ≥ 55% (recover cost + fees) → “initials”
at 3.0–4.0×: sell 20–30% of remainder
moonbag ≥ 15% of original tokens (three.ws: ≥15%)
trail on remainder: 25–35% from peak (wider than scalp’s 10–14%)
hard SL from entry until initials taken: −20% to −35% (not −6% — noise; but liquidity-shock exit always on)
time stop: 24h if no new high / or 6h post-grad flat
smart-money cluster exit → flatten moonbag
```

**Evidence:** three.ws autopsy — take-initials only net+; size as if →0; MadeOnSol runner = peak ≥60m (needs room).

**Paper test:** Mode C vs current ladder (1.5×/2.0× 25% each + 10% trail) on score≥70 subset only.

### (d) Per-trade mode decision (scalp vs ride)

Score each dimension 0–2; sum:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Runner Score band | &lt;40 | 40–69 | ≥70 |
| Holder quality | concentrated | mixed | broad / improving |
| Smart money | exiting | mixed | holding / adding |
| Narrative / X | fading | stable | accelerating + on-chain confirm |
| Liquidity | thin / impact &gt;5% on size | OK | deepening |
| Volatility / structure | disorderly wick | moderate | higher lows / controlled trend |
| Buyer velocity | flat/neg | positive | accelerating |

```
sum 0–4  → no trade or Mode A spike-scalp only (tiny)
sum 5–7  → Mode B scalp runner
sum 8–12 → Mode C moonbag eligible
sum ≥10 + Runner≥80 → Mode C default with wide trail
```

**Override:** any hard rug veto → flat. Dev dump → Mode A max sell. Never average down.

---

## 5. Exits (shared engine)

Default ladder if mode unset (replace current balanced preset gradually):

```
+50–75%:  sell 20%
+100% (2×): sell enough to recover cost (~50–55%)
+200–300%: sell 20–25% of rest
remainder: mode trail (B: 12–18%; C: 25–35%)
time: 60–180s negative flow → cut 25–50%; 3–5m flat buyers → exit
liquidity shock: estimated sell impact > 8–10% → marketable exit now
```

Current JEV presets (`strategies.js`): balanced stop −6%, trail 10%, ladder 1.5×/2.0× @25% — **too tight for runners, too loose for rugs without vetoes**.

---

## 6. Sizing

Base rate + Bitquery 74% losers → **fractional Kelly, tiny**.

```
per-trade risk: 0.10–0.25% of equity (stop distance × size)
notional cap: 0.25–0.75% equity (FRESH smaller)
lane caps: FRESH 0.35 / GRAD 0.40 / MOVER 0.25 of equity open basis (close to lanes.js)
max positions: 2–3 until expectancy proven
daily loss: 1–2%; week DD stop 5–8%
never average down; moonbag never topped up
```

Stress Kelly with −100% rug leg, not average loss.

---

## 7. Execution (paper realism → later live)

- Fees: Pump.fun curve **1.25%**; model slip + priority + failed tx  
- Read: Helius LaserStream / gRPC; market intel: Birdeye or MadeOnSol / SolanaTracker for bonding + KOL  
- Route: direct Pump.fun/PumpSwap when state known; Jupiter fallback  
- Live later: Jito + `dontfront`, tip &lt; expected edge; dual RPC  
- Log: signal→quote→land latency, slip, impact  

---

## 8. Data / API stack (recommendation)

| Need | Prefer | Notes |
|---|---|---|
| Raw chain / webhooks | **Helius** | Infra, not OHLCV |
| Bonding + KOL + deployer + cap-table | **MadeOnSol** (or SolanaTracker) | Runner labels, buyer_quality_score |
| Broad OHLCV / holders | **Birdeye** | WS pricey |
| Free spot check | DexScreener | No history/tape |
| Wallet PnL graphs | Cielo / MadeOnSol | |
| Execution quotes | Jupiter | |
| DIY smart-money list | On-chain PnL, freeze prior 14d, ≥N tokens, drop outliers | Legitimate public data only |

Build alpha list prospectively; never look-ahead.

---

## 9. Survival / studies to cite in reviews

1. Marino et al. arXiv:2602.14860 — velocity, bots, top traders, creators  
2. Kamat et al. arXiv:2607.02823 — 0.198% grad; social HR fragile  
3. mahad1z/memecoin-survival — 21+ unique traders landmark  
4. CoinGecko 18.67M — day-0 death  
5. Bitquery buyers lose / bundles  
6. Arrow Algo 1,411 — naive filters still lose  
7. MadeOnSol methodology — dump/runner definitions, surge gates  
8. three.ws autopsy — exits leak; take-initials net+  

---

## 10. Prioritized concrete JEV paper changes (10–15)

Implement **in order**; each as A/B with tagged `strategyId` / mode; no LIVE.

1. **Add `runnerScore(pair, ctx)` module** with §1.3 weights; log components on every scored mint.  
2. **Gate entries:** require Runner Score ≥ 40 (scalp) / ≥ 55 (standard) / ≥ 70 (moonbag); keep minScore as secondary.  
3. **Hard vetoes before size:** mint/freeze, sell-sim fail, bundle≥30%, bot cohort≥50%, deployer cold.  
4. **Replace raw volume weight** with organic/turnover component (buy-paid mcap move).  
5. **Unique-buyer landmark:** prefer `unique_buyers_5m ≥ 21` when tape available; else buyers/min accel proxy.  
6. **Mode router (d):** attach Mode A/B/C from §4 on fill; store on position.  
7. **Mode A spike exit** in risk agent (vol/range triggers).  
8. **Mode B re-entry state machine** (sold-spike → watch → reclaim).  
9. **Mode C take-initials @ 2.0× ≥55% + trail 25–35%** on remainder; disable −6% hard stop after initials (keep liquidity-shock exit).  
10. **Widen pre-initial stop** on high Runner Score to −15/−25% **or** impact-based; keep −6% only for low-score scalps.  
11. **Cut size:** buyPctMax ≤ 0.12–0.15 until 50+ closed trades show + expectancy; KellyCap ≤ 0.10.  
12. **Time stops:** 90–180s negative flow; 5m flat buyers; 18–30m FRESH max hold unless Mode C.  
13. **Deployer / smart-money enrichment** via MadeOnSol or local whales.js + frozen alpha list.  
14. **Paper fill realism:** 1.25% + slip model + partial fills on thin liq; mark rugs when liq &lt; exit size.  
15. **Dashboard A/B:** expectancy, profit factor, DD, capture ratio, runner precision@score≥70, results **with top 1% trades removed**.

### Suggested first A/B week (paper)

| Arm | Entry | Exit |
|---|---|---|
| Control | current score≥70, −6%/10% trail, ladder 1.5/2.0 | as now |
| T1 | Runner≥55 + vetoes | Mode A+C hybrid (initials@2×, trail 25%) |
| T2 | Runner≥40 | Mode B scalp only |
| T3 | Runner≥70 only | Mode C full |

Promote T* only if OOS expectancy &gt; Control and DD &lt; Control.

---

## 11. Mapping to current engine (do not thrash)

- `analyst.js` — add Runner Score beside existing breakdown; sniper heuristic stays as penalty input  
- `lanes.js` — FRESH/GRAD/MOVER caps OK; tighten FRESH size mult further when score &lt; 70  
- `strategies.js` — add presets `runner_scalp`, `runner_moon`, `spike_tp`  
- `paper.js` risk loop — mode-aware exits + re-entry  
- `smartMoney.js` / `whales.js` — feed cluster component  
- `feedback.js` — learn Runner component weights from closed-trade labels  

**Concurrent UI worker owns `public/*` — this research writes only under `/workspace/jev-research/`.**

---

## 12. Explicit non-goals

- No LIVE enablement  
- No guarantee of profitability (Arrow Algo: many filters still lose)  
- Social/Telegram alone is not an entry  
- Graduation ≠ runner (buyable/bundled grads fail)

---

*End of playbook. Update when walk-forward reweights Runner Score.*

---

## Backtest headlines (free-tier walk-forward)

**Run:** 11/2/2026, 4:46:31 PM America/New_York · sources: pump.fun + DexScreener (free) · fill sim: Jito+MEV+fail · no paid APIs

| Metric | Value |
|---|---|
| Universe | 30 |
| Taken / skipped | 5 / 25 |
| Win rate | 20% (1W/4L) |
| Total PnL (paper $10 ea) | $-3.1101 |
| Avg PnL / trade | $-0.622 |
| Sandwiched fills | 2 |

### By A/B arm

- **T2**: n=1 · pnl=$-0.32 · 0W/1L
- **T1**: n=1 · pnl=$-0.67 · 0W/1L
- **CONTROL**: n=3 · pnl=$-2.12 · 1W/2L

### Walk-forward folds

- Fold 1 (n=10): taken=1 win=0% pnl=$-0.3204
- Fold 2 (n=10): taken=1 win=0% pnl=$-0.6661
- Fold 3 (n=10): taken=3 win=33.3% pnl=$-2.1236

> Caveat: Dex `priceChange` windows are noisy labels (look-ahead haircut 40%). Treat as research ranking, not live expectancy.

---

## Tuning run — 11/2/2026 5:05 PM ET (routine)

**Snapshot:** equity $85.65 (−14.35% from $100; peak $113.22), cash $63.46, 14 closed (4W/8L), realized −$15.08, loss streak 3. Bot **stopped** (`running=false`) after daily-loss limit (12%) + loss-streak cooldown; cooldown itself expired ~16:40 ET.

| Slice | n | W/L | PnL |
|---|---|---|---|
| MOVER | 7 | 4/2 | −$4.98 |
| GRAD | 5 | 0/4 | −$6.09 |
| FRESH | 2 | 0/2 | −$4.01 |
| aggressive preset | 10 | 4 W | −$12.04 |
| ab_harness CONTROL (SCALP) | 2 | 0/2 | −$3.04 |
| T1/T2/T3 | 0 | — | — |

**Observations (no param change — every slice < 20 closed trades):**
1. GRAD hard stops fill at −97% (ANSEMKIN R52) and POGE held at −95%: % stop can't protect against liquidity pulls → pre-entry liquidity/LP veto + impact-based exit is the real fix.
2. MOVER neg-flow cut re-fires every ~8s halving a dust position (WASTED): dozens of $0.00 sells, nonsense pnlPct (−5700%). Needs dust force-close + one-shot cut.
3. Legacy positions have no `timeStopAt` (three/WASTED/POGE held 45–55 min).
4. A/B arms T1–T3 have 0 trades; runner≥55/70 gates rarely pass on free data.

**Concurrent work in progress (uncommitted, another worker, 17:04–17:06 ET):** mint cooldown/blacklist, dust close, MOVER age gate + caps, time-stop backfill, auto-resume after daily-loss. Covers 2 & 3 above; routine did not edit code to avoid collision.

**Next hypotheses (once ≥20 on slice):** (H1) GRAD lane: require liq ≥ $15k and LP/impact check, or drop GRAD SCALP < R55. (H2) Count rug-stops separately and measure expectancy ex-rugs to see if exits or entries are the leak.

## 2026-11-02 — v17 hold / rebuy / novelty / X buzz

### Live diagnosis (pre-fix)
- Open holds: `three` MOVER ~52m (token age ~187d), `WASTED`/`POGE` dust zombies from repeated 50% neg-flow cuts.
- Activity flooded with same-symbol micro-sells; slots blocked so FRESH starved (lane buys FRESH2 / GRAD5 / MOVER7).
- `timeStopAt` null for GRAD/MOVER (laneRisk only set FRESH); CONTROL `timeStopMs: null`.
- Daily loss set `running=false`, which **froze protective exits** in `tickPrices`.

### Fixes
1. Per-mint cooldown (45m) + stop-loss blacklist (24h); Mode B reclaim capped at 1.
2. Max hold: FRESH/SCALP 15m, GRAD/MOVER/RIDE 45m, MOON trail + stall; backfill legacy positions.
3. Novelty bias + MOVER age gate / cap 1 open MOVER; prefer never-traded FRESH/GRAD.
4. Dust sweep + neg-flow full exit; protective exits run even during buy cooldown.
5. X buzz: bearer-enabled, 1 cached counts query/tick for top candidates only.

LIVE_ENABLED remains false.
