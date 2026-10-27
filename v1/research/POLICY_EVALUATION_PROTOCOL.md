# Policy evaluation, 11 September 2026

Evaluate the existing policy without changing live code, settings, stops or capital.
The raw capture ends at 2026-09-11 09:29:47.068 UTC. Its SHA-256 is
`e4c7805aeb0daf8e8500bdbb4d63cbfeb5de76eeea4074c193230f10a64dc376`.
SQLite backup copies and the running source accompany the capture under
`data/research/20260911-policy-evaluation/raw/`.

Use the latest recorded policy seam, `VENUE_PAUSE_ON 1 -> 2`, at
2026-09-08 13:42:00.582 UTC. Earlier parts of the seven-day window are unavailable
for current-policy inference. Show actual cash by recorded era separately.
Reserve the final six hours from cost fitting and candidate selection.
Every observation in this study is retrospective. Require observations after
this capture before claiming prospective validation.

Freeze the following single changes before comparing outcomes:

- Remove the 50 bps creator-tax entry floor, retaining the 200 bps screen ceiling.
- Remove the three-wallet entry floor, retaining the one-wallet screen floor.
- Remove the 60-minute pause after a real loss on the same template.
- Replace the adaptive exit with each of 1.25, 1.36, 1.50, 1.75, 2, 2.5 and 3.
- Recover the market at +1; retain an existing pause on stale data; require
  positive recent direction; require gains without the largest winner; use the
  existing staged smaller-entry candidate.
- Apply the existing buyer-participation overlay to +2 as a separate test.

Broader tax ceilings, zero-exemption launches and static template screening are
separate screen decisions. Do not imply the entry-filter tests establish them.
Only test a combination after each constituent passes separately.

Reconstruct market windows using recorded score availability and block order.
Compare reconstructed values to guard samples. Attribute each recovery's score
change to added outcomes, removed losses, removed winners and shared-row changes.
An old loss leaving a rolling window is not newly available profit.

Use `COALESCE(onchain_pnl_wei,pnl_wei)` and actual stake per row for booked cash.
Include failed-buy gas. Carry cumulative cash across every epoch reset.
Assign actual recovery episodes by entry time from arming to the next halt.
Keep market recovery, stale reopening, DD reset and operator resume distinct.
Score availability is strict before hypothetical entry. Preserve the adaptive
selector's broader population and its actual missing-key behavior.

Reprice the same screened launches with production integer curve arithmetic.
Use actual decision times and pinned adaptive targets for recorded attempts.
Preserve failed-entry costs across profit-target changes. Different-size outcomes
on a recorded failed attempt remain unavailable. For untraded opportunities, use
launch plus two seconds or detection, whichever is later. Use the same exit
clock origin recorded in the position context. Apply the recorded decision-to-send
delay on actual attempts, and its preceding-era median on untraded launches.
Use send time as the entry-execution proxy; subsecond inclusion time is unavailable.
No policy outcomes were inspected before this timing refinement. Use the same exit
polling (50 ms). Calibrate delay from preceding recorded exit decisions and closes,
rounded up to 50 ms. This includes receipt confirmation and is a conservative
execution proxy. Also test fixed delays of 600 and 1,200 ms. Use historical pinned
stake and rules. Use only preceding costs from the same contiguous execution-rule
and stake era. This fee warmup can precede the market-threshold seam because the
execution rules and size remained constant. No close in the final six hours fits
costs. Staged stakes must be replayed through the curve, never scaled from cash.

Keep operator controls, starting account drawdown, touch gate, capital, concurrent
capacity, the execution stop and DD recovery in account comparisons. Missing admitted
outcomes stop an account path and retain its unknown holding. Also show paired
opportunity diagnostics, with missing counts, without claiming executable account
profit. No missing outcome becomes a zero return.

Replacement requires higher fit-period and full-period net profit, no worse cumulative
closed-cash drawdown, and no increase in either losing recovery count or recovery loss.
The reserved six hours must not reverse those comparisons. Incomplete account paths
cannot qualify. Show profit captured, profitable trades missed and losses avoided.
Report eight three-hour bins and seven daily bins ending at capture. Every mean has
median, sample standard deviation and n. Report unresolved execution and timing limits.

The repeated-search limitation follows Bailey et al.,
[The Probability of Backtest Overfitting](https://scholarworks.wmich.edu/math_pubs/42/).

## Work list

- completed: capture sources and establish current policy era.
- completed: reconstruct losses, recoveries and account stops.
- completed: compare filters, exits and recovery rules.
- completed: verify outputs and publish the local findings artifact.

The [findings](POLICY_EVALUATION_FINDINGS_20260911.md) record the verdicts and remaining
execution limits. All 20 account variants were evaluated. No candidate was selected.
