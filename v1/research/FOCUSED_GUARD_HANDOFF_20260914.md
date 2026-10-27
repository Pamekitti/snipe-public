# September 14 guard experiment handoff

The completed run found a balanced historical profit candidate at 15/8, but no
supported lower-risk replacement for the 20/8 reference guard. Start with the saved
report and regenerate charts from saved accounts before acquiring or scoring anything.
This document records research results, not the running bot configuration.

Use [GUARD_CHART_STANDARD.md](GUARD_CHART_STANDARD.md) for the two KPIs and six charts.
Use [BACKTEST_STANDARD.md](BACKTEST_STANDARD.md) for execution-fidelity requirements.
The [handoff lock](FOCUSED_GUARD_HANDOFF_20260914.json) records artifact and runner hashes.

## Open the completed result

Paths below are relative to `bot/`:

```text
data/research/20260914-focused-guard-v1/                 RUN
  report/report.md                                    complete report
  report/decision.json                                 exact selected settings
  report/shortlist.csv                                 central results
  report/all-stresses.csv                              six-scenario results
  report/time-bins.csv                                 daily / 24h / 7d bins
  report/late-loss-check.json                          Sep 9–14 and last 48h
  all-settings.csv                                    all configuration scorecards
  manifest.json / score-freeze.json                    frozen comparison identity
  report/verification.json / report/artifact-hashes.json
```

The run finished on September 14 at 23:30 UTC, within the user's two-hour limit.
Total elapsed time was 107.06 minutes. Offline guard scoring took 121.79 seconds.
Most elapsed time went to restoring source coverage and checking historical timestamps.
Everything ran on the laptop. This run created no AWS resource and changed no live control.

## Frozen range and population

| Item | Recorded value |
| --- | --- |
| Capture | Sep 1, 2026 00:00 UTC through Sep 14 19:30 UTC (20:30 London) |
| Comparable range | `[1788220800000, 1789414161237)` in Unix milliseconds |
| Last comparable boundary | Sep 14 19:29:21.237 UTC; final 38.763 seconds remain unavailable |
| Era 1 | Sep 1 00:00 through Sep 8 00:00 UTC, exclusive end |
| Era 2 | Sep 8 00:00 through the comparable boundary |
| Opportunities | 27,269 entries, including filter-rejected launches |
| Restored tail | 2,046 launch paths; 87,393 verified headers in merged coverage |
| Unavailable inside comparable range | Zero scenario outcomes; one unfinished launch begins at the excluded boundary |
| Actual cash figure | 1,210 completed captured actual attempts, including probe cohorts |

The raw capture is `../20260914-1930-extension/capture.json.gz` relative to RUN.
Do not call this dataset live or up to date beyond its frozen cutoff.
Both eras are retrospective. The user explicitly requested whole-era comparison,
so this run has no training/test split and makes no untouched-validation claim.
Guard and account state continue through Sep 8; only the era plots restart at zero.

## Exactly what was tested

| Parameter | Values |
| --- | --- |
| Main window N | 10, 15, 20, 30 |
| Fresh window M | 3, 5, 8, 10, with M < N |
| Pause when main sum < B | −2, −1.5, −1, −0.5 stakes |
| Fresh recovery sum > R | +0.5, +1, +1.5, +2 stakes |
| Full recovery sum > H | +1, +2, +3 stakes |
| Recovery mode | Fresh only, full only, both |
| Maximum evidence age | 180 minutes, fixed |

There are 1,140 configuration rows and 1,008 distinct effective rules.
The full-only mode repeats across unused fresh-window choices as calculation controls.
These repeats are not additional independent discoveries.
All guards require complete compatible warmup and new publication evidence to recover.
Stale, invalid or missing evidence fails closed. Comparisons use strict `<` and `>`.
Fresh-only recovery can reopen below the brake and pause at the next distinct check.

Stake stays at 0.02 ETH, adaptive TP memory at 20 and maximum hold at 45 seconds.
The concurrent stake budget is 0.08 ETH, with a maximum of 14 positions and no entry-hour restriction.
Entry filters require creator tax of at least 50 bps and at least three exempt wallets.
The template-loss block lasts one hour.
The stake budget limits concurrent holdings; it is not a reconstruction of spendable
real-wallet balance. Read the frozen account configuration for all effective fields.
No TP or exit-timer search was run in this focused experiment.

The six execution stresses cross 600/1,200/2,000 ms sell delays with before/after
same-time ordering. The chart uses 1,200 ms / after, named `p50-after` in saved files.
Here that ID refers to a fixed scenario, not a newly measured median delay.
Historical pool results retain the earlier `pool-d0-h0-pub0` approximation.
Delay/haircut pool alternatives and extra publication-delay stresses were not rerun.

