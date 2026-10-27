> Historical document. Snipe was retired on 25 October 2026. Operational statements below describe their original era. Start at the root README for this public edition.

# Pons sniper

A sniping bot for Pons V2 bonding curves on Robinhood Chain (chain 4663). Live with real
money since 2026-08-18. The operating rules are in the root `CLAUDE.md`; the runbook is
`DEPLOY.md`; this file is the map of the code.

## The shape of a trade

1. A `TokenLaunched` log arrives (Alchemy socket inside the entry window, HTTP polling of
   the public rpc otherwise). `bot.onLaunch` reads the curve (one multicall) and the
   creator's buy from the launch calldata, screens the book (`screenCurve`), and starts
   observing the curve so gatewatch can score it whether or not we trade.
2. `strategy/entry.ts pickEntry` is the one decision point: the creator-tax band
   (`ENTRY_MIN_TAX_BPS`/`ENTRY_MAX_TAX_BPS`, both inclusive and both hot since 2026-09-15),
   at least 3 exempt wallets, inside `ENTRY_UTC_HOURS`, no real loss on the same template in
   the last 60 minutes. Every decline is written to `launches.entry_reject`. The band is a
   trading filter and never narrows `screenCurve`, which still passes everything up to the
   200 bps screen bound and defines the observation universe the sensors and `edgecheck.py`
   measure against.
3. The buy fires after the bot OBSERVES a feed block stamped `launchedAt + 2` (the snipe
   tax is 618 bps at elapsed 1 and 19 bps at 2), with a 50% slippage fuse and a 4.5x
   entry-price guard against pumped curves.
4. Exits run off local curve state with no RPC in the path (`strategy/exit.ts`): sell on
   the graduating curve at 12% supply left, take profit at the adaptive bar (argmax over
   the last 20 scored launches, 1.75 fallback), dead-coin bail at 20 s below 1.03x, the
   45 s clock, hard stop at 0.5x. Every sell goes out at a 1 wei bound (no mempool, so the
   bound can only refuse).
   Confirmed graduation hands an unsold holding to `graduation.ts` for immediate sale
   through the official V4 swap router. It completes permissionless graduation steps if the pool is missing. The row stays
   open until the sale is confirmed.
5. Receipts are backfilled onto the row (`telemetry/truth.ts`); the wallet balance is the
   truth every number is reconciled against.

Entries stop by themselves under three guards, and only the last one needs a person: the
venue pause when the trailing window of launches the book would have bought loses money,
the drawdown stop (which lifts itself once those launches pay again after it fired,
resetting the epoch as it does), and the bot-broken halt when our own fills come in far under what the same coins
replayed at. `strategy/risk.ts` owns which kinds may lift themselves and why.

## Modes

| `MODE` | signs | broadcasts | needs |
|---|---|---|---|
| `observe` | no | no | nothing |
| `shadow` (default) | yes | no | a key |
| `live` | yes | yes | a funded key AND `LIVE=1` |

Never switch to shadow with live positions open: the sells would be signed and never sent.

## Source map (`src/`)

