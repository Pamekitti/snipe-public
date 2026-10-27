# Research engine implementation, 9 September 2026

The shared offline workflow and the 14-day guard comparison are complete. No live
configuration, deployment, restart, funding, or trading action was performed.

| Delivered | Evidence |
|---|---|
| Frozen input | Snapshot ending 2026-09-08 22:09:53 UTC, with content hash and read-only SQLite capture |
| Opportunity coverage | 4,687 launches, 4,686 complete six-topic paths, 230,068 headers, and 3,077 receipts |
| Execution benchmark | 121,190 transaction arithmetic checks matched exactly; 1,387 of 1,396 attempts independently reconciled |
| Historical rules | 192 attempts pinned; 1,204 older attempts kept in an unavailable partition |
| Actual-fill decisions | 142 of 152 comparable exits agreed; disagreement rate 6.58% |
| Guard comparison | Baseline plus 28 alternatives on one causal stream; six incomplete opportunities excluded before every policy |
| Graduated exits | Two historical official-router quotes and two passing disposable fork scenarios |
| Compatibility | Legacy cash and action outputs reproduced before the 165-file cleanup was retained |
| Verification | 129 research tests, 704 bot tests, both TypeScript checks, and production curve validation passed |

The immutable result is `v1/data/research/20260909-guard-engine-final-v12/`. Read
`report.md`, `validation.json`, and `outputs.json` there. The dataset SHA-256 is
`dfb7ee366d746b2ab95e8da7fc16629f5085d3cd9b00a336608fc81ae2b30725`.

The opportunity model selects `market_plus1`: 2.894943 ETH conditional profit and
0.103855 ETH maximum closed-cash drawdown, versus 2.799096 ETH and 0.142032 ETH for
`market_plus2`. Both calibration and the reserved final six hours improve. The selected
policy has five false restarts, versus four for +2.

The shorter recorded-fill comparison does not support the replacement. It gives +1
0.171885 ETH with 0.155531 ETH drawdown, versus +2 at 0.248594 ETH with 0.078821 ETH
drawdown. This comparison cannot establish fills that +1 would newly admit. The report
therefore records +1 as the mathematical winner of the complete opportunity comparison,
while retaining +2 as the live policy pending a separate review and prospective evidence.

Nine accounting cases remain outside ranking. Seven lack historical exit transactions.
Positions 2167 and 2180 lack the burned preparation transaction hashes needed to prove
all historical ancillary gas. Their known receipts reconcile, and the fresh fork scenarios
include every approval and preparation receipt, reconcile wallet cash exactly, and finish
with zero tokens.

Invalidated development runs remain preserved with explicit markers. The retired one-off
scripts remain available in Git history. Current exit, joint-policy, dated guard, and
operational instruments retain their interfaces.
