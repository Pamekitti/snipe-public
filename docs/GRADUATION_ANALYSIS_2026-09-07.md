> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Graduated coins: exit safety and initial evidence

Automatic recovery is justified. Deliberately targeting graduates is not supported by this sample. Graduation changes the trading venue; it does not make the token worthless or make its next trade profitable.

The current era begins at 13:55:27 UTC on 7 September 2026. The frozen snapshot ends at 16:16:30 UTC, only 2 hours 21 minutes later. Its SHA-256 is `fff71c66258ed626334490b4a02676d590079e61cf1f18e02365fb3ad0646789`. The last three hours are excluded from selection, so there are zero training observations. HUSDP was inspected before this audit and is not unseen validation.

HUSDP passed the entry guard at a recorded 3.929×, below the 4.5× cutoff, then graduated after the purchase. The safety implementation leaves entry rules unchanged. A confirmed graduation transfers the holding to the official native ETH V4 swap route. Exact approvals and the swap are recorded before broadcast. The position stays open through RPC errors, missing liquidity and uncertain receipts. It closes only after the correct receipt and an empty token balance. Six reverts, reverted gas reaching 5% of the stake, or twelve submitted transactions stop further broadcasts and leave an operator alert. These budgets survive restart. This handles an exit failure; it cannot guarantee liquidity or successful execution.

HUSDP 2167 is now reconciled to 0.080013752899899322 ETH proceeds and 0.059881385438513322 ETH net profit. Total recorded gas is 0.000132367461386 ETH. The original database was backed up before the correction. The sale is [confirmed on chain](https://robinhoodchain.blockscout.com/tx/0x2f3f81b187b94514c019fc070a26f3f4b1fa6e22eb1d8af20116946863555425).

Of 4,390 recorded launches in the era, 316 passed screening and 88 also met the current tax and exemption floors. Eight of those 88 graduated by the snapshot (9.1%). These floors are necessary entry conditions; account guards, prior losses, timing and entry-price checks still determine whether a purchase is allowed. The factory emitted 74 graduation events in the interval, including 13 for tokens launched before the era.

Four actual purchases eventually graduated. Rynex, INDEXED and PONLIX had already exited on the curve for profits of 0.01620, 0.00738 and 0.01863 ETH. HUSDP was the only held position abandoned at graduation in this era. The other 80 eligible launches belong in the denominator when judging an attempt to predict graduation. Knowing later which coins graduated is not a signal available before entry.

The single exploratory test buys 0.02 ETH two seconds after graduation and sells 45 seconds later. Historical archive quotes include hook fees and each quote’s own impact. Each round trip deducts a 0.000107136398564 ETH gas proxy derived from the real rescue transactions and original buy. This is not measured V4 round-trip gas. All eight historical quote pairs were available.

| Coin | Estimated net return |
|---|---:|
| PACE | +141.7% |
| Rynex | -7.7% |
| CHAOS | -11.5% |
| TRADEX | -30.2% |
| PONLIX | +16.1% |
| HUSDP | +190.4% |
| Nightdesk | -7.8% |
| INDEXED | -22.0% |

Three of eight outcomes won. Mean return was +33.6%, median -7.8%, sample sd 83.8 percentage points, n=8. Total estimated profit was +0.05376 ETH. Removing the two largest outcomes changes that total to -0.01264 ETH.

These quote pairs keep the historical intervening trades unchanged. They do not propagate our hypothetical purchase’s reserve changes through those trades. They also assume that the purchase, approvals and sale can be executed at the sampled times. This can overstate attainable returns. Eight correlated market observations are insufficient to establish a profitable entry policy. No new entry policy was selected.

For the actual HUSDP token holding, the historical sale quotes were:

| Delay from graduation | ETH before gas |
|---|---:|
| 0 seconds | 0.03739 |
| 2 seconds | 0.02663 |
| 5 seconds | 0.03811 |
| 15 seconds | 0.02903 |
| 45 seconds | 0.06623 |
| 60 seconds | 0.07028 |
| 300 seconds | 0.06638 |
| 621 seconds | 0.07795 |

These use the end of the sampled second. The 621-second quote is after our actual sale, so it includes our sale’s price impact and is not a counterfactual amount we could have received instead. The two-second quote of 0.02663 ETH was above the original 0.02 ETH stake. Waiting happened to pay more this time. The code will exit promptly rather than make that bet automatically.

Both required rolling windows end at the frozen snapshot. They do not have full historical coverage under the current strategy. Bins before the era are unavailable rather than zero-return observations.

| Window | UTC start | UTC end | Coverage | Eligible launches | Graduated | Quote n | Mean return | Median | Sample sd |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| last24h | 2026-09-06T16:16 | 2026-09-06T19:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-06T19:16 | 2026-09-06T22:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-06T22:16 | 2026-09-07T01:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-07T01:16 | 2026-09-07T04:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-07T04:16 | 2026-09-07T07:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-07T07:16 | 2026-09-07T10:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-07T10:16 | 2026-09-07T13:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last24h | 2026-09-07T13:16 | 2026-09-07T16:16 | partial era | 88 | 8 | 8 | +33.6% | -7.8% | +83.8% |
| last7d | 2026-08-31T16:16 | 2026-09-01T16:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last7d | 2026-09-01T16:16 | 2026-09-02T16:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last7d | 2026-09-02T16:16 | 2026-09-03T16:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last7d | 2026-09-03T16:16 | 2026-09-04T16:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last7d | 2026-09-04T16:16 | 2026-09-05T16:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last7d | 2026-09-05T16:16 | 2026-09-06T16:16 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| last7d | 2026-09-06T16:16 | 2026-09-07T16:16 | partial era | 88 | 8 | 8 | +33.6% | -7.8% | +83.8% |

Next evidence should be prospective: record every eligible graduation with executable quotes, quoted liquidity, approval timing, sale simulation results and gas. Continue counting non-graduates. Compare the fixed immediate recovery against a predeclared entry rule on future data before considering any change to exposure.

Reproduce from `bot/` with `research/graduation_audit.ts`, `research/graduation_archive.mjs` and `research/graduation_summary.py`; the frozen protocol is `research/GRADUATION_PROTOCOL.md`. Public RPC cannot provide older state, so archive quotes use the already configured provider without reading or transmitting a wallet key. Raw data and receipt evidence are retained under `v1/data/graduation-audit/`.

Implementation validation: the new router calldata succeeded in a read-only archive simulation against the real HUSDP wallet state one block before its sale. A real receipt fixture verifies both hook deductions. Tests cover approval sequencing, uncertain sends, restart recovery, duplicate prevention, missing pools, gas budgets and accounting. All 646 tests passed on the laptop and the box. Type checking passed. The validator matched 99,080 curve transitions and 409 tax checks exactly after its rate-limit handling was corrected. Snapshot `a8f44be` was deployed and activated while flat. The dashboard STOP remained set, with zero open positions and two automatic restarts already used. Entry rules, size and stop limits were preserved.
