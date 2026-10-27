# Expanded market guard audit, 2026-09-08

The user requested a larger dataset and an honest result. Freeze a new read-only
export in data/market-guard-extension-20260908. Preserve the earlier 06:39 UTC snapshot.
Do not tune new thresholds. Test the six previously reported market policies, the
frozen fitting winner, and the full existing 207-policy grid only as a descriptive
ranking. The former hindsight winner is now a named fixed candidate, not a newly
selected independent discovery.

## Periods

- Extend the current uninterrupted 0.02 ETH period from 7 September 13:55 UTC to the
  new snapshot. Separately report activity after the old 06:39 UTC snapshot.
- Test the earlier continuous 0.02 ETH episode from position 2001 to the hot change
  to 0.01 ETH. This is an older strategy period, not extra current-era validation.
- Answer the full-24-hour question with an additional continuous historical-stake
  replay beginning at position 2001. Charge each actual trade's actual stake and cash
  outcome, including the intervening 0.01 ETH period. Carry account risk state through
  the stake changes and through the start of the 24-hour reporting slice. Never scale
  0.01 ETH profits linearly to 0.02 ETH or call this an all-0.02 ETH backtest.
- Current-era cash remains the primary comparison. Earlier cash and mixed-stake results
  are labelled diagnostics and cannot select a new live policy. Report actual calendar
  coverage, trade counts and changes to settings. Do not claim a seven-day cash test
  when comparable instrumentation is shorter.

## Comparison

Use the tested market simulator and the same cost correction. Freeze market window,
thresholds and persistence for all six reported alternatives. Apply the effective live
account-risk settings uniformly across alternatives in the new main comparison. Also
rerun the old account-risk settings to isolate any setting change since the prior
snapshot. Never silently compare an alternative with a looser recovery threshold.

Retain original observer score-arrival timestamps. Repeated timer polls are not
confirmation evidence. Per-trade exits and historical stake schedule remain fixed.
The simulation may only retain or remove known actual attempts in the primary cash
comparison. Keep non-trade failed-buy costs and report correct return denominators for
each stake. Use wallet residual allocation that excludes false flat samples from
repaired holdings. Report open or unresolved attempts rather than dropping them quietly.

Add a separate missed-fill scenario for eligible original halt rejections. Use the
same causal adaptive observer target, actual historical stake schedule, fitting-period
measured gas, 45-second holding proxy, and return shifts of -20/0/+20 percentage points.
The 0.01 ETH observer is not a calibrated 0.02 ETH execution model. Report those
hypothetical results separately and count missing outcomes. A launch without a score
is not zero-profit evidence.

## Checks and outputs

Compare the old snapshot under unchanged rules with the prior saved cash results.
Report changed or rescored observations and receipt corrections between snapshots.
Show delayed-score and signal-error sensitivities for the six named policies on the
expanded current era. Keep the last six hours out of any descriptive fitting ranks.
No refitting may use the newly added period while calling it an out-of-sample test.
Use the required last-24-hour eight bins and last-seven-day seven bins, ending at the
new snapshot. Earlier-era bins remain labelled separately. Every mean includes median,
sample standard deviation and n. Save full results, the fixed policy list, source
hashes and a plain-English findings table. No live setting, deployment or automated
future run is authorized by this research request.

## Descriptive grid clarification

The original 207 definitions use today's common account settings, except explicit
drawdown-threshold hypotheses, which keep their stated thresholds. One definition
then duplicates the baseline, so there are 206 distinct settings. The new full-period
numerical winner also receives the missed-fill and signal-error stresses. Those are
post-hoc diagnostics. The original six named policies remain the fixed comparison.
