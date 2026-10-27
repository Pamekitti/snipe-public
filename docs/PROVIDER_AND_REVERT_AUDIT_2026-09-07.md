> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Provider quota and buy-revert audit, 7 September 2026

The launch subscription alone exceeds the free-tier pace. Moving routine reads cannot close the gap. The current buy-revert sample does not justify changing entry protection.

## Provider gap

At 19:01:17 UTC, after 44.35 minutes of process uptime:

| Counted source | Projected CU per 30 days | Share |
|---|---:|---:|
| Factory launch subscription | 44.18M | 75.1% |
| Counted HTTP reads | 14.63M | 24.9% |
| Total | 58.81M | 100% |

Compute units (CU) are the provider's usage measure. This is a rate extrapolation since process startup, not consumed account quota. It is not a month-long measurement.

Reaching 30M requires a 49.0% reduction from this snapshot. A proposed 24M operating target would require 59.2%, with 6M headroom. The headroom is a planning allowance, not a guarantee that emergency exits remain available after an account limit is reached.

Alchemy documents an account-wide 30M free allowance and subscription billing at 0.04 CU per byte. Its current method table charges 26 CU for eth_call and 20 CU for transaction and receipt reads. A JSON-RPC batch still charges each contained method. Sources: [free-tier details](https://www.alchemy.com/support/free-tier-details), [method costs](https://www.alchemy.com/docs/reference/compute-unit-costs).

### What the existing code already does

- The socket subscribes only to TokenLaunched events from the factory.
- Routine balances, accounting receipts and log polling use the public RPC. The box has no RPC_URL override.
- The HTTP provider URL is derived from LOGS_WS_URL. Missing RPC_KEY_URL does not mean the key is unused.
- Free feed metadata already screens some launches before paid reads.
- Ordinary buys and sells broadcast through the sequencer.
- Graduation uses provider reads with public fallback.

The public poller had 633 failures over the process's available trailing-hour history at the snapshot. Moving urgent requests there is not a demonstrated equivalent replacement.

### Gaps in the quota estimate

1. The totals reset on restart. There is no durable account billing-period ledger or remaining-allowance reading.
2. The meter omits nonce reads, graduation requests and separate research calls. Transport retries are not counted individually.
3. eth_getTransactionByHash is charged as 17 CU in the code; the current published table says 20.
4. The meter counts logical attempts before their result. It cannot distinguish every transport retry or zero-charge 429/403 response.
5. ReadBudget.allow exists but readVia deliberately ignores its verdict. A quota forecast does not throttle anything.

Therefore the estimate can err in either direction. It cannot tell us when the account will run out. The missing inputs are actual account usage, billing-period reset and other applications sharing the allowance.

### Reductions worth pursuing

The main candidate is to use the existing free sequencer feed to identify launch transactions, screen their calldata, and request confirmed receipts only for candidates. A receipt supplies the actual token and curve addresses. Preserve the public poller for authoritative reserve updates, launch history, deployer counts and observation coverage. Reserve provider access for time-sensitive reads and exits.

A 90-second passive laptop sample observed 866 feed blocks, zero gaps and 21 decoded direct launcher calls. Twenty used native ETH. Eight met a coarse initial screen. All eight corresponded to the eight launches the production bot screened as passed during that interval. Eight subsequent public-RPC receipt reads succeeded and confirmed those exact token addresses.

This test establishes a possible data path only. It does not measure provider receipt availability at launch, sustained coverage, indirect launcher calls, reconnect handling, or resulting entry latency. The coarse screen omits the deployer and template checks. Zero-tax candidates were retained because observations inform the bot even when it will not buy them.

At the current published method prices, one receipt plus one curve multicall costs 46 CU before retries. Per 1,000 candidates per day, that is 1.38M CU per 30 days. This is unit-cost arithmetic, not a candidate-volume forecast. Simply replacing every subscription event with a receipt request also requires a way to obtain its transaction hash.

Other changes can improve accounting and resilience but do not solve the stream cost alone: durable metering at every provider transport, account-usage reconciliation, cached immutable metadata, and fewer duplicate reads. The event's indexed fields are token, curve and deployer; pair token and tax are not available as simple subscription-topic filters.

A production replacement needs a read-only comparison against the current stream over busy and quiet periods. Check candidate coverage, receipt readiness before the two-second entry, long-tail latency, feed reconnects and failure fallback. Keep the latest three hours out of any tuning. No replacement has been deployed.

If preserving the current stream is preferred, the published PAYG rate makes 60M CU about $27 per month before taxes or other services. PAYG bills the full 60M at $0.45/M, rather than only the amount above the free allowance. A usage cap is supported. No plan or billing setting was changed. Source: [PAYG pricing FAQ](https://www.alchemy.com/docs/reference/pay-as-you-go-pricing-faq).

## Buy reverts

The dashboard alert was generated at 11:30:33 UTC. It combines older settings and is not a fresh verdict on the current configuration. Its test flags a positive optimistic replay over at least 20 reverted coins, or a revert rate above 10%. It does not establish what those failed transactions would actually have earned.

For the current money-setting era, from 13:55:27.189 to the frozen endpoint at 19:02:00.068 UTC:

- 72 submitted live buys; 2 reverted (2.78%).
- Exact booked gas cost: 0.00006000819536 ETH, about $0.15 at the snapshot's $2,493.335/ETH.
- Both rows have on-chain P&L populated.
- Both recorded gas usage of 53,165 against a 400,000 limit. Neither was out of gas.
- Decision-to-send time across all 72 buys: mean 104.9 ms, median 98.5 ms, sample sd 38.2 ms.

| Coin | Position | Decision to send | Gas cost, ETH | Optimistic replay at its recorded TP |
|---|---:|---:|---:|---:|
| WALL | 2148 | 136 ms | 0.00003020645175 | -20.75% |
| bred | 2189 | 53 ms | 0.00002980174361 | -11.54% |

Replay mean and median are both -16.15%; sample sd is 6.51 percentage points; n=2. These are existing gatewatch replays from an assumed launch+2-second entry, not executable fills at the failed transactions' positions in the block. They do not quantify profit saved by the fuse.

The stored failure cause is generic reverted. This audit does not claim to have decoded the contract's exact revert reason. Neither gas usage nor the optimistic replay demonstrates a quote bug. Both reverts occurred without unusually slow decision-to-send times relative to this small sample.

Decision: leave buy protection unchanged and do not spend further effort tuning it from this alert. Continue recording failures. Reopen the investigation for out-of-gas failures, a rising current-era revert rate, or evidence of stale quotes at the actual failed execution point.

## Required windows

The strict era follows the last recorded trade-size change and includes subsequent software deployments. Earlier periods are unavailable for this comparison, not zero-activity periods. No threshold or strategy was selected. The last three hours are reported descriptively and were not used to select a deployment.

Last 24 hours, eight bins ending at the frozen endpoint:

| UTC start | UTC end | Era coverage, hours | Submitted buys | Reverts |
|---|---|---:|---:|---:|
| 2026-09-06 19:02 | 22:02 | Outside era | Unavailable | Unavailable |
| 2026-09-06 22:02 | 01:02 | Outside era | Unavailable | Unavailable |
| 2026-09-07 01:02 | 04:02 | Outside era | Unavailable | Unavailable |
| 2026-09-07 04:02 | 07:02 | Outside era | Unavailable | Unavailable |
| 2026-09-07 07:02 | 10:02 | Outside era | Unavailable | Unavailable |
| 2026-09-07 10:02 | 13:02 | Outside era | Unavailable | Unavailable |
| 2026-09-07 13:02 | 16:02 | 2.11 | 43 | 1 |
| 2026-09-07 16:02 | 19:02 | 3.00 | 29 | 1 |

Last seven days, seven bins ending at 19:02 UTC:

| Start date | End date | Era coverage, hours | Submitted buys | Reverts |
|---|---|---:|---:|---:|
| 2026-08-31 | 2026-09-01 | Outside era | Unavailable | Unavailable |
| 2026-09-01 | 2026-09-02 | Outside era | Unavailable | Unavailable |
| 2026-09-02 | 2026-09-03 | Outside era | Unavailable | Unavailable |
| 2026-09-03 | 2026-09-04 | Outside era | Unavailable | Unavailable |
| 2026-09-04 | 2026-09-05 | Outside era | Unavailable | Unavailable |
| 2026-09-05 | 2026-09-06 | Outside era | Unavailable | Unavailable |
| 2026-09-06 | 2026-09-07 | 5.11 | 72 | 2 |

Durable per-bin provider CU histories do not exist. Those bins cannot reconstruct billed provider consumption. Launch counts are retained in the evidence JSON, but are not substituted for CU totals.

## Evidence and scope

Snapshot, exact rows and sample evidence (unavailable historical artifact: `../v1/data/provider-audit/audit-2026-09-07.json`). [Passive sample instrument](../v1/research/provider_feed_sample.ts).

The four relevant source files matched the box byte for byte: src/rpc/budget.ts, src/logs/subscriber.ts, src/bot.ts and scripts/edgecheck.py. The snapshot came from read-only SQLite connections and /api/state. The probe used the free feed and eight public receipt reads. It used no provider key or wallet signer and has stopped.

This was an exploration. Runtime code, subscriptions, entry protection, account stops and billing settings remain unchanged. The monthly cap is still not enforced locally.