| file | what it owns |
|---|---|
| `index.ts` | entrypoint: mode, env, boot-time recovery, stranded bags |
| `bot.ts` | the bot: streams in, entries on the snipe-tax clock, exits, housekeeping, meters |
| `config.ts` | every constant with the evidence beside it (STRATEGY, RISK, GAS, ENDPOINTS, ADDRESSES). The operator-settable fields are getters onto the live snapshot |
| `config/schema.ts` | every setting an operator can change, declared once: env key, bounds, hot or restart-only, per-trade or account |
| `config/store.ts` | the live snapshot and the `.env` watcher. The file wins for hot keys, the environment for restart-only ones |
| `graduation.ts`, `tx/graduated.ts` | durable graduated-pool exits, exact approvals, retry budgets and receipt accounting |
| `recovery.ts` | crash recovery, `readCurve` (multicall incl. the ArbSys block), `readCurveRetry` |
| `feed/client.ts`, `feed/decoder.ts` | sequencer feed: frames are liveness, non-block messages are not gaps |
| `logs/subscriber.ts` | authoritative logs: socket (launches only, in the window) plus the poller |
| `rpc/budget.ts`, `rpc/read.ts` | estimated provider usage and bounded provider-first reads with public fallback; quota estimates never change routing |
| `state/curve.ts` | exact bigint port of the curve math (`npm run validate` proves it) |
| `state/engine.ts` | per-curve confirmed and pending reserve state; skips only logs the seed already had, and checks the book against the chain while a position is open |
| `strategy/broken.ts` | our real returns against the same coins' replay: the halt for when the bot, not the market, is losing |
| `telemetry/epoch.ts` | the epoch reset transaction, shared by the hand tool and the drawdown stop's self-lift |
| `telemetry/price.ts` | the ETH price, fetched hourly. Display only, which is what makes fetching it safe |
| `telemetry/levels.ts` | every threshold the operator display decides on, so the page and the alerts cannot disagree |
| `telemetry/resources.ts` | free disk and per-process memory, sampled in housekeeping and alerted on as `disk` and `memory` |
| `simulation/arrivals.ts` | the in-memory ring of log arrival times, promoted to one `curve-arrivals` capture per opportunity |
| `simulation/cadence.ts` | when the paper report is worth rebuilding, so liveness no longer costs a full replay |
| `strategy/shadow-coverage.ts` | merges `shadow_coverage` ranges; outside `SHADOW_KERNEL` on purpose, so it cannot cost the certificate |
| `strategy/bot-db-retention.ts` | 48 h on `shadow_source_logs`, 8 days on `shadow_decisions`, replay payloads blanked on dead configs' `shadow_jobs`. Outside `SHADOW_KERNEL` for the same reason; never touches `launches` |
| `strategy/launch.ts` | launch parsing, book screen, entry window helpers |
| `strategy/entry.ts` | `pickEntry`, the single entry decision and `templateKey` |
| `strategy/exit.ts` | exit rule, sell retry state, `Position` |
| `strategy/takeprofit.ts` | the adaptive bar (pure) |
| `strategy/gate.ts` | the two venue sensors read from gate.db: the touch gate (`read`, `gateAction`) and the P&L one (`trailingOutcome`, `readVenue`, `venueAction`), plus `readBars` and the drawdown stop's resume evidence |
| `strategy/cohort.ts` | in-process touch verdicts so a halt does not wait for the 5-min timer |
| `strategy/risk.ts` | the drawdown stop (ETH, wei against wei), the probe cap, the six halt kinds and which of them lift themselves |
| `strategy/deployers.ts` | deployer track record from `data/deployers.json` |
| `tx/builder.ts`, `tx/nonce.ts`, `tx/sender.ts`, `tx/signer.ts` | build, nonce (status code first, 'nonce too high' resyncs), send, the shadow/live gate |
| `telemetry/db.ts` | sqlite schema and migrations, `NON_TRADE_SQL` |
| `telemetry/truth.ts` | balance poll, receipt backfill, burned revert gas, the two drawdowns |
| `telemetry/approvals.ts` | durable approval hashes and receipt costs, including retries |
| `telemetry/dashboard.ts`, `dashboard-page.ts` | status and chart APIs; the self-contained uPlot page and controls |
| `telemetry/operator-state.ts`, `build.ts` | operator view of guard decisions and build identity |
| `telemetry/market-history.ts`, `dashboard-notices.ts` | sampled market history and current dashboard fault notices |
| `telemetry/kpi.ts`, `summary.ts`, `gatehistory.ts` | rolling KPIs, the health line, gate history |

## Scripts (`scripts/`)

