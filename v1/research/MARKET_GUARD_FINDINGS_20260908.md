# Market guard research, 8 September 2026

Two or three distinct positive recovery updates are the most useful candidates for a further test. No tested policy has enough evidence for a live recommendation.

The audit tested **207 policies** on **155 completed trades and four failed buys** at 0.02 ETH. The continuous stake period runs from 7 September 13:55 UTC to 8 September 06:39 UTC, or 16.7 hours. All 159 attempts have booked receipts. Dollar figures use the frozen ETH price of $2,466.

Conditional profit, drawdown and missing-fill sensitivity for the current rule and four alternatives (unavailable historical artifact: `../data/market-guard-audit-20260908/comparison.png`)

The current rule uses the sum of the last 20 eligible observer outcomes. It pauses below −1 stake and resumes above +1. A persistence candidate keeps those thresholds and waits for two, three or five distinct window updates above +1. Each update incorporates a newly scored launch. A dip to +1 or below resets the count. Repeated timer polls do not count. Pausing remains immediate.

| Policy | Full-period net ETH | Illustrative dollars | Largest loss from a peak | Last six hours | Trades retained |
|---|---:|---:|---:|---:|---:|
| Current rule | +0.234439 | $+578 | $170 | $-94 | 155/155 |
| 10-launch window | +0.264044 | $+651 | $123 | $-72 | 136/155 |
| 2 positive updates | +0.257478 | $+635 | $137 | $-80 | 150/155 |
| 3 positive updates | +0.274915 | $+678 | $99 | $-37 | 139/155 |
| 5 positive updates | +0.281897 | $+695 | $99 | $-15 | 136/155 |

These cash comparisons retain or remove trades that actually occurred. They cannot establish the profit of trades the live bot skipped. The current-rule simulation retained every recorded attempt and reconciles to the wallet over this period. It is a comparator applied from a common starting point, not a recreation of every process restart or manual stop.

The 10-launch candidate pauses below −1 and resumes above zero. It was selected using only the earlier 10.7 hours, before the final six-hour check. Ten-launch selection improved full-period profit by $+73, but failed the conservative missing-fill scenario. It is not the recommended candidate.

Within the persistence family, two and three updates tied on earlier-period profit. The declared simplicity tie-break selected two. Two updates avoided five recorded losing trades and gave up no recorded winners. Three updates looked better on the later data, so it remains an exploratory challenger. Five updates looked best in the displayed recorded-trade comparison, but missed profitable opportunities when hypothetical fills were included.

| Recovery rule | Recorded gross losses avoided | Recorded gross winning profit forgone | Net difference |
|---|---:|---:|---:|
| 2 positive updates | $57 | $0 | $+57 |
| 3 positive updates | $147 | $47 | $+100 |
| 5 positive updates | $169 | $52 | $+117 |

The comparisons keep stake, exits, capacity and the 0.06 ETH drawdown limit fixed. A larger day-level loss is possible after an automatic drawdown recovery resets the accounting peak. No code or settings were deployed.

## Later-period checks

The final six hours were excluded from fitting. They had already been inspected in the prior conversation, so this is a recency check, not an untouched holdout. The 207-way search also creates selection bias.

| Fit through, UTC | Policy selected then | Profit in next three hours | Current rule | Difference |
|---|---|---:|---:|---:|
| 19:55 | 2 positive updates | $+169 | $+169 | $+0 |
| 22:55 | 10-launch window | $-9 | $+1 | $-9 |
| 01:55 | 2 positive updates | $-86 | $-99 | $+13 |

The chronological selection procedure gained only $+4 over the current rule across three disjoint three-hour evaluations. One period improved, one tied and one worsened. This is too little independent evidence to call any threshold optimal.

## Timing and missed opportunities

The two- and three-update candidates stayed ahead with one- and three-minute observation delays. They also stayed ahead with ten- and twenty-second clock shifts and at most one confirmation per timer interval. A fixed five-percentage-point reduction in every observer outcome reversed their advantage. Across a 20-launch window that perturbation moves the signal by one stake. It is a sensitivity assumption, not a measured error correction.

| Policy | Extra net ETH with −20 pp missed-fill returns | With unchanged replay returns | With +20 pp returns |
|---|---:|---:|---:|
| 10-launch window | -0.169565 | +0.068913 | +0.276913 |
| 2 positive updates | +0.012968 | +0.016968 | +0.087909 |
| 3 positive updates | +0.018031 | +0.033345 | +0.105345 |
| 5 positive updates | +0.010931 | -0.040469 | -0.037754 |

The sensitivity prices 119 originally halt-rejected launches; three more lack a usable outcome. The exit target is selected using observations available at each decision. A 45-second assumed holding period is tested against 20 and 90 seconds. Fitting-period measured gas is charged. Other path-dependent entry rules are not reconstructed.

The observer replays a 0.01 ETH stake, while the live stake is 0.02 ETH. These synthetic fills cannot establish attainable cash profit. Removing the market pause wins under optimistic assumed fills and loses under conservative ones. That wide spread is the reason it is unsuitable for selection.

The 10-launch fitting winner goes from an advantage to a loss of $-418 relative to the current rule in the conservative scenario. Two and three recovery updates stay ahead in all three missing-fill scenarios. Five updates falls behind in two of the three.

## Candidate to carry forward

Keep the 20-launch window and immediate pause below −1. Test a requirement for **two distinct window updates above +1 before resuming**, with a reset on any reading at or below +1 or any stale reading. Keep three updates as the named challenger. The fitting-period tie-break chose two; choosing three from its better recent result would use hindsight.

