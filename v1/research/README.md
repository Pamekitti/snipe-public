> Historical document. Snipe was retired on 25 October 2026. Operational statements below describe their original era. Start at the root README for this public edition.

# Research

Use the corrected audit chain below for strategy questions. Files not listed here are
historical evidence or focused operational diagnostics. Raw inputs and generated results
live under `v1/data/` and remain outside Git.

## Start here for the completed September guard charts

The [September 14 focused-grid handoff](FOCUSED_GUARD_HANDOFF_20260914.md) records the
completed Sep 1–7 / Sep 8–14 comparison, exact settings, source repairs, artifact locations,
safe chart regeneration and the steps for a new run. Its results remain diagnostic.
The [guard chart standard](GUARD_CHART_STANDARD.md) defines the five-panel wallet/DD/
retention/indicator layout, halt shading and the two headline money-retention KPIs.
Older dated studies below retain their original four-KPI and fitting conventions.
They do not define the scope or live settings of this completed comparison.

## Shared replay workflow

Follow [BACKTEST_STANDARD.md](BACKTEST_STANDARD.md) before claiming that simulated
earnings are realistic. `validate-replay` compares independent execution and account
predictions with actual cash. A failed or missing certificate means diagnostic only.
The [11 September fidelity findings](BACKTEST_FIDELITY_FINDINGS_20260911.md)
show why a similar net loss can conceal inaccurate trade and account predictions.

The [13 September error profile](SIMULATION_ERROR_PROFILE_20260913.md) documents the
full-period reference scenario, its exact assumptions, and observed deviations across
profitable and losing periods. It includes a machine-readable scorecard.
The scenario remains diagnostic; its historical errors do not establish a future error allowance.

The [sell-clock investigation](EXECUTION_CLOCK_FINDINGS_20260913.md) separates
execution from receipt completion and tests preceding inclusion bounds. It reduces
some false winners in the supported later cohort, but remains diagnostic and changes
no simulator defaults. It does not have preceding-clock coverage before September 8.

`python3 -m research` (from `bot/`) provides capture, preparation, execution benchmarking,
policy comparison, pool quotes, fork verification, and reporting. Read
[CORE_PROTOCOL.md](CORE_PROTOCOL.md) for commands and evidence limits. `capture` freezes
read-only SQLite backups and dashboard state. Research uses the public RPC unless a paid
run is explicit and bounded. `CORE_PROTOCOL.md` defines the four paid-run variables and
the shared allowance. Configured URLs never enter saved artifacts or logs.
`core/` owns new research work. Current dated runners remain compatibility references for
their published findings.

## Evaluation of filters, exits and recoveries

`core/evaluation.py` evaluates the 11 September capture without changing live behavior.
Read [POLICY_EVALUATION_PROTOCOL.md](POLICY_EVALUATION_PROTOCOL.md).
The completed [11 September findings](POLICY_EVALUATION_FINDINGS_20260911.md) link to the full report and frozen outputs.

From `bot/`, run:

```sh
python3 -m research.core.evaluation audit --root data/research/20260911-policy-evaluation
python3 -m research prepare --snapshot data/research/20260911-policy-evaluation/snapshot.json.gz \
  --out data/research/20260911-policy-evaluation/replay --days 7 \
  --since-ms 1788874920582 --population screened --scope opportunities --fetch-missing --immutable-latest
python3 -m research benchmark --run data/research/20260911-policy-evaluation/replay
python3 -m research.core.evaluation build --root data/research/20260911-policy-evaluation
python3 -m research.core.evaluation compare --root data/research/20260911-policy-evaluation
python3 -m research.core.evaluation_report --root data/research/20260911-policy-evaluation
```

`--population screened` retains launches rejected by the trading entry floors.
`--since-ms` limits inference to a recorded policy era. The default preparation
population and existing dated runs retain their original behavior. Missing admitted
executions stop the new comparison instead of being removed from every policy.
Reruns need a fresh output directory. Immutable source archives accompany results
under `objects/`; a checkpoint refuses a different dataset or model implementation.

## Current guard research

The [indicator experiment findings](INDICATOR_FINDINGS_20260911.md) test window length,
strategy-matched returns, exponential weighting, direction and staged exposure against
the 11 September 12:44 UTC capture. The main staged runs earned simulated profit, but
every later-start stress lost money. No candidate passed the full acceptance criteria.
Read [the experiment protocol](INDICATOR_POLICY_PROTOCOL_20260911.md) before rerunning.

