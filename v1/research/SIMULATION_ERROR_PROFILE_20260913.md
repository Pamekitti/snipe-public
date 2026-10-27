# Observed simulation error, 13 September 2026

The shared simulator reproduces the earlier profitable period and the later losing period under the tested assumptions. Its earnings accuracy remains insufficient for a validated profitability claim.

This document freezes a **diagnostic reference scenario**, `q5000-rank0.5-sell1200-after`.
It was a display example declared before scoring, not a fitted winner or a promoted default.
Neither live trading nor the production indicator settings changed.

## What these deviations mean

The measurements below describe this historical sample. They are not expected future errors, confidence intervals, or maximum possible losses.
The profitable period contains missing historical settings that required assumptions.
September was already inspected before this study, so it is retrospective evidence.

Use this profile to compare later audits with a fixed reference.
Continue showing execution stresses when comparing ideas.
Do not subtract one constant percentage from simulated profit or assume that a conservative monthly result is conservative on each trade.
The same scenario understated profit earlier and understated losses later.

## Frozen settings

| Input | Reference value or provenance |
|---|---|
| Shared engine | `execution-account-v3` |
| Model hash | `a786d53c6a59dad0060d983bb91a4f1d805d2f056849b948618084f655fdabad` |
| Send delay | Actual recorded send time minus decision time, available before inclusion |
| Buy inclusion | 300 ms after send, assumed |
| Fill adoption | 600 ms after send, assumed |
| External-log observation delay | 600 ms, assumed |
| Buy position inside the unresolved second | Fraction 0.5 among whole external transactions, subject to the causal floor |
| Sell delay | 1,200 ms, assumed |
| Same-time sell ordering | `after` |
| Reconstructed entry quote | Invert the recorded minimum using a 50% slippage assumption; retain the submitted minimum unchanged |
| Exit checks | Every 50 ms |
| Stake and TP | Each attempt's recorded stake and pinned TP; the recorded TP selector itself is not revalidated by this test |
| Exit rules | 45-second maximum hold; 0.5 hard stop; dead-trade exit at 20 seconds below 1.03 |
| Entry-price multiple | 4.5 |
| Rule provenance | Recorded context when present; documented historical rules assumed where context is missing |
| Cost samples | Latest 100 eligible successful receipt pairs closed more than six hours before entry; at least 20 pairs |
| Cost calculation | Separate integer medians for buy and sell gas; preceding approval median when at least 20 approval records exist |
| Missing approval history | Preceding median sell gas is an explicit approval-cost proxy |
| Approval delay | 600 ms |
| Sell retries | 500 ms retry interval, maximum 20 attempts; zero assumed failed-sell attempts in the fixed cost input |
| Replay horizon | Up to 180 seconds after entry, capped at capture |

Cost availability is modeled from completed receipts. Historical local publication times remain unproved.
Actual current fills, costs and net cash serve as comparison labels, not inputs used to force a matching prediction.
The model excludes our wallet's historical orders and recalculates external orders against simulated reserves.
Other traders' reactions to different orders remain unknown.

## Coverage and net cash

Capture: **1 September 00:00 UTC through 13 September 15:30 UTC**, or 16:30 London.
The source contains no recorded attempts on September 1–3.
All 1,190 source paths were verified and scored under 36 fixed scenarios.
The common receipt-reconciled comparison contains 1,182 attempts.

| Period | Compared / recorded attempts | Actual net ETH | Reference simulated net ETH | Sim minus actual ETH | Deviation relative to absolute actual net |
|---|---:|---:|---:|---:|---:|
| Sep4–7 | 900 / 908 | +0.551015 | +0.449216 | −0.101799 | −18.47% |
| Sep8–13 | 282 / 282 | −0.408750 | −0.394811 | +0.013939 | +3.41% |
| Combined | 1,182 / 1,190 | +0.142265 | +0.054405 | −0.087860 | −61.76% |
| Final six hours, subset of Sep8–13 | 32 / 32 | −0.138493 | −0.127544 | +0.010949 | +7.91% |

A positive signed deviation means the simulator is more optimistic than actual cash.
The final-six-hour row overlaps the other rows and must not be added to them.
Net percentages can become large when winning profit and losing loss nearly cancel.

Eight unreconciled labels contribute **+0.161775 ETH** to recorded net.
They remain in the full-history chart and the exclusion inventory.
Their small count does not make their missing cash evidence immaterial.
All-recorded September net is +0.304040 ETH; it must not replace the matched +0.142265 ETH denominator above.

## Four reproduction ratios

Each ratio is simulated total divided by actual total on identical matched attempts.
100% means equal totals; values above 100% mean overstatement.
These measure reproduction accuracy, not the guard's retention against an always-on account.
Zero denominators are unavailable.

| Period | Winning trades | Losing trades | Winning money | Losing money |
|---|---:|---:|---:|---:|
| Sep4–7, n=900 | 96.50% | 103.51% | 99.00% | 107.53% |
| Sep8–13, n=282 | 101.41% | 99.53% | 107.51% | 103.52% |
| Combined, n=1,182 | 97.24% | 102.30% | 101.53% | 105.53% |
| Final six hours, n=32 | 133.33% | 96.55% | 146.52% | 96.85% |

Combined winning money was overstated by 1.53% and losing money by 5.53%.
Those apparently small aggregate differences still reduced simulated net profit by 61.76%.
Matching aggregate counts also does not establish that the same trades won.

## Individual-trade deviation

Define signed error as `100 × (simulated net − actual net) / that attempt's recorded stake`.
Absolute error is the magnitude of that number, in percentage points of stake.
It is not a percentage of profit.

