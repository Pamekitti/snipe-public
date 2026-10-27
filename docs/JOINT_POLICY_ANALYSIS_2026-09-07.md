> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

The combined idea has conditional support, especially when stale information also triggers the cautious profile. The earlier exit audit did not test size, target, and holding time together, so its separate-clock results did not answer this proposal.

The new comparison changes all three controls at entry. Live settings remain unchanged. The main test and the missing-data diagnostic are separated because the diagnostic was added after inspecting the first result.

**The indicator is a fixed replay-profit score**

The profit guard's score S sums the last 20 eligible launches' replayed returns. Every launch is valued using the same 1.75 take-profit target, 45-second maximum, 20-second bailout, and 0.01 ETH replay stake. Eligibility here means passing the screen, creator-tax floor, and exempt-wallet floor. This includes launches the bot did not trade.

For example, proceeds of 1.10 times the simulated stake contribute +0.10 to S. Proceeds of 0.80 times the stake contribute -0.20. Curve fees and price impact enter these returns; gas does not enter the stored guard score. The trading comparisons below charge gas separately.

Current adaptive TP chooses the largest of seven such historical target scores across a broader screened-launch group. It does not directly read the profit guard's single S value. Slippage is an execution bound, not the feature choosing that target. There is also a separate older touch-rate guard measuring the share reaching 1.21 within 45 seconds.

The current profit guard pauses below S=-1 and reopens above S=+1. The oldest of its 20 launches must be within three hours. An unfresh window publishes an open venue reading while retaining its previous internal state. An adaptive trading policy therefore needs an explicit rule for missing information.

**The combined profile tested**

| Information available before entry | Size | TP | Maximum hold |
|---|---:|---:|---:|
| Fresh score above +1 | Normal | 2.00 | 45 seconds |
| Fresh score at or below +1, while the guard still permits entry | Half | 1.36 | 30 seconds |
| Score below -1, or still waiting for the guard to reopen | No new trade | n/a | n/a |
| Stale or insufficient score, primary test | Current policy | Current policy | Current policy |
| Stale or insufficient score, later diagnostic | Half | 1.36 | 30 seconds |

Normal/half was tested at 0.01/0.005 ETH and at yesterday's 0.02/0.01 ETH. The latter is a historical-size scenario, not permission to raise today's size. The hard stop, peak-based bailout, graduation exit, and existing venue pause remain in both profiles. Each entry pins its profile.

**Data and execution**

The reused snapshot ends at 2026-09-07T12:31:02.343000+00:00; the excluded fitting boundary is 2026-09-07T06:31:02.343000+00:00. There are 634 complete chain sequences spanning about 39.5 hours. The previous analysis already inspected this period. These comparisons are retrospective, not an untouched holdout.

Every proposed size rebuilds the curve path, token allocation, exit proceeds, and price impact. Half size is not implemented by halving the full-size P&L. A reconstructed 4.5 entry-price guard is applied at the hypothetical entry block. This remains a proxy for the original quote before a live buy was sent.

The account replay includes a 30-second guard clock, the 0.06 ETH drawdown stop, post-stop recovery evidence, two automatic lifts per UTC day, and 0.08 ETH concurrent deployment capacity. Trade and halt states carry across the fitting boundary. Historical touch-gate decisions, manual stops, and template-loss filtering are not fully reconstructed. Changes in other traders' behaviour are unknown.

Gas comes from fitting-period observed costs at each size. The previous report incorrectly described the 0.01 ETH fee estimate as a fallback from 0.02 ETH trades. It actually used 43 earlier 0.01 ETH trades; the numerical estimate was correct. The report text has been corrected.

Spread cells show **mean / median / sample standard deviation; n**. Gas costs below are ETH.

| Historical stake | Observed gas-cost distribution |
|---|---|
| 0.005 ETH | 0.000072007 / 0.000067133 / 0.000010397; n=176 |
| 0.01 ETH | 0.000080734 / 0.000066598 / 0.000046011; n=43 |
| 0.02 ETH | 0.000083640 / 0.000082490 / 0.000005441; n=88 |

