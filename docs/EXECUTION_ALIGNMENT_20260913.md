> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Versioned paper execution and capture

Policy Paper is the default dashboard account. Continuous Paper uses the same execution and admission code while ignoring account pauses. The latest-eight candidate remains separate from the active live guard.

`counterfactual.ts` exposes the typed version 3 prediction API. The old replay entry point remains available for historical fixtures. Predictions pin the stake, submitted token minimum, quote, exit rules, timing scenario and cost model. Actual fills are reserved for reconstruction and comparison. Global block log order and observation time remain separate.

Whole-second chain timestamps cannot order a hypothetical trade against other transactions inside that second. The strict model returns unavailable in that case. Historical before/after scenarios remain labelled. PACT and MID exposed this problem: later sells in the same second had been applied before the hypothetical buy. A timestamp does not establish that order.

`paper-account.ts` owns admission, capacity, template cooldowns, token reuse, account stops, latest-eight recovery and cash. Account state survives UTC month boundaries. Monthly display baselines reset without resetting holdings or cooldowns. Unknown admitted executions stop the comparable cash path. Missing pre-month state prevents publication of a monthly total.

## Capture and operation

The bot writes versioned evidence through a bounded queue to `data/bot.simulation.db`. One child process owns the writer. It captures opportunities before account guards, feed orders, chain logs, submitted limits, fill adoption, changed exit inputs, timer boundaries, sends, receipts, approvals, graduation activity and controls.

The queue holds at most 2,048 events. Each batch contains at most 64 events. Acknowledgement follows durable storage. Duplicate delivery is idempotent. Overflow and write failures create explicit gaps. An unclean writer restart records a gap from its last durable heartbeat. Parent disconnection terminates the child. Capture failure cannot disable real exits.

Historical captures and results are append-only. Results bind the source fingerprint and request digest. A source change creates another result instead of replacing the old one. Pending legacy shadow jobs are no longer rewritten to claim they were captured under a new kernel.

The paper worker collects settled history independently of the legacy watcher. It double-scans source logs and fits timing only from preceding observations outside the final six hours. Missing fill-adoption timing uses explicitly labelled first-mark upper bounds. Incomplete ordering, unsupported pool state or missing cost evidence produces an unavailable result.

Graduated execution requires a separate contract replay whose token quantity and curve state match the hypothetical holding. An actual pool sale is not accepted as a prediction of a different holding. Historical holdings without this evidence remain unavailable.

## Research and reporting

The Python adapter calls `scripts/execution-worker.ts` for both prediction and account replay. The standard command accepts a frozen capture export and an optional older execution archive:

```sh
cd bot
python3 -m research validate-replay \
  --capture /path/to/evidence.json.gz \
  --dataset data/research/20260911-policy-evaluation/replay/dataset.json \
  --out data/research/a-new-output-directory
```

The output directory must be new. `fidelity.json` retains every prediction and acceptance check. `coverage.json` identifies unresolved September attempts. `bins.json` contains eight 24-hour bins and seven seven-day bins, split by execution era. `timing-scenarios.json` retains the historical ordering sensitivities. Source archives and prior research outputs remain intact.

`/api/chart` exposes `policy`, `continuous`, `paperAccounts`, and `paperComparison`. `paper` aliases the default Policy Paper account. `/api/state` separates `activeGuard`, `candidateIndicator`, `modelValidation`, and `captureHealth`. Presentation reads worker summaries. It does not run replay in the HTTP request loop.

Paper cash, interval stakes and candidate outcomes use version 3 inputs. Venue estimates are no longer spliced into those values or recorded indicator history. Missing evidence breaks the chart line. The dashboard shows matched cash, failed-buy agreement, entry quantity errors, unmatched counts and the largest discrepancies.

## Verification and remaining gates

The controlled laptop comparison used 14 synthetic open positions at 200 exit-evaluation cycles per second. With capture and background replay, 18,592 of 18,592 events were stored. There were zero reported drops and zero unreported losses. Added p99 evaluation time was 0.057 ms. Added p99 scheduling delay was 3.628 ms. This is a controlled comparison, not a guarantee about every production load.

Laptop curve validation passed 60 of 60 curves, 99,080 of 99,080 constant-product checks and 409 of 409 tax checks. Desktop and 375-pixel browser checks cover account selection, synchronized time axes, null gaps, stale capture and monthly zero baselines. Regression fixtures preserve PACT, MID, Anny, EVERYTHINGPAD, PORT, RQTE and FROGE.

September remains incomplete. The frozen live export has 1,177 September actual attempts and begins on 4 September. The supplied older archive contains paths for 200 of those attempts. Source availability alone does not establish execution timing, historical controls or pre-September paper state. The coverage report names each unresolved attempt. Policy Paper, Continuous Paper and the latest-eight September counterfactual therefore have no complete monthly total.

Historical accuracy has not passed the existing acceptance limits. Prospective validation requires new observations after the final source freeze. Strategy ranking and promotion remain frozen. Deploying capture and diagnostics does not authorize latest-eight activation, a drawdown reset, an operator resume or a stake change.

## Deployed result

Capture and diagnostics are running from snapshot `4232811`. Both restarts were performed with zero open real positions. The post-restart configuration comparison found no changed settings. The active guard remains legacy. Capture reports zero dropped events, and the recorded sequences are contiguous.

The restart interval is retained as a coverage gap. It is not hidden or treated as observed history. Paper jobs are advancing and retain both closed and unavailable outcomes. The shutdown path now waits for the capture queue and writer to finish. Historical accuracy and prospective validation remain incomplete.
