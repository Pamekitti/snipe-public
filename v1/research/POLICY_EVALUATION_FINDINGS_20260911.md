None of the tested changes clears the frozen acceptance rule. The creator-tax floor excludes profitable opportunities. The repeat-loss pause has support. Stale reopening remains a source of losses.

The subsequent [actual-versus-simulated cash benchmark](BACKTEST_FIDELITY_FINDINGS_20260911.md) fails the simulation accuracy checks. The hypothetical filter and policy results below remain diagnostic. They do not establish executable profit or support a live change.

The evaluation covers the recorded +2 policy era from 8 September at 13:42 UTC through the capture on 11 September at 09:29 UTC. The final six hours were excluded from fitting. All results are retrospective. No live code, settings, stops or capital changed.

Full report, required time bins and comparison tables (unavailable historical artifact: `../data/research/20260911-policy-evaluation/report.md`) · [Frozen protocol](POLICY_EVALUATION_PROTOCOL.md)

**Losses and recoveries**

Actual cash lost 0.14870 ETH across 186 completed trades and four failed attempts. Cumulative closed-cash drawdown reached 0.22196 ETH across five accounting resets. Seven of nine automatic market-recovery episodes lost money. The three stale reopenings booked a combined loss of 0.03188 ETH.

Old losses leaving the rolling window contributed to score recoveries. They did not create new profitable launches. The report separates those changes from added outcomes, drawdown resets and operator resumes.

**Filters**

These are individual hypothetical opportunities with the other entry filters held fixed. They do not represent achievable account profit. Return percentages use the actual 0.02 ETH stake. Each statistical cell gives mean / median / sample standard deviation / count.

| Group | Return %: mean / median / sd / n | Verdict |
| --- | --- | --- |
| Admitted control group | −3.3482 / −7.6820 / 45.0613 / 1,319 | The admitted population is not profitable in this sample. |
| Rejected by the 0.5% creator-tax floor | +6.7949 / −1.4247 / 56.1205 / 2,727 | Profitable opportunities were excluded. The floor is not vindicated. |
| Rejected for fewer than three exempt wallets | −1.2037 / −6.2553 / 27.9478 / 361 | No profitable rejected group is established. Removing the floor remains unvalidated. |
| Rejected after a recent loss on the same template | −12.6399 / −14.9586 / 31.8312 / 76 | The pause rejects a worse group. Removing it also worsens modeled account results. |

The low-tax group earned a hypothetical 3.70591 ETH over the era, but lost 0.08418 ETH in the last 24 hours and 0.22603 ETH in the reserved six hours. Its positive era total does not establish a current trading opportunity. The tests do not evaluate the hard tax ceiling, zero-exemption launches or static template screening.

**Profit exits**

All seven fixed targets and the adaptive selector lost money across the same 1,395 priced opportunities. Fixed targets 1.75, 2 and 3 improved the unconstrained opportunity total relative to adaptive. Targets 1.25, 1.36, 1.5 and 2.5 did not.

No fully priced fixed target improved the constrained account result. The 3× account path becomes unavailable at a graduated-pool exit. Adaptive is therefore not proven optimal, but switching to a fixed target is not supported by the account comparison.

One of 27 actual take-profit exits booked a loss. Across the modeled opportunities, four of 197 take-profit exits booked a loss. Executable proceeds sometimes exceeded the trigger mark, so the evidence does not support treating every delayed exit as lost profit.

**Recovery rules**

The modeled −1/+2 baseline lost 0.16958 ETH, with 0.17669 ETH cumulative drawdown. These hypothetical amounts are separate from actual cash.

| Change | Difference from modeled baseline | Verdict |
| --- | --- | --- |
| Recover at +1 | +0.06373 ETH | Fails risk requirement: losing recoveries rise from 9 to 12, and their combined losses rise from 0.20450 to 0.23942 ETH. |
| Keep an existing pause while stale | +0.01155 ETH | Avoids 0.01501 ETH of losses and misses 0.00345 ETH of profit. All benefit is in the reserved six hours; there is no fit-period profit gain. |
| Positive recent direction | No account change | No demonstrated incremental benefit. |
| Gains without the largest winner | No account change | No demonstrated incremental benefit. |
| Buyer-participation overlay | −0.02816 ETH | Lower profit and higher drawdown. |
| Staged smaller entries | Unavailable | The first differently sized recorded failed buy has no established executable outcome. |

**What remains unresolved**

Relaxing either entry floor reaches a graduated-pool exit at 15:40 UTC on 8 September. Its counterfactual pool execution is unproved. Staged entries become unavailable at 04:14 UTC on 9 September. These paths stop at the missing outcome. Their cash comparisons truncate both sides at the same time.

The recorded-fill permission check differs from actual cash by 0.01074 ETH because reconstructed touch-gate timing rejects two actual trades. Subsecond feed arrival and inclusion times remain unavailable. The full report quantifies replay error and the 0.000005698463 ETH wallet-to-book residual.

Verification reconciled all 190 attempts from 566 receipts and matched all 19,811 checked transactions. The laptop curve validator passed 99,080 arithmetic checks and 409 tax checks. Bot tests passed 704/704. Research tests passed 148/148. The report passed 47 accounting identities and 130 additional coverage, time-bin and provenance checks. New observations are required before any prospective validation claim.
