# Adaptive fresh recovery release

The production integration is implemented. The first deployed source collector failed prospective verification; its replacement requires a new verification window.
Operator STOP remains required throughout collection and verification.

## Selected behavior

Require 20 available shadow outcomes from launches within three hours. While running,
pause below minus one stake across those 20 outcomes. While paused, reopen only on a new
publication whose latest eight outcomes sum above one stake. A recovery can occur while
the 20-outcome sum remains below minus one, followed by a pause on the next distinct check.
The 8,056 recorded research decisions preserve that selected behavior.

## Evidence path

`src/strategy/counterfactual.ts` is shared with the research worker. The frozen original
worker and 144 captured requests check exact integer fills, costs, exit decisions and times.
The background worker verifies a historical interval at least ten seconds behind the head.
It requires two matching scans one second apart, verifies block timestamps, fills source gaps
and runs the independent shadow account. Actual entries and exits never await its RPC work.

Shadow entries pin adaptive TP, the selector observation snapshot, configuration, stake,
exit rules and preceding reconciled cost samples. Shadow capacity and template losses are
independent of actual positions. Publications require modeled closure, gatewatch completion
and a durable local result. Configuration and execution-source changes start a separate window.

Guard decisions run on publication, entry attempts and freshness expiry. Dashboard reads
only display the cached decision. A recovery clears the market stop alone. Manual, touch,
execution and drawdown stops remain independent.

## Verification and limits

The September deployment-clock comparison is in
`data/research/20260911-fresh-live/september/report.md`. It uses the frozen September sample
and selected thresholds. Historical RPC processing duration is unknown; the report retains
an additional publication-delay stress scenario. These are retrospective simulations.

The cash-fidelity report in `data/research/20260911-fresh-live/fidelity` remains diagnostic.
Exact calculation parity does not establish realistic predicted earnings or future profit.

Before release certification, collect at least 20 new complete shadow outcomes and run
`scripts/verify-shadow.ts` against their frozen inputs. It compares with the frozen original
worker, checks source coverage and publication ordering, and records an engineering certificate.
An unresolved execution, worker failure or missing launch intent blocks entry permission.
Source log gaps are backfilled automatically. A missed eligible launch without a frozen
admission cannot be reconstructed faithfully and requires explicit source repair.

No stake increase or accounting reset is part of this release. Auto activation is a separate
operator action after prospective verification. See `DEPLOY.md` for the rollout procedure.

## Source defect caught before activation

The first prospective sample failed independent source verification on September 12.
Live poll responses omitted four orders before the first modeled exit. An earlier cache
comparison also found additional events after exits; those later events do not affect results.
The execution interval itself must match an independent historical fetch exactly.

Version 2 treats poll coverage as a cache hint. Every outcome uses the settled, repeated
historical scans described above. The first sample is preserved under archived shadow tables
and cannot authorize entries. The replacement starts a new shadow account and requires 20 new
complete outcomes. Actual positions, cash accounting, stake and drawdown settings are unchanged.
The release evidence records deployment and verification progress.
