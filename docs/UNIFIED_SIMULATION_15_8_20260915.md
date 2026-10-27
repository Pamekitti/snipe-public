> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Unified simulation and 15/8 release status

The integration is implemented and staged. Auto is stopped. The new build has not been deployed or certified.

## Selected behavior

The candidate is `n15-m8-b-1.5-r1-h2-fresh`: main window 15, fresh window 8, pause strictly below -1.5 stakes, and recover strictly above +1 in the fresh window. Recovery needs a new publication and complete evidence within 180 minutes. Any of six execution scenarios can pause; all must recover. `fullOn: 2` is an inactive compatibility field, not a recovery condition.

The last captured live configuration used a 0.005 ETH stake, 0.08 ETH concurrent stake budget and 0.015 ETH drawdown limit. Both new-guard switches were off, so the running guard still used fixed-1.75 outcomes. The operator STOP was applied through the existing control endpoint. No accounting reset, size change or restart was performed.

One existing position was parked and remained open. Restarting while it is open is outside this release procedure. SSH authentication completed during the work. The running source snapshot (`ca0ab15bf855c35ab490444e14f9122dc925d8c8`) and private rollback backup were captured and downloaded with SHA-256 verification. An isolated candidate was prepared from that source plus the reviewed changes.

## Shared calculation path

The background simulation worker scores every configured TP target across the same six execution scenarios. It includes the broader book-passing population before trading filters, capacity and template exclusions. Target scores use central `p50-after` net returns. The selector retains its existing argmax, tie behavior, target list and warmup fallback.

A warmup TP fallback supplies virtual trades only while entry evidence is unavailable. It cannot authorize real entry. The market guard never falls back to fixed-1.75 outcomes when the scenario path is enabled.

Target publications are immutable and atomic with scenario publications. The shared request is stored once; target results retain only their deltas. The selector snapshot pins publication identities, configuration and source model. Missing target outcomes block the selector instead of contributing zero. Research calls the same exported target replay function.

The guard controller, worker and preview default to the explicit 15/8 candidate. Historical 20/8 parity remains explicitly configured. Saved state must match the policy and model. Drawdown recovery reads compatible post-halt shadow publications across all six scenarios while retaining the existing count, threshold, flat-position and daily-lift checks.

Real fills, receipts and wallet cash remain actual observations. Replay and history acquisition stay outside the entry and exit path.

## Dashboard contract

The displayed continuous paper line and simulated outcome bars use the shared published ledger. Old shadow-job estimates are not substituted when that ledger is missing. Actual cash stays separate.

Additional aligned panes show guarded paper against its matching-exit market-off account, cumulative drawdown, winning ETH retained and losing ETH retained. Zero reference denominators are unavailable. Yellow shading denotes the named simulated policy's market pause; red denotes its drawdown pause. The existing market pane remains the recorded active guard. The outcome tiles name their central scenario; live permission still requires all six.

The state/chart interfaces retain existing fields and add `simulationComparison`, source/model/configuration identities, coverage and publication metadata. The older strict account fields remain diagnostic compatibility fields. They do not supply the displayed paper series.

## Verification and evidence

Local artifacts are under `v1/data/research/20260915-unified-15-8-v1/`. Live snapshots and synthetic UI screenshots are under `v1/data/releases/20260915-unified-15-8/`.

- Bot tests: 967 passed locally and on the isolated host candidate, including all 8,056 historical baseline guard checks. The model hash is `d58d12d1bc6ae146cbb948f2c4517fd1604416f3fe40ca8421460d52a8da30fc`.
- Research tests: 330 passed when run from `bot/`.
- Both TypeScript configurations passed.
- Desktop and mobile UI fixtures rendered eight panes without JavaScript errors. Fixture curves are synthetic and are not financial results.
- The laptop curve check failed on an RPC timeout. This is an unpassed check, not proof of an arithmetic regression.
- The final actual-attempt audit in `final-fidelity/` is diagnostic. It retains all 1,190 actual attempts, but only 13 have captured pre-execution inputs. In that captured cohort, the central simulation understated the loss by 9.4%.
- The final 36-row compatibility comparison in `final-guard-compatibility/` covers three guards, six scenarios and two eras. It reuses frozen outcomes and publication times. It does not validate the new production pipeline.

The requested full production replay remains blocked. The first September source job has zero preceding timing samples, placeholder submitted limits and a proxy approval cost. The production model rejects those inputs. Do not promote fixed-delay historical matrices into production evidence or scale the prior 0.02 ETH results to the current 0.005 ETH stake.

## Reproduce and resume

Run checks from `bot/` using Node 22:

```sh
npm test
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit -p research/tsconfig.json
PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 python3 -B -m unittest discover -s research -p 'test_*.py'
npm run validate
```

`research/core/guard_release_audit.ts ACCOUNT_INPUT NEW_OUTPUT_DIRECTORY ERA_CUTOFF_MS` is a compatibility audit only. For this capture the era cutoff is `1788825600000`. Use a new output directory and retain its input hash.

Deployment must follow `v1/DEPLOY.md` once the account is flat. SSH access and the source backup are now complete. Prepare an isolated release and enable the scenario path under STOP. Preserve the captured stake, bankroll and drawdown settings. Review the full release difference against the running source before shipping.

After the model is frozen and running, collect at least 20 new complete shadow outcomes. The independent verifier now checks every target's replay and the pinned selector evidence. Certification binds the full guard policy, not only its name. A release also requires historical fidelity, supported selection and prospective actual-trade accuracy. All existing gates remain mandatory.

Do not manufacture a passing release file. If actual post-lock samples are missing, leave Auto stopped. Calibration trades require separate authorization. Activation is not an observed recovery cycle; verify the first natural recovery and subsequent pause from recorded decisions after activation becomes eligible.

## Live deployment update

Source snapshot `eabbc5aab8b955f24387a4967c81d2a370c32882` is deployed and running under operator STOP. All 967 host tests passed. Model identity remains `d58d12d1bc6ae146cbb948f2c4517fd1604416f3fe40ca8421460d52a8da30fc`.

Position 2571 had already sold on chain, but its closure was missing from the book. The successful buy and sale receipts show the same token quantity, and a fresh balance read returned zero. Its original row and receipt evidence were backed up privately before reconciliation. The booked loss is 0.000641835965148016 ETH, including receipt costs and recorded reverted gas. The ledger was flat before restart. No accounting reset or trade broadcast occurred.

`VENUE_EXECUTION_SCENARIOS=1` selects the 15/8 policy. Pause is below -1.5 stakes; recovery requires fresh eight above +1 in every scenario, with new evidence and a 180-minute maximum age. The legacy configuration fields remain present but do not control this path. Stake remains 0.005 ETH, bankroll 0.08 ETH and drawdown limit 0.015 ETH. Adaptive TP and the 45-second hold remain unchanged.

The live desktop and mobile dashboard rendered eight chart panes without JavaScript errors. Unavailable paper evidence remains visibly unavailable. Worker capture heartbeats advance, but RPC throttling and incomplete coverage prevent verified shadow publication. Historical fidelity, selection support and prospective actual accuracy remain unpassed. Auto is stopped; no recovery cycle has been observed.
