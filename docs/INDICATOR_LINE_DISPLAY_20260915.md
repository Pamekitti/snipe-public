> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Indicator lines during pending simulations

Build `4d205cc8ed181787943ba90967995a47d62ad25e` keeps already-published indicator scores visible while the next selector execution is pending. This removes the repeated short breaks and gray stripes. The tooltip says “Last published scores; next simulation pending.”

The display uses the recorded six-scenario values. It requires a preceding publication timestamp, six distinct supported scenarios, complete 15/8 windows, finite values and fresh evidence. Missing publication metadata, incomplete windows, source gaps, worker failures and model mismatches remain unavailable. There is no interpolation and no change to guard decisions or entry permission.

Only `dashboard-policy.ts`, `dashboard-page.ts` and the existing display test changed in the isolated release. The execution model remains `97c88fa203e92de58c8b1fcbec97938011f62ac8546c162d4da2f9f833cd45b1`. The historical backfill artifact is unchanged.

Verification passed: 42 focused tests, both TypeScript checks and all 991 host tests. On the frozen one-hour chart, 255 already-displayed values were unchanged, 143 selector-pending samples retained their known scores, and two source-failure samples remained missing. Desktop and mobile were inspected once, at 1440 and 390 pixels. Both displayed connected step lines, with no browser errors or horizontal overflow.

Deployment used the runbook under operator STOP with zero open positions. The two restart gaps were checked with bounded verified headers, two matching factory-log scans and original transaction inputs. All seven launches in the expanded restart interval failed the unchanged admission screen. The seven recorded passing launches in the surrounding five-minute capture audit all had durable captures. Original gap records and proofs were archived in the immutable `resolved_capture_gaps` table before resolving the two active gaps. No account history or loss was reset.

The prior Auto selection was restored through the normal endpoint. Configuration and accounting were preserved. The missing release certificate still prevents entries, and selector processing may also temporarily block the guard. This display change does not certify execution accuracy.

Local release evidence is in `v1/data/releases/20260915-indicator-line/`. Private host rollback and restart proof are in `data/release-backups/20260915-indicator-line/`.

Todo:
- completed: Trace the line breaks.
- completed: Apply and test the display-only change.
- completed: Deploy, audit restart continuity and verify desktop/mobile rendering.
