The replay supports investigating late recovery entries. It does not establish that removing the guard is profitable.

The comparison covers **9 September 2026 at 12:02 UTC to 11 September at 12:02 UTC**.
TP selection, creator-tax and exempt-wallet floors, repeat-loss filtering, stake and simultaneous exposure limits stay unchanged.
The market-only variant removes the -1/+2 guard while preserving other stops.
The continuous variant removes all account pauses in simulation, including operator, drawdown and touch stops.
No live settings changed.

Full timeline and tables (unavailable historical artifact: `../data/research/20260911-guard-visual-final/report.md`) · Score passages (unavailable historical artifact: `../data/research/20260911-guard-visual-final/score-passages.png`) · Frozen results (unavailable historical artifact: `../data/research/20260911-guard-visual-final/comparison.json`)

**The rise from -1 to +2**

A passage starts at the last recorded score at or below -1 before the first reading above +2.
A stale reading or a recording gap breaks the passage.
The following period ends at the next reading at or below -1, or when evidence ends.
These are hindsight segments, not an entry rule that knew its starting point in advance.
Returns belong to trades entered during each segment, with costs and their eventual exits included.

- Nine of twelve rising passages contain profitable continuous-trading entries under each of the three tested delay scenarios.
- Eleven following periods reach -1 before the data ends. Eight lose money under central assumptions; six lose money with a 600 ms exit delay.
- Six of those eleven completed pairs show both a profitable rise and a losing following period under central assumptions. Five do with the 600 ms delay.
- Six crossings occur with no recorded account halt remaining. Four of their rises are profitable under all three delay scenarios.
- The other six crossings still have operator, touch and market pauses recorded. Crossing +2 alone could not reopen those accounts.

The 9 September passage ending at 17:46 illustrates the proposed pattern.
Entries during the rise earn a modeled 0.03281 ETH.
Entries after +2, until the following -1 crossing, lose 0.06430 ETH.
The whole pause before that reopening loses 0.08852 ETH in the continuous replay.
The difference matters: the whole pause includes losses before the recovery begins.

That passage's score rises from -1.44583 to +2.17516 stakes.
New scored outcomes contribute 2.34434 stakes, while old losses leaving the window contribute 1.27665 stakes (rounded).
The rolling score therefore is not a cash balance or a direct measure of the profit available during the rise.
Other boundary decompositions can differ from recorded scores because of score availability and cache timing.
The graph and passage boundaries use recorded samples.

**Trading continuously still loses over the full period**

| Policy | Attempts | Net ETH | Cumulative closed-cash drawdown ETH |
| --- | ---: | ---: | ---: |
| Actual account | 95 | -0.20273 | 0.20273 |
| Guarded simulation | 93 | -0.21628 | 0.22173 |
| Market guard removed; other stops retained | 160 | -0.17331 | 0.21740 |
| Continuous simulation; all account pauses removed | 699 | -0.13279 | 0.41251 |

The central continuous model improves net cash by 0.08349 ETH relative to the guarded model.
It also increases cumulative drawdown by 0.19078 ETH.
Its additional trades earn 2.12138 ETH in winning profit and lose 2.08321 ETH on losing attempts.
Changes in template-loss filtering and capacity also displace 0.04533 ETH of guarded-model losses.
The comparison does not attribute every missed trade to the market guard alone.

With 600 ms exits, the guarded model loses 0.15790 ETH and continuous trading loses 0.16342 ETH.
The policy ranking reverses.
The direction of cash during rising passages is more stable in these tests than the full-account ranking.
These scenarios are sensitivity checks, not probabilities or confidence intervals.

Minimum modeled starting funding for continuous trading is 0.34930 ETH before an extra gas reserve.
The simulation retains the 0.08 ETH simultaneous exposure cap but assumes enough funds to continue at the recorded stake.
Epoch resets never erase cumulative losses in this comparison.

**Evidence and verification**

The read-only capture ends at 12:02:14 UTC.
There are no new actual attempts after the preceding 09:29 capture, but market observations continue.
The extension covers 415 launch paths, 415 parameter sets and all 25,651 requested block timestamps, with zero timestamp conflicts.
It adds 157 modeled launch opportunities after the previous capture.
Previously saved outcomes remain bound to their source artifacts.
Actual failed-buy outcomes are independently replayed rather than copied into predicted cash.
All nine full-account runs finish without an unavailable admitted execution.

The unchanged guarded engine reproduces the archived baseline's cash, decisions, actions and unresolved events exactly.
All 170 research tests pass, including nine tests for guard removal and passage boundaries.
The three charts were visually checked.
The report contains the required eight 24-hour bins and seven daily bins.
Earlier bins outside the common simulation window remain unavailable.
Every reported mean includes median, sample standard deviation and count.

The prior execution fidelity benchmark remains failed.
This analysis tests a historical pattern and does not validate a new recovery rule prospectively.
The final six hours did not supply calibration data, and the entire inspected capture remains retrospective.
