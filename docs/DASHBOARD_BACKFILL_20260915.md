> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# September dashboard backfill, 15 September 2026

The refreshed history contains 241 calculated coin outcomes, up from 124. All 124 prior outcomes retain their exact profit and stake. No bot source, trading control, accounting value or live model changed. Publication required no restart.

## Supported ranges (UTC)

| Series | Supported history |
| --- | --- |
| Coins | Captures from Sep 13 14:36:46.809 through Sep 15 15:54:22.824; 241 available outcomes, with missing launches left visible |
| Paper Wallet | Sep 15 13:55:06.161 through 15:51:52.103; 20 closed simulated trades, net −0.013331037527234132 ETH |
| Market Indicator | Complete 15/8 windows from Sep 15 14:40:51.452 through 15:51:38.248; 225 supported samples |

The paper wallet begins at zero cumulative profit/loss at its known independent-account start. It does not begin with zero spendable capital. Monthly profit remains unavailable. This account disables only the market guard and preserves recorded operator stops and other protections. It cannot extend across an unknown holding or missing account interval.

The two indicator lines use the minimum main and fresh scores across all six scenarios. Incomplete warmup and samples at or after the unresolved account boundary are null. These historical decisions are reconstructed and are not live activation evidence.

## Why September 1 and September 7 are unavailable

The audit read all 25,272 jobs in the earlier September research manifest and verified every chunk hash. Every request has a missing or placeholder entry limit. The old research could explore an assumed execution, but those values cannot be imported as captured executions of the current live engine. RPC history cannot recover a client-side quote or submitted limit that was never recorded for a skipped launch.

The newer frozen capture has 2,748 opportunities. The shared engine produced 1,193 target-score sets and 250 complete adaptive opportunity replays. There are 1,555 unavailable inputs: 1,522 missing frozen execution requests, 32 incomplete source intervals and one missing source publication. The remaining 943 opportunities have selector-blocked admissions. The source retains 114 historical capture gaps.

For display, 84 earlier supported coin outcomes are combined with 157 durable current-model outcomes. The current-model ledger takes precedence inside its model era. The paper account and indicator come from that independent current-model account, never from summing these 241 independent coin results. Historical account continuity before this account remains unresolved.

## Publication and reproduction

Run directory: `v1/data/research/20260915-dashboard-backfill-v2/`.

- `export.cjs` performs a read-only, frozen export with one read transaction per source database.
- `audit-old.py` checks all older job hashes and counts missing entry limits by day.
- `input.json.gz` is the frozen capture. SHA-256: `4000f7578faad940fe6aefc91dfccd44402acda658a0f23529527b6ba77469e8`.
- `replay/` contains the shared-engine reconstruction and its input/model manifest.
- `publish.py` assembles the display artifact without modifying live evidence.
- `verify-artifact.py` checks prior outcome preservation, cash sums, indicator minimums, warmup and boundaries.
- `history.json` SHA-256: `31d066563fa1f046025fddbe7b05b87f2eb75f7a894646246f6204a0ca820933`.
- `verify-ui.mjs`, `ui-verification.json` and screenshots record desktop/mobile checks.

From `bot/`, using Node 22 and the frozen input:

```sh
ENV_FILE=.env.example MODE=observe LIVE=0 node --import tsx research/core/shared_backfill.ts data/research/20260915-dashboard-backfill-v2/input.json.gz data/research/20260915-dashboard-backfill-v2/replay
python3 data/research/20260915-dashboard-backfill-v2/publish.py
python3 data/research/20260915-dashboard-backfill-v2/verify-artifact.py
```

The running dashboard verifies the artifact hash before loading it. Previous display files are preserved privately on the host under `data/release-backups/20260915-dashboard-backfill-v2/`. Restoring both previous history files restores the prior display without restarting the bot. No live activation certificate was created.

## Verification

All 15 focused backfill, ledger, historical-display and indicator-display tests passed. All prior 124 outcomes match exactly. Six account cash sums reconcile to their ledgers. Both indicator lines match the minimum scenario scores and require complete windows.

The four-chart interface was inspected at 1440 and 390 pixels. Each showed 22 paper curve points, 225 main samples, 225 fresh samples and 157 classified coin outcomes in the four-hour view. No browser errors or horizontal overflow occurred. Gray regions retain unavailable evidence.

The served seven-day response contains all 241 classified outcomes. Its paper curve starts at the known zero and ends with a null at the unresolved boundary. All 398 retained account-history samples from the pre-publication chart match the actual database. One older sample expired under normal retention. Live settings, operator Auto selection and booked accounting remain unchanged.

Historical cash fidelity remains diagnostic. This publication does not establish future profitability or remove the live release-verification blocker.