Compare both on at least five additional independent days before revisiting live settings. Freeze the definitions above. Count skipped winners as well as avoided losses, price hypothetical entries at the real 0.02 ETH stake, and require a net-profit improvement with no worse drawdown in later periods. No ongoing monitor or scheduled task was created.

Time-only cooldowns, delayed pausing and stale-data alternatives did not provide a fitting-period advantage over current settings. Stronger drawdown-restart requirements tied before the final six hours, so their apparent overnight benefit has no earlier-period support in this sample.

## Verification and limitations

- All 3,535 recorded market samples match a causally available window within the normal 30-second refresh interval. Of these, 3,451 match the latest window exactly.
- The actual 06:17 drawdown recovery is reproduced within six seconds, with the same +0.25-stake evidence.
- The extended baseline matches the established guard simulator cash flow exactly. Its initial drawdown gap was zero at the current-size seam.
- The shared wallet helper now rejects historical flat labels contradicted by repaired holding intervals. This prevents deployed principal from being assigned as another trade’s gas. The net wallet residual over this era is −0.000004661 ETH.
- The four displayed candidates preserve the largest winning trade. Their full-period advantage also remains when that trade is removed from both comparisons.
- The strict post-22:34 deployment subset is reported in results.json; comparison state is carried into it.
- Final receipt corrections are charged at the recorded exit time. Historical correction arrival, operator stops, template-loss changes, quote guards on new hypothetical entries, and other traders’ responses are not fully reconstructed.
- Thirty-three focused tests pass, including stale readings, distinct updates, exact thresholds, capacity, open exits during a stop, post-stop evidence, midnight restart budgets and the repaired-holding accounting regression.

## Spread and required time windows

The following tables show sample standard deviation. An unavailable bin predates this continuous stake era. A partial bin uses only the part within the era. Failed-buy costs are included in time-bin cash; the trade-return table excludes failed buys.

| Policy | Mean trade return | Median | Sample sd | n |
|---|---:|---:|---:|---:|
| Current rule | 7.57% | -4.54% | 67.84% | 155 |
| 10-launch window | 9.71% | -4.23% | 68.98% | 136 |
| 2 positive updates | 8.59% | -4.34% | 68.70% | 150 |
| 3 positive updates | 9.89% | -4.12% | 70.68% | 139 |
| 5 positive updates | 10.37% | -3.94% | 71.34% | 136 |

**24h, ending at the frozen snapshot. All values in ETH.**

| UTC interval | Coverage | Net | Mean | Median | Sample sd | n |
|---|---|---:|---:|---:|---:|---:|
| 2026-09-07 06:39 to 2026-09-07 09:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-07 09:39 to 2026-09-07 12:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-07 12:39 to 2026-09-07 15:39 | partial | 0.032577 | 0.001018 | -0.000836 | 0.009848 | 32 |
| 2026-09-07 15:39 to 2026-09-07 18:39 | current-era | 0.160194 | 0.006161 | -0.001281 | 0.026083 | 26 |
| 2026-09-07 18:39 to 2026-09-07 21:39 | current-era | 0.080375 | 0.001276 | -0.000652 | 0.010050 | 63 |
| 2026-09-07 21:39 to 2026-09-08 00:39 | current-era | -0.000725 | -0.000036 | -0.000536 | 0.006069 | 20 |
| 2026-09-08 00:39 to 2026-09-08 03:39 | current-era | -0.017437 | -0.001453 | -0.001354 | 0.006210 | 12 |
| 2026-09-08 03:39 to 2026-09-08 06:39 | current-era | -0.020544 | -0.003424 | -0.004907 | 0.004055 | 6 |

**7d, ending at the frozen snapshot. All values in ETH.**

| UTC interval | Coverage | Net | Mean | Median | Sample sd | n |
|---|---|---:|---:|---:|---:|---:|
| 2026-09-01 06:39 to 2026-09-02 06:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-02 06:39 to 2026-09-03 06:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-03 06:39 to 2026-09-04 06:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-04 06:39 to 2026-09-05 06:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-05 06:39 to 2026-09-06 06:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-06 06:39 to 2026-09-07 06:39 | Unavailable | unavailable | unavailable | unavailable | unavailable | 0 |
| 2026-09-07 06:39 to 2026-09-08 06:39 | partial | 0.234439 | 0.001474 | -0.000872 | 0.013397 | 159 |

Matched fitting-period observer-minus-real return error was −5.55 percentage points (median −0.74, sample sd 38.47, n=138). In the recency period it was −4.94 points (median −1.78, sample sd 8.27, n=17). The observer was pessimistic in this sample; an old blanket claim of twofold optimism is not a current calibration.

## Reproduction

```bash
python3 -m unittest discover -s bot/research -p "test*guard_audit.py"
PYTHONHASHSEED=0 python3 v1/research/market_guard_audit.py \
  --snapshot v1/data/market-guard-audit-20260908/snapshot.json.gz \
  --out v1/data/market-guard-audit-20260908/results.json
python3 v1/data/market-guard-audit-20260908/render_report.py
```

Snapshot SHA-256: `de5f71e88d1a7357e90c992dc6cafe7feabbff1a93e9e47aad56921e4e4a892f`.

The candidate grid, rules and validation boundaries are in [MARKET_GUARD_PROTOCOL.md](MARKET_GUARD_PROTOCOL.md). Full results, the frozen fitting selection, every candidate score and the missing-fill scenarios are in `v1/data/market-guard-audit-20260908/`.