```sh
python3 -m research.core.indicator_study models \
  --root data/research/20260911-indicator-input \
  --tail data/research/20260911-indicator-input/tail
python3 -m research.core.indicator_study sizes \
  --root data/research/20260911-indicator-input \
  --tail data/research/20260911-indicator-input/tail
python3 -m research.core.indicator_study compare \
  --root data/research/20260911-indicator-input \
  --out data/research/<fresh-indicator-run>
```

The prepared tail begins at the preceding evaluation capture, 1789118987068 ms.
The runner reuses immutable earlier execution models and adds independent smaller-size
and fixed-target controls. `core/indicators.py` owns causal signal availability and the
optional research guard. Captured configuration supplies stake, book floors and baseline
thresholds. New indicator events never advance the other guards' polling schedules.
All production behavior is unchanged.

The [11 September guard timeline comparison](GUARD_VISUAL_FINDINGS_20260911.md)
holds TP and filters fixed while comparing the current guard, market guard removal,
and continuous trading. It also measures the recorded passages from -1 to +2.
`core/guard_visual.py` generates the three charts and time-bin report from frozen inputs.
These results remain diagnostic because execution-delay assumptions reverse the account ranking.

```sh
python3 -m research.core.guard_visual \
  --root data/research/20260911-guard-visual-input \
  --previous data/research/20260911-policy-evaluation \
  --tail data/research/20260911-guard-visual-input/tail \
  --out data/research/<fresh-guard-visual-run>
```

The guard work forms one dependency chain:

1. `guard_audit.py` provides receipt-based cash accounting, causal signal timing,
   capacity, and account-risk simulation.
2. `market_guard_audit.py` tests market thresholds and distinct recovery updates.
3. `market_guard_extension.py` carries actual stake changes and account state across a
   longer retrospective period. It added no new real trades after the first snapshot.
4. `market_guard_longer.py` and `market_guard_longer_fetch.py` compare one and two
   weeks using complete curve ranges, explicit signal reconstruction and execution
   calibration. The longer results do not establish a live improvement.
5. `recovery_policy_audit.py`, `recovery_policy_models.py`, and
   `recovery_policy_followup.py` test false recoveries after both market and DD
   pauses. Read `RECOVERY_POLICY_PROTOCOL.md` and
   `RECOVERY_POLICY_FINDINGS_20260908.md`. `recovery_policy_report.py` renders the
   saved comparisons and checks aggregate cash.

Read each matching `*_PROTOCOL.md` before running its script. The completed findings are
`MARKET_GUARD_FINDINGS_20260908.md` and
`MARKET_GUARD_EXTENSION_FINDINGS_20260908.md` and
`MARKET_GUARD_LONGER_FINDINGS_20260908.md`.

The completed 14-day comparison is in
`data/research/20260909-guard-engine-final-v12/`. The complete opportunity model selects
`market_plus1`, but the shorter recorded-fill comparison favors `market_plus2` and +1 has
one more false restart. The live policy remains +2 pending separate review. Read
`IMPLEMENTATION_STATUS.md` for exact figures and unresolved evidence.

`stale_policy_audit.py` isolates stale reopening, retaining pauses, ignoring the age
limit, and blocking all stale entries at +1 and +2. Read `STALE_POLICY_PROTOCOL.md`
and `STALE_POLICY_FINDINGS_20260908.md`. The comparison favors retaining the existing
stale exception at +2; holding pauses earned less without reducing modeled drawdown.

`activity_policy_audit.py` and `activity_policy_report.py` compare seven entry overlays
on Market +2: launch pace, ETH turnover per coin, buyers per coin, net buying, gains
without the largest winner, recent direction, and demand with launch pace. Read
`ACTIVITY_POLICY_PROTOCOL.md`. Results and preserved benchmark copies are under
`data/activity-policy-20260908/`. The 8 September pass found no replacement for +2:
two overlays improved the recent conditional replay but reduced longer modeled profit.
The fresh export contained the same 169 actual attempts, so it added no independent
execution validation. All live behavior was left unchanged.

## Other corrected studies

