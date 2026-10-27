> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Recovered dashboard history, 15 September 2026

The published history now contains 1,224 simulated coin outcomes, up from 241.
All 241 previously displayed outcomes retain their exact P&L and stake.
This publication supersedes the display artifact described in
`DASHBOARD_BACKFILL_20260915.md`. It does not change the live engine or trading settings.

## Supported coverage

All times below are UTC. London is one hour ahead on these dates.

| Series | Supported range | Contents |
|---|---|---|
| Frozen opportunity capture | 13 September 14:36:46.809 to 15 September 16:22:15.992 | 2,794 opportunities |
| Available coin outcomes | 13 September 14:54:54.136 to 15 September 16:18:31.179 | 303 on the 13th, 725 on the 14th, 196 on the 15th |
| Independent paper account | 15 September 13:55:06.161 to 16:19:35.091 | 21 completed trades, net −0.015145708337626337 ETH |
| Complete 15/8 indicator windows | 15 September 14:40:51.452 to 16:19:15.081 | 284 decision points |

Coin outcomes can appear independently of account continuity. The 114 captured gaps
remain in the replay inputs. The earlier account reaches its first gap on 13 September,
so later independent outcomes cannot extend that wallet or release unknown holdings.
The displayed paper account comes from the frozen, published current-model ledger.
Its known starting point is not a fabricated monthly zero balance.

## Recovered inputs

The repair rebuilt 1,245 execution requests using original captured entry quotes and
minimum token limits. It reused verified price paths from the focused research capture.
All source chunk hashes were checked before extraction. The adapter retained the
original stake, curve parameters, wallet exclusion, logs and verified timestamps.
It reconstructed timing and gas assumptions from preceding recorded samples.
No new receipt acquisition was needed.

The existing shared engine produced 1,234 available adaptive outcomes and 2,484 TP score
sets. The publication uses those older reconstructed outcomes before the current
account's model boundary. It overlays 196 frozen live-ledger coin records afterward.
The resulting display contains 1,224 available outcomes.

For repaired historical requests, completion is modeled at the later of entry plus
190 seconds and the recorded gatewatch publication. This is an assumption about
historical availability, not a recorded worker publication. Original complete requests
retain their recorded completion times. The current ledger retains its durable
publication ordering. These historical results are diagnostic display evidence only.

## Remaining missing evidence

The replay leaves 310 opportunities unavailable: 32 with incomplete source coverage,
one without source publication, and 277 without a complete frozen execution input.
Among the latter 277, the additional worker-cache audit found:

- 270 without a matching cached price path.
- Three with cached logs but missing verified headers.
- Four in the frozen capture tail whose modeled completion is after the cutoff.

Missing paths or headers may be recoverable through further bounded acquisition.
They were not replaced with invented fills. This pass reused verified stored evidence
without adding a history scan to the live trading process.

The 25,272 earlier research jobs audited in the preceding pass have placeholder entry
limits. Their original submitted limits cannot be recovered from those files.
The newer capture beginning 13 September contains original quotes, which enabled this
repair. September 1–12 remains unsupported for this dashboard publication.

## Verification

- All 1,245 reconstructed requests match captured entry intents and use preceding
  cost and timing samples. Frozen current observer and coin records remain unchanged.
- Forty full input fixtures, three TP targets and six scenarios produced 720 exact
  full-path versus shortened-path comparisons. These cover 194 winning and 526 losing
  outcomes. Integer fills, costs, decisions and closure times agreed in every case.
  This check does not establish accuracy against actual trading cash.
- Artifact hashes, all 241 prior outcomes, account cash totals, complete indicator
  windows and minimum scores across six scenarios passed their checks.
- Sixteen focused backfill, history, ledger and indicator-display tests passed.
- The published API reconciles to all 1,224 displayed coin outcomes and 284 indicator
  points. Desktop (1,440 px) and mobile (390 px) screenshots were inspected. All four
  panes render without page errors or horizontal overflow. Earlier unavailable account
  and indicator intervals remain visibly empty.
- Historical cash fidelity remains diagnostic. No release certificate was generated.

## Artifacts and reproduction

Run directory: `v1/data/research/20260915-dashboard-backfill-v3/`.

The input files are `input.json.gz`, `cached-paths.json.gz`, `adoptions.json` and
`receipt-supplement.json`. `recover.ts` builds `recovered-input.json.gz` using the
production engine types. `recovery-proof.json` identifies every source and cost sample.
The unchanged `research/core/shared_backfill.ts` produces the offline `replay/` output.
`request-verification.json` and `horizon-verification.json` record calculation checks.
`publish.py` merges historical coins with the frozen current ledger.
`verify-artifact.py` checks the final publication. `verify-ui.mjs` checks desktop and
mobile and saves screenshots plus `ui-verification.json`.

Frozen recovered input SHA-256:
`db860078fc9de609335710d58284f435820c79bff7d225cd79259f91703a9527`.

Published artifact SHA-256:
`5015aa8b0170da812a97335fe7b9ee302b35ceee46c7ac67f619dd63f128eb6f`.

Model identity:
`97c88fa203e92de58c8b1fcbec97938011f62ac8546c162d4da2f9f833cd45b1`.

The publication script verifies the preceding artifact hash before replacing the two
history files. It saves the old files under the host's private
`data/release-backups/20260915-dashboard-backfill-v3/` directory. The manifest is replaced
last. No restart, real-account database edit, or control request is involved.
