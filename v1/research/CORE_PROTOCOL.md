# Consolidated research workflow

The shared CLI separates preserved results from corrected replay. It cannot approve a
trading-policy change. The original +2, stale and activity studies remain intact.

[BACKTEST_STANDARD.md](BACKTEST_STANDARD.md) governs simulation realism claims.
Run its `validate-replay` command after the frozen evaluation inputs are complete.
Arithmetic agreement alone does not validate predicted profit or account decisions.

Run from `bot/`:

```sh
python3 -m research capture --bot-db /path/to/bot.db --gate-db /path/to/gate.db \
  --state /path/to/dashboard-state.json --out data/research/captures/<capture>.json.gz
python3 -m research prepare --snapshot /path/to/capture.json.gz \
  --out data/research/<run-id> --days 14 --scope opportunities --fetch-missing
python3 -m research benchmark --run data/research/<run-id>
python3 -m research compare --run data/research/<run-id> --mode legacy
python3 -m research compare --run data/research/<run-id> --mode recorded
python3 -m research compare --run data/research/<run-id> --mode opportunities
python3 -m research pools --run data/research/<run-id> --fetch-missing
python3 -m research report --run data/research/<run-id>
```

`capture` reads offline SQLite copies in read-only mode. It records their hashes and
refuses to replace an existing capture. Take the database copies with SQLite's backup
API so WAL activity cannot produce a torn file.

The public Robinhood Chain RPC is the only implicit research route. Trading endpoint
variables and the trading `.env` are ignored. A non-public route requires an explicit
`RESEARCH_RPC_URL`, `RESEARCH_ALLOW_PAID=1`, a positive
`RESEARCH_MAX_PAID_REQUESTS`, and `RESEARCH_PAID_BUDGET_PATH`. Every batch member and
retry claims the shared allowance before sending. Child processes and the archive proxy
must use the same allowance file.

`RESEARCH_LOGS_RPC_URL` and `RESEARCH_HEADERS_RPC_URL` can route logs and headers. A
non-public value has the same paid-run requirements. URLs never enter caches, reports, or
logs. Successful historical results are cached. Pending transactions, latest-state reads,
failures, and missing values are not cached as evidence. Independent verification uses
`bypass_cache=True`. Each manifest reports cache hits, network attempts, paid allowance
used, and missing results. These counts estimate usage and do not replace provider billing.

`prepare` refuses to replace an existing dataset. Omit `--fetch-missing` to work entirely
from the local RPC cache. Successful responses survive an interrupted fetch. The default
scope fetches block timestamps for actual traded curves first. Use `--scope opportunities`
for all screened curves and `--days 14` for a longer diagnostic window. A zero log timestamp is treated as missing and requires a block header. Invalidated runs
cannot be benchmarked, compared or reported. Coverage is counted
explicitly; choosing 14 days does not establish 14 days of complete evidence.

`--immutable-latest` permits a fallback read of the eight deployment constants when the
historical RPC refuses them. It never reads current reserves or prices. Each token records
whether its constants came from the historical anchor or that fallback. The option does
not repair missing historical pool state.

The imported snapshot includes launches, positions, native score rows, guard samples,
health, balances and transaction journals. Preparation strips signed raw transactions.
It stores a sanitized, content-addressed source object beside the run. A generated result
has a content-addressed copy and an archive of the research and production source used.
The named result files are convenience views; old objects remain available after a rerun.

## Evidence boundaries

