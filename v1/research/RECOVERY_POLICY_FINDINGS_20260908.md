# False recovery: +2 normal market reopening is the leading research candidate

The bot reopened the normal market pause at +1.393 stakes on 8 September at
12:30:33 London time. Ten reconciled trades lost $105.76 before the market pause
returned at 12:53:03. This was not a DD restart. Three qualifying market updates
would not have prevented the episode from its actual starting halt.

Fourteen fixed policies and explanatory follow-ups tested longer confirmation,
short-window confirmation, dependence on one winner, rolling drawdown limits,
limited DD retries, and smaller restart trades with independently repriced exits.
The leading candidate reopens the normal market pause strictly above +2 while
retaining the -1 pause threshold and the existing separate DD recovery rule.

In the fixed-exit two-week opportunity model, that candidate retained 116.4% of
baseline profit and reduced peak-to-trough drawdown from $494 to $370. It remained
ahead under the timing and trade-return stresses, but the gain ranged from $150
to $2,076 across those assumptions. Nearly all of the main-model benefit came
from the latest week; the earlier week lost $4.52 relative to baseline.

The live episode alone cannot select +2: the sampled reading never exceeded
+1.393, so +1.5 also would have blocked those entries. No prospective test has
established an optimal threshold. The smaller-probe policies tested here rejected
too much modeled profit; this is not a conclusion about all possible sizing rules.

The full current-size recorded comparison covers 169 actual attempts in 22.62
hours. The 14-day model uses reconstructed older signals and fixed 1.75 exits.
Graduated V4 exits, adaptive strategy feedback and counterparty responses remain
incomplete. Its dollar profits are not earnings forecasts. No live setting or
bot runtime source file changed in this research. All 69 research tests pass.

Full report, tables, chart and validation (unavailable historical artifact: `../data/recovery-policy-20260908/report.md`)
and [protocol](RECOVERY_POLICY_PROTOCOL.md). Frozen inputs, source copies, hashes,
per-trade cash and all scenario results remain in the data directory.
