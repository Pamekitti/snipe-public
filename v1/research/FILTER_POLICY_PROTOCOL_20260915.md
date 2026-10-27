# Filter policy comparison, 15 September 2026

Use the saved September execution outcomes to test entry filters without changing live behavior. The comparison covers 1 September 00:00 UTC through 14 September 19:29:21 UTC. It requires no new chain query.

## Fixed behavior

- Current workspace unified filter, account and guard engine. Its model identity is recorded with the run.
- Captured opportunity outcomes from the September 14 focused run. Their source model identity remains recorded separately.
- Fixed 0.02 ETH modeled stake. This preserves the saved integer execution results and is not scaled to the current live stake.
- Adaptive TP with a 20-outcome memory and the saved target chosen at each entry.
- Maximum hold of 45 seconds, dead-coin bailout, hard stop and graduation handling.
- Six execution stresses crossing 600, 1,200 and 2,000 ms sell delays with before and after same-time ordering.
- Selected 15/8 market guard: pause below -1.5 stakes and recover when the fresh eight exceed +1 stake. Evidence must be complete and no older than 180 minutes.
- Three-stake modeled drawdown stop, flat-position recovery, 20 post-halt outcomes above +1 stake and at most two lifts per UTC day.
- Bankroll, capacity, publication timing and account state across the 8 September boundary.

## Filter candidates

The main grid contains 20 policies:

| Filter | Values |
| --- | --- |
| Minimum creator tax | 0, 50, 100, 150 or 200 bps |
| Minimum exempt wallets | 1 or 3 |
| Template-loss cooldown | 0 or 60 minutes |

An additional diagnostic trades only launches with exactly zero creator tax, at least three exempt wallets and the 60-minute template cooldown. The exact cohort prevents a minimum-zero policy from being mistaken for a zero-tax-only policy.

No name, symbol, social-link, dev-buy, repeat-deployer, TP, hold or guard threshold search is included.

## Two views

The fixed-sensor view derives market-guard decisions from the current 50 bps, three-wallet and 60-minute policy. Every candidate receives that same decision schedule. Only account admission changes.

The policy-matched view derives the 15/8 guard tape from each candidate's own admitted shadow outcomes. Guard thresholds stay fixed, but the evidence population follows the deployable filter policy.

Both views use the same candidate account rules and drawdown model. Results from one view cannot substitute for the other.

## Time split and acceptance

Report 1 to 7 September and 8 to 14 September separately. State carries across the boundary, while displayed period P&L restarts at zero. The final six hours end at the frozen cutoff and are excluded from candidate ranking.

The final six hours have already been inspected in earlier work. They are a reserved consistency check, not untouched validation.

A replacement must beat the current filter in both eras under all six execution stresses. It must not increase drawdown, recovery loss or losing-recovery count in either era. The final six hours must not reverse the comparison. Missing or unresolved outcomes make the affected account unavailable.

No historical result authorizes live trading. A candidate that passes this comparison remains shadow-only until a frozen policy completes prospective validation and actual execution accuracy passes.

The saved outcomes predate the unified storage layer. The execution math, account reducer, entry filter and guard behavior must match the current source. Any behavioral difference invalidates reuse. Additive bundle-compaction code is acceptable only when the current engine reproduces every financial result.

The current workspace model identity and the last deployed snapshot identity are distinct claims. This research records both and does not claim that the workspace build is deployed.

## Outputs

Save the candidate catalog, input and source hashes, both account views, time-bin statistics, validation identities and findings under `data/research/20260915-filter-policy-v1/`. Report every mean with its median, sample standard deviation and count.
