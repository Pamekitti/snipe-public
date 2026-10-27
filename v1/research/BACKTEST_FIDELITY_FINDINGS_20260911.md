# Backtest validation, 11 September 2026

The standardized benchmark is implemented. The current simulator does not pass its accuracy checks.
Use [BACKTEST_STANDARD.md](BACKTEST_STANDARD.md) for future runs.

The frozen comparison covers **8 September 2026 13:42 UTC to 11 September 2026 09:29 UTC**.
It contains 190 actual attempts, including four failed buys.
This is a captured historical dataset, not a continuously updating feed.
The final six hours contain nine attempts and remain excluded from calibration.
All this data had already been inspected, so the reserved period is retrospective too.

| Cash measure | Actual account | Predicted execution of the same 190 intents | Independent account replay |
| --- | ---: | ---: | ---: |
| Winning profit, ETH | 0.601351 | 0.513523 | 0.320974 |
| Losing loss, ETH | 0.750049 | 0.792231 | 0.477636 |
| Net, ETH | -0.148698 | -0.278708 | -0.156662 |
| Cumulative closed-cash drawdown, ETH | 0.221961 | 0.285847 | 0.163771 |
| Attempts | 190 | 190 | 109 |

Profit and loss include costs. The middle column fixes recorded entry intent and target.
It predicts fills, exits and costs independently of actual cash.
The final column also simulates which opportunities the policy enters.
It matches 82 of the 190 actual entries and adds 27 other entries.
Its similar net loss therefore does not establish realistic behavior.

The per-attempt absolute error averages 9.9319 percentage points of stake.
The median is 1.0761 points, sample standard deviation 20.6926 points, and count 190.
The simulator gets the profit/loss sign right on 165 of 190 attempts.
It independently predicts none of the four actual failed buys as failures.

Actual-fill exit reasons agree on 154 of 186 completed trades.
Exit timing evidence covers 165 of 186 trades.
Absolute timing error averages 2,309.78 ms, with median 37 ms, sample standard deviation 7,577.62 ms and count 165.
Its 95th percentile is 25,015 ms.

The transaction reconstruction still matches all 19,811 checked transactions exactly.
Receipt accounting reconciles all 190 attempts.
A wallet residual of 0.000005698463162793 ETH remains unexplained.
The shared account engine reproduces the saved baseline's cash, decisions, actions and unresolved events exactly.
These checks establish arithmetic and accounting evidence, but do not resolve the prediction errors.

The version 1 scorecard passes 18 of 57 checks.
Its limits were introduced after this capture was inspected.
The result is **diagnostic only**, with no prospective validation or live-change authorization.
No live settings or services were changed.

The full scorecard (unavailable historical artifact: `../data/research/20260911-backtest-standard-verified/report.md`) includes the required eight 24-hour bins and seven daily bins.
Earlier daily bins outside the recorded policy era remain unavailable.
The machine-readable artifact (unavailable historical artifact: `../data/research/20260911-backtest-standard-verified/fidelity.json`) contains individual predictions, admission differences and source hashes.
The research suite passes all 161 tests, including 13 tests for the new accuracy checks.

Future simulator work must address entry decisions, execution timing and failed transactions before strategy rankings can be trusted.
The historical data lacks exact feed-arrival and within-block inclusion timing.
New timestamped predictions and execution observations are needed to test those gaps prospectively.
