> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Four-chart dashboard, September 15

The dashboard keeps Account, Paper Wallet, Market Indicator and Coins. The added comparison panes and replay table are removed. The simulator and 15/8 policy remain unchanged. Auto stays stopped.

## What each chart means

- Account preserves actual balance, open cost and receipt-based cash. Recorded market pauses are amber, drawdown pauses red, and other stops grey. Its existing linked time controls remain in place.
- Paper Wallet reads the published `p50-after` market-off account. Only the market guard is disabled. Recorded operator stops, other account protections, independent capacity and template losses remain effective. It can therefore be flat while shadow outcomes continue. It is cumulative simulated net ETH, not a funded wallet balance.
- Market Indicator shows Main 15 and Fresh 8. Each is the minimum across all six execution scenarios. Thresholds are Main below -1.5 to pause and Fresh above +1 in every scenario, with new valid evidence, to recover. The tooltip exposes each scenario and its evidence status. Missing, incompatible or unverified evidence is null. Recorded history is filtered to the current model and broken at configuration or recording gaps.
- Coins retains the count bars and shadow return strip. Its displayed return is explicitly `p50-after`. Coin tooltips distinguish simulated admission, actual attempted entry, and membership in the published shadow-account evidence. An independent replay after an account gap does not become an admitted account trade. Admission without a recorded decision remains unavailable.

## Coverage and unresolved evidence

The frozen acquisition cutoff is **2026-09-15 10:47:13.635 UTC**. The capture contains **2,406 opportunities**, beginning September 13 at 14:37:11.138 UTC. The preceding account-control record is at 14:36:46.809 UTC.

The shared engine recalculated **920 independent launch results**. The remaining **1,486** comprise 1,453 missing frozen execution inputs, 32 incomplete source records and one missing source publication. The comparable account prefix ends **September 13 at 14:42:17.105 UTC**. Later individual results may appear in Coins but cannot extend that wallet.

The old four-trade curve was the unrestricted continuous shadow collector. The requested market-off account retains other stops and has **zero admitted trades before the gap**. Its supported segment is flat at zero. Displaying the old four trades as this account would be incorrect.

September 1 and September 7 were audited as requested. Earlier archives include 268 actual-attempt requests, but these do not establish the skipped-launch population, causal target-selection evidence or a complete account timeline. They are not imported as a continuous paper wallet. The coverage audit records the source hashes.

The live selector remains blocked by `selector_unresolved_execution`. A bounded ten-block read through the existing client returned HTTP 429, Too Many Requests. The existing worker continues its serialized retry/backoff. No duplicate acquisition process was started. The missing evidence was not replaced with zero, actual proceeds or an invented closure.

Historical cash fidelity and prospective actual-trade accuracy remain unpassed. These charts are monitoring and diagnostic evidence, not proof of future earnings.

## Reproduction and verification

Run artifacts are in `v1/data/research/20260915-four-charts-v1/`. The raw input is private and hash-bound. `coverage-audit.json` records coverage; `replay-parity.json` records exact agreement of integer cash, targets, closure and publication fields across all 2,406 rows before and after adding display metadata. The observer output is unchanged.

From `bot/`, with Node 22:

```sh
ENV_FILE=.env.example MODE=observe LIVE=0 node --import tsx research/core/shared_backfill.ts data/research/20260915-four-charts-v1/input.json.gz data/research/20260915-four-charts-v1/final-replay
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p research/tsconfig.json
```

Local verification passed 978 tests in 83 files and both TypeScript checks. This includes the 8,056 historical guard parity cases. No execution calculation changed, so the existing failed cash-fidelity verdict is retained rather than replaced by presentation tests. The isolated release starts from live source snapshot `af61d4f`, preserving unrelated workspace work.

Deployment and browser evidence are recorded in the run directory after verification. Screenshots use actual API payloads. A separate, explicitly synthetic fixture checks the two-line tooltip wiring; it is not trading evidence.

## Running release

Build `646773264b83b08d37fb9ec366a5b74fc8c735d2` is deployed and restarted under operator STOP, with zero open positions. All 980 host tests passed in 83 files. Both TypeScript checks passed. The nine shipped source-file hashes match the reviewed laptop release. The shared model hash remains `d58d12d1bc6ae146cbb948f2c4517fd1604416f3fe40ca8421460d52a8da30fc`.

Desktop and 390-pixel mobile verification passed with no JavaScript errors or horizontal overflow. Screenshots were inspected. Exactly four chart containers remain. The historical view retained all 920 available results while reducing detailed coin records from about 69,000 observed launches to about 5,000 relevant launches. Aggregate counts still include filtered launches. Detailed replay logs are not loaded into the chart response.

The UI verifier waits for both chart and state responses before checking STOP. Its synthetic boundary fixture is recorded separately from the real historical payload. The history viewport remains a rolling lookback, so launch counts at its left edge change with time; the frozen replay cutoff does not change.

Actual realized cash stayed at -0.004578226687220658 ETH through deployment. Stake remains 0.005 ETH, bankroll 0.08 ETH and drawdown limit 0.015 ETH. Auto was not enabled. The live reason remains `selector_unresolved_execution`; no recovery cycle was observed.

The published historical artifact SHA-256 is `db871c42264310c2166024b821b703d3405d8f7c307fe0013869c4b8d70b2c91`. Temporary export files were removed from the host after verifying the downloaded input hash. Local inputs, evidence, screenshots and the private rollback backup remain preserved.
