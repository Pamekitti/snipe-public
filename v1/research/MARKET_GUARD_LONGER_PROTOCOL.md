# One-week and two-week guard comparison

The user requests longer backtests. Freeze the read-only export at 2026-09-08
10:52:43.423 UTC. Preserve every earlier study. No live settings change.

## Fixed comparisons

Compare the existing guard, two, three and five recovery updates, the previously
reported 10-launch rule, and both historical winners. Do not search another grid.
Use the effective export settings: 0.06 ETH drawdown, 0.08 ETH concurrent capacity,
20 post-stop observations above +1, at most two automatic recoveries per UTC day.
Market decisions use a 30-second clock and distinct observation arrivals.

## Longer data

Fetch complete launch-through-95-second curve log ranges for historically screened
launches with creator tax 50–200 bps and at least three exemptions. Include one day
before the 14-day report boundary for signal warmup. Reuse only caches that record
the requested range. Old unbounded caches cannot establish completeness. Requests
use the laptop and the public endpoint, paced at one second, with rate-limit
backoff. No paid provider key or live process is used.

Report two different comparisons:

1. Conditional recorded-trade replay over 24 hours, 48 hours, 7 days and 14 days.
   Retain actual entry sizes, exits and booked costs. Record failed attempts,
   missing receipts and open positions. Earlier eras are historical diagnostics.
2. A common-opportunity guard experiment at 0.02 ETH with fixed TP 1.75, 45-second
   cap, 20-second dead-coin exit and 0.50 stop. Rebuild nonlinear curve paths at
   that size. This fixed exit isolates the guard and is not the complete current
   adaptive strategy. Include originally skipped eligible launches. Apply a 4.5
   entry quote proxy and report unavailable paths explicitly.

Retain original observer returns and their scoring timestamps whenever available.
For earlier launches reconstruct the fixed 1.75 observer return at its native
0.01 ETH stake, using gatewatch's own engine and parameters. Assume a five-minute
scoring delay, rounded up to a minute. Label these timestamps reconstructed and
stress two- and ten-minute delays. Missing outcomes are never set to zero.

## Execution and validation

Charge median recorded successful-trade gas from the first seven days, grouped by
stake, and report the sample and nearest-size fallback. Reprice matched actual
fills at their recorded fill block and TP to measure model error. Report current
size and older size groups separately. Stress sell latency at 0.6, 1.2 and 2.4
seconds, signal returns down five percentage points, and trade returns down ten
percentage points. Shift the unknown housekeeping clock phase by 15 seconds as
another timing check. These are scenarios, not confidence intervals.

Carry account and open-position state across reporting boundaries. Also show a
fresh-account seven-day run to identify initialization sensitivity. Keep the last
six hours out of calibration. No threshold selection occurs, and reused recent
history is not an untouched validation set.

Save daily and overnight results, the required eight three-hour and seven daily
bins ending at the export, and full mean/median/sample-sd/n distributions. Report
coverage separately for recorded and reconstructed signals. Verify time ordering,
distinct confirmations, complete range reuse, cash aggregation and deterministic
reproduction. Document fixed-exit, historical-screen, feedback, graduation,
block-time, execution and account-model limitations beside profit tables.

Collection adjustment: initial requests waited three seconds. Wide ranges caused
server query timeouts, so batches now span at most 9,000 launch blocks. After the
narrower ranges completed without rate limits, the laptop-only collector moved to
a one-second pause. Rate limits still trigger a 60-second backoff.

Coverage diagnostic added before full-period results: 76 additional launches meet
the current static screen but were originally blocked by the template screen.
Fetch these too. Report a separate opportunity sensitivity that admits them while
holding the original market-signal universe fixed. This does not reconstruct the
template gate itself and does not change the primary comparison or policy set.

Receipt check: three older recovered-flat attempts have no reconciled receipt and
book a combined 0.01 ETH loss. Retain the required booked-value fallback in the
primary table. Also rerun the three core guards with these uncertain losses set to
zero. This is a cash-quality sensitivity, not a receipt correction.