| Period | Absolute error mean | Median | Sample SD | Empirical p95 | n |
|---|---:|---:|---:|---:|---:|
| Sep4–7 | 13.81 | 2.95 | 33.87 | 64.25 | 900 |
| Sep8–13 | 6.62 | 0.77 | 17.56 | 36.78 | 282 |
| Combined | 12.10 | 2.46 | 30.92 | 55.85 | 1,182 |
| Final six hours | 4.92 | 0.83 | 8.92 | 26.73 | 32 |

For a 0.02 ETH stake, 2.46 percentage points corresponds to about 0.000492 ETH of cash error.
The combined empirical p95 of 55.85 points corresponds to about 0.01117 ETH at that stake.
These are scale illustrations, not forecasts or a claim that each stake era has the pooled error distribution.
The empirical percentile uses the existing `describe()` function; larger historical errors exist beyond p95.

| Period | Signed error mean | Median | Sample SD | n |
|---|---:|---:|---:|---:|
| Sep4–7 | −0.025 | −0.802 | 36.583 | 900 |
| Sep8–13 | +0.247 | −0.075 | 18.773 | 282 |
| Combined | +0.040 | −0.520 | 33.206 | 1,182 |
| Final six hours | +1.711 | −0.035 | 10.079 | 32 |

The near-zero signed average hides cancellation between optimistic and pessimistic errors.
It also weights each trade by its own stake, so its sign can differ from the total ETH deviation.

## False winners and drawdown

| Period | Profit/loss/zero sign agreement | Predicted profit, actual loss / predicted winners | Predicted profit, actual zero / predicted winners | Predicted loss, actual profit / actual winners |
|---|---:|---:|---:|---:|
| Sep4–7 | 819 / 900 (91.00%) | 18 / 386 | 9 / 386 | 38 / 400 |
| Sep8–13 | 267 / 282 (94.68%) | 8 / 72 | 0 / 72 | 7 / 71 |
| Combined | 1,086 / 1,182 (91.88%) | 26 / 458 | 9 / 458 | 45 / 471 |
| Final six hours | 31 / 32 (96.88%) | 1 / 4 | 0 / 4 | 0 / 3 |

Combined, 35 of 458 predicted winners did not produce an actual profit.
That includes 26 actual losses and nine zero outcomes.
The one false winner on the latest day was one of only four predicted winners.

| Period | Actual cumulative closed-cash drawdown ETH | Simulated drawdown ETH | Sim minus actual ETH |
|---|---:|---:|---:|
| Sep4–7 | 0.202363 | 0.228283 | +0.025920 |
| Sep8–13 | 0.418340 | 0.400983 | −0.017357 |
| Combined | 0.431765 | 0.498939 | +0.067174 |
| Final six hours | 0.138493 | 0.127544 | −0.010949 |

Accounting resets do not erase cash in these totals.
These drawdowns use completed-trade cash, not the lowest intratrade wallet valuation.
They describe the matched historical attempts, not an independently selected continuous paper account.

## Why the accuracy verdict remains diagnostic

The existing [acceptance limits](BACKTEST_LIMITS_V1.json) remain unchanged.
The combined mean absolute error of 12.10 points exceeds the 5-point limit.
Its median of 2.46 exceeds 1.5, and p95 of 55.85 exceeds 10.
Sign agreement of 91.88% is below 95%.
The missing historical context, modeled availability times and eight unreconciled labels also prevent a full fidelity pass.

All 36 scenarios showed earlier profits and later losses on the common sample.
However, earlier simulated net ranged from +0.109982 to +1.071317 ETH against +0.551015 ETH actual.
Later simulated net ranged from −0.551497 to −0.044255 ETH against −0.408750 ETH actual.
Those ranges measure assumption sensitivity; they are not confidence bounds.

The fixed example differs from the earlier 281-trade, preceding-calibrated inclusion study.
Its error measurements cannot be transferred to that study or silently assigned to the live shadow indicator.
It also does not validate historical guard admissions, capacity, account stops, or the TP selector's broader observation population.

## How to use this reference in later research

1. Identify the model hash, scenario, UTC cutoff and matched sample in every error claim.
2. Keep winning and losing periods, all four reproduction ratios, tail errors and missing cash visible.
3. Recompute the error profile when execution code, assumptions, stake or policy behavior changes.
4. Keep the unchanged fidelity checks as the acceptance gate. A close aggregate or this document cannot grant a pass.
5. Freeze predictions before new outcomes arrive, then measure prospective errors. Do not force live trades to obtain samples.

No reliable future error allowance has been established.
In particular, this study does not support claims such as “the simulator is within 5%” or “real losses need a fixed 8% adjustment.”

## Evidence and reproduction

- [Machine-readable profile](SIMULATION_ERROR_PROFILE_20260913.json), including exact wei totals, distributions and source hashes.
- Full study report (unavailable historical artifact: `../data/research/20260913-both-periods-v1/report.md`), including charts and all 36 scenarios.
- Frozen run (unavailable historical artifact: `../data/research/20260913-both-periods-v1/run-freeze.json`), protocol (unavailable historical artifact: `../data/research/20260913-both-periods-v1/protocol.json`), and unreconciled labels (unavailable historical artifact: `../data/research/20260913-both-periods-v1/excluded.json`).

From `bot/`, with the frozen inputs present:

```sh
python3 -m research.core.both_periods run --root data/research/20260913-both-periods-v1
python3 -m research.core.both_periods_report --root data/research/20260913-both-periods-v1
```

The completed study passed 286 research tests and 432 replay spot checks.
Three scalar checks agreed, and the charts were inspected.
These engineering checks verify the calculations, not future earnings.
