> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Policy-aligned dashboard verification

The redesign is implemented locally. No deployment, restart, live setting change or accounting reset was performed.

## Preview

Open http://127.0.0.1:8811 while the local preview process is running. It serves a snapshot captured on 12 September 2026 at 15:20:58 UTC. Both databases are read-only. POST requests return HTTP 405, and both trading controls are disabled.

The preview uses captured effective policy and saved strategy values. It does not replay guards, start simulations or connect to the trading wallet.

To reopen it from `bot/`:

```sh
ENV_FILE=.env.example node --import tsx scripts/dashboard-preview.ts --state data/dashboard-policy-preview/state.json --db data/dashboard-policy-preview/bot.db --gate data/dashboard-policy-preview/gate.db --port 8811
```

## Changes

- Shared fresh-recovery policy preserves the existing 20-outcome pause below -1 and eight-outcome recovery above +1. The legacy recovery threshold is identified as inactive.
- State and chart responses retain their existing fields. Added data covers both readings, effective policy, publication evidence, recorded decisions and adaptive outcome buckets.
- Nullable guard telemetry records both readings and their policy going forward. Older shadow decisions remain usable without invented historical thresholds.
- The status strip reports the decision owner's state. Headline values separate UTC today's closed cash, account value, remaining drawdown and entry size.
- Simulated bars sum each published outcome's recorded net P&L divided by its recorded stake. Positive and negative contributions remain separate. Missing outcomes and pending work do not become zero returns.
- Recent trades show net P&L, exit reason, holding time and pinned TP. Open returns are labelled estimates before gas. Detailed trade metrics and launch diagnostics remain expandable.
- Current warnings are compact. Technical details and recorded halt reasons remain available.

## Checks

| Check | Result |
| --- | --- |
| `npm test` | 60 files, 758 tests passed |
| `npm run typecheck` | Passed |
| Laptop `npm run validate` | 60/60 curves; 99,080/99,080 core calculations and 409/409 tax calculations bit-exact |
| Captured four-hour outcome reconciliation | 78 source rows and 78 chart outcomes; both sum to -2.090234542053 stakes |
| Read-only control endpoint | HTTP 405 |
| Desktop, 375px and 414px | No page overflow; all three plot widths aligned; axis labels readable |
| Chart inspection | Touch tooltip and keyboard arrows work; Escape dismisses the tooltip; 1h, 4h and 7d ranges checked |
| Trade inspection | Keyboard expansion works |
| Fixture states | Stale, missing, incomplete, observer failure, fresh recovery with negative main window, pinned open target and separate drawdown recovery checked |
| Simulated controls | Resume requires confirmation; stop works; requests affect only the isolated in-memory fixture |

Policy tests cover strict boundaries, publication delays, other stops and observer recovery. Outcome tests cover different sizes and targets, failed buys, zero returns and absent cash. Accounting and history tests cover UTC midnight, epoch separation, policy changes and older telemetry schemas.

Screenshots are in `docs/dashboard-preview/policy-aligned/`: `desktop.png`, `desktop-top.png`, `desktop-market.png`, `mobile-375.png`, `mobile-414.png` and `mobile-market.png`.

## Remaining limitations

The snapshot contains an execution-price disagreement warning. This presentation change does not resolve that underlying fault or establish that the strategy is profitable.

Older decisions lack recorded threshold provenance. Their readings are shown with gaps where evidence is invalid. Historical thresholds remain unavailable; the dashed references are explicitly labelled as the current policy.

Open-position value is an estimate before exit gas. Wallet transfers are not counted as trading profit. The snapshot is fixed at its capture time and does not describe the current live account.

## Chart continuity correction

Removed the dashboard-only 45-second cutoff from history and tooltip lookup. Valid readings remain connected between recorded samples. Recorded invalid evidence and configuration changes still break the line; the chart does not extend past its final sample. Added a regression test for 60-second and 120-second intervals.