**Combined profit and risk results**

The following are simulated ETH totals, not realized wallet profits. All-period drawdown is the largest decline in cumulative closed-trade cash. It can exceed a single stop budget after automatic restarts. Different policies can take different numbers of trades after their drawdown stops.

| Normal/half size | Policy | Earlier P&L, n | Final six hours P&L, n | Whole-period maximum drawdown |
|---|---|---:|---:|---:|
| 0.01/0.005 | Current policy | +0.795248; n=463 | +0.034613; n=51 | 0.039854 |
| 0.01/0.005 | Combined, stale uses current policy | +0.881103; n=463 | +0.013246; n=51 | 0.055256 |
| 0.01/0.005 | Combined, stale also uses cautious profile | +0.846186; n=463 | +0.030226; n=51 | 0.034814 |
| 0.01/0.005 | Half size when weak or stale | +0.740398; n=463 | +0.035479; n=51 | 0.021563 |
| 0.01/0.005 | Half size only when stale | +0.771947; n=463 | +0.049674; n=51 | 0.032678 |
| 0.02/0.01 | Current policy | +1.520457; n=445 | +0.009598; n=35 | 0.076483 |
| 0.02/0.01 | Combined, stale uses current policy | +1.779523; n=463 | -0.010868; n=37 | 0.124665 |
| 0.02/0.01 | Combined, stale also uses cautious profile | +1.711349; n=463 | +0.061758; n=51 | 0.061966 |
| 0.02/0.01 | Half size when weak or stale | +1.461397; n=464 | +0.058069; n=51 | 0.049229 |
| 0.02/0.01 | Half size only when stale | +1.475410; n=445 | +0.085550; n=51 | 0.076483 |

The primary combined profile earned more in the earlier period and less in the final six hours at both size pairs. At 0.01 ETH normal size, its whole-period drawdown rose from 0.039854 to 0.055256 ETH. The broader exit conclusion therefore changes: the joint policy can increase profit, but that increase does not by itself establish better protection.

Treating stale information as weak changed the result. At 0.02/0.01 ETH, the combined diagnostic increased whole-period simulated P&L by 0.243051 ETH and reduced drawdown from 0.076483 to 0.061966 ETH. It also improved the recent period. At 0.01/0.005 ETH, whole-period profit and drawdown improved, but recent profit remained 0.004387 ETH below the baseline. The size effect is material.

Joint profit and drawdown comparison (unavailable historical artifact: `research/joint-policy-audit-20260907.png`)

**Which part helped?**

The controls change one component at a time. At 0.01 ETH normal size, fixed TP 2.00 everywhere produced more total simulated profit than the conditional combined profile. Much of that profile's profit improvement came from changing the target generally. The market switching itself was not the whole source of the gain.

| Component, at normal 0.01 ETH | Earlier P&L change vs baseline | Recent P&L change vs baseline | Whole-period drawdown |
|---|---:|---:|---:|
| Half size in weak conditions | -0.031548 | -0.014195 | 0.036036 |
| Lower/higher TP only | +0.112154 | -0.009761 | 0.055144 |
| Shorter clock only when weak | +0.003073 | -0.004569 | 0.039854 |
| TP and clock together, full size | +0.108579 | -0.009761 | 0.055144 |
| Combined, stale uses current policy | +0.085855 | -0.021367 | 0.055256 |
| Fixed 2.00 target everywhere | +0.127002 | +0.017414 | 0.055068 |

**The recent losing trades expose the missing-data problem**

Of the final 18 actual 0.02 ETH trades, 11 had an unfresh profit-guard window. Five had a fresh score above +1. Two would have been paused by today's 20-launch guard. None was a fresh weak-but-tradable case. Treating unknown as the current policy left those 11 trades at normal size.

