# Indicator policy experiment, 11 September 2026

Compare causal indicators with subsequent executable returns, holding production TP,
entry filters and account stops fixed. Research only. No live changes are authorized.

## Fixed design

The original 48-hour capture and all previously inspected observations are retrospective.
A fresh read-only capture supplies the endpoint. Reserve its final six hours from
selection and cost fitting. This is a reserved retrospective check, not prospective
validation. Report the last 24 hours in eight bins and seven days in seven bins;
current-era or execution gaps remain unavailable. Keep a common complete 48-hour
account interval where possible and report the exact boundary.

Keep the actual adaptive TP chosen at entry. Signal returns use independent execution
predictions at the historical stake, including gas. Each result enters the indicator
only after both its modeled close and recorded observation publication, plus one
millisecond. Do not backdate scores, count pending results as zero, or substitute
actual cash for predictions. Use the always-running continuous simulation's filter
and template-cooldown admissions as a common shadow population. It has the same
capacity limit as the baseline, but no account stops. Signal construction cannot
inspect the future return when deciding whether an opportunity enters that population.

Compare these mechanisms individually before interpreting a combination:

1. Existing fixed-1.75, 20-launch, -1/+2 guard, with every other stop retained.
2. Retain an existing pause while its window is stale.
3. Fixed-1.75 windows of 10 and 40, with stop/reopen thresholds scaled per launch
   (-0.05/+0.10 stakes per launch). Keep the touch and DD windows at their baseline size.
4. Strategy-matched 20-result signal, first with the same per-launch thresholds,
   then with a zero-profit boundary. The latter changes the decision rule separately.
5. Exponential weighting of the native fixed-1.75 outcomes, with the original per-launch
   thresholds, to isolate smoothing from strategy matching.
6. Strategy-matched exponential weighting with those thresholds.
7. Strategy-matched recent profitability above zero.
8. Require improving direction only when reopening the recent-profit guard.
9. Also retreat when recent profitability falls below the slower estimate.
10. Staged exposure on the recent-profit rule, with and without a shared probe-loss budget.

Exponential weights halve every six newer outcomes and every 30 minutes of launch age.
The slower context halves every 20 outcomes and every 90 minutes. Use only the last
three hours, require six available results and effective sample size of at least four,
and require the newest underlying launch to be at most 30 minutes old. Publish unknown
when evidence fails those checks. No freshness recovery may reopen a paused candidate.
Use at most the last 200 outcomes for computation. Missing executions remain explicit.
Sensitivity halves/doubles the fast outcome half-life (3 and 12), without selecting
the better value. Every summary mean includes median, sample SD and n.

Staging begins at one quarter of normal size with one position at a time. Three closed
probe trades with positive aggregate net cash permit half size; another three positive
aggregate closes permit normal size. The current recent-profit signal must still allow
entry. A market stop resets the stage, but never resets the optional cumulative gross
probe-loss allowance of one normal stake. Reserve each probe's full stake and estimated
gas against remaining allowance before admitting it. Smaller stakes must be replayed
through production curve math for every execution-delay scenario, never scaled from
full-size cash. Compare staging alone and staging plus allowance after the signal-only
results are available. Do not treat that combination as selected or validated.

## Timing and acceptance

Use the inherited causal cost/timing model and independent actual-intent predictions.
Compare central execution with 600 ms and 1,200 ms sell delays. Freeze the central
signal tape across these scenarios so execution stress cannot give the indicator
advance knowledge of its own favorable execution assumption. Separately delay signal
publication by 60 seconds. Explain coverage and the inherited fidelity failure.

Measure future five-opportunity cohorts from disjoint 15-minute decision anchors.
Require entry strictly after the anchor and complete closes inside the scoring partition.
Report overlapping outcome membership explicitly; repeated anchors are not independent
samples. Also report non-overlapping fixed 15-minute future entry cohorts and the net
return after each candidate reopening, with every account stop retained in account runs.
Never select a signal because it merely correlates with preceding wallet gains.

Compare fit, reserved and full-period cash, winning profit, losing loss, cumulative
closed-cash drawdown, and losing recovery episodes. All epoch resets preserve cumulative
cash. A candidate must improve net cash without worse drawdown or recovery loss/count
in each partition and across execution stresses. Flat/no-trade candidates cannot qualify
as evidence of profitable recovery capture. Ranking must survive modest signal timing
and half-life changes. The prior failed realism certificate prevents a live-profitability
claim regardless of a candidate's diagnostic ranking.

Outputs: reproducible source and input hashes, JSON scorecards, full findings, aligned
24-hour and 48-hour charts of account P&L, indicators, evidence age/count and admission
states; separate profit-captured/missed/loss-avoided comparisons. Include every tested
candidate, not only the highest historical return.

## Attribution controls added before inspecting candidate results

The user's follow-up asks whether the sensor's different coins and fixed TP misrepresent
the configured strategy. Add a native-20 control with the candidate publication/freshness
semantics. Add independent fixed-1.75 execution at the actual stake and modeled costs,
first on all modeled book-eligible launches, then restricted to the common shadow
account's admissions. Compare the latter with adaptive-TP outcomes on those same
admissions. This separates execution adjustment, population selection and TP matching.
These are explanatory controls, not a search over new numeric thresholds. Native versus
exponential comparisons still bundle weighting and evidence freshness requirements;
they cannot identify a pure smoothing effect.
