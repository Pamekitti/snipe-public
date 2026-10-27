> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Paper, market and real execution alignment

Captured 13 September 2026 at 2026-09-13T13:25:38.745Z. Read-only investigation. No live settings or code changed.

Real execution lost more than paper on the matched sample, but large individual errors dominate. The simulations are not validated wallet forecasts.

## Matched amounts

All matched attempts used 0.02 ETH and identical pinned take-profit targets. Actual values prefer onchain_pnl_wei over pnl_wei. All 38 actual matched values have receipt accounting. Counts include failed buy attempts.

| Sample | Matched attempts | Actual ETH | Paper ETH | Paper minus actual ETH |
|---|---:|---:|---:|---:|
| All available paper matches | 38 | -0.109964 | -0.086636 | 0.023328 |
| Normally captured, excluding outage repairs | 24 | -0.047702 | -0.038010 | 0.009691 |
| Reconstructed outage captures | 14 | -0.062263 | -0.048626 | 0.013637 |
| Last 24 hours | 22 | -0.105407 | -0.091413 | 0.013994 |
| Last hour | 10 | -0.053179 | -0.042862 | 0.010317 |

There were 47 actual attempts since paper recording began; 38 have published paper counterparts, and nine were rejected by the independent paper account. These totals therefore cannot explain the whole-wallet path without the unmatched attempts. Real and paper account stops and template-loss histories differ.

Paper and real profit/loss signs agree on 35/38 attempts. Two discrepancies are actual reverted buys modeled as winners; the third is RQTE. Excluding failed buys, signs agree on 35/36 trades.

## Error distribution

Errors are simulated return minus actual return, in percentage points of the attempt's stake. Positive means optimistic. Spread is sample standard deviation.

| Sample | n; mean / median / sd error, pp | n; mean / median / sd absolute error, pp |
|---|---|---|
| All matches | 38; 3.07 / -0.05 / 16.78 | 38; 8.58 / 1.51 / 14.68 |
| Normally captured | 24; 2.02 / -0.07 / 16.60 | 24; 7.80 / 1.90 / 14.71 |
| Outage repairs | 14; 4.87 / 0.13 / 17.55 | 14; 9.92 / 1.31 / 15.08 |
| Last 24h | 22; 3.18 / 0.13 / 20.69 | 22; 11.60 / 2.17 / 17.25 |

Only 15/38 paper outcomes exceeded their actual counterparts. The median error is near zero; large optimistic errors outweigh the many small pessimistic ones. A uniform discount would not fix this.

The 38 matched attempts paid 0.000993 ETH actual gas. Their paper-minus-actual gap is 0.023328 ETH. Paper already models gas, and even all actual gas is far smaller than this gap.

## Concrete discrepancies

| Position | Actual ETH | Paper ETH | Evidence |
|---|---:|---:|---|
| PACT 2522 | -0.011086 | -0.000928 | Paper allocated 2.1378 times the actual buy-event tokens at the same 0.02 ETH stake. Normally captured. |
| MID 2535 | -0.010505 | -0.001241 | Paper allocated 1.9805 times the actual buy-event tokens. Reconstructed outage capture. |
| PORT 2505 | -0.007590 | -0.001180 | Paper exited on dead-coin rule after about 21 seconds; actual held about 46 seconds and exited on time. |
| Anny 2490 | -0.000009 | +0.004404 | Actual buy reverted; paper acquired a winning position. Normally captured. |
| EVERYTHINGPAD 2530 | -0.000008 | +0.006565 | Actual buy reverted; paper acquired a winning position. Reconstructed outage capture. |
| RQTE 2525 | -0.000460 | +0.003911 | Actual exited dead at 12:17:40.780 UTC; paper triggered take profit at 12:17:41.045 and settled at 12:17:42.245. |
| FROGE 2512 | -0.004687 | -0.014050 | Large error in the other direction; cancellation can hide trade-level inaccuracy. |

The actual token quantities above were checked against the CurveBuy events inside the stored independently collected source logs, not just the position's expected token field.

