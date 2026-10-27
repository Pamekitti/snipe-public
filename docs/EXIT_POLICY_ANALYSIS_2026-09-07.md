> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

Keep the 45-second maximum and current 20-second bailout for now. The tested alternatives did not produce a consistent improvement across the earlier sample, final six hours, and matched actual fills. The current adaptive take profit is also not established as optimal.

Scope update: this report tested exit changes separately. [The combined-policy follow-up](JOINT_POLICY_ANALYSIS_2026-09-07.md) tests the guard score choosing size, TP, and holding time together.

Analysis frozen at **2026-09-07T12:31:02.343000+00:00**. The final six hours begin at **2026-09-07T06:31:02.343000+00:00**. Live configuration and trading code were read only. No settings, risk limits, processes, or accounting periods were changed.

**What the bot actually adapts**

| Control | Input | Action |
|---|---|---|
| Take profit | Replayed returns at seven targets on the last 20 scored, screened launches | Choose the largest total return, with ties going to the lowest target. Pin the target when the trade opens. |
| Targets | 1.25, 1.36, 1.50, 1.75, 2.00, 2.50, 3.00 times entry liquidation value | Fall back to 1.75 with fewer than 20 usable records or a cache read older than five minutes. |
| Profit-based market guard | Last 20 scored launches with creator tax at least 50 bps and at least three exempt wallets, valued at fixed 1.75 | Pause below -1 total stake; reopen above +1. The oldest observation must be within three hours. |
| Touch-rate market guard | Share reaching its own fixed 1.21 threshold inside 45 seconds | Separate pause/reopen decision. Its measurement does not move with the take profit. |
| Entry price guard | Fresh-curve token quote divided by current token quote for the same stake | Reject a quote at 4.5 times or more. |
| Slippage bound | Minimum acceptable execution output | A transaction acceptance limit, not the signal choosing take profit or holding time. |

The take-profit multiple compares the estimated proceeds from selling the whole position with that estimate at entry. Fees and price impact enter both estimates. A 1.75 target therefore does not promise a 75% net gain on the ETH spent. Actual net return also pays execution costs.

The exit order is graduation risk, take profit, 45-second maximum, 0.50 hard stop, then the dead-coin bailout. The bailout fires after 20 seconds only when the **highest** liquidation value seen remains below 1.03 times its entry value. A brief rise above 1.03 disables that bailout for the rest of the trade. There is no trailing profit protection in the live rule.

The target changes between trades. It does not tighten on a developer sell during a position. The five-minute freshness check measures the cached read's age, so a regularly reread old launch window can still be used.

**How recent and relevant is the adaptive signal?**

All spread cells below show **mean / median / sample standard deviation; n**. Percent-return cells use percentage points of the stake. Standard deviation is unavailable for a single observation.

| Measurement | Distribution |
|---|---|
| Eligible launches in each 20-launch TP window | +3.93 / +4.00 / +2.15; n=618 |
| Span of all-screened TP window, minutes | +13.29 / +12.80 / +6.92; n=618 |
| Span of eligible-only 20-launch window, minutes | +73.81 / +64.62 / +41.54; n=609 |
| Launch-to-score delay, seconds | +200.14 / +170.72 / +116.89; n=3482 |

The latest 20 contained 4 eligible launches. Eligible-only learning chose a different target on 502 of 618 scored launches. The reconstructed all-screened rule matched 314 of 327 recorded live targets with a conservative 30-second read delay. A 15-second delay matched 321 of 327, and no added delay matched 317 of 327. The bot's exact historical refresh timestamps were not recorded.

**Take-profit comparison using recorded observer outcomes**

These are observer returns before gas. They are not wallet profits. Both adaptive variants use only observations whose stored scoring time was already past. Entry is approximated at launch plus two seconds. A 30-second read delay is included.

