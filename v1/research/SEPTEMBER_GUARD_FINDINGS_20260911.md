# September guard results

Keep `matched20` as the research baseline. Fresh recovery is the strongest follow-up
candidate, but it increases repeated-recovery losses. None of the selected family
representatives passed the frozen higher-profit and no-worse-risk criteria across
all six main execution scenarios in the later assessment period.

The sweep tested 59 settings across 15 guard families. Three controls, nine scenarios
and 11 complete intervals produced 6,138 account comparisons. Adaptive TP and the
adaptive shadow information source remained common. The drawdown stop and its recovery
rule remained unchanged. Only earned exposure changed stake, using separately priced
quarter and half stakes.

The period is September 1 00:00 through September 11 12:44 UTC. This is the earlier
frozen capture, not a live feed. September 1-7 selected one setting per family;
September 8 onward assessed those settings. The final six hours stayed outside
selection. All dates remain retrospective because the history had already been inspected.

## Fresh recovery captures more of both sides

The selected fresh rule restarts when the latest eight available shadow outcomes sum
to more than one stake. It pauses when the 20-outcome indicator falls below minus one.
It needs new evidence to restart and retains the shared freshness requirement.

| Central September comparison | Adaptive baseline | Fresh recovery |
|---|---:|---:|
| Winning trades retained | 47.3% | 53.3% |
| Losing trades retained | 40.1% | 47.2% |
| Winning money retained | 49.8% | 55.7% |
| Losing money retained | 39.3% | 46.1% |
| Modeled net ETH | +2.7058 | +2.8118 |
| Conditional cumulative drawdown ETH | 0.1351 | 0.1375 |
| Worst individual interval drawdown ETH | 0.0894 | 0.1375 |
| Losing recovery episodes | 18 | 21 |
| Losses in losing recovery episodes ETH | 0.2570 | 0.3906 |

Every retention percentage uses the same-period always-on denominator. Money is ETH,
including modeled execution costs. The fresh rule improved whole-period net in all
nine scenarios. It improved later-assessment net in four of six main scenarios, but
lost that advantage under slow sells. Recovery losses rose in every scenario.

My initial trailing-curve preference did not win. Its selected version earned
+2.4196 ETH with 0.2124 ETH conditional drawdown. Entry permits and recovery exhaustion
missed much of the profitable period. Earned exposure reduced loss money but also cut
winning money retention to 24.2%, against 49.8% for the baseline.

## Evidence limits and artifacts

Ten unsupported graduated exits require separate accounts around coverage boundaries.
The comparison omits 63 minutes of admission time. Concatenated cash retains losses,
but cross-boundary account state is not continuous. The common strict prefix ends on
September 2 at 21:44 UTC. Full target-history data starts on September 5; earlier TP
selection falls back to 1.75. The actual-cash fidelity check remains diagnostic.

All 209 research tests pass. Independent checks cover 680,980 simulated admissions,
109,459 guard transitions and 120 exact matches against prior baseline cash.
The first attempted sweep was invalidated for intrabatch peak artifacts before
aggregate candidate results were inspected. The corrected study observes publication
batches atomically. A later checkpoint list/tuple normalization changed no policy behavior.

Outputs are under `v1/data/research/20260911-september-guards-v2/`:

- `report.md`: each family's behavior, tradeoffs and later-period results.
- `scorecards.json`: all settings, four KPIs, exact cash, means with median/SD/count,
  September daily bins and standard 24-hour/7-day bins.
- `september-lines-kpis.png`, `family-kpis.png`, `all-family-lines.png` and
  `settings-sensitivity.png`: visually verified charts.
- `explore-all-settings.html`: self-contained interactive comparison. Browser security
  blocked local HTML preview verification; the static charts are the verified view.
- `design.json`, `selection.json`, `strict-prefix.json`, `independent-verification.json`
  and `verification.json`: definitions, selection boundary and checks.

No live code, configuration or activation changed. See the research README for commands.
