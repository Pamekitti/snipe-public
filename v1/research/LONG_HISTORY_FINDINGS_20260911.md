# The longer history supports matching the indicator to the traded launches

**The strongest automatic-trading candidate by simulated profit is `fixed_shadow20`.**
It measures net outcomes from the launches admitted by a policy-matched shadow account.
It retains a fixed 1.75x scoring target. The actual trading account keeps adaptive exits.
The fully adaptive indicator, `matched20`, gives up a little profit for lower drawdown
in the central longer comparison.

These are useful comparative results. They are not exact earnings predictions. No live
code, settings, stake, halt state or account reset changed during this evaluation.

The final selection and four-KPI line charts (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/final-selection/decision.md`)
record `fixed_shadow20` as the chosen candidate for implementation. Losing-trade and
losing-money percentages there are retained losses, exactly as requested.

## What was tested

The capture ends **11 September 2026 at 12:44:12.950 UTC**. Actual booked cash starts
on 17 August. The modeled comparison covers **19 August to 11 September, 23 days**,
after calibration and warmup. The requested earlier portion of 45 days is unavailable.
This is a frozen historical dataset, not a chart that keeps updating live.

All 6,965 prepared launches have curve paths, parameters and timestamps. There are
5,600 historically screen-passed models meeting the current static entry criteria,
including warmup. Every guard faces the same admission population and trading config.
The historical screen decisions remain fixed; this study does not retest rejected filters.

The replay contains 19 policies in 132 continuous-account groups and 132 common-interval
groups. Six scenarios assume automatic operation. Six preserve recorded human controls.
They combine two histories of indicator availability and three sell delays, 600, 1,200
and 2,000 milliseconds. These scenarios overlap and are not independent statistical trials.

Ten graduated-market executions remain unresolved under at least one stake or delay.
The longer comparison therefore uses **11 separate, common coverage intervals**.
Their total omitted admission time is 63 minutes, including equal closing tails.
Each interval starts a flat account. **The sums below are conditional comparison scores,
not one continuously running wallet.** Renewed risk budgets at the boundaries can matter.
The strict account tests keep these unknowns visible instead of assigning zero returns.

## Automatic operation: profit and loss together

The central case reconstructs earlier missing fixed-target observations and uses a
1,200 ms sell delay. Account stops remain enabled except in the always-on reference.

| Guard | Sum of interval net, ETH | Worst interval drawdown, ETH | Change vs current, ETH |
|---|---:|---:|---:|
| Current -1/+2 | +2.794528 | 0.169970 | 0 |
| Same admitted launches, fixed 1.75x indicator | **+3.209405** | **0.134635** | **+0.414877** |
| Same admitted launches, adaptive indicator | +3.140330 | 0.089439 | +0.345802 |
| Keep an existing pause while stale | +2.807202 | 0.151023 | +0.012674 |
| Recent weighted profit | +3.013499 | 0.110989 | +0.218971 |
| Staged entries | +2.427671 | 0.065700 | -0.366857 |
| Always on, all stops disabled | +4.669646 | 0.250101 | +1.875118 |

The fixed-target matched indicator adds about **14.8%** to the current guard's comparison
score and reduces its worst interval drawdown by about **20.8%**. Always-on captures more
profit, but its larger drawdown fails the agreed risk comparison.

Both matched indicators improve net cash, worst-interval drawdown and recovery losses
in **all six automatic scenarios**. Both also pass those comparisons when publication
is delayed by another 60 seconds. That extra stress was added after identifying the
leaders and did not change their original scores or thresholds.

The fully continuous automatic account starting 9 September at 12:44 UTC provides a
separate 48-hour check. Current guard: **-0.009439 ETH**. Fixed-target matched indicator:
**+0.035316 ETH**. Adaptive matched indicator: **+0.054065 ETH**. All three accounts are
complete at the central delay. These figures do not use coverage-boundary resets.

## The requested capture metrics

Every percentage uses the same always-on interval reference. Loss avoidance is one minus
the share of always-on losses retained. Positive values therefore mean fewer losses.

| Guard | Winning trades captured | Losing trades avoided | Winning profit captured | Losing money avoided |
|---|---:|---:|---:|---:|
| Current | 45.7% | 59.5% | 47.0% | 58.0% |
| Matched launches, fixed target | 44.0% | 62.3% | 46.8% | 61.8% |
| Matched launches, adaptive target | 42.9% | 62.9% | 45.6% | 62.9% |

The improvement primarily comes from avoiding more losing money while retaining most
of the current guard's winning profit. Captured winners alone would miss that distinction.

| Guard | Mean / median / sample SD / attempt count, ETH |
|---|---|
| Current | +0.001614 / -0.000924 / 0.010233 / 1,731 |
| Matched launches, fixed target | +0.001969 / -0.000918 / 0.010431 / 1,630 |
| Matched launches, adaptive target | +0.001963 / -0.000929 / 0.010407 / 1,600 |

## Proposed behavior

Keep the 20-launch window and the -1/+2 thresholds for the leading candidate. Change
what is measured: the shadow account's admitted launches, with entry timing, normal
stake and costs included. Score them at 1.75x after the result becomes available.
Insufficient evidence or any of the 20 launches being older than three hours blocks entry.
The actual take-profit selector and the other account stops retain their existing rules.
The separate drawdown-recovery monitor is unchanged in these tests.

```text
Policy-matched shadow account admits a launch
                    |
          Net result becomes available
                    |
       Latest 20 scored launch outcomes
                    |
       incomplete or stale -> PAUSE
       sum below -1        -> PAUSE
       sum above +2        -> ALLOW on new evidence
       between thresholds  -> KEEP STATE
                    |
       Existing account stops still apply
```

The evidence does not establish that 20 trades or a fixed 1.75x sensor is inherently
wrong. Shorter windows, slope rules and staged entries did not consistently improve
the longer comparison. The cohort, costs and timing appear more useful places to improve
the sensor. This inference comes from comparing the frozen candidates, not from fitting
a new threshold after seeing their results.

## What does not hold up

The larger replacements lose their advantage in most scenarios that replay recorded
human stops and restarts. Their timing interacts with those controls. A positive sensor
cannot override an operator stop or drawdown stop. The charts separate these cases.

Neither replacement preserves every profitable period under every assumption. In the
strong 5 September 15:10 to 7 September 18:25 interval, the current guard scores
+1.78466 ETH and the fixed-target replacement +1.44423 ETH. The replacement gains
elsewhere, but this is a tradeoff. No candidate passes every predeclared condition.

Keeping an existing pause while stale is the most consistent smaller change. It improves
net results and worst-interval drawdown in all 12 original scenarios. Its central
recorded-control gain is only +0.011482 ETH and comes from four fewer completed attempts.
It should not be presented as a solution to the entire profit-capture problem.

Before 5 September at 21:03 UTC, the stored monitor lacks per-target outcomes. The
adaptive selector uses its documented 1.75x fallback. Reconstructed fixed-target readings
are a separate scenario. Neither supplies a complete historical modern adaptive monitor.

All candidates were frozen before the longer comparison, but the ideas originated in
already-inspected losses. The final six hours supplied no calibration costs. They are
still retrospective data. The previous-week ranking diagnostic mostly selected accounts
that remained stopped, so it adds little forward-selection evidence.

## Verification and artifacts

All 194 research tests pass. The optimized indicator matched the original on 2,500
randomized queries, including backward clocks. All 5,836 execution models use at least
20 preceding calibration attempts. Every calibration observation predates entry and
the final-six-hour cutoff. Integer cash sums and attribution identities pass for all
132 strict groups and all 132 interval groups.

The chain benchmark matches 186,098 of 186,098 checked transaction-math results.
That validates a component, not the entire simulation. The existing actual-cash replay
certificate passes 18 of 57 checks and remains diagnostic. Known differences in timing,
admissions and failed buys remain material. Comparative historical evidence can still
support the candidates above without treating their ETH totals as forecasts.

- Actual cash history (unavailable historical artifact: `../data/research/20260911-history-charts/history.png`)
- Automatic profit and risk (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/automatic-profit-risk.png`)
- Automatic cash and indicators, latest 24 hours (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/automatic-cash-indicators-24h.png`)
- Automatic candidate behavior and tables (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/automatic-report.md`)
- Recorded-control comparison and all 12 scenarios (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/comparative-report.md`)
- Continuous accounts from different starting dates (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/report.md`)
- Publication stresses, chronological checks, and bins (unavailable historical artifact: `../data/research/20260911-long-history-results-v2/supplemental-report.md`)
- [Frozen protocol](LONG_HISTORY_PROTOCOL_20260911.md)

Chronological testing reduces look-ahead bias but cannot ensure that future markets match
the historical distribution. See [CFA Institute](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation).
Repeated historical strategy searches can overstate performance. See
[The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).
