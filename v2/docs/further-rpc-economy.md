# Further RPC economy

All new routing switches default off. Existing halted economy remains independent.
Strategy, sizing, stops and execution rules are unchanged when the switches are off.

| Switch | Behavior |
| --- | --- |
| `RPC_TX_CACHE=1` | Reuse signed launch calldata after hash, chain, destination and selector validation. Misses use the existing paid lookup. |
| `RPC_FILTER_MODE=compare` | Compare a paid filter against authoritative range scans without delaying them. Additional calls require the shared allowance. |
| `RPC_FILTER_MODE=live` | Use filters only while flat and idle, with range verification every two seconds. Critical work retains range polling. |
| `RPC_QUIET_ECONOMY=1` | Public polling between opportunities, with an entry hold and immediate paid preparation when a launch arrives. |
| `RPC_HALTED_READ_ECONOMY=1` | Public observation and maintenance reads while all books are halted and readiness is held. Critical work preempts public reads. |

These environment settings take effect at process startup. Changing a switch does not clear
an automatic disable file. Inspect the recorded failure before explicitly resetting that
feature's disable state during a later reviewed rollout.

The cache also compares signed feed bytes against ordinary paid metadata while reuse is off.
This adds no network requests. `cache.compared` excludes missing reference results and
`cache.mismatches` disables cache reuse in that process. Public and paid pending lookups are
separate, so a hung public lookup cannot hold up the critical paid request.

Filter events do not advance the verified cursor. A timeout or expired filter requires range
repair. Missing or changed events disable filters persistently. After 120 eligible cycles,
filters also disable when their measured paid units equal or exceed equivalent range calls.
The comparison reader stops when its shared allowance is exhausted; execution does not.
Live filter events remain tentative until the range scan verifies their order and completeness.
A launch in a filter response forces that scan immediately. This avoids applying an event that
a later repair could not undo in curve reserves or guard history. The two-second verification
interval still requires arrival-timing acceptance before activation.

Quiet preparation does not wait for a newly armed launch to expire. The fold retains a
chain-released arm while readiness is held and expires it at its original fallback deadline.
A missed deadline disables quiet routing. STOP cancels the preparation generation. Paid
preparation refreshes gas and nonce when halted-read economy is enabled, and waits for any
preempted maintenance operation before applying those fresh values.

## Measurement

`/api/state.rpcRouting` adds transport, verified cursor, filter repairs and disables, cache
counts, quiet preparation, shared comparison usage and traffic grouped by phase, purpose,
route and method. Phases are halted, quiet and critical. Seven days of minute summaries live
beside the tape. Older summaries without purpose fields remain readable.

The dashboard displays routing, verified coverage, paid rescues, reuse, preparation and
automatic-disable reasons. Compute units are estimates, not an invoice. JSON-RPC batching
does not make its members free.

## Bounded transport comparison

Run `node --import tsx tools/rpc-economy-compare.ts OUTPUT.json 24` from `v2/` on the
production host after source verification. It requires all four explicit research settings:

- `RESEARCH_RPC_URL`: the selected research endpoint, never inherited from trading.
- `RESEARCH_ALLOW_PAID=1`.
- `RESEARCH_MAX_PAID_REQUESTS`: a positive integer at most 100000.
- `RESEARCH_PAID_BUDGET_PATH`: the shared comparison SQLite file. Use the same path as the
  running comparison reader if both are active; do not create separate allowances.

The production filter comparison uses `TAPE_PATH.rpc-comparison.sqlite` with a maximum of
100000. Prefer one comparison reader at a time. Every member and retry is charged before
sending. The collector cannot sign or broadcast and does not load `.env`. It polls the public
route and the candidate filter, verifies against paid ranges, and reports latency mean,
median, standard deviation, p95 and sample count. Reports include eight trailing 24-hour bins
and seven trailing daily bins, with unavailable history labelled partial.

This collector is transport evidence only. Its output deliberately cannot certify entry or
guard parity. Complete paired arrival-timing analysis against the actual reference tape before
activating quiet routing or halted metadata reads. Require at least 24 hours, 100 launches and
20 reference-admitted opportunities, with the final six hours held out. Zero additional missed
reference entries, unchanged guard decisions and lower net paid usage are required. A missing
comparison remains a failed activation gate, even if unit tests and ordinary replay pass.

## Release and rollback

Verify the current deployed source, strategy hash, controls and flatness. Use `WITH_CONFIG=0`.
Prepare the actual fold with `tools/prepare-economy-snapshot.ts SOURCE_ROOT SOURCE_SNAPSHOT
TAPE --quiet-upgrade`; it pins both reviewed core inventories, compares decisions and state
against the old fold, and refuses unsettled wallets. Follow the restart commands in
`v1/DEPLOY.md`. Never rebuild historical cash using a different policy.

Enable cache reuse, filters, quiet routing and halted reads separately, after their evidence
passes. Do not stop trading to create a measurement period. Revert the affected switch to off
and restart only when flat if routing health worsens. Preserve disable evidence and all money
controls. Failure to obtain the required sample leaves the feature disabled.

## Local verification on 2026-09-26

- V2: 760 tests passed on production after the settlement eligibility correction; typecheck passed.
- Research: 353 tests passed, one skipped.
- Historical comparison: 250000 events, 30856 intents/refusals, identical decisions and final
  state; snapshot resume matched. These inputs predate this rollout and prove no transport timing.
- Curve validation: 60/60 curves, 99080/99080 core checks, 409/409 tax checks, all exact.
- Isolated dashboard: routing, reuse, filter-disable reason, preparation and failure feedback
  observed. STOP cancellation passed controller tests; browser cancellation was not completed.

## Production rollout on 2026-09-26

Build `42eea98fdf69c04a` is running live. Both code deployments used `WITH_CONFIG=0` and
both restarts were flat. Strategy hash remained
`fad0f7ccd497a8292febc4073b3057cb68fa69a82ab67647055a71d564ca4d07`.
Wallet balance, booked P&L, sizes and book stops matched across each restart. Logs and feed
were healthy afterward; the recorded gap count remained 112.

Actual-fold upgrades compared 2283 and 2444 live events respectively, with identical state,
history and decisions. The settlement correction reuses the existing quiet-wallet check:
expired unsigned approvals are inert, while signed, recent and other unresolved actions
still block economy eligibility. No historical transaction record was deleted.

New optimization switches remain off. Existing halted economy remains on. Passive cache
comparison requires no additional network requests. The first three-minute transport probe
audited 579 logs with no missing or mismatched records; it was deliberately stopped before
the eligibility correction and its evidence was preserved.

The full 24-hour comparison started at 2026-09-26 19:53:39 UTC on the corrected build.
Its final six-hour holdout starts at 2026-09-27 13:53:39 UTC. It is supervised separately
as `snipe-rpc-comparison-20260926-r2`, with results under
`data/rpc-economy-20260926-r2/`. Raw log and head arrival evidence is recorded beside the
transport report. Its shared 100000-request allowance includes the first probe and caps
additional estimated paid usage at $3.15 at the configured rate.

The supervisor stops optional comparison work if observation health worsens. An hourly
task follow-up stays quiet during healthy collection and reports actionable failures or
completion. The pre-rollout mixed-workload estimate was about $74/month. Additional monthly
savings, paired arrival-timing acceptance and staged feature activation remain unproven.
