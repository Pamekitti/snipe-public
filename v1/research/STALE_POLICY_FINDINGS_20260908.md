# Market +2 stale-data decision

Keep `venue_plus2_only`, the +2 market recovery threshold with the existing stale
exception. The new tests do not support replacing the exception with holding a
pause until fresh recovery evidence returns.

The same two-week main model produced:

| Market +2 variant | Net profit | Maximum realized drawdown |
|---|---:|---:|
| Existing stale exception | $14,697.26 | $370.40 |
| Hold existing pause while stale | $14,459.73 | $370.40 |
| Latest 20 outcomes regardless of age | $14,592.34 | $454.70 |
| Pause every entry while stale | $12,294.80 | $350.64 |

Holding pauses removed 22 modeled trades worth $237.54 net. It reduced neither
the maximum drawdown nor the worst rolling 24-hour or 48-hour drawdown. The
existing exception earned more in all seven model scenarios with equal or lower
maximum drawdown. Any-age earned more in three scenarios, but its main-run
drawdown was $84.30 larger. Pausing every stale entry gave up $2,402.46 for a
$19.76 reduction in maximum drawdown.

All four +2 rules tied on the current-era recorded attempts, both timing phases,
and the isolated September 8 false recovery. Only three stale-exception reopening
events occurred in the main model, all before the current-size era. This is
limited, reused history, not a validated live optimum. The earlier concern about
reopening on stale evidence was a hypothesis; it did not establish better results.

Inputs end at 2026-09-08 12:32:24.439 UTC, the same frozen endpoint as the earlier
chart. These synthetic profits are not live earnings forecasts. Unresolved
graduation pricing and execution differences remain. Conditional current-era
cash is retained historical attempts, not an estimate of all alternative fills.

Reproduce with `python3 -B v1/research/stale_policy_audit.py`. The protocol is
`STALE_POLICY_PROTOCOL.md`; generated results, both reporting windows, seven
sensitivity scenarios, source copies and hashes are in
`v1/data/recovery-policy-20260908/stale-policy/`. The research suite passed all
77 tests after eight new stale-policy cases. Existing baseline and Market +2
cash/actions match the prior saved experiment in every comparable scenario.
