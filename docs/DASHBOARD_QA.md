> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Original dashboard refinement, 2026-09-07

The refined uPlot dashboard is deployed and active as box snapshot `bfe8de7`.
No trading controls, settings or accounting resets were exercised against production.

## Changes

The four-card layout now uses sans-serif labels and monospaced numbers. The banner,
Venue vs us, eight diagnostic cards and Since baseline section are removed. Current
faults appear inside the relevant cards. The raw alert API remains unchanged.

Market return replaces the touch-rate card and line. The page uses owner-computed guard
status and recorded samples with their historical thresholds. Missing evidence leaves
gaps without hiding account history, trade markers or launch bars. The original launch
outcome categories, toggles, rolling table and expandable trade rows remain.

The kill switch shows ETH first. An above-limit percentage remains visible even when its
bar is full. Wallet cash is separate from estimated account and open-position values.
An operator stop reads Stopped by you. Recovery details preserve every owner condition.

## Evidence

- Type checking and all 653 unit tests passed across 48 files.
- Chrome checks passed at 1440, 375 and 414 px, without page overflow or browser errors.
- Pixel checks verified all three plotted panes and aligned timestamp axes. They also
  covered a lone signal, missing market history and an empty chart interval.
- Browser checks covered all six periods, zoom through polling, tooltip timestamps,
  hover/tap details, keyboard trade expansion, stale connections, market hysteresis,
  combined stops, exhausted recovery allowance and ETH drawdown above 100%.
- STOP/START checks intercepted requests locally. The snapshot server refuses all writes.
- Read-only database checks matched launch counts, stack totals, trade counts and booked
  P&L across all six periods. Each retained market point matched its recorded value and
  thresholds. The seven-day view held 173,281 launches and 811 closes, with only 236
  market samples from the final hour. Those counts describe this QA snapshot, not a
  current-strategy performance analysis.
- The original chart smoke check passed every period and expandable trade details.
- Laptop curve validation passed: 60/60 curves, 99,080/99,080 core calculations and
  409/409 tax calculations matched chain history exactly.

## Preview

The local read-only preview runs at http://127.0.0.1:8799. It uses state captured on
7 September at 17:55 BST and SQLite backup copies. The original databases were opened
read-only during capture. No wallet key is needed by the preview.

Desktop (unavailable historical artifact: `dashboard-preview/refined-desktop.png`),
375 px phone (unavailable historical artifact: `dashboard-preview/refined-phone-375.png`),
414 px phone (unavailable historical artifact: `dashboard-preview/refined-phone-414.png`).

Missing-market scenario (unavailable historical artifact: `dashboard-preview/refined-no-market.png`) and
recovery scenario (unavailable historical artifact: `dashboard-preview/refined-recovery.png`) use synthetic overrides for
those conditions. They are test cases, not statements about the running bot.

## Deployment verification

The deployment used an isolated copy of box snapshot `a8f44be`. All non-dashboard
production source stayed byte-identical. All 653 tests passed again on the box.

Activation used the runbook restart after checking zero open positions in memory and
SQLite, plus the persisted operator stop. The stop survived. Effective configuration,
accounting boundaries and the two used automatic recoveries remained unchanged.

The Tailscale page and new state/chart APIs were verified after activation. Chrome
checks passed on desktop and a 375 px phone viewport, with no browser errors or control
requests. Trading remained stopped with zero open positions.

Deployed desktop (unavailable historical artifact: `dashboard-preview/deployed-desktop.png`),
deployed phone (unavailable historical artifact: `dashboard-preview/deployed-phone-375.png`).

## Compact follow-up, deployed as bfd0932

A further local revision restores ACTION NEEDED for current faults and CHECK THIS for
useful warnings. It suppresses deliberate operator stops, obsolete probe warnings and
resolved exit totals. Dollar P&L now appears beside ETH in the second recent-exit column.
Four rolling metrics are visible by default; More metrics preserves the other five.

The launch-bar calculation is unchanged. It uses the recorded broad screen and the
watcher's fixed touch test, not every live entry filter or the adaptive exit target.

The preview measures 2,732 px high on desktop and 3,215 px on a 375 px phone. The previous
deployed captures were 3,324 and 3,642 px respectively. Main body and table text remains
14 px. These are screenshot comparisons, not controlled performance measurements.

All 655 tests and type checking passed against an isolated copy of the deployed codebase.
The shared workspace has unrelated graduation, epoch and stuck-exit test failures from
concurrent trading work. Dashboard-focused tests, chart smoke checks and Chrome checks
passed, including alert escaping, dollars/ETH, extra metrics and phone widths.

This follow-up is deployed and active as `bfd0932`. All 655 tests passed on the box.
Activation waited for zero open positions in memory, the risk owner and SQLite.
Configuration, accounting boundaries, operator-stop state and recovery allowance were
unchanged after restart. The bot remained enabled. Read-only Chrome checks verified
both currencies, four default metrics, all three chart panes and phone layout.

[Live dashboard](http://127.0.0.1:8787).

Compact desktop (unavailable historical artifact: `dashboard-preview/compact-desktop.png`),
compact phone (unavailable historical artifact: `dashboard-preview/compact-phone-375.png`).

## STOP ALL RPC economy, local acceptance on 2026-09-25

The local dashboard showed `RPC economy public` while the fixture was stopped and
eligible. The START button changed to `PREPARING...` during the asynchronous control
request. A failed paid catch-up returned `still stopped` and displayed the reason. A
second run sent a newer STOP during preparation. The pending START reported cancellation,
and the button returned to START.

Chrome ran at 1440 by 1000 px with zero horizontal overflow and zero page exceptions. The
test used an isolated headless profile and intercepted fixture controls. It did not contact
the live wallet. Superset browser access was unavailable, and neither supported desktop
driver was installed, so this check was not visible in a workspace pane.