| Question | Instrument | Protocol or findings |
|---|---|---|
| Exit policy | `exit_policy_audit.py`, `exit_policy_fetch.py`, `test_exit_policy_audit.py` | `EXIT_POLICY_AUDIT_PROTOCOL.md`, `../../docs/EXIT_POLICY_ANALYSIS_2026-09-07.md` |
| Size, target, and clock together | `joint_policy_audit.py`, `test_joint_policy_audit.py` | `JOINT_POLICY_PROTOCOL.md`, `../../docs/JOINT_POLICY_ANALYSIS_2026-09-07.md` |
| Guard foundations | `guard_audit.py`, `test_guard_audit.py` | `GUARD_AUDIT_PROTOCOL.md`, `../../docs/GUARD_AUDIT_2026-09-07.md` |
| Graduation cohort | `graduation_audit.ts`, `graduation_archive.mjs`, `graduation_summary.py` | `GRADUATION_PROTOCOL.md`, `../../docs/GRADUATION_ANALYSIS_2026-09-07.md` |
| Graduation entry timing | `graduation_launch_prepare.mjs`, `graduation_launch_archive.mjs`, `graduation_launch_summary.py` | `GRADUATION_LAUNCH_PROTOCOL.md`, `../../docs/GRADUATION_LAUNCH_ANALYSIS_2026-09-07.md` |
| Contract-level graduated exit | `graduation_fork_check.ts` | `../../docs/GRADUATION_EXIT_VERIFICATION_2026-09-07.md` |

Run the research tests from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 \
  python3 -B -m unittest discover -s bot/research -p 'test_*.py'