## One execution engine, distinct causal accounts

```text
Verified capture + cached paths + block headers + preceding costs
                              |
             Frozen shared TypeScript execution engine
                              |
                six clocks × seven TP targets, once
                              |
        Broader observation population selects entry-time TP
                              |
                  Pinned opportunity outcomes
                   /                       \
       Independent shadow accounts       Policy / guard-off accounts
                   |                       ^
        Causal publication schedule        |
                   |                       |
           Scenario guard decisions --------+
                              |
                   Cash + halts + indicators
                              |
                  two-era charts and KPIs
```

The frozen source is `../20260914-bounded-grid-v1/frozen-render-engine` relative to RUN.
Model hash: `f808d4488248591b41e65d0d6d0e8f3be278d2dd4c78b29bde7568ea870cb192`.
The current workspace source is not automatically equivalent to that snapshot.

`predictExecution` excludes our wallet's historical orders and recalculates external
orders against simulated reserves. It preserves taxes, fees, failed execution and
pinned rules. External traders' order quantities stay fixed to history.
Actual outcomes are labels for fidelity comparisons, not inputs to make predictions match.
Unresolved admitted execution ends the comparable account prefix without releasing capital.

Adaptive TP chooses among 1.25/1.36/1.5/1.75/2/2.5/3 using the preceding 20 available
broader-population observations. The central scenario ranks net returns; ties choose
the lower TP. The same chosen TP is pinned across six execution stresses.
Warmup fallback is 1.75 in this selector. That fallback is distinct from a market guard
using fixed-1.75 outcomes; guard warmup still blocks entries.
Each scenario's shadow and selected account retain independent capacity and template history.

Publication uses the frozen 180-second source horizon, the next 60-second tick,
600 ms worker allowance and causal ordering after modeled closure.
See `core/publication.py` and the frozen manifest for exact boundary arithmetic.
It is modeled historical publication, not a claim to reproduce actual observer latency.
Entry attempts, publications and freshness checks drive decisions; chart reads do not.

The hypothetical Auto comparison omits historical manual control events (`controls=[]`).
It must not be described as reconstructing the operator-controlled wallet.
Actual booked cash remains a separate figure using `COALESCE(onchain_pnl_wei, pnl_wei)`.

## Drawdown comparison and ranking

The core screen disables DD. Nine shortlisted rules were then compared with and without
DD across the same six stresses. The DD trigger is three pinned stakes (0.06 ETH).
Its frozen recovery model requires flat holdings and 20 post-halt published shadow
outcomes whose sum exceeds +1. It permits at most two lifts per UTC day.
DD recovery uses the `details.ts` schedule, not a newly certified live control replay.
Accounting resets do not erase cumulative cash losses. A three-stake trigger is not
a three-stake lifetime drawdown cap.

`rank.py` selects era winners, whole-period winners, worst-clock controls and balanced-profit
candidates. The central balanced score is the minimum of the candidate's two era profits
divided by each era's best tested profit. This normalization assumes positive best profits
in both eras. A new all-losing dataset needs an explicitly defined replacement score.
`report.py` applies the balanced criterion to the DD shortlist.
Its conservative choice minimizes worst-scenario full-period DD among shortlisted rules
profitable in both eras under all six scenarios.

| Historical selection | Rule | Central net, Sep 1–7 / Sep 8–14 |
| --- | --- | --- |
| First-era winner, no DD | 15/5, brake < −2, fresh > +0.5 | +5.0695 / +0.5396 ETH |
| Second-era winner, no DD | 10/8, brake < −1.5, fresh > +1 AND main > +1 | +4.3213 / +1.0949 ETH |
| Balanced with DD, shortlist | 15/8, brake < −1.5, fresh > +1 | +4.4022 / +1.2800 ETH |
| Lower worst-scenario DD, shortlist | 20/8, brake < −1, fresh > +1 | +4.3744 / +0.8623 ETH |

The 15/8 rule's worst September DD is 0.2897 ETH across stresses, versus 0.1812 for
the 20/8 reference. Only one of its eight immediate neighbors beats baseline profit in
both eras under all six stresses in the no-DD screen. No shortlisted DD rule dominates
baseline profit, DD and recovery-loss measures in both eras across all stresses.
Do not promote the highest central profit to a robust or safer winner.

## Corrections that must survive the next run