| Target rule | Earlier sample return % | Final six hours return % |
|---|---|---|
| Fixed 1.25 | +7.92 / +7.22 / +34.44; n=551 | +6.14 / +10.28 / +25.72; n=66 |
| Fixed 1.36 | +10.28 / +2.20 / +39.89; n=551 | +8.78 / +6.63 / +31.18; n=66 |
| Fixed 1.5 | +11.22 / -1.61 / +44.90; n=551 | +10.94 / +2.72 / +34.47; n=66 |
| Fixed 1.75 | +16.14 / -3.17 / +55.23; n=551 | +9.42 / -4.54 / +38.56; n=66 |
| Fixed 2 | +17.06 / -4.04 / +62.76; n=551 | +8.60 / -5.02 / +43.90; n=66 |
| Fixed 2.5 | +16.23 / -4.15 / +68.28; n=551 | +6.76 / -5.05 / +44.98; n=66 |
| Fixed 3 | +17.60 / -4.15 / +76.43; n=551 | +6.04 / -5.19 / +49.79; n=66 |
| Current adaptive, all screened | +14.04 / -2.84 / +54.72; n=551 | +6.68 / -4.08 / +35.99; n=66 |
| Adaptive, eligible only | +16.63 / -3.93 / +67.18; n=551 | +4.21 / -4.96 / +35.16; n=66 |

The fixed 3.00 target won the earlier sample. It lost its advantage over current adaptation in the final six hours. Eligible-only adaptation also improved the earlier sample and underperformed current adaptation in recency. Fixed 1.75 beat current adaptation in both periods, but it was not the training winner. That is a candidate for prospective comparison, not a selection proved by this holdout.

**What happened in real trades**

The current 0.01 ETH size began shortly before the primary snapshot, which contains two closed trades at that size. A later check adds 11 executions. The immediately preceding uninterrupted 0.02 ETH series contains 106 real trades and one failed buy. All 107 rows have chain-reconciled P&L. Its net booked result was +0.019394 ETH, including the failed buy. The 88 trades resolved before the final-six-hour boundary earned +0.109926 ETH; the 18 opened inside that final period lost 0.090502 ETH. Changing guards and restarts affect which launches actually traded.

| Exit reason at 0.02 ETH | Trades / 106 | Net booked ETH | Holding time, seconds |
|---|---:|---:|---|
| dead | 27 / 106 | -0.072133 | +21.10 / +20.87 / +0.58; n=27 |
| graduating | 1 / 106 | +0.034612 | +22.92 / +22.92 / n/a; n=1 |
| stop | 17 / 106 | -0.215889 | +13.88 / +8.01 / +13.62; n=17 |
| time | 43 / 106 | -0.033062 | +46.06 / +45.99 / +0.31; n=43 |
| tp | 18 / 106 | +0.305896 | +10.76 / +6.95 / +9.27; n=18 |

Sixty-three of 106 trades already exited without reaching the 45-second clock. The stop-loss trades closed at a median 8.014 seconds. Moving the maximum to 20 or 30 seconds cannot by itself prevent losses already occurring before then.

**Clock and path-based exits**

Complete 95-second log ranges were requested for 634 launches. The comparison contains 618 enterable cohort paths. 16 paths could not enter in the replay. Every paired policy sees the same launches, the same 0.01 ETH stake, and the same causally chosen take profit. Current real trading filters beyond screen/tax/exemptions, capacity, halts, and repeat-template losses are not rerun as a whole-bot simulation.

Gas is charged at 0.000066598 ETH per trade, the median measured cost across 43 earlier 0.01 ETH trades. The two 0.01 ETH trades at the primary snapshot describe the latest uninterrupted size period, not all earlier trades at that nominal size. The model charges the same one-buy/one-sell cost to every policy, so that assumed charge cancels in paired differences. Extra failed transactions and retries are not simulated. Actual execution calibration uses each trade's own booked costs.

The table reports **change in return versus the current 45-second policy**, in percentage points. Positive values favour the candidate. The current policy is zero by definition. Every alternative retains the hard stop and graduation exit. Except for the named bailout variants, the 20-second peak-based bailout remains enabled.

