# Market guard persistence audit, 2026-09-08

The user authorized research into market thresholds and sustained recovery, with profit
and missed opportunities considered alongside losses. This is an offline audit. It does
not authorize a live setting change or a deployment.

## Frozen scope

Use `data/market-guard-audit-20260908/snapshot.json.gz`, captured 2026-09-08 06:39:05.874
UTC, SHA-256 de5f71e88d1a7357e90c992dc6cafe7feabbff1a93e9e47aad56921e4e4a892f.
The primary continuous stake era starts at the 2026-09-07 13:55:27.189 UTC change back
to 0.02 ETH, positions 2128 onward. The first trade arrives five minutes later. Do not
join the earlier 0.02 ETH segment across the intervening 0.01 ETH period. A strict
post-22:34 deployment subset is a diagnostic, not another fitting set.

Use final receipt-booked costs, plus measured wallet residuals. Include failed-buy
costs as cash events but not successful trades. Preserve capacity, open positions,
chronological cash, and the two daily drawdown recoveries. Keep the 0.06 ETH drawdown
limit, stake, entry filters and exits fixed. Initial risk starts at zero in the common
policy comparison; compare the simulated baseline with actual events and disclose
seam/restart differences. Initial drawdown sensitivity uses the measured starting gap.

Signals use original gate observer score timestamps, the same book floors as live,
and the fixed 1.75 bar. Do not replace score availability with launch time. Existing
older observations may warm the signal, but only current-era cash can enter selection.

## Predeclared exploration

Always include current live policy, no market pause (drawdown remains), and no
additional guards as diagnostic benchmarks. The candidate pool includes:

- Window 10, 15, 20, 30, 40 launches; pause below -0.5, -1, -2, -3 stakes;
  resume above 0, 0.5, 1, 2, 3 stakes. Cross these 100 threshold combinations.
- On the live thresholds: require 2, 3, 5, 8 consecutive updated windows above +1
  before resuming; separately below -1 before pausing; separately both directions.
- On windows 15, 20, 30 and pause thresholds -0.5, -1, -2: combine resume thresholds
  0.5, 1, 2 with 2, 3, 5 confirmations. Do not additionally cross cooldown and slopes.
- Resume after 2, 5, 10, 20 minutes continuously above the live threshold.
- Minimum pause duration 5, 15, 30 minutes with the live recovery test.
- Require the latest five outcomes to sum above zero at resumption.
- Pause behavior when stale: keep the previous state, or refuse entries until fresh.
- Drawdown recovery sums above +0.5, +1, +2 with 20 post-stop observations;
  confirmation counts 2, 3, 5 above the existing zero threshold.
  Separately require the regular market sum above +1 at drawdown recovery.

A confirmation is a distinct change in the selected observer window, processed at
its recorded score-arrival time. Repeated timer polls do not count. Multiple scored
launches in a batch count in score-time order; a sensitivity counts at most one
confirmation per housekeeping interval. Decisions still apply only on the 30-second
clock. A violating or stale reading resets a pending streak or dwell time. Streaks
for resumption start after a pause, not before it.

## Selection and evaluation

Exclude the latest six hours from fitting. They were inspected in the previous
conversation and are a recency check, not an untouched holdout. Select the highest
fitting-period cash profit among candidates with drawdown no worse than baseline.
Break ties by simpler changes nearest live settings, then stable name. Fit only on
exits resolved by the boundary. Freeze this choice before examining recency scores.
Also select within policy families for comparison and report the complete candidate
count. An all-period winner is explicitly hindsight, never a recommendation.

Use expanding chronological folds with six hours minimum fitting and disjoint
three-hour evaluation. Carry simulation state across boundaries. Report the last
24 hours in eight bins and seven days in seven bins ending at the snapshot; pre-era
bins are unavailable. Every mean has median, sample standard deviation and n.

For selected policies and family winners, stress observer delay 60/180 seconds,
clock phases 0/10/20 seconds, one confirmation per tick, and a 5 percentage-point
adverse shift in each market outcome. Report whether results depend on the largest
winner, gross winners forgone, and gross losses avoided. No significance claim from
an exhaustive grid and fewer than five independent days is justified.

## Missing opportunities

The primary cash comparison only retains/removes historical executions. It cannot
price new fills. Separately add originally halt-rejected eligible launches using a
causally selected adaptive observer target, 45-second assumed holding time, measured
fitting-period costs, and return shifts -20/0/+20 percentage points. The observer
uses 0.01 ETH and live uses 0.02 ETH, so this is a missing-fill sensitivity, not a
profit forecast. Include alternative hold times 20/90 seconds for the frozen choice.
Quantify unpriced launches and entry-filter uncertainty. Never describe the
simulation-only improvement as money the wallet earned or would certainly earn.

## Verification

Tests must cover exact threshold equality, distinct confirmations, streak reset,
time dwell, cooldown, stale readings, no future scores, drawdown recovery evidence,
simultaneous positions, capacity, and boundary continuity. Compare the baseline
against the existing guard simulator. Check matched recorded market samples and
recovery events. Any unresolved discrepancy must be carried into the findings.

## Accounting correction during verification

The first run used recorded `balance.open_n=0` labels to allocate wallet residuals.
Some labels predated the repaired stranded holding. They incorrectly allocated
deployed principal to a different trade. The shared helper now excludes a flat
sample when the corrected position history still has a holding open at that time.
The full-period net is unchanged, but individual cash events and drawdown comparisons
change. Rerun the same candidate pool and fitting-only selection after this correction.
The final findings use the corrected run. Neither the grid nor the fitting cutoff changed.
