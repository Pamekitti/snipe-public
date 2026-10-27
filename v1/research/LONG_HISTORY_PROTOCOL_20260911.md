# Longer guard comparison, frozen before new candidate outcomes

The objective is to preserve profitable market periods while reducing cumulative losses.
This is retrospective research, not an unbiased forecast or authorization to trade.
The original indicator candidates were developed after inspecting September losses.
Extending their history cannot undo that selection. No outcome from the extension may
change their thresholds, candidate list, entry filters or take-profit selector.

## Inputs and scope

Use the frozen capture ending 11 September 2026 at 12:44:12.950 UTC. It contains
actual live attempts from 17 August. A requested 45-day interval would start 28 July;
the preceding records are unavailable in this source. Retain the entire available
history and report the complete comparable prefix when execution coverage fails.
Account cash uses COALESCE(onchain_pnl_wei,pnl_wei), with historical stakes and eras.

Apply the captured entry and exit configuration to historical opportunities as a
separate counterfactual. Use identical filters, capacity and execution assumptions for
every guard. Independently price normal, half and quarter stakes. Historical actual
results are an accounting reference, not predictions for changed sizes or policies.
The adaptive selector uses only the broader monitor outcomes available before entry.
Before per-target observations exist, its documented fallback applies. Label that
interval separately; it does not establish how today's complete monitor would have run.
Native sensor reconstructions are a separate sensitivity, never recorded observations.

## Fixed candidates and controls

Reuse all 14 definitions returned by core.indicators.candidates() without modification.
Controls are current -1/+2, +1 recovery, stale-hold, market guard disabled with account
stops retained, and always-on with all account stops disabled. The last is an opportunity
benchmark, not a proposal. Keep all other account stops for candidate policies.

Compare a hypothetical fully automatic account from a flat initial state with a
separate scenario preserving recorded operator interventions. Neither scenario may
silently reset cumulative cash, probe allowances or drawdown when a reporting bin ends.
Unknown initial historical state prevents claiming exact actual-account replication.

## Time and execution

Publish signal outcomes only after their modeled exit and recorded observation clock.
Any substitute publication clock is explicitly reconstructed. Compare recorded availability
and reconstructed availability where needed. Signal delay sensitivity adds 60 seconds.
Use preceding costs and timing only. Exclude the last six hours from calibration.
Require calibration evidence or retain an unavailable result; never fit costs on future
attempts. Stress sell delays at 600 and 1200 ms and smaller-stake curve impact independently.
Missing paths, targets and pool exits remain unavailable. No failed outcome becomes zero.

## Evaluation and selection

Show full-history actual cash, seven daily bins and eight 3-hour bins ending at capture.
Partition candidate cash into chronological blocks, the previously profitable September
7–9 interval, the September 9–11 interval, and the final six hours. These are retrospective
partitions, not independent trials or untouched holdouts. Keep whole-account state continuous.
Where coverage permits, choose among the frozen candidates using preceding seven-day
results and score the next day without changing that choice using its outcomes.

Report winning-profit capture, loss avoidance, winning/losing trade counts, value added
against always-on, cumulative drawdown and repeated-recovery losses. Distinguish smaller
exposure from selection skill. Show extra/displaced entries and shared cash differences.
Each mean must include median, sample SD and n. All cash remains in ETH.

A deployable replacement needs a passing unchanged BACKTEST_STANDARD certificate,
complete candidate coverage, higher net cash with no worse drawdown or repeated-recovery
losses than baseline, preservation of profit in earlier profitable intervals, and support
under execution and start-date stresses. A model-only numerical winner that fails these
requirements is a research candidate. Do not loosen acceptance limits to force a winner.
Already-inspected data cannot provide prospective validation. Freeze a final candidate
before collecting genuinely new predictions. No live change is part of this work.

## User-directed interpretation amendment

Before the longer execution models or candidate results were produced, the user clarified
that comparative evidence is the objective. An imperfect simulation is not a veto on
identifying the strongest historical candidate. Report that candidate if its relative
advantage survives profitable and losing periods and execution stresses. Preserve all
accuracy findings and missing outcomes. The historical-fidelity certificate and its
limits remain unchanged. A research recommendation does not claim an exact forecast,
prospective validation, or authorize changes to the live account.

## Coverage amendment before candidate cash inspection

The execution audit found four unresolved exits at normal size and the central delay,
and ten tokens unresolved under at least one size/delay assumption. All paths and
parameters are present; these are graduated-market modeling gaps. Preserve the strict
continuous-account tests. Add common complete-interval comparisons split around the
union of these ten tokens. Each interval is a separate hypothetical flat account, not
an automatic reset or a continuous portfolio. Omit the same three-minute admission
tail on both sides so admitted trades can finish. Report interval results separately;
their sum is conditional tested-segment cash and must not be labeled wallet earnings.

Retain historical screen decisions, including template rejections, for every candidate.
Execution models were also calculated for 236 screen-rejected launches. They remain
available as diagnostics but do not enter this guard comparison. The initial partial
account run was marked invalid before candidate cash was inspected. No indicator
threshold or trading filter was selected using these changes.
