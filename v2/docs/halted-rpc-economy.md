# Public polling while every book is halted

`RPC_HALTED_ECONOMY=1` uses public log polling whenever all configured books are halted,
startup reconciliation is complete, the wallet is flat, and no buy, sell, approval or graduation
transaction is unresolved. Venue, drawdown, operator and mixed halts qualify. The old
`RPC_STOPPED_ECONOMY` setting is an alias when the new setting is absent.

The fold records an entry hold before public routing starts. Market observations continue
at the existing cadence. Launch subscriptions, metadata, wallet checks and execution reads
keep paid routing because they establish new launches and transaction state.

When a book reopens, the bot reads a paid head, fetches the blocks through that head, and
waits for the driver and pending launch work to finish. Only then does it release the entry
hold. This does not remove a stop, reset drawdown, change size or change the strategy.
Preparation has a ten-second deadline. Failure keeps entries held and retries after one
second. A newer STOP cancels preparation. Existing positions always retain their exit path.

Public failures use paid rescue at the requested range. Only an explicit provider range
rejection causes splitting. A rescued paid head keeps its log scan on paid RPC.
Two public failures cause five seconds of paid polling. Repeated failures double that
cooldown up to sixty seconds. A successful public scan resets it.
A public head below the cursor gets up to three seconds to reach blocks already covered
by the previous paid scan. That wait advances neither coverage nor freshness. A longer lag,
a head that stops advancing, or malformed logs triggers paid rescue.

`/api/state.rpcRouting` reports route counts, failures, rescue counts, estimated compute
units, entry readiness and the latest automatic preparation duration. Minute summaries
remain beside the tape. These are usage estimates, not provider billing.

## Measurements on 2026-09-25

From the production host, 20 of 20 public head reads succeeded. The public head trailed
the paid head by 4 to 9 blocks. Paid head plus gap-fetch time was 45 to 171 milliseconds.
Those timings exclude driver work. A separate thirty-second poller probe made 59 public
requests, zero paid polling requests, and had zero failures or gaps between covered ranges.
Its final paid catch-up fetched fifteen blocks in 117 milliseconds.

These short probes establish that savings are possible on this host. They do not establish
monthly uptime or a guaranteed recovery delay. Compare paid usage and observation health
over eligible production periods after activation.

## Snapshot upgrade

Use `WITH_CONFIG=0`. This release adds optional readiness evidence to `logs-status`.
Old events and existing state keep their previous decisions. Do not rebuild the wallet
from historical policy replay. Before restarting, run `tools/prepare-economy-snapshot.ts`
with the verified old source tree, its actual snapshot, and the live tape path.
The tool accepts only the additive core edits, compares both folds across the snapshot
tail, and prebuilds the new snapshot with identical wallet state and history.
Restart only after a fresh live check confirms zero open positions and halted books.

## Production acceptance on 2026-09-25

Activated build `85be9629fdb492a6` with `RPC_HALTED_ECONOMY=1`. Both deploys used
`WITH_CONFIG=0` and both restarts were flat. The strategy hash remained
`fad0f7ccd497a8292febc4073b3057cb68fa69a82ab67647055a71d564ca4d07`.
Taxed remained operator-stopped, untaxed remained drawdown-halted, and both sizes
remained 0.005 ETH. Wallet balance and booked P&L were unchanged across activation.

The final 180-second sample made 334 public polling requests and 26 paid polling
requests. Two public failures were rescued; no paid requests failed. All seven sampled
stream readings were healthy. The window includes the remainder of an inherited
sixty-second cooldown from the first build. Total bot-meter usage, including metadata,
maintenance and subscription bytes, was 2,464.44 estimated compute units.
At the configured $0.525 per million units, that projects $18.61 per thirty days of this
halted workload, versus the pre-change estimate of $105.48. The implied reduction is
82.4%, or $86.87 per month of comparable halted operation. This is a short-run estimate,
not a provider invoice or a forecast of how often the books will halt.

An independent paid scan checked blocks 72,279,529 through 72,281,028 after activation.
All 365 matching logs were on the tape, with zero missing or extra logs. Verification
used three paid requests outside the bot meter.

Three isolated runs against the actual saved fold measured full catch-up plus driver
processing at 50, 103 and 122 milliseconds. One run included a metadata read. The test
could neither sign nor broadcast; zero positions opened. These are current-load samples,
not a bound on a slow provider or a queue of pending launches.

Validation: 734 tests and typecheck passed locally and on the host. Curve validation
remained exact across 60 curves, 99,080 core checks and 409 tax checks. The deployed
baseline and candidate both produced kernel `14830a86ec81c944` over 250,000 recorded
events. Their 42 historical differences against recorded signatures were unchanged.
Snapshot proof matched state, history and decisions. The actual-fold migrations also
matched across 1,689 and 2,219 tail events. The local dashboard displayed public routing,
START preparation, and failed-preparation feedback; concurrent STOP cancellation is
covered by the transport and controller tests.