On the 16 actual-fill paths that today's venue guard would permit, the cautious missing-data profile improved modeled P&L by 0.053279 ETH. Halving size alone when the score was stale supplied 0.031506 ETH of that difference. Eleven of those 16 trades changed. These are alternative executions reconstructed from real chain events, not savings observed in the wallet.

| Recent 0.02 ETH actual-fill comparison | Modeled P&L difference per trade, ETH |
|---|---|
| Combined, stale also uses cautious profile | 0.003330 / 0.000557 / 0.005356; n=16 |
| Half size when weak or stale | 0.001969 / 0.000557 / 0.002504; n=16 |
| Half size only when stale | 0.001969 / 0.000557 / 0.002504; n=16 |

**Execution calibration and timing sensitivity**

Replay-minus-wallet gaps below use actual fill blocks, recorded targets, actual stakes, and each trade's booked costs. Positive gaps mean the replay is optimistic. Small medians coexist with large errors on individual trades, especially at 0.005 ETH. Alternative-order profits cannot be treated as exact wallet forecasts.

| Actual stake | Earlier execution gap, percentage points | Recent execution gap, percentage points |
|---|---|---|
| 0.005 ETH | 5.32 / 0.00 / 55.90; n=174 | Unavailable; n=0 |
| 0.01 ETH | 0.62 / -0.00 / 16.24; n=43 | -3.48 / -3.48 / 4.92; n=2 |
| 0.02 ETH | 2.13 / -0.21 / 23.31; n=88 | 2.84 / -0.00 / 6.25; n=18 |

The cautious missing-data profile at 0.02 ETH still improved the recent period with extra score delays of one and three minutes, and with sell delays up to 2.4 seconds. At 2.4 seconds, however, its earlier-period gain turned into a loss and its whole-period drawdown became worse. At today's 0.01 ETH normal size, recent profit remained below baseline in every tested timing sensitivity.

The fitting grid contained 18 joint profiles plus the baseline. Weak targets were 1.25/1.36/1.50, weak caps 20/30 seconds, and strong targets 1.75/2.00/2.50. Selection required no greater fitting-period drawdown than baseline. It retained the baseline at 0.01 ETH. At 0.02 ETH it chose weak TP 1.50 and 20 seconds, with strong TP 2.00; that choice underperformed the baseline in recency.

A zero-score weak/strong split was also checked as a diagnostic. It improved both profit periods at 0.01 ETH but increased whole-period drawdown. It failed the recent comparison at 0.02 ETH. That sensitivity prevents presenting +1 as an established optimal cut.

**All predeclared joint candidates**

Cells report total modeled ETH. The baseline and exact primary profile appear above. The full JSON also records return distributions, costs, skips, stops, and resumes.

| Weak TP / seconds / strong TP | Earlier delta, normal 0.01 | Recent delta, normal 0.01 | Earlier delta, normal 0.02 | Recent delta, normal 0.02 |
|---|---:|---:|---:|---:|
| 1.25 / 20 / 1.75 | +0.010058 | -0.022670 | +0.097096 | -0.019459 |
| 1.25 / 20 / 2 | +0.086815 | -0.023108 | +0.261072 | -0.020466 |
| 1.25 / 20 / 2.5 | +0.035780 | -0.020418 | +0.056814 | +0.010971 |
| 1.25 / 30 / 1.75 | +0.009311 | -0.021035 | +0.095580 | -0.019459 |
| 1.25 / 30 / 2 | +0.086068 | -0.021474 | +0.259556 | -0.020466 |
| 1.25 / 30 / 2.5 | +0.035033 | -0.018784 | +0.055298 | +0.010971 |
| 1.36 / 20 / 1.75 | +0.010919 | -0.022563 | +0.098754 | -0.019459 |
| 1.36 / 20 / 2 | +0.087676 | -0.023001 | +0.262730 | -0.020466 |
| 1.36 / 20 / 2.5 | +0.036641 | -0.020311 | +0.058472 | +0.010971 |
| 1.36 / 30 / 1.75 | +0.009098 | -0.020928 | +0.095090 | -0.019459 |
| 1.36 / 30 / 2 | +0.085855 | -0.021367 | +0.259066 | -0.020466 |
| 1.36 / 30 / 2.5 | +0.034820 | -0.018677 | +0.054808 | +0.010971 |
| 1.5 / 20 / 1.75 | +0.020560 | -0.018907 | +0.117914 | -0.019459 |
| 1.5 / 20 / 2 | +0.097317 | -0.019346 | +0.281890 | -0.020466 |
| 1.5 / 20 / 2.5 | +0.046282 | -0.016656 | +0.077273 | +0.010971 |
| 1.5 / 30 / 1.75 | +0.018853 | -0.018617 | +0.114472 | -0.019459 |
| 1.5 / 30 / 2 | +0.095610 | -0.019055 | +0.278448 | -0.020466 |
| 1.5 / 30 / 2.5 | +0.044575 | -0.016366 | +0.073707 | +0.010971 |

