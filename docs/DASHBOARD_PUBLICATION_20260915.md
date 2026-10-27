> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Supported dashboard history, 15 September

The existing Replayed history view now contains actual Account history, Paper Wallet, Main 15 and Fresh 8, and Coins. No production code or trading setting changed. Publishing the data required no restart.

Open http://127.0.0.1:8787 and select **1h** for the recent indicator and coin bars. Select **3d** for earlier coin outcomes. Zooming a three-day response into minutes retains coarse coin buckets, so change the time control first.

## Coverage

- Historical capture: 13 September 14:36:46.809 UTC through 15 September 10:47:13.635 UTC.
- Current ledger snapshot: through 15 September 14:43:04.891 UTC. This is a frozen display snapshot, not an automatically advancing live indicator.
- Historical replay: 84 complete adaptive coin executions, 920 target-score sets, and 1,486 unavailable inputs among 2,406 opportunity captures. Warmup-blocked entries are not reported as executions.
- Current snapshot: 40 published coin outcomes. Six independent indicator accounts each contain 16 outcomes. The market-guard-disabled account has 12 closed trades, with other recorded account stops retained.
- Supported displayed wallet starts 15 September 13:55:06.161 UTC. It is not joined to the earlier unresolved account. Missing historical submitted limits and source coverage prevent a continuous September wallet.
- Total displayed coin outcomes: 124. Earlier September 1 or September 7 coverage was not manufactured from fixed-TP estimates.

The current model is `97c88fa203e92de58c8b1fcbec97938011f62ac8546c162d4da2f9f833cd45b1`. The history artifact SHA-256 is `8800ba4ce3f4f2ca69fe9315325846f920c7779ed1b9247f103da2ec37f513cc`.

## Verification and rollback

Thirteen focused ledger, historical-display and backfill tests passed. The served interface was inspected at 1440 and 390 pixels. All four panes rendered, both indicator lines had values, coin bars were visible, and there were no browser errors or horizontal overflow. Account cash remained separate from simulation. No replay runs in dashboard requests.

Local artifacts: `v1/data/releases/20260915-indicator-repair/dashboard-published/`. The two input hashes bind the current frozen ledger and newly rerun historical backfill. The live host retains previous display artifacts under `data/release-backups/20260915-dashboard-publication/previous*`. Restoring those two files restores the prior display without restarting trading.

The publication is diagnostic display evidence and has `activationEvidence: false`. The ordinary Live capture page still follows certified guard readings. This publication does not remove release gates or enable Auto. The user accepted the observed 14% historical diagnostic loss understatement; this does not supply missing prospective execution evidence.