The older extension omitted 1,236 broader-selector launches. Restoring them changed
the pinned TP on 562 launches. Standardizing publication assumptions changed 787
publication times. The pre-correction extension chart is superseded for this comparison.
The repair preserved 54,121 earlier cash rows across six scenarios and three account variants.

Native log `blockTimestamp=0` fields were placeholders. Verify timestamp, block number
and block hash against historical headers. Use bounded serialized reads, verified caches,
durable checkpoints and backoff. A completed database copy is not complete replay coverage.
The fixed-45-second runner uses at least 65 seconds of verified price coverage, including
late detection. That optimization passed 33,432 integer comparisons across 797 launches.
It does not authorize shorter publication delay or longer exit timers on the same paths.

## Files needed on another machine

Raw data, runners and generated results under `v1/data/` are outside Git. A fresh clone
alone cannot reproduce this run. Restore these private local directories with their
relative layout before running commands:

- `data/research/20260914-focused-guard-v1/` (about 1.3 GB at handoff).
- `data/research/20260914-bounded-grid-v1/` (about 22 GB, including the frozen engine and earlier account/fidelity artifacts).
- `data/research/20260914-1930-extension/` (about 1.7 GB, including the capture and earlier extension).
- `data/research/cache.sqlite` for acquisition or source revalidation; chart rendering needs no RPC cache.

Those sizes describe the local folders, not a new backup. No remote backup was created
by this documentation task. The handoff lock detects missing or altered key artifacts.
Restore private inputs securely; do not put trading keys or live `.env` files in research archives.

Runtime used: Node 22.22.0, Python 3.14.2, matplotlib 3.10.8 and NumPy 2.4.1.
Use the saved Node dependency lock and matching native SQLite runtime when rebuilding.
The manifest and generated source contain absolute paths. On another machine, relocate
them only in a new derived run and regenerate its hashes. Never bypass checkpoint checks.

## Verify saved results without rerunning the grid

Run from `bot/`. This reads local files and checks the score identity and report hashes:

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
r = Path('data/research/20260914-focused-guard-v1')
lock = json.loads((r / 'score-freeze.json').read_text())
for key, name in [('inputSha256','account-input.json'), ('candidateHash','policies.json'),
                  ('scorerHash','cloud_score.ts'), ('manifestHash','manifest.json')]:
    assert hashlib.sha256((r / name).read_bytes()).hexdigest() == lock[key], name
for name, digest in json.loads((r / 'report/artifact-hashes.json').read_text()).items():
    assert hashlib.sha256((r / name).read_bytes()).hexdigest() == digest, name
print('Saved score identity and report hashes match')
PY
```

## Regenerate charts in a fresh preview directory

This command reuses saved cash and decisions. It does not reacquire data, rerun the grid,
change the original report, or issue a new fidelity certificate. It creates a sibling
preview directory so the renderer's earlier-run references keep resolving.
The five generated charts are rebuilt; the actual cash figure and correction evidence
are copied from the verified result. Inspect the new images before sharing them.

```sh
python3 - <<'PY'
import importlib.util, shutil, tempfile
from pathlib import Path
source = Path('data/research/20260914-focused-guard-v1').resolve()
preview = Path(tempfile.mkdtemp(prefix='focused-chart-preview-', dir=source.parent))
for name in ['manifest.json', 'ranking.json', 'grid-results.json', 'details',
             'preflight.json', 'complete-tail', 'all-settings.csv']:
    (preview / name).symlink_to(source / name, target_is_directory=(source / name).is_dir())
(preview / 'report').mkdir()
for name in ['actual-cash.json', 'actual-cash.png', 'baseline-correction.json']:
    shutil.copy2(source / 'report' / name, preview / 'report' / name)
