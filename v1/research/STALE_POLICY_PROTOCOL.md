# Stale-indicator comparison, 8 September 2026

Compare four age policies at market recovery thresholds +1 and +2. Keep all other
settings and the frozen 12:32:24.439 UTC input identical to the recovery study.
This is retrospective comparison of already inspected data. It is not prospective
validation and does not authorize changing live configuration or resuming trading.

1. `open`: the existing exception. A stale window publishes open and may release a
   market pause. Fresh data restores the sensor's remembered hysteresis state.
2. `hold`: retain the existing market pause through stale or incomplete evidence.
   A placed market pause can release only on a full, fresh window strictly above
   the recovery threshold. Already-open trading continues while evidence is stale.
3. `any_age`: use a complete latest-20 window regardless of launch age for both
   stop and recovery thresholds. An incomplete window preserves existing state.
   A placed market pause requires a full window strictly above the recovery line.
4. `fresh_only`: stale or incomplete evidence places a market pause. Recovery
   requires a full, fresh window strictly above the recovery line. Merely becoming
   fresh again inside the hysteresis band does not release the pause.

Fresh means all 20 selected launches are at most three hours old. The indicator
continues to use only outcomes available at decision time. Disabling this age
restriction does not allow unscored or future outcomes into the window. The DD
recovery remains its separate 20 post-stop scored outcomes above +1. The 0.06 ETH
DD trigger, two recoveries per UTC day, 0.02 ETH size, capacity and modeled costs
stay fixed. Cash drawdown is cumulative across accounting resets, with no open marks.

Test recorded current-era attempts first, at native and +15-second sampling phase,
and the isolated September 8 false recovery from its observed pre-existing halt.
Replay the same two-week fixed-1.75 opportunity model under base execution, a
1.2-second sell delay, +15-second sampling, reconstructed scores available after
two and ten minutes instead of five, returns reduced by five percentage points,
and the existing virtual graduation valuation sensitivity. Existing baseline and
Market +2 outputs must match saved cash and decisions before comparing variants.

Report 14 days, each constituent week, final 48 and 24 hours, and current-era
conditional cash. Include the existing eight 3-hour and seven daily bins ending
at the frozen export, explicitly label old eras and unavailable current-era bins.
Every mean includes median, sample standard deviation and count. Quantify stale
exposure, stale resumptions, additional and removed winning/losing trades, and
timing sensitivity. Favor profit retention with lower drawdown across scenarios;
report genuine tradeoffs and ties rather than inventing a universal optimum.

No refitting, new data pull, live code edit, deployment or bot restart is part of
this comparison. Preserve the earlier outputs and their source snapshot. Write
new results, charts and source hashes into a separate stale-policy subdirectory.
