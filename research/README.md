# Research index

The research is part of the experiment, including the ideas that failed. Dated documents preserve original assumptions, corrections, and evidence limits. “Current” inside a dated document refers to its own historical era.

## Start with the questions

| Question | Reading |
|---|---|
| Why did the first selection rule fail? | [August postmortem](../docs/history/POSTMORTEM.md) |
| Was the data complete? | [Decision amendments](../docs/history/DECISIONS.md) |
| Did the simulator match real execution? | [Fidelity findings](../v1/research/BACKTEST_FIDELITY_FINDINGS_20260911.md) and [error profile](../v1/research/SIMULATION_ERROR_PROFILE_20260913.md) |
| Which filters, exits, and recovery guards were tested? | [Original research map](../v1/research/README.md) |
| What happened in the final guard study? | [Focused-grid handoff](../v1/research/FOCUSED_GUARD_HANDOFF_20260914.md) |
| Why was V2 different? | [Architecture](../docs/architecture.md) |
| What did provider optimization establish? | [Halted RPC study](../v2/docs/halted-rpc-economy.md) |

## Preserved protocols and findings

- [Activity and recovery research, 8 September 2026](../v1/research/ACTIVITY_POLICY_PROTOCOL.md)
- [Backtest validation, 11 September 2026](../v1/research/BACKTEST_FIDELITY_FINDINGS_20260911.md)
- [Backtest standard](../v1/research/BACKTEST_STANDARD.md)
- [Consolidated research workflow](../v1/research/CORE_PROTOCOL.md)
- [Sell execution and receipt completion are different clocks](../v1/research/EXECUTION_CLOCK_FINDINGS_20260913.md)
- [The decision is whether the adaptive take profit and 45-second maximum have a supported replacement. This is analysis only.](../v1/research/EXIT_POLICY_AUDIT_PROTOCOL.md)
- [Filter policy findings, 15 September 2026](../v1/research/FILTER_POLICY_FINDINGS_20260915.md)
- [Filter policy comparison, 15 September 2026](../v1/research/FILTER_POLICY_PROTOCOL_20260915.md)
- [September 14 guard experiment handoff](../v1/research/FOCUSED_GUARD_HANDOFF_20260914.md)
- [Adaptive fresh recovery release](../v1/research/FRESH_RECOVERY_IMPLEMENTATION_20260911.md)
- [Launch-entry and graduation-hold audit, 2026-09-07](../v1/research/GRADUATION_LAUNCH_PROTOCOL.md)
- [Graduation audit, 2026-09-07](../v1/research/GRADUATION_PROTOCOL.md)
- [September guard and exit grid search](../v1/research/GRID_SEARCH_20260912.md)
- [September experiment rerun](../v1/research/GRID_V2_IMPLEMENTATION.md)
- [Guard audit protocol, 2026-09-07](../v1/research/GUARD_AUDIT_PROTOCOL.md)
- [Guard wallet charts and retention KPIs](../v1/research/GUARD_CHART_STANDARD.md)
- [The replay supports investigating late recovery entries. It does not establish that removing the guard is profitable.](../v1/research/GUARD_VISUAL_FINDINGS_20260911.md)
- [Research engine implementation, 9 September 2026](../v1/research/IMPLEMENTATION_STATUS.md)
- [Indicator experiment: better loss control, no validated replacement](../v1/research/INDICATOR_FINDINGS_20260911.md)
- [Indicator policy experiment, 11 September 2026](../v1/research/INDICATOR_POLICY_PROTOCOL_20260911.md)
- [Test the user's combined policy: use the existing profit guard's market score to choose stake, take profit, and maximum holding time at entry.](../v1/research/JOINT_POLICY_PROTOCOL.md)
- [The longer history supports matching the indicator to the traded launches](../v1/research/LONG_HISTORY_FINDINGS_20260911.md)
- [Longer guard comparison, frozen before new candidate outcomes](../v1/research/LONG_HISTORY_PROTOCOL_20260911.md)
- [Expanded market guard results, 8 September 2026](../v1/research/MARKET_GUARD_EXTENSION_FINDINGS_20260908.md)
- [Expanded market guard audit, 2026-09-08](../v1/research/MARKET_GUARD_EXTENSION_PROTOCOL.md)
- [Market guard research, 8 September 2026](../v1/research/MARKET_GUARD_FINDINGS_20260908.md)
- [Longer backtest: more history weakens the case for three recovery updates](../v1/research/MARKET_GUARD_LONGER_FINDINGS_20260908.md)
- [One-week and two-week guard comparison](../v1/research/MARKET_GUARD_LONGER_PROTOCOL.md)
- [Market guard persistence audit, 2026-09-08](../v1/research/MARKET_GUARD_PROTOCOL.md)
- [None of the tested changes clears the frozen acceptance rule. The creator-tax floor excludes profitable opportunities. The repeat-loss pause has support. Stale reopening remains a source of losses.](../v1/research/POLICY_EVALUATION_FINDINGS_20260911.md)
- [Policy evaluation, 11 September 2026](../v1/research/POLICY_EVALUATION_PROTOCOL.md)
- [Research](../v1/research/README.md)
- [False recovery: +2 normal market reopening is the leading research candidate](../v1/research/RECOVERY_POLICY_FINDINGS_20260908.md)
- [Recovery policy experiment, 8 September 2026](../v1/research/RECOVERY_POLICY_PROTOCOL.md)
- [September guard results](../v1/research/SEPTEMBER_GUARD_FINDINGS_20260911.md)
- [Lighter coverage of the coins Snipe actually bought](../v1/research/SHORT_COVERAGE_FINDINGS_20260922.md)
- [One-shot short tester](../v1/research/SHORT_ONCE.md)
- [Observed simulation error, 13 September 2026](../v1/research/SIMULATION_ERROR_PROFILE_20260913.md)
- [Market +2 stale-data decision](../v1/research/STALE_POLICY_FINDINGS_20260908.md)
- [Stale-indicator comparison, 8 September 2026](../v1/research/STALE_POLICY_PROTOCOL.md)
- [Shared execution, paper accounts and market evidence](../v1/research/UNIFIED_EXECUTION_STANDARD.md)

## Code and inputs

The analysis implementation remains under `v1/research/` to preserve its local imports. Retained August acquisition and validator-support tools are in this directory. [Historical tools](HISTORICAL_TOOLS.md) explain their original dependency chain.

[Dataset availability](../datasets/README.md) distinguishes offline reproduction, partial private-input studies, and documentation-only studies. Raw financial databases and credentials are not public.

The Lighter short-coverage investigation is retained as a separate, unsuccessful venue-feasibility experiment. It is not part of the Pons launch strategy.

## Later exploratory V2 work

[Recovered tail-grid and missed-opportunity work](EXPLORATORY_V2.md) remains explicitly unvalidated.
