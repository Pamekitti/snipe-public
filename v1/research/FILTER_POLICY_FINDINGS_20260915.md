# Filter policy findings, 15 September 2026

The current 50 bps creator-tax floor, three-wallet floor and 60-minute template cooldown remains the only tested policy that passes the frozen replacement rule. Exact zero-tax launches are stronger in the recent era, but they are not a safe static replacement across both eras.

The run reused 27,269 saved book-passing opportunities from 1 September 00:00 UTC through 14 September 19:29:21 UTC. No chain query, live control, restart or capital change occurred.

The account grid ran through the current workspace unified engine, model `07bd38c101f131c70283651f8939421289bbec218963300e1f98bca5c84080be`. The last deployed snapshot recorded before this study is `d58d12d1bc6ae146cbb948f2c4517fd1604416f3fe40ca8421460d52a8da30fc`. This study does not claim the workspace model is deployed.

[Protocol](FILTER_POLICY_PROTOCOL_20260915.md)

Machine-readable results (unavailable historical artifact: `../data/research/20260915-filter-policy-v1/results.json`) | Validation (unavailable historical artifact: `../data/research/20260915-filter-policy-v1/validation.json`)

## Fixed policy

The comparison holds the selected 15/8 market guard, modeled three-stake drawdown stop, adaptive TP, 45-second hold, 0.02 ETH stake, capacity, costs and six execution stresses constant. It varies only the creator-tax floor, exempt-wallet floor and template-loss cooldown.

The primary table uses policy-matched guard evidence. This represents the deployable behavior because each entry policy also defines the shadow outcomes that feed its guard. Values use the central `p50-after` scenario with modeled drawdown protection.

| Entry policy | Sep 1-7 net / DD | Sep 8-14 net / DD | Final 6 h net | Mean / median / sample sd in Sep 8-14 | n |
| --- | ---: | ---: | ---: | --- | ---: |
| Tax at least 0, exemptions at least 3, cooldown 60 m | +1.450 / 0.213 ETH | +0.411 / 0.206 ETH | -0.030 ETH | +0.00054 / -0.00144 / 0.01088 ETH | 757 |
| **Current: tax at least 50, exemptions at least 3, cooldown 60 m** | **+4.402 / 0.129 ETH** | **+1.280 / 0.149 ETH** | **+0.016 ETH** | **+0.00112 / -0.00126 / 0.01049 ETH** | **1,142** |
| Tax at least 100, exemptions at least 3, cooldown 60 m | +4.365 / 0.129 ETH | +1.120 / 0.151 ETH | +0.016 ETH | +0.00105 / -0.00126 / 0.01041 ETH | 1,068 |
| Tax at least 150, exemptions at least 3, cooldown 60 m | +1.068 / 0.064 ETH | +0.105 / 0.118 ETH | -0.028 ETH | +0.00025 / -0.00131 / 0.00830 ETH | 418 |
| Tax at least 200, exemptions at least 3, cooldown 60 m | +0.538 / 0.079 ETH | +0.049 / 0.114 ETH | -0.012 ETH | +0.00014 / -0.00128 / 0.00770 ETH | 340 |
| Exact zero tax, exemptions at least 3, cooldown 60 m | +1.278 / 0.346 ETH | +2.382 / 0.198 ETH | +0.132 ETH | +0.00251 / +0.00079 / 0.01164 ETH | 949 |

Minimum tax zero admits every tax from zero through 200 bps. It does not isolate zero-tax launches. The exact zero-tax diagnostic contains 15,017 saved opportunities.

## What each filter contributes

The 60-minute template cooldown is supported. Removing it from the current tax and exemption policy changes central second-era net from +1.280 to +0.482 ETH. Drawdown rises from 0.149 to 0.234 ETH. The final six hours change from +0.016 to -0.069 ETH.

The three-wallet floor is supported in the recent era. Lowering it to one wallet while keeping tax 50 and the cooldown raises first-era net from +4.402 to +4.692 ETH. Second-era net falls from +1.280 to +0.392 ETH, and the final six hours fall from +0.016 to -0.031 ETH.

Raising the tax floor to 100 changes little because few launches have tax between 50 and 99 bps. It loses profit and adds one worst-case losing recovery in the second era. Floors of 150 and 200 reduce some central drawdown but give up most profit and lose in the final six hours.

Exact zero-tax is the strongest recent cohort when it supplies its own guard evidence. Across all six stresses, its second-era net is at least +1.902 ETH and its final-six-hour net is at least +0.118 ETH. Its first-era net is only +0.790 ETH at worst, compared with +4.000 ETH for the current policy. Its first-era drawdown reaches 0.346 ETH, compared with 0.135 ETH.

## Fixed-sensor isolation

Holding the current guard decision schedule fixed makes the one-wallet and 100 bps variants look slightly better in central profit. Neither survives the full risk and six-stress requirements.

| Fixed-sensor candidate | Sep 1-7 worst net / DD | Sep 8-14 worst net / DD | Final 6 h worst net |
| --- | ---: | ---: | ---: |
| Current policy | +4.000 / 0.135 ETH | +0.860 / 0.290 ETH | +0.009 ETH |
| Tax 50, one wallet, cooldown 60 m | +4.057 / 0.131 ETH | +1.011 / 0.301 ETH | +0.003 ETH |
| Tax 100, one wallet, cooldown 60 m | +4.046 / 0.131 ETH | +1.031 / 0.199 ETH | +0.003 ETH |

The one-wallet candidates increase recovery losses or losing recoveries and underperform in the reserved final six hours. Their policy-matched versions also lose most of the second-era profit. They are not replacements.

Exact zero-tax behaves differently between views. With the current guard schedule fixed, its final six hours lose at least 0.040 ETH. With its own policy-matched signal, they earn at least 0.118 ETH. The recent result therefore comes from the zero-tax cohort and its matching guard behavior together. It is not an entry-filter effect alone.

## Decision

No new policy passes. The current filter is retained for the tested static strategy.

Exact zero-tax deserves a separate shadow account with its own frozen guard evidence. It should not replace or mix into the current policy. Future evaluation needs at least five complete days after the policy lock, full publication coverage and actual execution accuracy. Historical simulation remains diagnostic because the existing fidelity gate failed.

## Verification

- Twenty minimum-filter policies and one exact zero-tax diagnostic completed in both views.
- Every candidate completed six execution stresses, both eras and the final six-hour check.
- The current-policy output matches the saved September 14 account details exactly.
- A repeated pilot candidate produced identical account and guard results.
- All financial outputs match the earlier frozen reducer exactly after rebinding to the current workspace unified engine.
- The fixed-sensor and policy-matched current-policy results are identical, apart from the derived configuration identifier.
- No unavailable result became zero profit.