Removed isolated market dots, labelled both series beside the plot, added current threshold labels on the plot, and reduced stop shading to a thin strip. Verified the corrected preview at desktop and 375px widths. No trading code changed in this correction.

## Restore chart controls and context

Restored full-height recorded halt shading and a separate coin-volume plot with total and passed counts. The 20-outcome and eight-outcome signals now have separate aligned plots. Removed the text drawn over threshold lines and the duplicate legend. Current readings sit beside their plots; the large Market Return card is hidden.

The single legend supports hiding market lines, current thresholds, positive and negative simulated bars, coin-volume categories, pass rate and halt shading. Checked these controls in the browser. All five plot widths align at 375px without page overflow. The final local suite passed 758 tests and typecheck. Screenshots: `restored-desktop.png` and `restored-mobile-375.png` in the existing screenshot directory.

## Redundancy pass, 12 September 2026

Implemented locally. No deployment, restart, live setting change or accounting reset was performed. Trading code is untouched: `STRATEGY.gate.touchMultiple` still scores the regime-gate cohort and is still published to gatewatch. Only the page stopped showing it.

The page was stating about six facts three to six times each. Each now appears once.

### Changes

- The state strip carries the bot's state in one sentence, with both market readings and both thresholds, plus the last close, the open count and the entry size. The market card, its nine per-second DOM writes and the boilerplate "resumes when all stop conditions clear" line are gone.
- Drawdown shows remaining in ETH and dollars, the bar, and one row reading used of limit. The percentage lives in the bar's tooltip and its accessible label. The two rows both labelled "Used" are gone.
- The account card shows one number, and splits into open value and wallet only while a position is open. The unverified reconciliation line is gone. The open-positions table is hidden when empty.
- Rolling performance shows 1h, 4h and 12h. The server still computes 24h for the report skill and the return-on-turnover alert. 15m was dropped: at about 27 trades a day it was almost always empty. More metrics keeps median trade, pop rate and receipt-verified; turnover and loss rate are derivable from what is shown.
- Recent exits lead with a UTC time, added as `exitAt` from `positions.exit_at`.
- Five panes became four. Adaptive outcomes merged into coin volume. Recorded stops shade the account pane only. The legend went from twelve toggles to six; the five that blanked a single-series pane are gone.
- Dead code removed: the hidden market card and its handlers, three elements written twice per tick, the launch-flow toggle mode, and the duplicate breakpoint blocks.

### The merged pane

`outcomeBuckets` in `dashboard-policy.ts` joins `launches` to `shadow_jobs` on token and keys each bucket by the launch's own `detected_at`, not the publication time, so a coin's result sits in the bar it launched in. One row per coin: where several policy versions simulated the same coin, the latest publication wins. Published outcomes are a proper subset of the coins that passed the book screen, so `passed` splits into win, loss, flat, pending and not-simulated, and the tooltip names each. Under the bars a colour strip carries the bucket's net simulated return in stakes.

`chartSnapshot` now emits `outcomes` in place of `launches` and `adaptiveOutcomes`, and no longer replays the regime gate for the chart: `venue`, `shut`, `gateFrom`, `openAt`, `shutAt` and the health-table `halts` had no reader left on the page and are gone from the payload. The state route still replays the gate, and `gateRows()` is unchanged. The four-hour payload is thirteen fields.

### Checks

| Check | Result |
| --- | --- |
| `npm test` | 60 files, 760 tests passed |
| `npm run typecheck` | Passed |
| `node scripts/chart-smoke.mjs` | PASS, 0 errors, all six periods drew, legend toggles redrew, 24 exits with expandable detail |
| Four-hour bucket reconciliation against SQL | 3,323 launches and 279 passed match the payload exactly; win+loss+flat+pending+notSimulated equals passed; passed+filtered equals total; positive and negative sum to net; 77 published rows across 77 distinct coins, all counted once |
| Layout at 375, 414, 900 and 1280 px | No page overflow at any width; all four plot widths equal; cards stack to one column at phone width |
| Hidden-while-flat elements | Account breakdown and open-positions card both compute to `display:none` |
| Open-position fixture | Card appears, account splits into open value and wallet, strip reads 1 / 14 |

