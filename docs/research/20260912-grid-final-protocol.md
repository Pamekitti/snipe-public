# September guard experiment, revised specification

Status: specification finalized, expanded experiment not implemented or completed.
This supersedes the research design in v1/research/GRID_SEARCH_20260912.md for the
next experiment version. It does not change the running job or live trading.

## Question and fixed baseline

Can a guard preserve more winning profit and admit less losing loss than the deployed
adaptive fresh-recovery policy across September, including profitable periods and
September 12 losses? No presumption that a replacement wins.

Baseline: adaptive shadow TP, 20 available outcomes from launches within three hours,
pause below -1 stake, recover on a new publication with latest eight above +1 stake.
Preserve reopening below the brake and pausing on the next decision. Keep stake,
filters, capacity, template history, manual/execution/touch/drawdown protections and
accounting intact. Configuration eras and actual stake sizes must be identified.
Show fixed-current-configuration simulations separately from historical actual cash.

## Data and honesty

The old frozen snapshot ends September 12 at 08:20:26.881 UTC and excludes today's
subsequent real trading losses. A separate live-record capture reaches 14:46 UTC;
this is not yet a complete replay dataset. Acquire and freeze a new immutable version
covering September 1 through a recorded capture time after these losses. Capture all
screened launches, including skipped launches, verified price paths, source coverage,
policy/configuration history, costs, stops, publication evidence and actual wallet rows.
End evaluable entries early enough to resolve the longest modeled exit and publication
lag. Report the unfinished tail and missing paths; never silently drop them.

Primary presentation: September daily cash and drawdown curves, plus September 12
intraday detail. Also supply the standard trailing 24h/eight bins and 7d/seven bins.
Older comparable history is an external sensitivity check if complete; do not substitute
dead policy eras or claim 45-day coverage without verifying it.

## Candidate definitions

Let r_i be net shadow return divided by its pinned entry stake, known only at its
publication time. S_N is the sum of the latest N available compatible outcomes; F_M
is the latest M. All candidates fail closed on invalid, incomplete or stale evidence.
A changed configuration requires compatible warmup. Decisions use production scheduling.

Core grid:
- N: 10,15,20,30,40; M: 3,5,8,10,15 with M <= N.
- Main pause B: -2,-1.5,-1,-0.5,0,+0.5; pause when S_N < B.
- Fresh recovery R: +0.5,+1,+1.5,+2; full recovery H: +1,+2,+3.
- Maximum evidence age: 30,60,120,180 minutes.
- Recovery: F_M > R; S_N > H; either; both.
- Test absolute thresholds and baseline scaling B*N/20, R*M/8, H*N/20.

Additional families are tested individually before selected combinations:
1. Fresh brake: pause if S_N < B OR F_M < b, b in {-1,-0.5,0}.
2. Recovery floor: require fresh recovery AND S_N >= L, L in {-1,0,+1}.
   Distinguish this from the stricter full recovery threshold H.
3. New evidence: require k in {1,2,4} newly published complete outcomes since the
   latest pause. Count outcomes, not batches; no expiry-driven increase can satisfy k.
4. Gradual aging: Q = 20*sum(w_i*r_i)/sum(w_i), w_i=2^(-age_minutes/h),
   h in {15,30,60}. Use latest N compatible outcomes, the same age/warmup gates,
   Q for the main score and 8-normalized weighted latest M for fresh score.
   Compare with equivalently normalized uniform means, not only raw sums.
5. Winner concentration: score r'_i=min(r_i,c), c in {0.5,1,2} stakes; do not cap losses.
   Separately require latest-M positive fraction >= p, p in {0.25,0.375,0.5},
   alongside recovery. Missing outcomes never count as wins or losses.

A raw rolling-sum slope is not a primary family: it conflates new performance with old
outcomes expiring. Fresh braking and explicit new evidence test that mechanism directly.
No arbitrary cooldown or exposure increase in this primary study.