| Alternative | Earlier sample change, pp | Final six hours change, pp |
|---|---|---|
| 15s maximum | -2.94 / +0.00 / +25.52; n=551 | -1.22 / +0.00 / +21.04; n=66 |
| 20s maximum | -2.42 / +0.00 / +21.38; n=551 | -0.45 / +0.00 / +17.84; n=66 |
| 30s maximum | -0.55 / +0.00 / +13.93; n=551 | -0.02 / +0.00 / +12.61; n=66 |
| 60s maximum | -0.15 / +0.00 / +19.19; n=551 | +2.05 / +0.00 / +14.95; n=66 |
| 75s maximum | -0.19 / +0.00 / +21.51; n=551 | +2.06 / +0.00 / +27.28; n=66 |
| Disable dead-coin bailout | +0.31 / +0.00 / +10.17; n=551 | +1.03 / +0.00 / +13.29; n=66 |
| Bail never-risers at 10s | -0.73 / +0.00 / +13.60; n=551 | -1.68 / +0.00 / +12.53; n=66 |
| Bailout at 15s | +0.01 / +0.00 / +7.68; n=551 | -0.63 / +0.00 / +12.69; n=66 |
| Bailout at 25s (training winner) | +0.42 / +0.00 / +5.29; n=551 | -0.73 / +0.00 / +5.96; n=66 |
| 15% giveback after 1.10x peak | -1.59 / +0.00 / +20.03; n=551 | -1.13 / +0.00 / +12.19; n=66 |
| 25% giveback after 1.10x peak | -1.03 / +0.00 / +14.32; n=551 | +0.55 / +0.00 / +2.39; n=66 |
| 15% giveback after 1.25x peak | -1.33 / +0.00 / +19.20; n=551 | -0.65 / +0.00 / +8.54; n=66 |
| 25% giveback after 1.25x peak | -0.75 / +0.00 / +12.91; n=551 | +0.27 / +0.00 / +1.42; n=66 |
| Exit on creator-address sell | -0.10 / +0.00 / +12.56; n=551 | -1.39 / +0.00 / +8.68; n=66 |
| Exit on early-wallet sell | -8.84 / +0.00 / +43.52; n=551 | -7.67 / +0.00 / +27.93; n=66 |
| Weak mark + nonpositive 5s flow from 15s | -0.65 / +0.00 / +12.08; n=551 | -0.78 / +0.00 / +13.12; n=66 |
| Weak mark + nonpositive 5s flow from 20s | -0.21 / +0.00 / +7.28; n=551 | -0.07 / +0.00 / +5.56; n=66 |
| Adaptive 20/30/45/60s maximum | -0.82 / +0.00 / +13.30; n=551 | -0.53 / +0.00 / +15.22; n=66 |

The training winner's final-period mean difference was -0.73 percentage points. Its 90% interval from resampling three-hour blocks was [-1.06, +0.04] pp across only 3 occupied blocks. This interval describes variation inside the observed period. It does not establish performance in a future market.

The adaptive clock chooses among 20, 30, 45, and 60 seconds using the last 20 resolved eligible launches. Those launches must be at least 90 seconds old and their recorded score must be available. It falls back to 45 seconds when fewer than 20 are available. This is a predefined candidate, not an existing live feature.

The selling-activity candidates act after observing the sell. They receive the post-sell curve price plus execution delay. They cannot exit at the price that existed before the dump. 'Creator' means the known creator address in the decoded event. Wallet aliases and unrecognised related addresses remain invisible.

Paired clock comparison and real exit costs (unavailable historical artifact: `research/exit-policy-audit-20260907.png`)

**Execution calibration and sensitivity**

Calibration replays actual fill blocks, recorded targets, actual stake sizes, and actual booked costs. Positive gaps mean the replay is optimistic relative to the wallet.

