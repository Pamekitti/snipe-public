> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Dashboard history repair, 13 September 2026

The live dashboard now shows four aligned panes: account, paper trading, market, and coins.
The paper dropdown and duplicate recovery pane are removed. Both market thresholds share one
pane. Detailed validation output is collapsed under Details.

Paper uses the existing continuous collector in shadow_jobs. It is explicitly labelled an
estimate from an incomplete record. Strict version 3 comparisons remain separate and retain
their failed or unvalidated status. Neither model is approved for strategy ranking. No older
venue estimates are spliced into the paper curve. Missing results are not reported as zero.

Passed coins without estimates have their own visible category. Hiding rejected coins cannot
hide these passes. Empty paper history has an explicit message. The final phone check also
caught and corrected clipping of the date labels.

Validation: 878 tests passed on the laptop and the server, with TypeScript checks passing.
Browser checks covered 375px, 414px and 1440px, all six ranges, plotted paper and bar pixels,
market thresholds, old legend preferences, zoom after refresh, missing results, stale capture,
null gaps and collapsed details. Read-only live browser verification found four panes, 59
paper points and 31 non-empty coin buckets in the one-hour window, with no JavaScript errors
and no control requests.

Initial dashboard deployment: 3555cdd. Final snapshot with reconnect cooldown handling:
885d37e. Both activations checked zero open positions and the persisted operator stop before
restarting. Effective configuration, active guard and execution-model hash were unchanged.
Unrelated local workspace changes were preserved by deploying an isolated copy of the
previous production snapshot plus the reviewed changes.

The restart exposed an upstream sequencer-feed rejection. The provider returned HTTP 403
and the message "Blocked for 1 hour after sustained feed connection rejections". The reconnect
client now honours Retry-After, handles HTTP dates, and cancels its retry timer on shutdown.
Real HTTP-server tests cover delayed retry, rejection fallback, duplicate-disconnect prevention
and cancellation. The running client recorded one rejection at 16:08:14 UTC with a 3166-second
cooldown, scheduling the next attempt for approximately 17:01 UTC (18:01 BST). No further
attempt occurred during the observed cooldown. Recovery of the feed itself is not verified.
The upstream block remains an external limitation. Trading remains operator-stopped.

Final health: chain logs healthy, simulation capture progressing without drops. The feed is
waiting for its provider cooldown. Paper accuracy and complete monthly coverage remain
unverified; the UI says so.

Screenshots: live phone (unavailable historical artifact: `dashboard-preview/simple-history/live-phone-375.png`),
live desktop (unavailable historical artifact: `dashboard-preview/simple-history/live-desktop.png`),
missing paper (unavailable historical artifact: `dashboard-preview/simple-history/phone-missing-paper.png`).