Exit axis retains all 54 existing descriptors: fixed holds 20/30/45/60/90 seconds,
dead timers, progress extensions, inactivity exits, recent-outcome-selected hold,
and joint adaptive TP/hold. Pin decisions causally at entry and keep the broader
adaptive selector population. Preserve the documented exhaustive old-core cross as
an audit job; expanded families first use baseline exits, then combinations among
training finalists. Do not describe staged expansion as exhaustive over all families.

## Search order and refinement

1. Audit coverage and actual-cash fidelity; create one reusable price-path cache.
2. Run baseline, market-disabled and core guards with baseline adaptive exits.
3. Evaluate additional families independently, including matched-window controls.
4. Run all existing exit descriptors with baseline guard. Cross training guard and exit
   frontiers, and retain the old exhaustive cross as a separate declared comparison.
5. Refine promising training regions: N/M by one outcome, thresholds by 0.25 stake,
   age by 15 minutes, exit timers by 5 seconds. Preserve valid bounds and M <= N.
   Test joint neighboring coordinates, not only one-coordinate changes.
6. If a training optimum reaches a boundary, allow one predeclared expansion: N 5..60,
   M 2..20, B -3..+1, R 0.25..3, H 0.5..4, age 15..240 minutes, hold 10..120 seconds.
   Any remaining boundary optimum is reported as unresolved, not globally optimal.

## Validation and selection

Previously inspected September history is retrospective, including today's losses.
Keep Sep1-7 for initial fitting; Sep8 onward is chronological evaluation. Because new
families were motivated by Sep12, later-period results are not untouched validation.
Add expanding fits (through Sep3, Sep5, Sep7) evaluated on the following two days.
Rebuild selector state causally; purge fitting outcomes not yet published at each cutoff.
Training refinement cannot read evaluation outcomes. Preserve the final six hours of
the new capture from numerical fitting, but label them retrospective if inspected.
After locking finalists, collect new observations for prospective assessment. Six hours
alone is insufficient in low volume; report resolved trades and recovery episodes.

Evaluate recorded and reconstructed entry timing with 600/1200/2000ms sell delay,
plus delayed-publication and recorded-control stresses. Preserve all costs, unresolved
executions, independent capacity/template history and serial shadow publication.
Report strict continuous coverage separately from independent-start intervals.
Cash fidelity failure means diagnostic-only earnings, even when code parity passes.

Report the four requested KPIs against always-on with the same non-market protections:
wins retained = candidate wins / reference wins;
losses retained = candidate losses / reference losses;
winning money retained = candidate positive net returns / reference positive returns;
losing money retained = abs(candidate negative net returns) / abs(reference negative returns).
Zero denominators are unavailable. Include a fixed baseline-exit denominator for exit
changes, and a separate unrestricted opportunity reference. Classify trades by net costs.
Show net ETH, cumulative peak-to-trough drawdown across resets, losing-recovery count
and total loss, turnover, missed winning money and avoided losing money. Every mean
has median, SD and n. Higher loss retention is worse; no weighted score hides tradeoffs.

Prefer candidates with higher net return and no worse cumulative drawdown or recovery
loss across evaluated stresses. Show lower-profit/lower-drawdown alternatives separately.
Require improvements across neighboring settings and chronological folds, not one day.
Show day-block resampling uncertainty as descriptive, since this short history cannot
support a precise future-profit guarantee. If candidates disagree across folds, a simpler
stable policy is preferable; if none qualifies, report no supported replacement.

Deliver line charts of simulated cash and drawdown, actual cash separately, indicator
and state overlays, four KPI panels, parameter heatmaps and a ranked tradeoff table.
The result is a best-supported tested candidate, never a global optimum or deployment
certificate. Live deployment remains a separate decision.

## Implementation delta

Existing: core 12,768 guards, 54 exit policies, replay parity tests and acquisition pipeline.
Required: refreshed dataset, added main thresholds, both recovery, five new families,
joint-neighbor refinement, fold evaluation and revised charts. Existing single-coordinate
refinement and old snapshot do not satisfy this specification. No expanded-run completion
or profitability claim is authorized by this document.
