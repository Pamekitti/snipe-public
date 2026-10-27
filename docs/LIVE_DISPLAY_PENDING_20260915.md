> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Live display deployed, 15 September

Build `81918eb5dc06ac53e39ba87e0edb181d1717e6c8` is deployed and restarted under operator STOP. All 990 host tests passed after correcting the script inventory documentation. The execution model remains `97c88fa203e92de58c8b1fcbec97938011f62ac8546c162d4da2f9f833cd45b1`.

The normal `?paper=live` dashboard now displays available calculated scores even when release approval is missing. It labels them as simulated scores with trading verification pending. Source faults, incomplete windows and stale evidence still produce gaps. The existing four panes were checked at 1440 and 390 pixels, with no browser errors or horizontal overflow.

The restart created two intervals, 1789486135948–1789486139525 and 1789486139526–1789486143817. Two matching settled chain scans per interval identified six unique launches in the expanded time ranges. Replaying the unchanged admission screen on their transaction inputs rejected all six. All 83 recorded passing launches since the prior verified cutoff had durable current-model captures. Effective configuration, model identity, operator STOP and zero real positions were checked again before the repair.

The two original gap rows and the complete proof were archived transactionally in the immutable `resolved_capture_gaps` table before removing them from the active unresolved-gap set. Existing captures, outcomes, losses, account holdings and processing jobs were not reset or edited. The affected jobs subsequently completed their normal retries; the queue snapshot had 213 completed jobs and no retry errors. Actual Auto remained stopped.

Artifacts are under `v1/data/releases/20260915-live-display/`. Host rollback records and proof are under `data/release-backups/20260915-live-display/`. `gap-records-before.json` preserves the exact affected rows; `restart-resolution-proof.json` preserves source scans, transaction inputs, screen results and the capture-delivery audit. A slow full-database backup was stopped before mutation and its incomplete output removed. Only the affected gap rows needed restoration protection, so the exact row backup and transactional archive were used instead.

This repairs the audited restart intervals. It does not automatically waive future restart gaps. A future interval with a missing eligible launch must remain unresolved until its required evidence is recovered. `check-restart-gap.ts` is read-only and does not authorize clearing a gap by itself. Release approval and prospective actual-trade accuracy remain separate activation requirements.

Current todo:
- completed: Prepare and test the live score display.
- completed: Deploy and restart under STOP with zero real positions.
- completed: Audit and resolve these two restart gaps without resetting the account.
- completed: Verify the normal desktop and mobile dashboard.
- blocked: Auto activation under the existing release criteria.

## Earlier preparation record

The display change is prepared in `v1/src/telemetry/dashboard-policy.ts` and `dashboard-page.ts`, with regression tests in `bot/test/live-indicator-display.test.ts`. It displays the minimum calculated main and fresh scores across six unique, fresh, complete scenario windows when only release approval is missing. It does not change guard state or entry permission. Missing source evidence, incomplete windows, stale workers and model mismatches still hide values.

The focused dashboard and ledger suite passed 41 tests. Bot TypeScript passed. No production files or controls changed in this turn.

Deployment remains incomplete. `simulation/worker.ts` records a restart gap even after a clean shutdown. `simulation/scenario-observer.ts` feeds every such gap into the independent account and has no resolved-gap path. Restarting merely to load the dashboard change would therefore invalidate the currently verified live account. The current model and its published outcomes must be preserved.

Do not delete that gap, change model identity to discard account losses, or assume that a short restart missed no launch. A restart continuity repair must preserve frozen account state and explicitly verify or reconstruct missing capture coverage before resuming publication. The existing frozen dashboard replay remains available while the normal live chart change is pending.

Todo:
- completed: Trace display gating and prepare the isolated display logic.
- completed: Run focused regression tests and bot TypeScript.
- in_progress: Resolve restart continuity before deployment.
- pending: Deploy and inspect the normal live dashboard.
- blocked: Auto activation still requires an explicit resolution of the remaining release criteria; no passing artifacts have been fabricated.
