# Accounting and evidence rules

## Distinct measures

- **Wallet balance** is the chain balance at a recorded timestamp. It includes the effects of funding and transfers.
- **V1 net booked cash** uses `onchain_pnl_wei` when recorded, otherwise `pnl_wei`. Null values remain missing.
- **V2 position delta** is stored proceeds minus stored spend. Gas carried separately by the wallet ledger is excluded.
- **V2 recorded risk ledger** is an accounting epoch. It is not the sum of every surviving position or a lifetime result.
- **Simulation** is modeled behavior under stated assumptions. It is not booked cash.

All exact accounting uses integer wei, where one ETH is 10^18 wei. Convert to decimals only for presentation. Daily bins use UTC. Means are accompanied by median, sample standard deviation, and count in the generated summary or daily table.

## Public input derivation

The saved retirement financial export contains 2,679 V1 rows and 1,693 V2 position records. The public copies preserve numerical fields needed for the tables while omitting wallet, token, curve, transaction, and signed-byte identities. Sequential IDs replace original identities.

There are 2,551 live V1 rows and 128 non-live rows. Only live closed V1 rows enter its cash table. All 1,693 saved V2 positions were closed; five record abandonment. Their stored position deltas remain separate from the recorded wallet gas.

Scripts rebuild the tables without network access. Input hashes are recorded in the [manifest](../datasets/manifests/public-inputs.json). The private original export was compared against the public numerical rows before review.

## Limits

The public position export does not include the full event tape, raw feed overlay, complete intratrade wallet path, or independent observer history. It cannot certify historical execution timing or reconstruct every guard decision.

Removing direct identifiers prevents independent receipt lookup from these public rows. This is an intentional privacy tradeoff. The supplied figures are evidence about preserved records, not a public cryptographic proof of lifetime profit.

The historical study's matched and excluded populations must remain separate. Eight unreconciled labels were excluded from the September 13 matched comparison. Accounting resets never erase losses from a full-history result.