The execution kernel uses whole-second block timestamps and preceding-trade median send/open delays. It cannot recover actual subsecond ordering. Its hypothetical simBuy does not receive the real minimum-token limit, so it cannot reproduce that class of buy rejection. It uses a fixed 1200 ms sell delay. Different observed price paths also change dead-coin versus time exits. These are established model limitations; the exact event-order explanation for each token requires replaying its complete decision trace.

## Last 24 hours, eight bins

Each row ends three hours after its start. Empty matched samples are unavailable for model comparison, not evidence of zero error.

| UTC start | Actual attempts | Matched | Matched actual ETH | Paper ETH | n; mean / median / sd error pp |
|---|---:|---:|---:|---:|---|
| 09-12 13:25 | 7 | 4 | -0.030937 | -0.040745 | 4; -12.26 / -3.66 / 23.70 |
| 09-12 16:25 | 0 | 0 | NA | NA | NA |
| 09-12 19:25 | 0 | 0 | NA | NA | NA |
| 09-12 22:25 | 0 | 0 | NA | NA | NA |
| 09-13 01:25 | 0 | 0 | NA | NA | NA |
| 09-13 04:25 | 0 | 0 | NA | NA | NA |
| 09-13 07:25 | 0 | 0 | NA | NA | NA |
| 09-13 10:25 | 19 | 18 | -0.074469 | -0.050667 | 18; 6.61 / 0.13 / 19.00 |

## Last seven days, seven bins

Each row ends 24 hours after its start. Paper recording began 11 September at 23:44 UTC. Earlier bins have no comparable current paper record. We do not pool earlier trading sizes and policy eras into the paper fidelity verdict.

| UTC start | Matched attempts | Actual ETH | Paper ETH | n; mean / median / sd error pp |
|---|---:|---:|---:|---|
| 09-06 13:25 | 0 | NA | NA | Outside paper capture era |
| 09-07 13:25 | 0 | NA | NA | Outside paper capture era |
| 09-08 13:25 | 0 | NA | NA | Outside paper capture era |
| 09-09 13:25 | 0 | NA | NA | Outside paper capture era |
| 09-10 13:25 | 0 | NA | NA | Outside paper capture era |
| 09-11 13:25 | 16 | -0.004558 | 0.004777 | 16; 2.92 / -0.07 / 9.75 |
| 09-12 13:25 | 22 | -0.105407 | -0.091413 | 22; 3.18 / 0.13 / 20.69 |

## Market alignment

The live setting checked during this investigation is VENUE_FRESH_RECOVERY=false. The active market guard is fixed 1.75x, last 20, pause below -1 and resume above +2. It is not the requested adaptive latest-eight recovery policy. No setting was changed in this investigation.

A separate later check on the same latest 20 paper tokens gives paper -7.0433 stakes versus fixed-bar replay -7.2729 stakes. Both describe deterioration. Those rolling recent sums must not be compared with the cumulative positive month-to-date paper balance.

The market replay is a different simulation and population. Over the last 24 hours, on 26 actual attempts, its fixed-bar sum was -3.6859 stakes against actual -4.8538 stakes. At each real trade's target, replay was -4.4581. These are normalized return comparisons, not predicted ETH at an unmodeled stake.

## Trust and next work

1. Actual receipt-accounted P&L is the source for earned or lost money.
2. Paper is useful for diagnosing paths and opportunities, but its cash forecast is not realistic enough to trust yet. The small sample and repaired timing are explicit limitations.
3. Market is a recent simulated condition measure. Its positive reading is not evidence that real entries will earn money.
4. Apply the actual entry limit and failed-buy modeling; validate event order, fills and exits at the real stake; retain prospective results separately from retrospective repairs.
5. Show matched actual/paper returns, unmatched counts, entry-fill error, and sign errors together. Require accuracy checks before using simulated profit as a live forecast.

No fresh validate-replay certificate was generated here. This matched observational audit is diagnostic only and does not establish prospective profitability.

Sources: live bot.db positions and shadow_jobs, gate.db obs; src/strategy/counterfactual.ts; src/strategy/shadow-worker.ts; src/strategy/gate.ts; live /api/state. Capture comparisons are pinned to the timestamp above.

