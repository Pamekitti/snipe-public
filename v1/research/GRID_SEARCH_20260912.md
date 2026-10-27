# September guard and exit grid search

The study is running. There is no final selection yet. Live trading settings are unchanged.

The frozen capture ends 2026-09-12 at 08:20:26.881 UTC. It contains 22,454 screened
September launches. September 1–7 supplies fitting data. September 8 through six
hours before capture supplies retrospective validation. The final six hours are reserved.
Previously inspected history is never described as prospective validation.

## Experiments

The coarse grid contains 12,768 guards. Main windows are 10/15/20/30/40; fresh
windows are 3/5/8/10/15, constrained to the main window. Pause thresholds are
−0.5/−1/−1.5/−2; fresh recovery thresholds are +0.5/+1/+1.5/+2; full recovery
thresholds are +1/+2/+3. Freshness limits are 30/60/120/180 minutes. Recovery
modes are fresh, full, and either. Absolute and baseline-normalized thresholds
are separate candidates.

There are 48 static or path-dependent exit descriptors: five fixed holding
periods, fifteen separate early-exit timer variants, sixteen progress extensions,
and twelve inactivity exits. Maximum holds are 20/30/45/60/90 seconds. Separate
market-selected holding periods use windows of 20/40/60 common completed observations.
Joint TP/hold selection has its own 35 combinations, before execution-delay stresses.

Every candidate retains independent capacity, template-loss history, costs,
account stops and causal publication. Missing executions remain unavailable.
Report continuous prefixes separately from conditional intervals with independent starts.
Compare market-disabled accounts with the same other stops, and separately show the
unrestricted opportunity benchmark. Retention KPIs show wins, losses, winning money
and losing money against explicit always-on denominators. Exit changes also need the
fixed baseline denominator. Net profit and cumulative drawdown remain separate.

Select training Pareto candidates without a fabricated weighted score. Fine-search
training neighbors, lock candidates, then evaluate later periods and the reserve.
Show profit/risk tradeoffs for operator choice. No backtest enables Auto.

## Current artifacts and checks

Artifacts are under `v1/data/research/20260912-grid/` relative to the repository root.
The original `historical-training-seed` was stopped for optimization and invalidated.
`training-seed-v2` and `training-seed-fast` are historical training computations,
not final September-to-capture rankings. The fast runner reuses account results only
when the guard has identical allowed-state transitions and identical expiry clocks.

The parameterized guard reproduces 8,056 frozen decisions. The research execution
copy reproduces 144 integer replay fixtures exactly. Default worker calls remain
compatible. Dynamic exit logic exists only in the research copy, never in production.

Remaining work: finish acquisition; verify merged coverage; generate candidate exit
models and matched shadow tapes; run joint sweeps and refinement; lock candidates;
run validation/stresses; run cash fidelity and the complete suites; render and inspect
cash/drawdown/KPI charts; publish the comparison and risk tradeoffs.

## Durable execution

`python3 -m research.core.grid_pipeline --root data/research/20260912-grid` runs the
remaining stages in order. Stage logs and `pipeline-status.json` identify progress
and failures. Completed jobs are checked against their input identities before reuse.
`pause.request` in that directory stops the research at a stage or account-job boundary.
It does not control trading.

The exhaustive joint stage has 54 exit policies × 12,768 guards × six execution
scenarios, before independent coverage intervals. This is a multiday computation.
The separate exit-axis stage runs the baseline guard first for all 54 exits.
The training-only frontier uses worst net cash, drawdown and losing-recovery losses
across the six scenarios. It retains tied candidates. Refinement changes one nearby
coordinate at a time within the declared ranges. No validation outcome enters selection.

The final replay preserves a serial worker publication clock. Historical durable
completion is modeled from coverage delay and one-second worker ticks, since the
historical counterfactual worker did not exist. A separate 60-second publication-delay
stress measures sensitivity. These are explicit timing assumptions, not observed
historical worker completion times.

The exit pilot completed 2,988 comparisons on 12 launches: 2,739 closures and 249
entry-price rejections. Its account reference closed 11 trades with complete matched
publications. The accelerated replay matched 9,936 scalar cases. Laptop curve
validation passed 99,080 integer fills and 409 tax checks. The existing cash-fidelity
report was rerun and remains diagnostic; it does not certify this new capture.

The initial acquisition may reject its final source archive because research files
changed during development. Its verified RPC responses remain in the durable cache.
The pipeline rebuilds the prepared artifact with frozen sources before merging inputs.
It never bypasses the source check.
