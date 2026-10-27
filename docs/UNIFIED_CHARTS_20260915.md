> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Unified simulation charts, 15 September 2026

Paper Wallet now displays the same continuous p50-after account that supplies shadow
outcomes to the market indicator. The previous display used the separate market-off
account, which still enforced drawdown and operator stops.

## Data contract

- Paper cash is the continuous account's cumulative integer net ETH. It retains filters,
  template history and concurrent-capital limits. Losses do not consume its fixed
  simulation capacity. The captured and effective entry-hour configuration is all day.
- Colored Coins outcomes require an admitted continuous-account cash record with the
  same execution identity and exact P&L. Other outcomes remain unavailable for wallet
  accounting. Original independent replay records are retained.
- Market Indicator retains the actual 15/8, six-scenario guard. Its minimum scores are
  not the same as p50-after alone. Contributor identities are exposed only when the
  stored tape reproduces the recorded scenario sums.
- Launch, execution closure and publication are different times. Coin bars use launch
  time; paper cash uses closure time; indicator evidence uses publication time.
- The chart reads the latest worker snapshot instead of waiting for the slower report
  rebuild. HTTP requests do not replay accounts or fetch chain history.

## One history

Old live/history links resolve to one chart response. Historical records merge with
new publications. The merge uses execution, configuration and scenario identity.
Conflicting P&L or stake is unavailable rather than silently preferred.

The interface keeps the four existing charts. Long coverage and validation text lives
under Details. Tooltips retain source, scenario and timestamp information.

## Historical recovery and limits

The new audit uses two matching factory-log scans, verified block headers and original
launch calldata. It checks the 190 seconds preceding each restart as well as the gap.
Recorded launch rejections account for launches that did not require a simulation intent.

The first restart gap on 13 September is resolved in a derived offline capture. The two
uncaptured launches were recorded rejections: creator tax 250 bps and a rejected template
dev-buy amount. The original live gap rows are not changed by this historical repair.

This recovers 31 continuous p50-after trades from the account starting at
13 September 14:36:46.809 UTC. Its supported prefix ends at 16:00:57.236 UTC.
Net P&L is −0.010530252994491839 ETH. There are 122 complete historical indicator readings.

The next restart includes an eligible launch without a captured simulation intent.
Ninety later queue-overflow gaps also remain. Price paths alone cannot restore those
missing intents, account holdings or template history. The later live account has its
own known start on 15 September. These two accounts are separate chart segments; their
losses and starting balances are never joined into a fabricated monthly total.

Historical evidence remains diagnostic and cannot authorize live entries.

## Verification and artifacts

`v1/data/research/20260915-unified-history/` contains the gap audit, derived capture,
replay, published history and exact reconciliation checks. Frozen comparison: all
31 older trades and all 70 trades in the 15 September snapshot match their coin P&L
exactly. The latter snapshot totals −0.053347830610139333 ETH.

The isolated release and logs are in
`v1/data/releases/20260915-unified-charts/`. The execution model identity remains
`97c88fa203e92de58c8b1fcbec97938011f62ac8546c162d4da2f9f833cd45b1`.
The private rollback files are under the same dated name in the host's
`data/release-backups/` directory.

No engine calculation, policy threshold, stake, accounting reset or release certificate
is changed by this dashboard release. Historical cash fidelity remains diagnostic.

## Deployed verification

The final release passed 997 host tests across 86 files, including the 8,056 baseline
guard checks. Both TypeScript checks passed. Desktop at 1,440 px and mobile at 390 px
were inspected. The 3d and 7d views retain the recovered segment, with no history-mode
links, coverage banner, page errors or horizontal overflow.

The final API check reconciled all 153 plotted cash records to exact admitted coin P&L:
31 in the recovered cohort and 122 in the current cohort. A new publication after the
baseline capture added +0.000264303350910012 ETH to the current account. The same coin
outcome and the advanced indicator publication were verified. The recovered history
remained present through the old `paper=history` URL.

Contributor addresses are stored once per response and referenced by numeric indexes
in each window. This preserves all identities while reducing the decoded chart payload.

Both deployment restart intervals were independently checked and archived before their
gap markers were resolved. The final check included a historical contract read that
confirmed a 500 bps creator tax on one rejected launch. No account state was reset.
The original Auto selection was restored; the existing market/release blocker still
prevents entries. Zero real positions were open during the restarts.