| script | runs | what |
|---|---|---|
| `gatewatch.py` | systemd timer | scores every book-passing launch from chain logs into gate.db (`obs.peak`, `obs.bars`) |
| `backfill-book.py` | by hand | fills historical book-cohort scores in gate.db, oldest first, without updating the live watcher heartbeat |
| `recon.py` + `reconstat.cjs` | systemd timer | replays each closed trade at its real fill block; the 1.5pp median-gap alarm |
| `push.py` | systemd timer | logs the dashboard's alerts (journald only until an ntfy topic exists) |
| `edgecheck.py` | systemd timer | daily per-rule verdicts into gate.db state (report's EDGE block) |
| `livewatch.cjs` | by `report` | the one-line live program summary |
| `newepoch.ts` | `npm run newepoch` | opens a new accounting epoch by hand: both drawdown stops from zero. The bot does the same in-process when the drawdown stop lifts itself (`src/telemetry/epoch.ts`) |
| `chainio.py`, `engine.py`, `stats.py` | imported | rpc plumbing, the curve engine, block bootstrap |
| `sim.py` | by hand | the replay simulator; ~2.7x optimistic, for ordering only |
| `validate.ts` | `npm run validate` | curve math against real chain history, bit-exact. LAPTOP ONLY: it reads `research/data/`, which the box does not have, and issues ~350 unpaced public-RPC calls. `SAMPLE` curves, default 60 |
| `stats.ts`, `reconstruct.ts`, `observe.ts`, `canary.ts` | npm scripts | results, shadow reconstruction, data-plane acceptance, send latency |
| `dashboard-preview.ts` | dev | local read-only dashboard from captured state and database snapshots; controls are disabled |
| `repair-paper-capture.ts` | by hand | backs up the database and repairs missed paper intents after a collector outage; sends no transactions |
| `coalesce-coverage.ts` | by hand, bot stopped | merges `shadow_coverage` into the ranges it means; the per-poll rows are redundant with the replay's own. VACUUM after it |
| `prune-bot-db.ts` | by hand, bot stopped | clears the `bot.db` retention backlog in one pass: `shadow_source_logs` past 48 h, replay payloads on dead configs' `shadow_jobs`, `shadow_decisions`, `health` and guard decisions past 8 days. Never touches `launches`. VACUUM after it |
| `verify-shadow.ts` | by hand | independently replays at least 20 new shadow outcomes against the frozen engine; `--certify` records calculation parity, coverage and publication checks |
| `diagnose-indicator-rpc.mjs` | by hand, on host | read-only block/log probes, sanitized provider errors, and the effective indicator configuration; never changes controls |
| `check-restart-gap.ts` | by hand, on host | read-only comparison of two settled launch-log scans for a restart interval; preserves the gap and writes a proof file |
| `repair-paper-capture.ts` | by hand | backs up the database and reconstructs missing paper intents after a collector outage; records approximate historical timing and invalidates prospective certification |
| `capture-frames.mjs`, `chart-smoke.mjs` | dev | refresh the feed fixture; headless chart check |

Cadences are in `DEPLOY.md`, which owns the timer table.

`research/` holds analysis instruments; its README says which ones are standing.

## Tests

`npm test` and `npm run typecheck`. Suites worth knowing: `venue` (the P&L sensor's window,
its freshness rule and the band), `ddresume` (every precondition on the drawdown stop
lifting itself), `broken` (telling a bug apart from a bad market), `configdrift`
(the strategy shape and where filters may live), `gatebar` (the gate never reads the take
profit), `gaslimits` (limits tied to measured usage), `noncerunaway`, `stuckexit`,
`recovery`, `wslaunch` (socket path end to end), `truth` (burned gas survives rebuilds),
`newepoch`, `dashboard` (every alert on a degenerate payload), `bookfixture` (every log of a
real coin replayed from launch must land on the chain's state bit-exactly), `bookcheck` (the
open position's book is compared against the chain and re-seeded when they disagree),
`queryplan` (every query a timer issues names the index that serves it, because the query
that starved the box on 2026-09-13 was a SEARCH that walked the whole table), `arrivals`
(the log-arrival ring), `shadow-coverage` (merging answers the verifier identically),
`resources` (the disk and memory rungs), `bundle-compaction` (a stored bundle expands back to
the six scenarios byte for byte, and a pre-2026-09-15 row is returned untouched),
`bot-db-retention` (the source-log block floor, the config the certifier needs left alone).

## Data

`data/bot.db` (positions, launches, health, balance, chain_truth; `shadow_coverage` is
merged hourly by the shadow service, and `shadow_source_logs`, `shadow_decisions`, `health`
and the guard decision log are pruned on the same hour), `data/bot.simulation.db` (captures;
per-log `chain-log` capture ended 2026-09-14, replaced by one `curve-arrivals` row per
opportunity. Since 2026-09-15 a scenario bundle stores one log array instead of six and
`results.request` stores a digest plus the fills map instead of the log bodies; the rows
written before that keep the bodies, because these tables are immutable by trigger),
`data/gate.db`
(gatewatch's obs and state), `data/recon.db`, `data/deployers.json` (the deployer
registry; the bot refuses to start live without it). All gitignored. The dashboard
listens on `localhost:8787` (`DASH=0` to disable, `DASH_PORT` to move it).

## Dashboard

RPC diagnostics in `/api/state.plumbing` include `providerMethodCalls` (attempts by
method), `providerMeterStartedAt`, and `sharedReceiptReads`. These counters reset on
restart. Receipt requests for the same hash share an outstanding request within each
read client. Completed receipts and failures are never cached, so the next call can
observe mining or a chain change. Sharing adds no polling delay. Each shared read
avoids one logical request; it is not necessarily a paid request when public fallback
is active. Live savings must be measured after deployment.

The self-contained page uses uPlot, with no frontend framework or build step. Every fact
appears once. A strip across the top carries the bot's state in one sentence, with both
market readings, both thresholds, the last close, the open count, the entry size and the
two controls. Three cards follow: today's closed cash, the account, and the drawdown left.
Current faults and useful warnings appear in the ACTION NEEDED / CHECK THIS banner.
Deliberate operator stops, obsolete probe warnings and resolved exit totals stay out of
that banner. Raw alerts remain available to existing monitors.
The rolling table shows 1h, 4h and 12h; the calendar day belongs to the card above it.
Trades, P&L, return and win rate are shown by default; More metrics reveals median trade,
pop rate and receipt-verified. The account card splits into open value and wallet only
while a position is open, and the open-positions table appears only then. Recent exits
lead with a UTC time and show dollars and ETH using the displayed ETH price.

Four aligned panes share one time axis: account history, paper trading, market, and coins.
Account history uses wallet ETH plus the cost of open positions. Recorded pauses shade this
pane. The market pane shows the active reading with both pause and resume thresholds.
When recovery uses a different window, its purple line shares the market pane.

Paper trading uses the existing continuous collector in `shadow_jobs`. It keeps simulating
through account pauses. These are estimates from the earlier model, whose accuracy has not
been verified. `dashboard-paper.ts` exposes recorded profit separately from a complete monthly
result. The chart labels the start of the available record and retains collection warnings.
Missing history is not reconstructed from venue observations or filled with zero profit.
The strict version 3 accounts and their comparison checks remain in the API and under Details.
Displaying the continuous estimates does not change the active guard or validate either model.

Coin counts remain visible independently of paper results. The stacks separate paper wins,
losses, break-even results, pending results, passed coins without an estimate, and filtered
coins. Hiding filtered coins does not hide unestimated passes. The return strip uses the same
continuous collector as the paper chart. Buckets with no results or unresolved simulations have
no return value. Passed coins are visible by default, with filtered coins available on the legend.
Old settings cannot hide the new category for passed coins without estimates.

For a local preview, pass captured state JSON with a `capturedAt` timestamp in milliseconds
and SQLite backup copies. The server opens both databases read-only and refuses controls:

```bash
ENV_FILE=.env.example node --import tsx scripts/dashboard-preview.ts \
  --state /tmp/snipe-preview/state.json --db /tmp/snipe-preview/bot.db \
  --gate /tmp/snipe-preview/gate.db
node scripts/chart-smoke.mjs http://127.0.0.1:8799
```

`test/dashboard.browser.mjs` adds Chrome checks for actual chart pixels, missing history,
stale state, controls, zoom, mobile layout and trade details. It uses a laptop installation
of Playwright supplied through `PLAYWRIGHT_MODULE`; it adds no production dependency.

`execution-worker.ts` runs batched, versioned prediction and account requests for Python research. It reads JSON lines from stdin and never sends transactions. The legacy replay API remains historical.

`verify-execution-scenarios.ts` independently replays at least 20 new compatible shadow publications. It checks source headers, integer calculations and publication ordering. It cannot enable trading. The shared research, paper and indicator contract is in [research/UNIFIED_EXECUTION_STANDARD.md](research/UNIFIED_EXECUTION_STANDARD.md).

Version 3 capture and paper accounts live in `src/simulation/`. The background writer uses
`data/bot.simulation.db`; real trading still uses `data/bot.db`. The writer heartbeats every
5 s and rebuilds its report only when the data changes; arrival times ride a ring in the main
process and land as one `curve-arrivals` capture per opportunity. The worker commits each
six-scenario result, continuous-account admission and indicator snapshot to the forward ledger
before publishing it to the trading process. Paper Wallet, Coins and Market Indicator read this
ledger directly. A compatible restart continues the epoch. A model, policy or configuration
change starts a visible new segment. Historical reconstruction files are not mixed into it.
See `../docs/EXECUTION_ALIGNMENT_20260913.md` for validation gates.