**Time windows**

Both windows end at the original frozen snapshot. Older bins precede the per-target instrumentation and are unavailable. Returns are per trade as a percentage of that trade's actual proposed stake. These tables use the cautious missing-data diagnostic at current 0.01/0.005 ETH sizes.

| 24h: bin start, UTC | Coverage | Net ETH | Return %, mean / median / sd; n |
|---|---|---:|---|
| 2026-09-06T12:31 | in sample | +0.063441 | 11.08 / -4.23 / 58.77; n=63 |
| 2026-09-06T15:31 | in sample | +0.265361 | 28.46 / -0.05 / 70.95; n=95 |
| 2026-09-06T18:31 | in sample | +0.211846 | 25.87 / -3.83 / 68.03; n=81 |
| 2026-09-06T21:31 | in sample | +0.174334 | 35.58 / 25.48 / 84.52; n=49 |
| 2026-09-07T00:31 | in sample | -0.027933 | -21.27 / -44.38 / 62.90; n=13 |
| 2026-09-07T03:31 | in sample | +0.000000 | Unavailable; n=0 |
| 2026-09-07T06:31 | in sample | +0.003938 | 7.79 / -5.70 / 22.92; n=7 |
| 2026-09-07T09:31 | in sample | +0.026288 | 8.19 / 3.18 / 36.94; n=44 |
| 7d: bin start, UTC | Coverage | Net ETH | Return %, mean / median / sd; n |
|---|---|---:|---|
| 2026-08-31T12:31 | unavailable | Unavailable | Unavailable; n=0 |
| 2026-09-01T12:31 | unavailable | Unavailable | Unavailable; n=0 |
| 2026-09-02T12:31 | unavailable | Unavailable | Unavailable; n=0 |
| 2026-09-03T12:31 | unavailable | Unavailable | Unavailable; n=0 |
| 2026-09-04T12:31 | unavailable | Unavailable | Unavailable; n=0 |
| 2026-09-05T12:31 | partial | +0.159137 | 11.13 / -4.59 / 46.69; n=162 |
| 2026-09-06T12:31 | in sample | +0.717274 | 20.96 / -1.83 / 66.78; n=352 |

**Decision**

The proposed combined adaptation deserves a forward observation test. Freshness must be part of the state, alongside the score. Strong evidence should permit the normal profile; weakening or missing evidence should have an explicitly tested cautious response. The latest diagnostics support reducing exposure when the score becomes unavailable, but do not establish the exact TP, clock, or size fractions to deploy.

No policy or trade size was changed. The stale-data diagnostic was prompted by losses already known in the reused sample. It needs fresh evaluation before a money decision. There are fewer than two independent days of primary data.

The executable study is [joint_policy_audit.py](../v1/research/joint_policy_audit.py). [The protocol](../v1/research/JOINT_POLICY_PROTOCOL.md) separates the original candidate set from the later diagnostics. Raw results are local under `v1/data/joint-policy-audit/`. The eight profile tests and sixteen existing guard-simulator tests passed.
