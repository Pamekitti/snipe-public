> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Normal launch entries and exits through graduation

There is a plausible opportunity in launch purchases that later graduate. This audit does not establish that removing the expensive-entry guard or routinely waiting after graduation increases attainable profit. The earlier post-graduation-purchase test answered a different question and should not be used to decide this one.

The running bot has three separate controls: the entry-price cutoff at 4.5×, the exit when 12% of sellable supply remains, and the immediate swap fallback after confirmed graduation. Take profit and the 45-second clock can also close a position before graduation. Removing only the entry-price cutoff would leave those exits in place. No trading code or live settings were changed in this audit.

At the snapshot, 16:51:31 UTC on 7 September, there were 109 launches meeting the current screening, tax and exemption floors. Only TRADEX reached the entry-price rejection with other gates permitting an entry. It was recorded at 9.2×. The price check runs after account and eligibility gates, so other rejected launches have no comparable recorded entry reading. This is one measured price-guard rejection, not evidence that the bot rejects all eventual graduates.

Eleven of the 109 graduated by the snapshot. Five graduated after the normal 45-second holding period. POLI graduated before a normal launch-second +2 entry was available. Five had a usable launch entry and graduated within the holding period: CHAOS, TRADEX, HUSDP, PARLEY and GRAND. Of the real purchases, only HUSDP remained held through graduation. Three other purchased coins eventually graduated after profitable curve exits.

The price metric is fresh-curve tokens divided by expected tokens for the same 0.02 ETH stake. It is not a quoted spot-price multiple. Historical entry simulations used the first block stamped launch time +2 seconds. Each simulation was checked against the exact bigint curve model, including partial-fill refunds. All five matched, and all five spent the full 0.02 ETH. The archive block state is not the exact feed state available to the live decision, so reconstructed multiples must not be treated as logged guard decisions.

| Coin | Reconstructed entry multiple | Supply remaining after entry |
|---|---:|---:|
| CHAOS | 2.29× | 51.69% |
| TRADEX | 11.72× | 0.59% |
| HUSDP | 5.32× | 20.22% |
| PARLEY | 1.16× | 88.44% |
| GRAND | 8.15× | 8.65% |

TRADEX is the direct test case for loosening the guard. A hypothetical buy returned 972,127 tokens at block 56940863. The same call reverted with CurveGraduated at blocks 56940865 and 56940867. Its immediate-swap proxy valued that inventory at 0.02646 ETH before gas. That demonstrates possible upside if a buy lands, but also a narrow execution window. The existing 12% supply exit would already demand an exit after that entry. Dropping the entry-price cutoff alone would not authorize holding through graduation.

We also checked five actual purchases whose recorded entry multiple was at least 3×. Returns after recorded costs were −62.4%, +9.7%, +27.6%, −64.7% and HUSDP’s +299.4%. Mean +41.9%, median +9.7%, sample sd 149.8 percentage points, n=5. Excluding HUSDP gives mean −22.4%, median −26.3%, sd 48.1 points, n=4. This is a sensitivity check on a small selected group of admitted trades, not an estimate for rejected entries.

For the five fast-graduation coins, we held a fixed launch inventory and requested historical V4 sale quotes at predeclared delays. HUSDP uses its actual purchased inventory. The other four use the hypothetical normal launch purchase. Each quote includes its own price impact and hook fees. “Immediate” means graduation +2 seconds as an operational proxy, not a measured latency guarantee.

| Coin | +2 seconds ETH | +60 seconds ETH | +10 minutes ETH |
|---|---:|---:|---:|
| CHAOS | 0.13004 | 0.12231 | 0.00527 |
| TRADEX | 0.02646 | 0.02410 | 0.02085 |
| HUSDP | 0.03955 | 0.07072 | 0.07009 |
| PARLEY | 0.34251 | 0.58170 | 0.11245 |
| GRAND | 0.03857 | 0.02342 | 0.02834 |

Changes below are relative to selling the same inventory at +2 seconds. A negative number can mean giving back profit, rather than losing the original stake. Gas cancels in a paired comparison under the stated same-transaction-cost assumption. Live gas and failed attempts can differ with timing.

