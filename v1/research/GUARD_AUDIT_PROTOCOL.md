# Guard audit protocol, 2026-09-07

The decision is whether the current pause, drawdown stop, and automatic restart policy
has a supported improvement. Entry filters, exits, and trade size remain fixed in the
primary comparison. Changes to those require a separate execution model that passes
calibration at the proposed size.

This protocol is written before running the replacement simulator. Today's losses were
already inspected. The latest six hours are excluded from selection but are **not a
previously unseen holdout**. Historical validation cannot become prospective evidence.

## Data and boundaries

- Freeze one read-only snapshot, including its timestamp and SHA-256 hash.
- Primary era: the uninterrupted 0.02 ETH main-trade series beginning at position 2001,
  2026-09-06 22:06 UTC, after the 22:02 process restart. Later deployments changed guards
  and accounting, so guard settings are replayed counterfactually. No earlier trade
  profit enters selection. Also report the stricter post-01:21 deployment subset.
- Exclude probes and non-live trades. Charge actual net booked costs using
  `COALESCE(onchain_pnl_wei, pnl_wei)`. Report missing receipts and non-trade account costs.
- Use actual observer rows and their recorded scoring times for primary signals. Older
  reconstructed timestamps are for coverage diagnostics only, never primary selection.
- Report the last 24 hours in eight bins and seven days in seven bins, both ending at
  the snapshot. Bins before the era are unavailable, not zero-profit observations.
- Every mean includes median, sample standard deviation, and n.

## Simulator and verification

- Preserve realized losses, concurrent positions, capacity, and chronological state
  across fitting/evaluation boundaries. Start drawdown peaks at zero.
- Check venue and recovery on a 30-second housekeeping clock. Test clock phases and
  delayed evidence. Resume only while flat, using observations scored after the stop,
  and respect the two-lifts-per-UTC-day budget.
- Mirror the live venue's stale-window release and retained internal hysteresis state.
- Use real entry decision timestamps and realized exit cash flows. Receipt correction
  times and historical in-process touch decisions are not fully recorded, so disclose
  that timing and original trade-selection restrictions remain conditional assumptions.
- Validate the known 09:46 restart signal and subsequent stop against production events.
- Test causality, missing bars, freshness expiry, initial losses, simultaneous positions,
  post-stop evidence, midnight budgets, and boundary-state continuity.

## Comparisons and selection

- Baseline: current live configuration, applied consistently from the era start.
- Candidates: stops 0.04, 0.05, 0.06, 0.07 ETH; restart windows 15, 20, 30;
  restart sums strictly above 0, +1, +2 stakes; venue settings
  `(60,-4,+0.5,3h)`, `(40,-3,+0.5,3h)`, `(30,-2,+1,3h)`, `(20,-1,+1,3h)`.
- Include diagnostic benchmarks: no additional guards, the old 0.112 ETH stop, one
  automatic restart per UTC day, and no automatic restart. Do not select a diagnostic
  merely because it benefits from an already-known loss.
- Fit only on exits resolved before the final six-hour boundary. Choose highest net
  realized ETH among policies with drawdown no worse than baseline on that fitting
  period. Break ties by distance from the current configuration, then stable name.
- Freeze that choice for recency evaluation. Also use expanding chronological folds:
  six hours minimum training, then disjoint three-hour evaluation periods where possible.
- Evaluate risk/profit tradeoffs and candidate stability. Report how many candidates tie
  and how few independent periods distinguish them. Do not call a numerical winner a
  demonstrated optimum with fewer than five independent evaluation days.
- Stress shortlisted policies with observation delays of 60 and 180 seconds, clock
  phases 0/10/20 seconds, and actual fitting-period replay calibration error. No stress
  outcome may be used to pretend the original selection was independent.

## Limits on conclusions

The cash-flow comparison can only retain or remove observed trades. It cannot know the
fills on coins the historical bot skipped, nor the changed future path after our own
orders change. Report the missing opportunities and selection bias explicitly. Its
results are conditional comparisons, not mathematical upper/lower profit bounds.

If the data cannot separate policies, retain the current settings as an unvalidated
baseline and name the next prospective test. A recommendation is not permission to
change live risk, restart the bot, reset accounting, or deploy trading changes.

## Audit corrections recorded after the first run

The flat wallet samples revealed 0.001637588746852 ETH of costs absent from the booked
P&L over these 101 trades. The first trade's approval receipt matches its isolated
wallet residual exactly. Performance now includes the measured residual in each flat
interval. Single-trade intervals allocate it exactly; concurrent-trade intervals split
it evenly. The production drawdown simulation still uses the booked ledger, matching
the live implementation. This is a cash-accounting correction, not a parameter change.

Additional sensitivities evaluate immediate venue refresh on observer score arrival
and a fixed five-percentage-point adverse signal perturbation. The latter is a stress
assumption, not an estimated fee or a fitted bias. Neither changes the candidate grid
or the selection rule.

The audit also evaluates the 32 launches with an original halt rejection. A separate
scenario test fills them using their observer outcome at a causally chosen adaptive
target, a 45-second assumed hold, and return errors of -20, 0, and +20 percentage
points. This is an imputation sensitivity at a mismatched replay size, not actual
execution evidence or a new selection set. It tests how missing fills can change the
comparison; it does not repair the missing chain sequences.
