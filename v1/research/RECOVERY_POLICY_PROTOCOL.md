# Recovery policy experiment, 8 September 2026

Test whether false recoveries can be made less costly without discarding profitable
periods. Research only. No live code, configuration, restarts, or trades change.

The frozen export is `data/recovery-policy-20260908/snapshot.json.gz`, captured at
12:32:24.439 UTC. The new live episode is a diagnostic, not an untouched holdout:
the user reported its loss before this experiment was specified. The final six
hours are excluded from any fee calibration. Previously inspected history is
retrospective throughout. Prospective confirmation remains necessary.

Use current-era recorded attempts as the primary comparison. Preserve actual
stake, exit, and COALESCE(onchain_pnl_wei,pnl_wei) cash. These comparisons can retain
or remove attempts, but cannot establish additional fills. Reproduce the live
market SQL's tax and exemption floors, independent of the opportunity screen.
Compare reconstructed readings with recorded guard_samples at their timestamps.

Freeze these candidate families before looking at their performance: baseline;
three normal-market updates; six DD updates with freshness and a positive newest
five; those conditions for both halt types at three and six updates; +2 for both
restart thresholds; a positive sum after dropping the largest winner; one DD
recovery per rolling 24 hours; a 0.06 or 0.09 ETH rolling drawdown budget that
survives resets; a 0.01 ETH restart loss allowance while admitting one position
at a time for the first five completed trades; and quarter-size restart probes.
Probe sizes are 0.005, 0.01, then 0.02 ETH. Advance only when flat, after at least
five completed trades at a stage with positive net cash and a fresh market above
+1. A 0.005 ETH loss from the probe's peak stops it. Also test six-update
confirmation combined with the full-size restart allowance and with small probes.
Consecutive update counts refer to changed outcome windows, not repeated timer
reads. Six qualifying windows include five changes after the first qualification.

Apply every restart safeguard to normal venue and DD recovery unless the name
explicitly says DD only. Retain ordinary market hysteresis. A failed probation
requires a new post-stop recovery window; it never clears a manual stop. Use the
known operator stop as a fixed endpoint for the live episode.

For longer coverage, reuse the complete 14-day public curve logs. This is a
fixed-1.75-exit opportunity diagnostic, not the full adaptive live strategy.
Reprice smaller stakes through the curve engine. Never scale actual P&L.
Include a causal 20-pair execution-underperformance stop (factor 0.78, 15 points)
as a model sensitivity, not evidence that modeled execution errors occurred live.
Score availability controls when that guard can see a pair. Its sticky behavior
is retained. The old opportunity model cannot price graduated V4 exits exactly;
show zero-recovery and virtual-curve valuation sensitivities instead of claiming
the uncertainty is fixed. The virtual-curve value is not a verified executable
upper bound. Historical touch/template feedback and counterparties' reactions
remain incomplete, so no synthetic profit table establishes a live optimum.

Report 24 hours in eight bins and seven days in seven bins ending at the frozen
export, identifying unavailable and older-era portions. Include means, medians,
sample standard deviations, and counts. Compare total cash, maximum drawdown,
profit/loss removed, profitable and losing restart periods, and sensitivity to
signal timing and transaction outcomes. Preserve source hashes and outputs.

Exploratory follow-up after the first results: separate the +2 rule into market
only and DD only, and test adjacent +1.5 and +2.5 thresholds plus three updates at
+2. These are explanatory sensitivity tests, not new validation observations.
The live episode is also replayed from its actual pre-existing venue halt and
0.00603 ETH drawdown so unrelated earlier account paths cannot earn credit for
preventing the episode. The observed end of that episode is retained.
