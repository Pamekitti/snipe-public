# Sell execution and receipt completion are different clocks

The sell-inclusion correction is a research candidate. It reduced false winners in
the supported later cohort, but has not passed the simulation fidelity standard.
No production model, simulator default or live trading control changed.

The frozen capture ends September 13, 2026 at 15:30 UTC (16:30 London). The
investigation retains all 1,190 attempts, with 1,182 receipt-matched cash labels.
Preceding measured sell clocks support only 280 attempts, all September 8 onward.
There is no supported preceding-clock comparison for the profitable earlier period.

The existing full-period reference assumes a 1,200 ms sell execution delay.
Recorded trigger-to-close delays include confirmation wait. The tested correction
instead bounds inclusion using the verified sell block's one-second timestamp:

```text
lower    = max(0, block timestamp - exit trigger)
upper    = min(block timestamp + 1 second - exit trigger,
               recorded close - exit trigger)
midpoint = (lower + upper) / 2
```

Each prediction uses the median from the latest 100 eligible preceding samples,
requires at least 20, and excludes samples completed or durably available within
six hours of entry. Current-attempt fills and cash remain comparison labels.
The midpoint and both ordering stresses were frozen before scoring.

| Same 280 attempts | Net ETH | Simulated winners that actually lost |
|---|---:|---:|
| Actual cash | -0.399894 | Unavailable |
| Fixed reference, after ordering | -0.385704 | 8 |
| Inclusion midpoint, before ordering | -0.404656 | 5 |
| Inclusion midpoint, after ordering | -0.410598 | 6 |

The final 32 actual trades lost 0.138493 ETH. Midpoint simulations lost about
0.1243 ETH, so recent loss understatement remains. Per-trade absolute errors also
remain above the standard's mean-error limit. A close ending balance is insufficient.

Separate tests of preceding adoption and recorded-close delays did not consistently
improve accuracy. Cost discrepancies account for at most 0.62% of the absolute cash
gap among the full-history reference's 26 false winners. A blanket gas or loss
offset would not address the main execution differences.

The historical `burned_gas_wei` fields are NULL on all matched attempts. Retry
counts remain unknown; NULL must not be treated as evidence of zero failures.

The 294 research tests and 1,122 exact baseline parity checks passed. The shared
engine hash remains
`a786d53c6a59dad0060d983bb91a4f1d805d2f056849b948618084f655fdabad`.
No prospective observations were scored for this correction. Existing live-shadow
certification and whole-account fidelity are not renewed by this test.

The full report (unavailable historical artifact: `../data/research/20260913-execution-discrepancies-v1/report.md`)
contains the line charts, reproduction KPIs, chronological comparisons, error
distributions, individual timelines and reproduction commands.
The sell-clock freeze (unavailable historical artifact: `../data/research/20260913-sell-clock-v1/freeze.json`)
binds inputs, candidate definitions, source and model identity.

Keep this finding separate from the
[full-period error profile](SIMULATION_ERROR_PROFILE_20260913.md). The two studies
have different comparison populations and do not establish future error bounds.