The browser suite `test/dashboard.browser.mjs` was rewritten for the new layout but **was not run**: Playwright is not installed on this laptop, and the repo deliberately keeps it out of its dependencies. It needs `PLAYWRIGHT_MODULE=<path> node test/dashboard.browser.mjs http://127.0.0.1:8813`. The checks above were run with headless Chrome directly instead, measuring the rendered DOM rather than driving it.

`scripts/chart-smoke.mjs` gained a `location` stub. The page began reading `location.search` during the 12 September policy work, which made every smoke run fail on the first fetch; this was a pre-existing break, not a consequence of this pass.

### Screenshots

`docs/dashboard-preview/redesign-desktop.png`, `redesign-desktop-top.png`, `redesign-phone-375.png`, `redesign-phone-414.png` and `redesign-open-position.png`. The phone captures were rendered in a 375 px frame because headless Chrome clamps its window to 500 px.

### Limitations

The snapshot's `recent` rows predate `exitAt`, so the preview's Time column reads as dashes; a unit test covers the field on a live database. The execution-price disagreement warning in the snapshot is unchanged, and none of this establishes that the strategy is profitable.

### Deployed and active, 12 September 2026

Shipped with `./deploy.sh` and activated on the user's instruction. The tar carried the whole `bot/` tree, so the concurrent policy work in `bot.ts`, `strategy/exit.ts`, `strategy/gate.ts`, `config/schema.ts`, `telemetry/db.ts`, `operator-state.ts` and `logs/subscriber.ts` went with it; that was stated before the restart was authorised.

| Step | Result |
| --- | --- |
| Box snapshot | `7284389`, from laptop `ca854bf` |
| Tests on the box | 60 files, 760 passed |
| Flat check before restart | 0 open in memory and 0 rows open in SQLite; last close 14:36:41 UTC |
| Restart | `pm2 restart compute-1 --update-env`, process online, restart count 27 |
| After restart | live mode, 0 of 14 open, still paused on the venue guard, size 0.02 ETH, drawdown 0.0471 of 0.0600 ETH, wallet 0.42316 ETH |
| Page | Rolling table reads 1h / 4h / 12h, `recent` rows carry `exitAt`, `/api/chart` serves `outcomes` with 49 buckets |
| Errors | None in the process log beyond the expected venue-halt notice |

No setting was changed, no accounting was reset and `HALT` was not touched. The bot remains paused by the venue guard, which after a restart reports no fresh evidence until the shadow observer refills its window.

The live page is at http://127.0.0.1:8787

## Seven-day backfill and the observer stall, 13 September 2026

Two problems, found in the same screenshot. Implemented locally. No deployment, restart,
live setting change or accounting reset was performed as part of this pass.

### The observer had been down for four hours

`shadow_meta.source_fault` was latched to `SqliteError: database is locked`. The worker's
tick returns immediately while that row exists, so nothing ran: 171 jobs queued and growing,
the reading frozen at -5.68 since 18:53 UTC, both panes reading "No fresh signal", and the
venue guard holding entries closed because of it.

Two faults chained.

- Three stream gaps (`[61254867,61254907]`, `[61265182,61265216]`, `[61362414,61362440]`,
  about 100 blocks or ten seconds of stream) each held a launch the bot's own feed never
  saw. `launches` has zero rows in all three ranges. The worker treated a token absent from
  `launches` as a possibly-missed admission and latched.
- After the 19:43 worker restart it began failing on write contention. The worker set
  `busy_timeout = 1000`; the main `Telemetry` handle set none at all, so it failed instantly
  whenever the worker held the write lock. Both processes write `bot.db`.