| Layer | What it establishes | What it cannot establish |
|---|---|---|
| Recorded accounting | Booked cash uses `COALESCE(onchain_pnl_wei,pnl_wei)` | A fallback book value is not a receipt proof |
| Independent accounting | Buy/sell event amounts and receipt gas, including unique ancillary hashes | Missing burned-transaction evidence remains unresolved |
| Curve arithmetic | Production bigint math checked against emitted transactions | Buy tax exemptions need separate evidence |
| Actual-fill decisions | Actual buy event applied once, recorded position mark and pinned exit rules | Block timestamps do not recover subsecond feed arrival |
| Hypothetical reentry | A new buy and exit under a stated timing assumption | The model is not the actual fill replay |
| Historical pool quote | Official quoter output at a specified historical block | Candidate pool reserves, preparation costs and execution latency need proof |
| Account comparison | Causal scores, exposure, cash, guards and explicit unknowns | Missing initial/process state prevents a complete live reconstruction |

The recorded comparison uses the latest contiguous execution-rule era in the snapshot.
The opportunity comparison applies the current pinned rules to recorded passed launches.
Its entry time assumes the later of detection and launch plus two seconds. Gas uses the
median of preceding calibration closes. No final-six-hour close fits those costs.
Both comparisons remain diagnostic while their evidence gates are incomplete.

The market sensor retains the recorded 0.01 ETH observation outcomes. Execution uses the
candidate's own size. Market observations use the trading book's tax and exemption floors.
The separate touch gate and adaptive target use their broader recorded observation universe.
Features use information strictly before entry. ETH sell volume comes from event word one;
buy volume comes from word zero. Creator and bot transactions are excluded from activity.

## Account rules

The account simulator has one entry per token, capital reservation, concurrent-position
limits, template loss pauses, touch and market hysteresis, DD recovery and the execution
underperformance halt. Operator stop, guarded resume and process restart are separate inputs.
DD uses its own epoch peak. Cumulative cash never resets when DD recovery opens a new epoch.
Approval and preparation costs can affect DD while a position is still open. Their timing
uses the receipt block, rounded to the end of its timestamp second. Unknown cost timing
remains part of the execution limitation.

Recovery candidates include distinct score updates, fresh short windows, winner trimming,
rolling loss budgets, limited repeat recoveries and staged smaller positions. Each candidate
is a `Policy` value. Supply `compare --policy-file policies.json` with a JSON list of field
overrides to test another set through the same simulator.

A missing admitted execution stops the account path and retains the unresolved holding.
It does not become a zero-price sale or release free capital for later hypothetical winners.
Charts stop at the known prefix. Reported DD measures closed cash plus known transaction
costs, not intratrade market-value drawdown.

## Graduated-pool contract verification

```sh
python3 -m research fork-check --run data/research/<run-id> --anvil /path/to/anvil
```

Set `RESEARCH_ARCHIVE_URL` in the execution environment. Its value is never printed or
passed on Anvil's command line. A localhost proxy permits only read RPC methods. The test
harness uses a public test key on a localhost fork and exercises the production graduation
owner loop. It verifies missing-pool preparation, both approvals, an adverse intervening
sale, zero remaining tokens and exact receipt-to-wallet cash reconciliation.

A failed archive connection is recorded as blocked. Existing fork artifacts remain historical
evidence. Their existence does not count as a new successful run, and fork wall time is not
a production latency measurement. The SSH workflow can pipe `archive-proxy.mjs` to Node on
the trading host and forward its loopback port. This keeps the configured provider URL on
that host and changes no live source or configuration.

## Checks and retirement gate

```sh
PYTHONPATH=. python3 -B -m unittest discover -s research -p 'test_*.py'
npx tsc --project research/tsconfig.json
npm test
npm run typecheck
npm run validate
```

The last command runs on the laptop. It validates production curve math against chain history.
The report includes the 14-day benchmark, era partitions, six reserved hours, 24-hour bins
and seven daily bins. Every return summary has mean, median, standard deviation and n.
Previously viewed data is labelled reserved retrospective data, never an untouched holdout.

`compare --mode legacy` must reproduce exact cash and actions before any legacy deletion.
Exit, joint-policy, dated guard, and operational `scripts/engine.py` instruments keep their
existing interfaces. No live source, configuration, deployment or restart belongs to this
workflow.