| Actual stake | Earlier replay-minus-real gap, pp | Final-six-hour gap, pp |
|---|---|---|
| 0.01 ETH | Unavailable (n=0) | -3.48 / -3.48 / +4.92; n=2 |
| 0.02 ETH | +2.13 / -0.21 / +23.31; n=88 | +2.84 / -0.00 / +6.25; n=18 |

The actual-fill replay reveals the tradeoff behind shorter holds. A 20-second limit would have improved the final 18 traded coins by 0.024801 ETH, but cost 0.045326 ETH on the earlier 88. The broader launch sample also lost from that shorter limit. Selecting only the recent losing trades would miss the winners it cuts short.

Removing the bailout improved both periods in the broad cohort replay. It nevertheless lost 0.012594 ETH on the final 18 actual-fill replays. That disagreement prevents treating its broad-cohort gain as a supported live improvement.

The next table uses those actual fill blocks, actual 0.02 ETH stakes, and recorded targets. Cells show the candidate's return difference from the replayed current exit rule, in percentage points.

| Candidate on actual-fill paths | Earlier change, pp | Final-six-hour change, pp |
|---|---|---|
| 20s maximum | -2.58 / +0.00 / +23.20; n=88 | +6.89 / +0.00 / +22.12; n=18 |
| 30s maximum | -1.20 / +0.00 / +19.21; n=88 | +2.33 / +0.00 / +14.90; n=18 |
| 60s maximum | -0.57 / +0.00 / +12.22; n=88 | +1.49 / +0.00 / +6.13; n=18 |
| Disable dead-coin bailout | +0.99 / +0.00 / +6.40; n=88 | -3.50 / +0.00 / +14.63; n=18 |
| Bailout at 25s | -0.03 / +0.00 / +1.67; n=88 | -4.63 / +0.00 / +13.14; n=18 |
| Exit on creator-address sell | +0.57 / +0.00 / +21.35; n=88 | -0.67 / +0.00 / +4.26; n=18 |

After freezing the training winner, I retrieved 11 subsequent 0.01 ETH trades through 2026-09-07T13:09:32.945000+00:00. The replay-minus-wallet gap was +0.41 / -0.44 / +2.28; n=11 percentage points. The chosen 25-second bailout changed none of these 11 exits. This later check supplies no evidence for the candidate's distinct behaviour.

The latency grid varies sell lag over 0.6, 1.2, and 2.4 seconds, and observation interval over 0.5 and 1.2 seconds. The selected 25-second bailout's final-period difference changed sign across that grid. Its result is sensitive to execution timing. An additional diagnostic removes entry quotes at or above a reconstructed 4.5 multiple. That quote is a proxy at the hypothetical fill block, not the unrecorded live quote at its decision time.

The simulator passed eleven tests covering causality, peak-based bailout, clock delay, exit priority, graduation, and trailing activation. Across 679 baseline comparisons on 97 real chain paths, 671 matched the existing replay. Eight differences on two tokens came from intentional execution corrections: an already-sent exit is not replaced by a later graduation trigger, and a fully graduated curve cannot sell.

**Did creator selling move earlier?**

These are retrospective timings within 75 seconds after entry, conditional on an identified creator-address sell. Launches without such a sell remain in the denominator. They are not assigned an invented sell time.

| Period | Creator sells / paths | First creator sell age, seconds | Age of maximum mark among paths reaching 1.10x, seconds |
|---|---:|---|---|
| Earlier | 284 / 552 | +22.76 / +14.05 / +21.34; n=284 | +30.83 / +24.70 / +24.93; n=381 |
| Final six hours | 34 / 66 | +32.58 / +30.35 / +26.36; n=34 | +40.46 / +44.00 / +24.25; n=52 |

These two periods do not isolate a causal market effect. The final six hours contain a small, selected set of launches. A change in creator-address mix can change this distribution without each creator changing behaviour.