Fixed: `gapVerdict` in `shadow-source.ts` now separates `feed-gap` (absent from `launches`,
counted in `shadow_meta.feed_gap_count` and passed over, because the live bot could not have
traded the coin either) from `missed` (in `launches`, past both floors, no job, which still
latches because the shadow account's bankroll and concurrency would be wrong from there on).
`transientDbError` keeps SQLITE_BUSY out of the latch, both handles wait 5 s, `cacheCoverage`
prepares its statements outside the write transaction, and a latch left over from a
contention error clears once at boot with the reason kept in `source_fault_cleared`.

### The three history panes covered 20 hours of a 7-day window

`obs.bars` holds each passed coin's return at seven rungs, 16,516 rows from 2026-09-05 21:03,
which is 6.96 days and grows by a day per day. `scoreObservations` prices each observation at
the rung chosen from the launches before it, reusing `adaptiveTakeProfit`, so the backfill is
priced the way the coin would have been and no coin votes on its own rung.
`reconstructMarketHistory` gained the recovery window and now emits `recentSum`, without
which the Recovery pane stays empty whatever it is fed. `outcomeBuckets` takes the same rows
for coins the shadow account never simulated and reports them as `reconstructed`. The page
draws the rebuilt span as a second dashed series at 60% alpha, so the seam is a break rather
than one line that changes meaning.

### Checks

| Check | Result |
| --- | --- |
| `npm test` | 60 files, 775 tests passed (760 before, 15 new) |
| `npm run typecheck` | Passed |
| `node scripts/chart-smoke.mjs` | PASS, 0 errors, all six periods drew; 7d 8,330 canvas ops against 1,021 at 4h |
| Window totals against SQL | 172,904 launches and 14,893 passed, both exact |
| One 4 h bucket fully inside the window (2026-09-05 16:00) | 6,800 launches, 644 passed, 115 eligible observations, all three exact against SQL |
| Bucket identities | `passed = win+loss+flat+pending+notSimulated`, `total = passed+filtered`, `pos+neg = net`, `win+loss+flat+missing = reconstructed`, all true on every bucket |
| 7 d payload | 3,116 reconstructed samples 09-05 15:20 to 09-11 23:39, then 2,367 recorded; 3,090 carry `recentSum`; 3,126 reconstructed outcomes across 43 buckets |
| Layout at 375, 414 and 1280 px | No page overflow at any width; all four plot widths equal |

### Limitations

The rebuilt series is a wider population than the recorded one. `obs` prices every coin that
cleared the entry screen at full notional size; the shadow account also declines on bankroll,
14 concurrent and template loss blocks. Expect a step at the seam and read it as that.

6.96 days is the ceiling. `obs.bars` starts 2026-09-05 21:03 and nothing older carries the
column, so a 7-day chart will always have its first hour empty.

At 7 d with "Filtered out" visible the y-axis reaches about 10,000 and the outcome segments
are slivers: filtered coins outnumber outcomes roughly 300 to 1. The legend toggle now works
in both directions, which it could not before, because hiding the grey used to leave six
empty days.

`test/dashboard.browser.mjs` gained a backfill scenario but was **not run**: Playwright is
not installed on this laptop. The layout numbers above were measured over the DevTools
protocol against headless Chrome instead.

### Deployed and active, 13 September 2026

Three deploys and two restarts, on the user's instruction to make it run properly rather than
leave the observer down.

`4b04ee9` shipped the backfill and the observer fix (775 tests). Before restarting, two more
changes went in, because the catch-up would otherwise have been the problem:

- **The replay scan is bounded.** `source()` scanned from a coin's launch block to the chain
  head: one 2,000-block chunk for a fresh coin, about 132 for a seven-hour-old one, twice. With
  218 jobs queued that was roughly 29,000 `eth_getLogs` on the live bot's budget.
  `scanCandidates` in `shadow-source.ts` now offers bounds at 12, 30 and 80 blocks per second
  from launch to `endAt`, and the worker keeps the first whose real header is past `endAt`,
  falling back to the tip. The replay never reads a log after `endAt`
  (`counterfactual.ts`), and `verify-shadow.ts` requires durable coverage across `[from, to]`,
  not that `to` is the tip. Three unit tests pin the candidate arithmetic.
- **The grey starts hidden.** Filtered coins outrun outcomes about 300 to 1, so with the grey
  on the pane named for outcomes showed slivers at 7 d. A first visit now hides it; any saved
  choice, including "show everything", is kept. `chart-smoke.mjs` was taught the default.

`6bbd265` shipped those (778 tests). Flat check: 0 open in memory, 0 in SQLite, last close
2026-09-12 14:36:41 UTC. Restart 28 at 01:15 UTC. The latch cleared at boot
(`source_fault_cleared` records what it was), the three stream gaps drained with 7 tokens
counted as feed gaps, and then the queue wedged on something new.

**The replay kernel had changed.** `SHADOW_KERNEL` hashes the replay's source files, and
`shadow-worker.ts` and `shadow-source.ts` are two of them, so every job captured before the
restart now read as "another replay version". The worker threw on that for the oldest queued
job every tick and nothing behind it could move. Marking them `unavailable` would have been
worse: `ShadowAccount.admission` refuses every later job while any earlier one is
`unavailable`. Since nothing had been computed for a queued job, the capture (entry time,
target, calibration, selector) is the intent and the code is not, so the worker now re-pins
such a job to the current kernel and the current config id and replays it there. The kernel
check still applies to published rows, which is what certification looks at. The config id
also includes the kernel, so the observer started a fresh account under `0d6de618` with an
empty window, which is why the reading began at `n = 0`.

`52c3bf7` shipped the re-pin (778 tests). Flat again; restart 29 at 01:25:28 UTC. Within 36
seconds the new config had 3 published and 3 rejected; the queue of 270 was moving at about
one job every 5 seconds against roughly 2 to 6 `eth_getLogs` each.

The live page at 7 d, `docs/dashboard-preview/backfill-live-7d.png`: dashed Market and
Recovery lines from 09-05, solid from 09-11 23:40, outcome bars across every bucket, the
net strip beneath, hatched pending at the right edge where the backlog is still draining.
2,921 rebuilt outcomes before the seam; 165,794 coins, 14,798 passed.

### Drain and certificate

The 270-job queue drained in 18 minutes, 01:25 to 01:43 UTC, about 15 a minute against 2 to
6 `eth_getLogs` each. The reading turned fresh at 01:38 with `n = 20`, and the observer's own
"collection backlog" verdict cleared once the oldest queued job was under three minutes old.

The guard then held on `verification_pending`: the certificate proof is stored per identity,
and the identity changed with the kernel. `verify-shadow.ts --certify` requires operator STOP
in the same transaction that saves the proof, so STOP was set through `POST /api/control`
(the dashboard's own button, `operator_stop = 1`) at 01:44:59, with the bot flat and already
held by the venue guard. The first certificate run died 9 s in on one independent
`eth_getLogs` with the cause discarded; the same call succeeded 111 ms later by hand. The
script gained three retries with backoff, a 120 ms pace between chunks and the cause in its
message, shipped as `f402d79` (a `scripts/` change, no restart). The second run passed:

| | |
| --- | --- |
| Verdict | `execution-and-publication-parity` |
| Outcomes checked | 189, each replayed twice against the frozen 2026-09-11 reference |
| Identity | config `0d6de618`, kernel `85906591` |
| Wall clock | 01:48:58 to 01:52:48 UTC |
| Guard after | fresh, `verified: true`, no observer error, reason `hold`, sum +4.15, latest 8 at -0.57 |
| Blockers | `stopped` (set for the certificate) and `venue` (latest 8 below +1) |

Not done, and deliberately: operator STOP is still set. Lifting it is the money decision and
is the user's, asked for on its own. When it lifts, the venue guard still holds until the
latest eight outcomes clear +1 on a new publication; at the time of writing they read -0.57.

## Filling the observer's blanks, and the 7-day chart's cost, 13 September 2026

Two problems found by measuring the live page, not by reading it.

### 1. The venue and recovery lines were blank for two thirds of the window

The recorded line blanks whenever the observer's reading is not
`fresh && verified && !observerError`. Of 3,224 recorded samples in a 7-day window, only
703 carried a reading.

| Blank (UTC) | Length | Cause |
|---|---|---|
| 09-11 23:40 to 09-12 09:23 | 9.7 h | observer born, uncertified until 08:03, then too few coins overnight to fill a 20-outcome window inside 3 h |
| 09-12 16:41 to 09-13 01:52 | 9.2 h | the stall, plus 14 minutes for the new certificate |

`chartSnapshot` already rebuilt history from `obs.bars`, but bounded the rebuild to the span
*before* the observer's first sample and only ever prepended it. It now rebuilds the whole
window and `spliceReconstructed` (`market-history.ts`) places a rebuilt point only where the
recorded sample in force carries no reading. A recorded reading always wins, at the same
instant too, so a healthy run is never interleaved.

The rebuild covers 24 of 39 quarter-hours in the first blank and 37 of 37 in the second. The
15 it cannot cover are genuinely quiet hours: 0 to 7 eligible coins, where the rule needs 20
inside 3 hours. Those stay blank, which is the honest answer.

**The population caveat now applies throughout, not to one prefix.** `obs` prices every coin
that cleared the entry screen at full notional; the shadow account also declines on bankroll,
14 concurrent and template loss blocks. At 7 days 78% of the drawn line is rebuilt, so the
page says so in those words and draws it dashed at `alpha:0.6` in its own uPlot series.

### 2. Seven days took 4 to 9 seconds

Measured from the laptop against the live page. The draw itself was never the problem: 1 to
4 ms.

All figures below are measured **on the box**, against the live database, not on the laptop.

| | before | after |
|---|---|---|
| payload at 7d | 1,848 KB | 361 KB |
| payload at 4h | 252 KB | 48 KB |
| `chartSnapshot` at 7d | 928 ms | 880 ms |
| rebuild cadence at 7d | every 5 s | every 60 s |
| event loop occupied by one 7d tab | ~19% | ~1.5% |
| adaptive series points at 7d | 6,045 | 1,811 |
| browser, click to painted panes at 7d | 9.0 s first, then 3.9-4.0 s | 1.05 s first, then 1.2-1.4 s |
| browser, chart fetches during 20 s at 7d | 3, each ~4 s | 0 |

**The rebuild itself barely moved, and that is the honest headline.** 880 ms of it is work that
has to happen: parsing 38,581 decision readings (279 ms), grouping 83k launches and joining the
shadow jobs (308 ms), and reading 33k guard samples (107 ms). What changed is that it now
happens once a minute instead of twelve times a minute, which is the 12x reduction in the
trading process's blocked time, and that the result is a fifth the size to send. The user-facing
wait fell from 9 s to 1 s because of the payload and the dropped click, not the rebuild.

Four causes, four fixes:

- **Dead weight on every sample.** `adaptiveHistory` put the whole parsed `market_policy`
  object, the 64-character `config` and `publicationAt` on all 38,581 decisions. The page
  reads none of the three. Dropping them took the series from 1,413 KB to 835 KB.
- **No downsampling.** `adaptiveHistory` had a hard-coded 15 s heartbeat and
  `reconstructMarketHistory` emitted one point per observation. Both now use the
  keep-extremes binner `marketHistory` has always had, exported as `thinSamples`/`binWidth`:
  ~600 bins across the window, first, min, max and last per bin, and a run ends on any change
  of freshness, threshold, state or config so no marker is averaged away.
- **One flat cache TTL.** `cached('chart:'+k, 5_000, ...)` rebuilt seven days of history every
  five seconds inside the trading process. `CHART_TTL_MS` scales it: 5 s at 1h, 60 s at 7d.
  The page polls on the same table. `/api/state` keeps its 1 s poll, so live numbers stay live.
- **A dropped click.** `chartBusy` returned early, so a lookback click during an in-flight poll
  waited out the request and the next tick. That was the 9 s first switch. The fetch now holds
  an `AbortController` and a click cancels the previous one.

Also fixed while in there: the legacy fixed-bar series is no longer built or shipped in
adaptive mode (a second `marketHistory` pass and 292 KB the page never drew); the page reads
which series to draw from `cd.marketSource` instead of `/api/state`, which on first paint
could pick the empty one; `marketAt` and `bucketAt` binary-search instead of scanning from
index 0 on every mousemove across four panes; `drawTrades` no longer spreads the whole trades
array into `Math.max` on every frame; and two indexes were added, `launches(launched_at)` and
`shadow_decisions(at)`, both of which every chart rebuild was scanning in full (407,732 and
38,581 rows).

### The replay identity, and an index that must not live in the kernel

`SHADOW_KERNEL` is a sha256 over eight source files, `shadow-account.ts` among them, and
`shadowConfigId` mixes it in. Adding one `CREATE INDEX` line to that file changed the kernel
from `85906591` to a new value, which changed the config id from `0d6de618` to `fd00ba5e`, which
orphaned the certificate earned on 09-13 at 01:52. After restart 30 the guard read
`verified: false`, `verification_pending`, `n: 0`.

The index was reverted out of `shadow-account.ts`, restoring that file byte for byte, and
created from `shadow-service.ts` instead (not a hashed file) immediately after the
`ShadowAccount` constructor makes the table. The kernel hash returned to `85906591`, the config
id to `0d6de618`, and the existing certificate applied again: `verified: true`, `fresh: true`,
`n: 20`, `reason: hold`, no re-certification needed.

**The rule this leaves behind: nothing that does not change replay arithmetic belongs in a file
inside `SHADOW_KERNEL`.** Indexes, logging, comments and telemetry all cost a certificate if
put there. The eight files are listed at `shadow-account.ts:10`.

### One scoring pass for both panes

`reconstructMarketHistory` scored every observation; `fillFromObservations` scored only the
ones the shadow account had *not* simulated. Because the adaptive rung is chosen from the
launches before each coin, the second pass picked rungs from a gappy history, so the bar split
could price a coin at a different rung than the lines did. Both now take one shared
`ScoredObservation[]` computed once in `chartSnapshot`, which removes the inconsistency and one
full re-parse of every `bars` blob.

### A bug this work created and then fixed

Rounding wallet ETH to 6 dp made a flat wallet line *exactly* flat, and `scripts/chart-smoke.mjs`
then hung. The cause was not the rounding: the smoke harness stubs `setTimeout` to run its
callback synchronously, and the new self-rescheduling poll recursed through it forever. The
poll now carries an in-flight guard that clears after scheduling, so a synchronous timer
cannot re-enter, and the 10 s deadline uses `AbortSignal.timeout` rather than a `setTimeout`.
Worth recording because the harness's stubbed timers make it the only place that would catch
this, and a real browser showed nothing wrong.

### Checks

| check | result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 809 passed, 60 files (778 before; 31 new) |
| `npm run validate` (laptop) | bit-exact, 60/60 curves, 99080/99080 and 409/409 |
| `node scripts/chart-smoke.mjs` | PASS, 0 errors, all six lookbacks, tooltip clean at four probes |
| real browser at 7d | 3 venue series, `dash:[4,4]`, 231 recorded and 1,393 rebuilt points, bars in 43/43 buckets, no exceptions |
| overflow at 1280 / 414 / 375 px | none |

### Limits

The rebuild cannot reach before 2026-09-05 21:03, where `obs.bars` starts, so a 7-day view
will always have its first hour empty. A blank the rebuild cannot fill stays blank rather than
being interpolated. `test/dashboard.browser.mjs` was updated but still needs Playwright, which
is not installed on the laptop, so it remains unrun.
