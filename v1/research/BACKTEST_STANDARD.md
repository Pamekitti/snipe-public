# Backtest standard

Validate simulated cash against actual cash before trusting a strategy comparison.
The standard command is `python3 -m research validate-replay` from `bot/`.
It reads frozen evidence and never changes the live bot.

For policy comparison output, follow [GUARD_CHART_STANDARD.md](GUARD_CHART_STANDARD.md):
Win retained and Loss retained measure money, with wallet, DD and indicator lines.
These two headline KPIs do not replace the independent execution-fidelity metrics below.
The [September 14 handoff](FOCUSED_GUARD_HANDOFF_20260914.md) is a completed diagnostic
example, including its blocked checks and frozen statistical conventions.

```text
Launches + swaps + receipts + recorded decisions + policy history
                              |
                       Freeze and hash inputs
                              |
              1. Reproduce transaction math and costs
                              |
              2. Predict outcomes of actual trade intents
                 Compare each prediction with its real result
                              |
              3. Replay the whole account from known state
                 Compare entries, profits, losses and drawdown
                              |
                     All accuracy checks pass?
                         /             \
                       NO              YES
                       |                |
                Diagnostic only    Historical fidelity pass
                                        |
                               Compare candidate policies
                                        |
                               Confirm on new observations
                                        |
                          Separate user decision about live use
```

## Three checks answer different questions

| Check | What it establishes | What it cannot establish |
| --- | --- | --- |
| Transaction reconstruction | Curve arithmetic, taxes and receipt costs agree with chain history | A simulated trade would have executed at the predicted time |
| Independent intent replay | Predicted outcomes resemble the actual attempts, with the same recorded intent and rules | The policy would choose the right launches by itself |
| Whole-account replay | The simulated policy resembles actual entries, cash and cumulative losses | Future profitability or the market's response to different orders |

The independent replay uses the production exit evaluator and curve implementation.
It starts from recorded entry intent, target and send clock.
Gas and exit delay estimates use preceding completed trades.
The final six hours cannot supply calibration observations.
Actual fills and actual failed-buy losses are not copied into predicted earnings.
A separate replay using actual fills checks exit reasons and decision timing.

The account replay chooses entries from the captured opportunity population.
It preserves capacity, operator stops, recorded controls and initial account state.
It uses simulated outcomes for failed buys too.
All drawdown resets remain in the control history, but never erase cumulative cash losses.
The benchmark also reruns the archived account model to check that the shared account engine reproduces its saved decisions and cash.

## Evidence requirements

Freeze SQLite backups, dashboard state, configuration history, strategy contexts,
launch observations, ordered swap logs, block timestamps and transaction receipts.
Keep accepted and rejected launches so filter comparisons have a denominator.
Record coverage for the observed population; an API response does not prove coverage of every launch.
Preserve signal availability times, polling, send and receipt times wherever recorded.

Use `COALESCE(onchain_pnl_wei, pnl_wei)` for actual cash.
Reconcile receipts with the book, then reconcile the book with wallet movements.
Explain every remaining wallet residual before passing accounting validation.
Exact integer curve math is required independently of approximate execution timing.

Keep historical stake and exit-rule eras separate.
The current adapter validates the recorded market-policy era in `audit.json`.
It also reports contiguous stake, exit-rule and build partitions inside that era.
Older weekly bins outside the era stay unavailable.
A different policy era needs its own audited controls and calibration.
Changing `--days` alone does not establish comparable evidence.

Unknown executions stay unavailable, including unsupported pool exits and stake changes.
The first admitted unknown execution ends the comparable account prefix on both sides.
An explicit price rejection can predict zero cash because it is a modeled no-entry decision.
An unknown execution cannot predict zero cash.

## Required scorecard

Report actual and predicted winning profit, losing loss, net cash and cumulative drawdown separately.
Profit and loss include each attempt's execution costs.
The account table assigns an attempt's total cash to its close time on both sides.
It measures closed-cash drawdown, not the lowest intratrade wallet valuation.
Per-trade error tables group attempts by entry time and include their completed outcomes.

Include signed error, absolute error, profit/loss sign agreement and exit timing error.
An error of one percentage point means an error equal to 1% of that attempt's stake.
Include entry precision (correct simulated entries / all simulated entries) and recall
(actual entries reproduced / all actual entries).
Every mean must show median, sample standard deviation and count beside it.
Report the last 24 hours in eight bins and seven days in seven bins, ending at capture.
Show missing predictions and short samples explicitly.

The machine-readable scorecard contains every prediction and failed check.
Its certificate binds the dataset, input artifacts, simulator source and acceptance limits by hash.
Changed inputs, changed runtime code or a missing certificate make the report diagnostic only.

## Version 1 acceptance limits