| Delay | Better than prompt exit | Mean change | Median change | Sample sd, points | n | Combined extra ETH |
|---|---:|---:|---:|---:|---:|---:|
| 5 seconds | 1/5 | -6.8% | -5.7% | 15.0 | 5 | +0.02186 |
| 15 seconds | 1/5 | -19.2% | -12.5% | 23.7 | 5 | -0.02913 |
| 30 seconds | 1/5 | -7.6% | -25.6% | 54.1 | 5 | +0.23338 |
| 60 seconds | 2/5 | +18.9% | -5.9% | 52.3 | 5 | +0.24513 |
| 180 seconds | 1/5 | -3.1% | -19.2% | 50.6 | 5 | -0.12726 |
| 600 seconds | 1/5 | -26.7% | -26.5% | 65.7 | 5 | -0.34012 |

Waiting 60 seconds produced more combined quoted ETH, despite reducing value in three of five cases. PARLEY contributed 0.23919 ETH of the 0.24513 ETH improvement. Removing PARLEY leaves +0.00594 ETH across the other four. Waiting ten minutes reduced sale value in four of five cases and lost 0.34012 ETH relative to prompt liquidation. CHAOS fell from 0.13004 ETH to 0.00527 ETH. HUSDP was the exception.

This is conditional on already holding inventory at graduation. It is not a replay of the strategy’s full exits. Most of these hypothetical positions might have hit take profit, the 12% exit or another rule first. Archive quotes do not propagate the hypothetical entry through later trades or alter graduation time. For that reason, the combined ETH numbers are exploratory opportunity-cost comparisons, not profit forecasts.

Timing inside a second matters. HUSDP’s +2-second quote was 0.03955 ETH at the first block in that second, versus 0.02663 ETH at its end in the preceding audit. Neither is a guaranteed executable fill. A policy comparison needs measured approval, quote and submission latency, not the best intra-second observation.

The current era spans only 13:55:27–16:51:31 UTC. The latest-three-hour exclusion starts at 13:51:31, leaving zero fitting observations. HUSDP was already inspected, so this is not unseen validation. Seven delays were predeclared, and no optimum was selected. Keep the price guard provisionally and treat prompt liquidation as the safety default. These data justify further testing of selective continuation; they do not justify a blanket “wait for a second pump” rule.

Both required rolling windows end at the snapshot. Earlier bins have no current-era coverage.

| Window | UTC start | UTC end | Coverage | Eligible launches | Price rejections | Fast-graduation comparison n | +60s mean change | Median | Sample sd |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| 24h | 2026-09-06T16:51 | 2026-09-06T19:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-06T19:51 | 2026-09-06T22:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-06T22:51 | 2026-09-07T01:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-07T01:51 | 2026-09-07T04:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-07T04:51 | 2026-09-07T07:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-07T07:51 | 2026-09-07T10:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-07T10:51 | 2026-09-07T13:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 24h | 2026-09-07T13:51 | 2026-09-07T16:51 | partial era | 109 | 1 | 5 | +18.9% | -5.9% | +52.3% |
| 7d | 2026-08-31T16:51 | 2026-09-01T16:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 7d | 2026-09-01T16:51 | 2026-09-02T16:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 7d | 2026-09-02T16:51 | 2026-09-03T16:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 7d | 2026-09-03T16:51 | 2026-09-04T16:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 7d | 2026-09-04T16:51 | 2026-09-05T16:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 7d | 2026-09-05T16:51 | 2026-09-06T16:51 | outside era | unavailable | unavailable | 0 | unavailable | unavailable | unavailable |
| 7d | 2026-09-06T16:51 | 2026-09-07T16:51 | partial era | 109 | 1 | 5 | +18.9% | -5.9% | +52.3% |

The frozen snapshot hash is `3354856b6636fb2b8d79a3e0cddb9a1e89af0702768e634ea75a420759ce5327`. Raw snapshots, entry-state checks and quotes are in `v1/data/graduation-launch-audit/`. The protocol is `v1/research/GRADUATION_LAUNCH_PROTOCOL.md`. The preparation, archive quote and summary instruments are named `graduation_launch_prepare.mjs`, `graduation_launch_archive.mjs` and `graduation_launch_summary.py`.