The next table defines market condition using the **current guard's own number**: the total replayed return at fixed 1.75 across its latest 20 eligible launches, with the three-hour freshness rule. It is a diagnostic grouping, not a newly fitted trading rule. A score below -1 would already pause new entries under the current guard.

| Current guard score at entry | Creator sell within 10s / paths | First creator sell age, seconds | Paired 30s-cap change, pp |
|---|---:|---|---|
| Below -1 | 14 / 57 | +24.93 / +12.70 / +22.79; n=35 | -0.10 / +0.00 / +8.29; n=57 |
| -1 through +1 | 25 / 108 | +21.32 / +12.80 / +21.16; n=55 | +0.70 / +0.00 / +17.09; n=108 |
| Above +1 | 86 / 417 | +24.15 / +15.30 / +21.98; n=209 | -0.92 / +0.00 / +13.80; n=417 |

Fast creator-address sells occurred on 14 of 57 weak-score launches and 86 of 417 strong-score launches. A two-sided Fisher exact test gives p=0.491. This sample does not establish that the guard predicts faster creator dumping. The unidentified-wallet limitation still applies.

**Chronological checks**

Each fold first chooses a policy using only resolved earlier launches, then scores it on the next disjoint three hours. The first fold has six hours of prior data. Changes below are paired return percentage points against the current clock.

| Evaluation starts, UTC | Training launches | Chosen policy | Evaluation difference, pp |
|---|---:|---|---|
| 2026-09-06T03:03 | 68 | Weak mark + nonpositive 5s flow from 20s | -0.06 / +0.00 / +0.47; n=35 |
| 2026-09-06T06:03 | 104 | Exit on creator-address sell | -7.83 / +0.00 / +35.44; n=30 |
| 2026-09-06T09:03 | 134 | 15% giveback after 1.25x peak | -0.55 / +0.00 / +5.16; n=38 |
| 2026-09-06T12:03 | 171 | 75s maximum | +6.59 / +0.00 / +36.24; n=62 |
| 2026-09-06T15:03 | 234 | 75s maximum | +0.54 / +0.00 / +11.66; n=86 |
| 2026-09-06T18:03 | 318 | 75s maximum | -5.99 / +0.00 / +28.86; n=92 |
| 2026-09-06T21:03 | 411 | Disable dead-coin bailout | -1.77 / +0.00 / +8.84; n=57 |
| 2026-09-07T00:03 | 468 | 75s maximum | +0.83 / +0.00 / +13.68; n=40 |
| 2026-09-07T03:03 | 509 | Bailout at 25s | +1.68 / +0.00 / +10.96; n=40 |
| 2026-09-07T06:03 | 549 | Bailout at 25s | +0.04 / +0.00 / +0.17; n=18 |
| 2026-09-07T09:03 | 567 | Disable dead-coin bailout | -0.08 / +0.00 / +11.18; n=41 |

**Required time windows**

Both windows end at the frozen snapshot. The per-target observer history starts on 5 September at 21:03 UTC. Earlier bins are unavailable for this policy comparison. A short history has not been stretched into seven days of evidence. These tables show the baseline raw-path replay return percentage, with mean / median / sample standard deviation; n.

| 24h: bin start, UTC | Coverage | Baseline return % |
|---|---|---|
| 2026-09-06T12:31 | in-era | +10.97 / -0.85 / +48.67; n=65 |
| 2026-09-06T15:31 | in-era | +23.65 / +25.24 / +59.49; n=97 |
| 2026-09-06T18:31 | in-era | +23.22 / +1.18 / +66.43; n=82 |
| 2026-09-06T21:31 | in-era | +27.46 / +22.99 / +71.56; n=52 |
| 2026-09-07T00:31 | in-era | -2.00 / -5.98 / +40.46; n=39 |
| 2026-09-07T03:31 | in-era | -15.50 / -18.77 / +22.59; n=39 |
| 2026-09-07T06:31 | in-era | +7.15 / -0.21 / +24.43; n=20 |
| 2026-09-07T09:31 | in-era | +5.53 / -5.20 / +40.22; n=46 |
| 7d: bin start, UTC | Coverage | Baseline return % |
|---|---|---|
| 2026-08-31T12:31 | before instrumentation | Unavailable (n=0) |
| 2026-09-01T12:31 | before instrumentation | Unavailable (n=0) |
| 2026-09-02T12:31 | before instrumentation | Unavailable (n=0) |
| 2026-09-03T12:31 | before instrumentation | Unavailable (n=0) |
| 2026-09-04T12:31 | before instrumentation | Unavailable (n=0) |
| 2026-09-05T12:31 | partial | +8.20 / -4.59 / +47.97; n=178 |
| 2026-09-06T12:31 | in-era | +13.76 / -3.08 / +55.45; n=440 |

