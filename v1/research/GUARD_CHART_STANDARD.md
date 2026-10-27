# Guard wallet charts and retention KPIs

Use the same five-panel line chart for every guard comparison. Change the data and
policy labels, while keeping the panels, units and denominators consistent.
The completed example is the [September 14 handoff](FOCUSED_GUARD_HANDOFF_20260914.md).
Execution accuracy still follows [BACKTEST_STANDARD.md](BACKTEST_STANDARD.md).

## Two headline KPIs

For each completed attempt, let `p` be its net ETH after modeled execution costs.
Within the displayed period and up to each plotted time, calculate:

```text
winning ETH = sum(max(p, 0))
losing ETH  = sum(max(-p, 0))

Win retained (%)  = 100 × candidate winning ETH / reference winning ETH
Loss retained (%) = 100 × candidate losing ETH  / reference losing ETH

profit missed = reference winning ETH − candidate winning ETH
losses avoided = reference losing ETH − candidate losing ETH
```

Higher Win retained and lower Loss retained are preferable. Neither is net return.
Zero denominators are unavailable, not zero or 100%. Do not clamp ratios to 100%:
independent capacity and template histories can let a candidate capture opportunities
the reference account misses. Negative profit missed or losses avoided also remain visible.
Trade-count ratios are no longer headline KPIs. Keep closure counts as context.

The reference is an executable market-guard-disabled account with the same stake,
filters, adaptive TP, exits, capacity and execution scenario. The September focused
run uses the reference **without DD** for both candidate-with-DD and candidate-without-DD
ratios. Keep that denominator fixed and say so on the chart.
An unrestricted opportunity sum is a separately labeled reference, not a wallet.
Exit comparisons must additionally retain the fixed current-exit denominator.

## Five aligned panels

| Order | Panel | Required convention |
| --- | --- | --- |
| 1 | Simulated wallet P&L, ETH | Cumulative closed-attempt cash, starting at zero for the displayed period; show each line's final ETH in its legend |
| 2 | Drawdown, ETH | Running cash peak minus current cash; zero at the top, larger losses downward |
| 3 | Win retained, % | Cumulative winning-money ratio; show its final percentage in the legend |
| 4 | Loss retained, % | Cumulative losing-money ratio; show its final percentage in the legend |
| 5 | Market indicator, stakes | Main and fresh sums, execution-scenario range, brake and active recovery thresholds |

Use step lines at actual modeled cash closures and indicator decision times.
Do not interpolate an indicator slope or treat expiring losses as new profit.
The indicator uses published compatible shadow outcomes, not real-account fills.
Draw gaps when evidence is unavailable or stale.

Cash is an integer number of wei until display conversion. Same-time closures must
use the account engine's deterministic ordering. This is closed-cash drawdown, not
intratrade mark-to-market loss. A wallet P&L line is not a spendable balance.

Carry holdings, guard state, template losses, warmup and DD state across era boundaries.
Rebase only the displayed P&L and period-local DD. Also report full-capture cumulative
DD, which must not reset at an era boundary or an accounting reset.

## Pauses and indicator ownership

- Yellow background: the highlighted policy's market gate is not open, including warmup or stale evidence.
- Red background: the highlighted policy's modeled DD halt.
- Shade all five panels over the same intervals. Overlap is allowed.
- Name the highlighted policy and its exact thresholds above the chart.
- Shading belongs to that one policy, not every overlaid line.
- A flat cash line alone is not proof of a halt. Use recorded modeled transitions.

Main and fresh indicators use distinct colors. The frozen example draws the lower
scenario sum as a step and fills the range up to the upper sum. These are six
sensitivity scenarios, not statistical confidence intervals. Pause if any scenario
crosses the brake; recovery requires every scenario to meet the selected conditions.
Hide inactive thresholds, or label them unused. All displayed thresholds must match
the number the engine actually compares.

## Required chart set

For the September two-era comparison, produce:

| File | Lines or contents |
| --- | --- |
| `era1-grid.png` | Sep 1–7: 20/8 reference guard, first-era winner, second-era winner, balanced no-DD candidate, market guard disabled |
| `era2-grid.png` | Sep 8 through capture: the same policies and colors |
| `era1-drawdown.png` | Selected rule without DD, the same rule with 3× DD, reference guard with DD, market guard disabled; add a distinct lower-DD alternative when selected |
| `era2-drawdown.png` | The same DD comparison for the second era |
| `window-heatmap.png` | Main window × fresh window, one panel per era; state that each cell takes the best net over other tested thresholds |
| `actual-cash.png` | Actual booked cumulative P&L and DD in a separate figure, using historical stakes and controls |

Deduplicate identical highlighted policies. Preserve line-to-color identity between
the two eras of a comparison. Name exact settings in the accompanying table.
Do not select different policies at Sep 8 and splice them into one claimed strategy.

Use UTC dates on the shared x-axis. State the requested London cutoff and its UTC
equivalent in the caption or report. Show the actual common comparable endpoint,
including an excluded unfinished tail. Do not silently call a partial day a full day.

The frozen renderer uses 15×15-inch figures at 145 dpi (2,175×2,175 pixels).
Wallet P&L gets more height than DD. Percent panels use a common 0–110% axis;
expand it visibly if another run has values above that range. Use fixed margins,
readable legends, a zero-P&L line and a 100%-retention reference line.
Matplotlib PNGs are sufficient. No browser, dashboard rebuild or hosting is required.

## Tables accompanying the charts

Include exact rules, net ETH, cumulative DD, both retention KPIs, winning and losing
ETH, closures, profit missed, losses avoided, recovery losses and losing-recovery count.
Show central results beside execution-stress ranges and worst DD.
Define recovery-episode attribution in the run manifest or companion source.
The frozen run assigns an attempt to its latest market recovery by entry time,
then accounts for that attempt's cash at closure. An episode with negative summed
cash contributes to recovery losses and the losing-recovery count.

Provide daily bins, trailing 24 hours in eight bins, and trailing seven days in seven
bins. State the bin endpoint. The focused example ends trailing bins at the comparable
prefix, 38.763 seconds before capture. Include a late-period loss view so an early
profitable day cannot hide later bleeding.

Every mean requires median, standard deviation and count. The frozen focused files
use population SD (`statistics.pstdev`, `ddof=0`), including the six-scenario summaries.
Label that convention when reproducing them. New analyses follow the backtest standard's
sample SD (`ddof=1`, unavailable when fewer than two samples) unless explicitly specified.
Do not rewrite archived statistics to make the conventions appear identical.

## Acceptance before delivery

1. Require matching model/input hashes and complete comparable accounts.
2. Check plotted final cash against account metrics using integer source cash.
3. Recompute both ratio endpoints from the displayed period's cash and its reference.
4. Check closure ordering, boundary state, clipped halt spans and missing evidence.
5. Inspect all images for clipping, overlap, units, legends and the stated policy owner.
6. Deliver a ranked table, charts, limitations, verification results and reproducible commands.
7. Hash the final artifacts after inspection. Keep actual cash and hypothetical cash distinct.

Passing chart checks does not pass execution fidelity. A failed, missing or stale
cash-fidelity certificate keeps all policy earnings diagnostic. Do not imply that
reproducing an attractive curve validates a future deployment.
