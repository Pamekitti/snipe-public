# Longer backtest: more history weakens the case for three recovery updates

The backtest now covers 48 hours, one week and two weeks. The added history does
not establish a replacement for the current market guard. Three recovery updates
retain a recent advantage when filtering recorded trades, but give up profit in
the broader opportunity model.

The frozen endpoint is **8 September 2026 at 11:52 London time**
(10:52:43.423 UTC). The two-week window starts on 25 August at the same time.
All dollar figures use the frozen conversion of $2,485.805 per ETH.

| Window | Historically eligible launches | Usable curve replays | Recorded signals | Reconstructed signals |
|---|---:|---:|---:|---:|
| 48 hours | 914 | 893 | 893 | 0 |
| 7 days | 2,961 | 2,921 | 1,390 | 1,531 |
| 14 days | 3,857 | 3,808 | 1,390 | 2,418 |

The full collection contains 3,945 complete requested log ranges, including a day
of signal warmup and 76 supplementary template rejections. All requests finished
without a remaining fetch error. In the primary two-week universe, 49 curves had
no enterable path at the assumed entry time. They are unavailable, not zero-profit
trades. Recorded indicator availability spans 61.8 hours; earlier timing requires
reconstruction.

## What changed in the comparison

These figures show **extra profit versus the current guard** under the same
assumptions. Positive means the alternative earned more.

| Comparison | Period | Two recovery updates | Three recovery updates |
|---|---|---:|---:|
| Filter recorded trades | 7 days | +$42 | +$86 |
| Filter recorded trades | 14 days | +$42 | +$86 |
| Model eligible opportunities | 7 days | -$446 | -$473 |
| Model eligible opportunities | 14 days | -$460 | -$566 |

The recorded-trade comparison uses 896 actual closed attempts: 830 completed
trades and 66 non-trade closures. It preserves five historical stake sizes and
booked costs. Three older closures lack receipt reconciliation. Their combined
0.01 ETH booked loss receives a separate zero-loss sensitivity in results.json.
Removing that uncertain loss leaves both alternatives' advantage unchanged.
This comparison can only retain or remove historical attempts. It cannot establish
what additional trades an alternative policy would have executed.

The opportunity experiment includes originally skipped launches. It reprices each
curve at 0.02 ETH with a common fixed 1.75 take profit and the same 45-second cap.
This isolates the market guard. It does not replay the full adaptive live strategy.

Three updates beat the baseline on **one of 14 days** in the recorded-trade
comparison and tied on the other 13. In the opportunity experiment, three beat
the baseline on **two of 14 days**, lost on seven, and tied on five. These are
rolling daily bins sharing account state, not independent statistical trials.

| Two-week drawdown | Current guard | Two updates | Three updates |
|---|---:|---:|---:|
| Recorded-trade replay | $212 | $212 | $212 |
| Opportunity model | $571 | $465 | $465 |

The stricter rules reduce modeled downside at the cost of modeled profit. Their
recent protection does not extend to an improvement in maximum recorded-trade
drawdown over the full period.

## Robustness and realism

Three remains behind the baseline over 14 days under each sell-latency and return
stress. It also remains behind with reconstructed scoring delays of two or ten
minutes. Including the 76
original template rejections also leaves three behind. A 15-second housekeeping
clock shift changes two's two-week result from -$460 to +$16. This sensitivity
precludes a precise profit forecast.

The indicator calculation reproduces all **1,390 matched recorded outcomes
exactly**. Its mean, median and sample sd reproduction error are all zero.
Five independent individual-curve requests also exactly match the batched data.
That validates the input calculation, not the execution model.

On 155 matched current-size fills, the execution model understates booked profit
by **0.181 ETH**. Two graduation exits account for **0.193 ETH** of the shortfall.
The return error has mean **-5.85 percentage points**, median **-0.83**, sample sd
**60.70**, and **n=155**. The model does not adequately price V4 graduation recovery.
Rare failed orders, retries, historical funding, touch guards, template feedback
and other traders' reactions also remain incomplete.

The oldest week had a fresh 20-launch window on 5,979 of 20,160 clock readings
(30%). The latest week had one on 17,155 of 20,160 readings (85%). Two calendar
weeks do not provide two weeks of equally active guard decisions.

## Decision

Keep the current live guard while improving validation. The earlier preference
for three was based on a benefit concentrated in one recent day. The longer data
show a profit-versus-drawdown tradeoff and material execution uncertainty. Neither
two nor three is a supported live optimum. No live setting or deployment changed.

The full report (unavailable historical artifact: `../data/market-guard-longer-20260908/report.md`) contains all seven
fixed policies, nightly results, daily comparisons, cash bins and stress tables.
The [protocol](MARKET_GUARD_LONGER_PROTOCOL.md), scripts, raw snapshot, complete
paths, source hashes, calibration rows and reproduction commands are retained.
Forty-two focused tests pass, and daily sums reconcile to period totals.
