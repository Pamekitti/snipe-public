# September experiment rerun

The refreshed capture ends September 12, 2026 at 15:01:27.549 UTC. It includes the
28 completed live attempts from September 12, totaling -0.024921710657771059 ETH.
The older morning run is superseded. Its artifacts and verified RPC cache remain.

No deployment or live control change is included. The experiment has 32,976 core
guards, six additional families and 54 coarse exit policies. It predeclares 1,337
fixed and dynamic exit descriptors for timer refinement and boundary expansion.
The staged family search is not exhaustive over every possible combination.

The comparison runtime is an isolated copy at:

```text
/path/to/snipe
```

From that directory, after source verification:

```sh
python3 -m research.core.grid_v2_run --root data/research/20260912-grid-v5
```

`run.json` owns capture and fitting dates, source hashes, configuration identity,
candidate definitions and fold boundaries. Changed inputs or code require a new
run version. Checkpoints also bind model inputs and candidate definitions.

The acquisition runtime remains `snipe-grid-20260912-v2/bot`. It only completes the
immutable capture under `data/research/20260912-grid-v2-isolated`. Its pause request
prevents the superseded comparison stages from starting. Version 5 waits for that
verified dataset. It does not issue a second set of historical RPC reads.

From the workspace bot directory, read durable counters with:

```sh
python3 -m research.core.grid_status
```

`data/research/latest-grid` resolves the active comparison. A heartbeat establishes
process responsiveness only. Estimates cover the stated stage or segment and exclude
later work. Logs live under each stage. A `pause.request` stops between account jobs.
SIGTERM to a verified research parent stops its research children and preserves
committed checkpoints. Never signal the live bot or use a broad process match.

Recorded and early entry scenarios have separately repriced fills. Early timing is
launch plus two seconds. Recorded timing uses an actual decision when available,
otherwise detection time. Both respect the two-second minimum. Shadow accounting
uses independent recorded-timing inputs in every execution stress.

Operator stops apply to every executable candidate and always-on reference.
Recorded-control stresses add independent recorded non-market stops. Clearing that
recorded stop cannot clear a candidate's own stop. The unrestricted opportunity
reference removes capacity, account stops and repeat-template restrictions. It is
not an executable wallet.

Identical modeled exits share lossless result storage. Account files are streamed
in batches. Guard scores use integer database references to avoid duplicating whole
cash histories. Original worker interfaces remain compatible.

Version 4 also caches shared observation calculations across candidate accounts.
All 4,004 account outputs in the performance comparison match version 3 exactly.
This is an engineering check, not evidence for selecting a trading policy.
The manifest pins the standard Python interpreter and its execution settings.

Version 5 computes independent threshold states in batches using the existing
scalar scores. On the archived test tape, all 415,092 transitions matched across
32,976 guards. Guard calculation took 7.52 seconds versus 89.83 seconds.
The full account check also matched all 32,976 outputs, including cash and recovery
details. Its scoring loop took 337.38 seconds versus a baseline of at least 395.46
seconds. These measurements do not establish the refreshed experiment's total ETA.

Account sweeps reuse the loaded snapshot instead of reading it twice. The September
7 fold reuses the identical completed training scores and recomputes selection.
It still evaluates the following period independently. Earlier-cutoff folds cannot
use that later training result. The manifest also pins the NumPy version.

The v5 change leaves acquisition running with the same process and cache. Its
snapshot, configuration, candidate definitions and period boundaries match v4.
Verification is recorded in `data/research/20260912-grid-v5/account-parity.json`
and `research-tests.log` (260 tests). Parallel scoring remains disabled.

The main chart reuses the previous cumulative-return and four retention panels.
Always-on is gray, the current guard is blue and the compared candidate is orange.
The four percentages are wins, losses, winning money and losing money retained.
Changing exits adds a matching-exit reference chart alongside the fixed-exit chart.

The pipeline runs acquisition, cash-fidelity diagnostics, repricing, account preparation,
core and family searches, exit crossings, refinement, boundary expansion, locked
evaluation, chronological folds, new baseline observations and report generation.
The final six hours do not supply fitting or calibration observations. September is
retrospective because it was previously inspected.

Tests cover baseline guard parity, scalar/batch exit agreement, entry timing,
publication rules, stop isolation, configuration changes and lossless storage.
The twelve-launch pilot is an engineering check with a synthetic detection delay.
It is not strategy evidence.

A report is complete only after chart review and disclosure of failed fidelity checks.
Current-capture intent diagnostics do not substitute for a whole-account certificate.
The post-lock collector reads new baseline outcomes and counts recoveries. It does
not establish prospective performance of a different candidate. That requires new
price paths and independent candidate-account replay. No backtest enables live trading.