spec = importlib.util.spec_from_file_location('focused_charts', source / 'report.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ROOT = preview
module.main()
print('Preview report:', preview / 'report/report.md')
PY
```

Do not run `finish_report.py` as a generic finalizer. It contains historical verification
counts and writes completion metadata. `final_audit.py` also assumes this run's old prefix.
For a new experiment, calculate fresh verification evidence and mark image inspection
only after inspecting the images. Re-rendering alone never validates earnings.

## Rebuild order when inputs or candidates really change

Create a new versioned run first. The dated runners are the reference implementation,
not a date-agnostic CLI. Changing only `manifest.json` does not change their acquisition
dates, seams, actual-cash boundaries, total-job counts or caption text.

| Stage | Reference runner in RUN | Inputs / output |
| --- | --- | --- |
| Missing selector population | `prepare_missing.py` | Frozen capture and earlier paths → missing-launch capture |
| Verified missing coverage | `acquire_hold45.py`, `acquire_verified.py` | Serialized missing reads → paths, header audit and coverage bounds |
| Merge and verify tail | `build_complete_tail.py` | Earlier and restored tail → verified dataset and execution jobs |
| Execute once | `execute_complete_tail.py`, `execution_source.py` | Jobs → six-clock, seven-target, hold-45 matrices |
| Pin TP and build accounts | `prepare_run.py` with `core/cloud_accounts.py` | Matrices and prelude → common account input, manifest and policy groups |
| Score | `run_grid.py` | Frozen input/groups → hash-bound scores, heartbeat and grid results |
| Select | `rank.py` | Complete six-scenario scores → shortlist, neighbor checks and ranking |
| Trace DD and cash | `details.ts` | Shortlist + frozen accounts → cash, indicator readings and halt episodes |
| Render and audit | `actual_cash.py`, `report.py`, `final_audit.py` | Actual book and traced accounts → charts, tables and consistency evidence |

`repair_seam.py` and earlier acquisition attempts are debugging history. The final
`complete-tail` build is authoritative. Do not restart obsolete acquisition processes.
Keep `pool-d0-h0-pub0` and the broader TP population consistent at every merge boundary.

For a new version, move every date, seam, period, input path, policy group and deadline
into explicit run inputs before starting. Freeze the shared engine, request assumptions,
source/candidate hashes and initial account state. Verify a pilot before launching the grid.
Use the existing model and account reducer; do not create a second simulator.
If acquisition cannot finish within the user's time limit, report the actual coverage
and stop at the agreed deadline. Never describe job existence as progress.

The validated offline command shape, using paths in the new run, is:

```sh
# From bot/, with Node 22 on PATH. RUN_DIR must name the new prepared run.
export ENV_FILE=/dev/null MODE=observe LIVE=0 DASH=0
export PYTHONPATH=.:research
python3 "$RUN_DIR/run_grid.py"
python3 "$RUN_DIR/rank.py"
node --import tsx "$RUN_DIR/details.ts" "$RUN_DIR/account-input.json" \
  "$RUN_DIR/shortlist.json" "$RUN_DIR/details" "$RUN_DIR/manifest.json"
python3 "$RUN_DIR/report.py"
```

Set a measured budget in that run before scoring. The old scoring deadline has expired.
Old outputs can be reused only when all checkpoint hashes match. Do not extend the old
deadline or relabel old checkpoints as a new comparison.
Precompute execution scenarios once, reuse shadow/reference accounts, group guards by
indicator windows, and benchmark concurrency. This run used two local scoring workers.
The two-minute scoring result does not include acquisition or justify a universal ETA.

## Verification and limits at handoff

Passed: 959 bot tests, 330 research tests, both TypeScript checks, 8,056 historical guard
checks, 238,260 candidate comparisons, 33,432 integer execution comparisons and the
54,121-row historical cash-prefix comparison. All six final charts were inspected.
The [chart standard](GUARD_CHART_STANDARD.md) records the frozen population-SD convention,
which differs from the sample-SD convention required by the general backtest standard.

Attempted laptop curve validation was blocked by HTTP 403 at the default RPC and
HTTP 413 at an alternate RPC, including a smaller-batch retry. No live-chain pass is claimed.
The prior 1,190-attempt audit through Sep 13 15:30 UTC had 26 simulated winners that
actually lost. Its actual net was +0.3040 ETH versus simulated +0.1883 ETH.
Cash-fidelity limits failed. This run did not extend that matched audit to Sep 14.
The 1,210-attempt actual-book chart is not a new independent execution certificate.

For fresh verification from `bot/`, run:

```sh
ENV_FILE=/dev/null MODE=observe LIVE=0 DASH=0 npm test
npm run typecheck
npx tsc --noEmit -p research/tsconfig.json
PYTHONPATH=.:research python3 -m unittest discover -s research -p 'test_*.py'
ENV_FILE=/dev/null MODE=observe LIVE=0 DASH=0 npm run validate
# FIDELITY_MANIFEST is the actual-attempt evidence manifest, not the guard chart manifest.
python3 -m research validate-replay --manifest "$FIDELITY_MANIFEST" --out "$NEW_FIDELITY_DIR"
```

Record failed or blocked checks explicitly. Keep acceptance limits unchanged.
The next research decision is whether to refresh matched actual-attempt fidelity or
test a new frozen candidate scope. Neither task was started by this handoff.
Deployment remains a separate decision under [DEPLOY.md](../DEPLOY.md).