[BACKTEST_LIMITS_V1.json](BACKTEST_LIMITS_V1.json) owns the numerical limits.
These are engineering error budgets introduced on 11 September 2026 after inspecting the historical capture.
They are not a fitted confidence interval or prospective validation.
Do not loosen them to make a particular run pass.
A justified revision needs a new version and a comparison on new observations.

| Check | Required |
| --- | --- |
| Fit sample / reserved sample / each execution-era sample | At least 100 / 20 / 20 attempts |
| Missing predictions | Zero |
| Absolute signed bias | At most 1 percentage point of stake |
| Mean / median / 95th percentile absolute error | At most 5 / 1.5 / 10 percentage points |
| Profit/loss sign agreement | At least 95% |
| Entry precision and recall | Each at least 95% |
| Error in total winning profit and total losing loss | Each at most 10% |
| Net cash error and cumulative drawdown error | Each at most 0.10 reference stakes |
| Largest cumulative cash difference | At most 0.25 reference stakes |
| Actual-fill exit reasons | At least 95% agreement |
| Actual-fill timing evidence | Present for every completed trade |
| Median / 95th percentile exit timing error | At most 1 / 2 seconds |
| Receipts, arithmetic, source and causal-input checks | All pass |
| Unexplained wallet residual | Zero wei |

The reference stake is the smallest actual stake in the cohort.
Small samples fail rather than inheriting a pass from a longer period.
The final six hours remain excluded from fitting even if fewer than 20 attempts occurred.
Gather a later capture to resolve the sample shortfall; do not move the boundary to improve a result.

## Observed error profiles

[13 September simulation error profile](SIMULATION_ERROR_PROFILE_20260913.md) records
the exact settings and measured deviations of the fixed full-period reference scenario.
It covers profitable and losing periods, with 1,182 receipt-matched attempts.
The profile remains diagnostic and does not promote a simulation default.
Historical percentiles are not expected future deviations or confidence bounds.
Keep these observed measurements separate from the acceptance limits above.

## Standard command and artifacts

For the shared execution model and six scenario accounts, use a hashed run manifest:

```sh
python3 -m research validate-replay --manifest MANIFEST_JSON --out NEW_DIRECTORY
```

[UNIFIED_EXECUTION_STANDARD.md](UNIFIED_EXECUTION_STANDARD.md) defines that model,
publication rules and release gates. The manifest fixes the UTC range, captured inputs,
runtime identity and acceptance limits. The command verifies hashes before and after
scoring. This adapter preserves missing attempts in the denominator and separates
captured intents from older inferred-intent diagnostics.

The commands below reproduce the older evaluation format.

First complete the frozen evaluation inputs using the commands in
[README.md](README.md#evaluation-of-filters-exits-and-recoveries).
Required files are `snapshot.json.gz`, `audit.json`, `models.json`, `comparison.json`,
both provenance files, `source-verification.json`, and the prepared `replay/` dataset and benchmark.
The current adapter expects the audit and model schema used by `core/evaluation.py`.
Source verification must include hashes of the deployed execution files.

```sh
python3 -m research validate-replay \
  --evaluation data/research/20260911-policy-evaluation \
  --out data/research/20260911-backtest-standard-v1
python3 -m research.core.evaluation_report \
  --root data/research/20260911-policy-evaluation
```

Use a fresh output directory for each run.
`validate-replay` runs offline against the prepared evidence.
It writes `report.md`, `fidelity.json` and a source archive under `objects/`.
It updates `fidelity-current.json` in the evaluation directory.
Exit code 0 means historical fidelity passed.
Exit code 2 means the scorecard completed and at least one accuracy check failed.
Exit code 1 means the command could not complete.
The report is still required when the accuracy checks fail.

Older `legacy`, `recorded` and `opportunities` comparison modes remain diagnostic instruments.
Their output alone is not a realism certificate.
Candidate profitability requires a current passing certificate plus complete candidate execution coverage.
Select only candidates with higher net cash and no worse cumulative drawdown or repeated-recovery losses than baseline.
Check each filter, exit or recovery rule separately before combining changes.

## What a pass still leaves unknown

Block timestamps cannot reconstruct feed arrival or transaction ordering within a second.
Replaying historical external orders assumes other traders keep the same quantities.
Changing our orders could change their behavior.
Historical forks can test contract execution at a block but do not reconstruct that reaction.
Delay and slippage sensitivity runs should show how candidate results change under these assumptions.

All observations already inspected remain retrospective, including a reserved period inspected in an earlier study.
Freeze the model and limits before collecting new shadow predictions.
Record predictions before outcomes become available, then score them against subsequent real attempts.
Shadow-only rejected opportunities still have no actual wallet outcome.
A historical fidelity pass never authorizes deployment, unpausing or a stake increase.