```

## Operational diagnostics

These tools answer narrow operational questions. They do not select a strategy.

| Instrument | Purpose |
|---|---|
| `approval_backfill.py` | Recover and apply exact historical approval costs with a database backup. |
| `blockcheck.ts` | Compare the curve reader with the ArbSys block. |
| `devbuycheck.ts` | Check launch calldata against the launch event. |
| `feedgaps2.ts`, `wsgap.ts`, `wssmoke.ts` | Diagnose feed gaps, lead time, and socket delivery. |
| `provider_feed_sample.ts` | Reproduce the read-only provider feasibility sample. |
| `recon2.py` | Compare wallet transaction counts with the ledger. |
| `taxpaid.ts` | Measure the snipe-tax bracket paid by actual buys. |
| `v4.ts` | Inspect graduated V4 pool state and prices. |

## Historical evidence retained by reference

`edge_fresh7d.py`, `guardcheck2.ts`, and `wind.py` through `wind3.py` remain because
source comments cite their measurements. They use historical assumptions. Do not use them
to choose current settings.

The earlier experimental families were removed from the active tree after exact legacy
reproduction, dependency checks, and the full test suite passed. Their conclusions remain
in Git history. This includes the legacy guard grid, reconstructed guard tape, breaker
experiments, regime scripts, old edge summaries, and stranded-on-curve graduation sweeps.

## Data rules

- Use current-era exports only for live strategy questions.
- Keep the final three to six hours out of fitting.
- Report the last 24 hours in eight bins and the last seven days in seven bins ending now.
- Give every mean with its median, sample standard deviation, and sample count.
- Use `COALESCE(onchain_pnl_wei, pnl_wei)` for booked profit.
- Preserve actual stake sizes. Never scale a smaller fill into a larger one.
- A missing outcome is unavailable, not zero.
- Record inputs, hashes, settings, and limitations beside every finding.

## Longer guard comparison, 11 September 2026

[Findings](LONG_HISTORY_FINDINGS_20260911.md) distinguish automatic operation from
recorded human controls. [The frozen protocol](LONG_HISTORY_PROTOCOL_20260911.md)
records the user-authorized historical extension and its coverage amendments.
This is a dated comparison under the captured configuration, not a live-setting change.

The frozen inputs live in `v1/data/research/20260911-long-history-input/`.
Results live in `v1/data/research/20260911-long-history-results-v2/`.
The earlier directory without `-v2` contains an explicitly invalidated partial run.

Run from `bot/`, using the existing frozen models:

```bash
python3 -m research.core.long_history study
python3 -m research.core.long_history_segments
python3 -m research.core.long_history_segments_report
python3 -m research.core.long_history_report
python3 -m research.core.long_history_supplement
python3 -m research.core.long_history_leader_stress
python3 -m research.core.long_history_automatic_report
```

The study can be split across three processes with `--shard 0 --shards 3`,
`--shard 1 --shards 3`, and `--shard 2 --shards 3`. Once all three finish,
`python3 -m research.core.long_history_finalize` verifies and combines their indices.
Group files are resumable checkpoints. Do not edit source files during artifact runs.

`long_history merge` and `long_history models` belong to acquisition and execution
preparation. Model checkpoints bind their original source hash and intentionally reject
source changes. The original source archives remain beside the artifacts. Do not delete
a valid checkpoint to bypass that check or overwrite the frozen comparison with new data.

Reports include common interval scores, continuous-account coverage, eight three-hour
bins, seven daily bins, previous-week ranking diagnostics, publication-delay stresses,
cash attribution, and the four always-on capture ratios. Missing graduated exits remain
unknown. The interval sums must never be labeled continuous wallet earnings.

`python3 -m research.core.guard_selection_chart` builds the final cash line charts and
the four requested ratios from those frozen outputs. It records `fixed_shadow20` as the
selection for implementation in `final-selection/decision.json`. This selection performs
no live change. Losing-trade and losing-money ratios mean losses retained, so lower is
better. Both full-interval and uninterrupted 48-hour views retain the same denominator
for every candidate.

## September stateful guard sweep

`core/september_guards.py` defines 59 variants across 15 market-guard families on the
same adaptive shadow outcomes. `core/september_guard_study.py` freezes definitions
and compares nine execution, publication and operator-control scenarios. This is
research only. The frozen input ends September 11 at 12:44 UTC.

From `bot/`:

```sh
python3 -m research.core.september_guard_study freeze
python3 -m research.core.september_guard_study run
python3 -m research.core.september_guard_report select
python3 -m research.core.september_guard_report report
python3 -m research.core.september_guard_verify
```

Results are in `data/research/20260911-september-guards-v2/`. `selection.json` uses
September 1-7 only. `scorecards.json` retains every variant and the four requested
always-on ratios. `strict-prefix.json` distinguishes the complete uninterrupted
prefix from the conditional 11-interval comparison. Missing graduated exits remain
unavailable. No source under `src/`, live configuration, or activation is changed.

## Version 3 execution alignment

`core/shared_execution.py` calls the production TypeScript prediction and account reducer.
`python3 -m research validate-replay --capture <export.json.gz> --dataset <dataset.json> --out <new-directory>`
produces the corrected diagnostic scorecard, source archive, September coverage manifest and era-separated bins.
The older grid worker retains its frozen legacy semantics. A certificate from that model cannot authorize new strategy ranking.
`alignment_load.ts` measures bounded capture and background replay in a controlled laptop comparison.


## Shared account grid performance

`prepareScenarioAccounts(input)` owns a copy of the frozen input. It builds each
continuous shadow account and market-off reference once. Guard policies with the same
main window, fresh window and evidence age reuse the publication schedule and indicator
values. Each selected account still uses `reduceAccount`, including capacity, template
losses, stops and cumulative cash across resets.

`replayScenarioAccountGrid(input, policies)` groups those policies for reuse and returns
scorecards in the supplied candidate order. Thresholds, integer arithmetic, floating-point
summation order and publication times are unchanged. Returned objects belong to the
prepared run. Treat them as read-only. Replay a selected candidate separately when
full cash lines and guard decisions are needed for charts.

Python callers can use `ExecutionWorker` from `core/shared_execution.py` as a context
manager. Reuse it for sequential offline batches. The `scenario-account-grid` operation
returns all scorecards for one input and candidate batch. The existing `execute_batch`
interface remains compatible. The dated Python grid retains its frozen implementation;
these optimizations do not change a process already running that older code.

The performance instrument is `core/grid_speed_benchmark.ts`. From `bot/`:

```sh
ENV_FILE=/dev/null MODE=observe LIVE=0 DASH=0 DOTENV_CONFIG_QUIET=true \
  node --import tsx research/core/grid_speed_benchmark.ts \
  data/research/20260914-grid-speed-v3 pilot 25272 900000
```

This command overwrites the named pilot outputs. Use a new run directory with copies of
its load fixture, candidate definitions and protocol when preserving an earlier result.
The fixtures deliberately reschedule recorded outcomes to create a computational load.
They do not represent historical wallet performance. Their apparent returns must never
be used to rank policies or certify simulation accuracy.

The benchmark writes completed policy counts, a heartbeat, measured durations and a
result digest. Exact reference comparisons are preserved under
`data/research/20260913-grid-speed-v1/` and `data/research/20260914-grid-speed-v3/`.
Cash fidelity remains a separate gate under `BACKTEST_STANDARD.md`.