**Limits and next decision**

The study has fewer than two days of primary path evidence. There are 13 actual executions at the current size across the primary and later snapshots. The final six hours were excluded from fitting, but some of today's live losses were visible before the study. They are historical validation, not an untouched prospective test. Launches unresolved at the fitting boundary are excluded from training.

The replay assumes 100 ms per block, approximates observation and entry timing, removes our observed trades, and inserts one hypothetical position. It cannot know how other wallets would respond to different orders. A shorter or longer hold also changes capacity and future opportunities. The paired returns do not include that whole-bot feedback, unobserved sell failures, or a capital deployment decision.

The next comparison should keep the current clock and bailout while testing fixed 1.75 against adaptive take profit in parallel scoring. A separate exit study can compare 45 and 60 seconds, with identical targets and entry rules. Record the signal at decision time and observe every eligible launch through at least 90 seconds. Retain at least five independent days before selecting a replacement. These are proposed observation tests, not changes made by this analysis.

The existing market guards should keep a fixed measuring rule. If a different hold rule later changes the return scale used by the profit-based guard, its pause and resume thresholds need a separate calibration.

**Reproducible files and sources**

The snapshot, production-source archive, fetched logs, complete candidate scores, timings, and sensitivity results are local under `v1/data/exit-policy-audit/`. The protocol records the candidates before path-based selection. The analysis writes the chosen clock to `frozen_clock_selection.json` before rendering its final-period scores.

| Input | SHA-256 |
|---|---|
| snapshot.json.gz | `221d113a7b8a2d0e8ec2337a759978232b2d928eddfd60e34aeb39c5828f5af0` |
| live-source.tar.gz | `94040858b6e837c7535f48dd79bcdbb49b6c6606fc744e492bd5011031fd1630` |
| protocol.md | `7dc8bd2b8fed10ea1b5df9dd6f54384896a49f4aa01eda5ac8b76fec88ef638e` |

Production references: `src/strategy/takeprofit.ts` selects the target. `src/strategy/exit.ts` owns exit priority and the peak-based bailout. `src/strategy/gate.ts` owns the distinct signal cohorts. `scripts/gatewatch.py` computes the replay outcomes at a fixed 0.01 ETH stake.

External context: [Uniswap execution documentation](https://developers.uniswap.org/docs/get-started/concepts/traders/swaps) distinguishes a slippage tolerance from the resulting execution price. [Robinhood's endpoint documentation](https://docs.robinhood.com/chain/connecting/) identifies the public RPC and its rate limits. [Bailey and colleagues](https://www.davidhbailey.com/dhbpapers/overfitting.pdf) explain why trying many backtests weakens an apparent winner; a historical holdout alone does not remove that problem.

The standing instrument is [exit_policy_audit.py](../v1/research/exit_policy_audit.py). Run `PYTHONHASHSEED=0 python3 research/exit_policy_audit.py --chain` from `bot/` to reproduce the main results from the frozen local files. [The protocol](../v1/research/EXIT_POLICY_AUDIT_PROTOCOL.md) records the scope. The raw-data manifest is `v1/data/exit-policy-audit/manifest.json`.
