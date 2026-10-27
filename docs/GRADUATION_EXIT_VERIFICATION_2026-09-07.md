> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Graduated exit verification, 7 September 2026

Release `658495d` is deployed and running. The bot reported zero active positions and zero reserved entry slots before activation.
The database also contained zero open live rows. Trade size, entry filters, loss limits, operator control,
accounting epoch and daily restart budget were preserved. The running source hashes
match the tested release.

The exit now accepts any positive ETH fill, matching the existing emergency curve exit.
It simulates the router transaction before broadcast and verifies proceeds afterward.
It does not need a quote-service response. A price falling beyond the old 10% bound
therefore cannot itself refuse the sale. Approval amounts remain exact and the Permit2
allowance remains short-lived.

Receipt checks run every 150 ms. Transient failures retry in 250 ms to one second.
Uncertain sends rebroadcast the same signed transaction after one second. Each RPC
endpoint has a 750 ms timeout and no transport retries, with the configured provider
first and public RPC fallback. These are software limits, not an end-to-end execution
time guarantee under network failure.

A closed curve can precede its swap pool. The bot now handles the permissionless
`graduate` and `createGraduatedPool` transitions when needed. Both are simulated before
broadcast. Owner-only forced sweeps and rescue methods are never called. Preparation
gas remains charged while the holding is open and survives accounting rebuilds.
Graduation also bypasses the ordinary buy/sell confirmation waiting timers. A prior
curve quote is cleared when the position moves venues so it cannot produce a false
execution-quality comparison.

The contract test ran on a local Anvil fork at Robinhood block 56954753, immediately
before HUSDP's original pool creation. A test account received the original holding on
the fork. The actual bot owner loop then created the missing pool, made both approvals,
and sold all tokens through the real contract code. The test required an empty token
balance and exact agreement between receipt proceeds and the fork wallet after all gas.

The second scenario injected a sale of existing holders' tokens after our transaction
was prepared and before it was submitted. The expected return fell 29.9896%. The automatic
sale still completed, with no tokens remaining. Receipt proceeds reconciled exactly.

| Local fork scenario | ETH proceeds | Gas, all exit steps | Remaining tokens |
|---|---:|---:|---:|
| Missing pool | 0.036119378636 | 0.000123428914 | 0 |
| Missing pool plus price drop | 0.025287326769 | 0.000035217713 | 0 |

Fork elapsed time includes archive-provider storage loading and is not a measurement
of production latency. No transactions were sent to the live network by either test.
The archive proxy refused write methods. The temporary proxy and fork were shut down.
Evidence is retained in `v1/data/graduation-hardening/`. The instrument is
`v1/research/graduation_fork_check.ts`, with `FORK_DUMP=1` for the adverse-price scenario.

The isolated release passed type checking and all 665 tests on the laptop and the box.
Failure tests cover RPC outages, unavailable pools, pending transactions, restarts,
and fee accounting. They also check the emergency output minimum and gas budgets. Curve validation
matched 99,080 transitions and 409 snipe-tax checks exactly across 60 historical curves.

The remaining limitations are external execution and liquidity. A missing RPC response
cannot prove a transaction failed, and the bot will not create a duplicate sale nonce
while that result remains uncertain. If liquidity is unavailable or the bounded gas
budget is exhausted, the holding remains open with an alert. The tests demonstrate the
automatic path on real historical contract state; they do not guarantee a future market
price or uninterrupted network access.
