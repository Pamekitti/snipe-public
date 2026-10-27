# Shared execution, paper accounts and market evidence

New research and the scenario indicator use `predictExecution` in `src/strategy/counterfactual.ts`.
Python calls that TypeScript implementation through `scripts/execution-worker.ts`.
Paper accounts use `reduceAccount` and `replayScenarioAccounts` in `src/strategy/`.
`replay` and the old research adapters remain available to reproduce historical artifacts.
Their output does not qualify a new policy for deployment.

## Execution and available evidence

An execution request pins the entry intent, stake, target, exit rules, timing calibration and costs.
Actual fills, receipts and booked cash are comparison labels.
They cannot supply the predicted quantity, outcome, cost sample or execution failure for that same attempt.
Receipt reconstruction is a separate arithmetic check.

The scenario runner varies preceding p10, p50 and p90 timing estimates and both orders for unresolved same-second transactions.
These are six stresses through one engine.
They are not confidence bounds and need not bracket real losses.
Timing estimates use marginal percentiles of the preceding sample.
The current calibration retains its six-hour embargo and first-observed-mark upper bounds where fill-adoption timestamps are absent.
Changing that calibration requires another frozen comparison.

The kernel excludes our wallet's external orders and recalculates external orders against simulated reserves.
External order quantities remain fixed to history.
Historical traders' responses to a different market path are not modeled.
Missing source coverage, unsupported pool execution and exhausted modeled retries stay unavailable.

The worker requires all event topics and verified block timestamps through the modeled horizon.
It reuses cached headers and records receipt costs from preceding attempts.
It uses bounded reads with one job in flight and backs off on failure.
The real entry and exit paths never wait for simulation or its network reads.

Six results are published together after the latest modeled closure, source publication and durable local completion.
Changing or duplicating an already published result with different calculations is an error.
Reports exclude results published after their requested cutoff.

## Accounts and guards

Each scenario has its own virtual holdings, capacity and template-loss history.
There are three references:

| Reference | Meaning |
| --- | --- |
| Policy account | Selected market rule plus recorded non-market controls and account protections |
| Market-off account | Same executions and account protections, with the market guard disabled |
| Unrestricted opportunities | Filter-eligible outcomes without an executable account's capacity or stops |

An independent Continuous Paper account supplies the indicator while the real wallet is stopped.
It is defined to begin flat at the first prospective capture for the current model hash.
Older model captures remain archived for research and cannot supply the live warmup window.
A restart with the same model retains that account history and its unresolved gaps.
That definition does not reconstruct an earlier real or paper wallet.
Historical account fidelity still requires known initial holdings, controls and template history.
Drawdown resets never erase cumulative simulated cash or cumulative drawdown.

The common entry state pauses if any scenario crosses the selected brake.
It recovers only when every scenario meets the selected recovery conditions using new publications.
The baseline's fresh-only recovery can reopen below its main brake and pause at the next distinct check.
Complete compatible warmup is required.
Stale, invalid, missing or unverified evidence blocks entries.
Configuration changes invalidate the compatible window.

The entry owner records decisions and consumed evidence in `execution_guard_decisions`.
New publications, entry attempts and expiry checks drive it.
HTTP and dashboard reads do not advance it.
A market recovery cannot clear an operator, execution, touch or drawdown stop.

The dashboard exposes main and fresh score ranges, effective windows, publication time and the blocking reason.
After a qualified cutover, its paper line uses the explicitly labeled p50-after Continuous Paper scenario.
The live guard still requires agreement across all six scenarios.
Actual wallet cash stays separate.

## Validation and release

`BACKTEST_STANDARD.md` and `BACKTEST_LIMITS_V1.json` retain the acceptance limits.
An incomplete account comparison has unavailable retention KPIs.
It cannot report a favorable ratio from whichever prefix happened to finish.
Policy reports now use two headline KPIs: winning money retained and losing money retained.
The [guard chart standard](GUARD_CHART_STANDARD.md) fixes their denominators and chart layout.
Trade counts remain supporting diagnostics. Dated four-KPI artifacts retain their original definitions.

`python3 -m research validate-replay --manifest MANIFEST --out NEW_DIRECTORY` audits frozen attempts.
The manifest fixes the UTC boundaries, input hashes, source hashes and model hash.
The report separates captured pre-execution intents from older inferred-intent diagnostics.
It keeps every actual attempt in the coverage denominator.

The earlier 2,160-guard, ten-timing-policy protocol remains a dated frozen experiment.
Candidate counts belong to each run manifest, not to the shared execution standard.
The [September 14 focused run](FOCUSED_GUARD_HANDOFF_20260914.md) tested 1,140 configuration
rows with fixed 45-second timing. Candidate parity compares state-machine calculations against the research rules.
That test is not a market experiment and does not rank their earnings.
Failed fidelity blocks a validated replacement claim.

`VENUE_EXECUTION_SCENARIOS` defaults to zero.
Activation requires a release file beside the simulation database, with the suffix `.release.json`.
The release binds the model, configuration, selected policy, dataset, candidate definitions and hashed validation artifacts.
The controller rejects failed historical fidelity, unsupported selection and missing prospective certification.

The offline command `scripts/verify-execution-scenarios.ts DATABASE LOCK_JSON OUTPUT_JSON` checks at least 20 new complete publications.
Its lock includes `at`, `configId` and `policy`.
An optional `actualFidelity` reference includes a path and SHA-256 hash for a passing actual-attempt audit that starts after the lock.
Shadow calculation parity alone does not pass prospective earnings validation.
Neither this command nor a certificate changes Auto, stake, accounting or any live control.

Deployment and activation follow `v1/DEPLOY.md` after all gates pass.
There is no fixed-bar fallback in the corrected path.
