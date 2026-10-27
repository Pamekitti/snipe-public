> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Live indicator repair, 15 September 2026

The repair addresses evidence production. Auto must remain stopped. Historical fidelity and new-outcome certification have not passed.

Latest running release: `87bfa5570277962c4f0d1e3b9a3b08e5647f7f13`, deployed after the user's Alchemy upgrade. The authenticated endpoint now passes block number, block header and log probes. Background history slices of at most 2,000 blocks use Alchemy first, with public fallback. Wider accounting scans and real execution deadlines are unchanged.

The new model fingerprint is `97c88fa203e92de58c8b1fcbec97938011f62ac8546c162d4da2f9f833cd45b1`. `lock-routing.json` defines its fresh verification window. All older evidence remains preserved. The preflight proved zero ready adaptive captures and zero scenario bundles for the preceding model, so no shadow holding or simulated loss was reset. Auto was found requested during preflight and restored to STOP before restart. There were zero real open positions.

All 988 host tests and both TypeScript checks passed. The laptop curve validator passed using the existing paid endpoint for that process only: 60/60 curves, 99,080/99,080 core checks and 409/409 tax checks. All 281 frozen strict results and six-scenario bundles match the preceding audit exactly. Historical cash fidelity remains diagnostic; passing curve arithmetic does not resolve missing historical intent, timing, source or account evidence.

At 14:01 UTC, six new launches had complete TP scores and ten launches had been captured. Publication delay across six completed launches was mean 195.12 s, median 193.97 s, population SD 2.86 s, maximum 201.49 s. The required wait is 190 seconds. Collection delay across ten launches was mean 2.14 s, median 2.15 s, population SD 0.03 s. There were no retry jobs in that snapshot and no shadow-account outcomes yet. This is a small runtime sample, not a completed activation certificate.

The latest artifacts are `deploy-routing.log`, `source-verification-routing.json`, `routing-preflight.json`, `routing-release-proof.json`, `routing-execution-parity.json`, `curve-validation-paid.log`, `fidelity-routing/` and `routing-progress-*.json`. The identity-separation idea in `routing-compatibility.json` was superseded and was not shipped. The original fingerprint recipe and all activation gates remain in force.

At 14:06 UTC, fourteen launches had complete target scores. All 98 p50-after target calculations matched independent laptop replay (`routing-target-parity.json`). `prospective-routing.json` still contains zero of twenty required shadow account outcomes. Target warmup and shadow certification are separate steps. Auto remains stopped; historical fidelity and prospective actual-trade accuracy are additional unmet activation gates.

## Confirmed cause

The authenticated Alchemy endpoint returned HTTP 429 with **Monthly capacity limit exceeded** for block number, block header and log requests. This is a provider response, not the dashboard's projected monthly usage.

The public endpoint returned block data. One successful single-block log probe took 2,649 ms. The existing real-execution read deadline is 750 ms. Public availability does not establish adequate live latency. The laptop curve validator also failed on HTTP 429.

The old processor retried its oldest failed job globally. The TP selector treated any older missing result as a permanent fault. Virtual warmup admissions used the 1.75 target even while adaptive selection was unavailable. These are separate defects from provider capacity.

## Changed behavior

- Durable job status, retry deadline and attempt count belong to each opportunity. Fresh unattempted jobs precede retries. Failed work remains visible and can be retried after a restart.
- Background reads use the existing public endpoint first and a five-second ordinary-read deadline. Historical logs retain their separate bounded timeout. Real execution deadlines are unchanged.
- Each historical log slice is compared across two reads and cached. Event block hashes and timestamps are checked before replay publication.
- The required TP population is selected before checking completeness. Missing required members block selection; older observations cannot substitute for them. A missing observation outside the required window no longer blocks selection.
- TP observations continue during STOP. A virtual trade needs a ready, compatible selection captured at entry. Blocked entries produce no fallback cash or guard outcomes.
- Account gaps and unresolved admitted executions still prevent continuation. No real accounting or protection setting is reset.
- A separate read-only process generates the full dashboard report. Its failure does not interrupt the indicator heartbeat.
- `/api/state.indicatorPipeline` reports selector evidence, required missing IDs, job counts, oldest blocking job, last completed job and last outcome publication.

## Evidence

Artifacts are under `v1/data/releases/20260915-indicator-repair/`.

- `diagnosis-logs.json`: sanitized endpoint responses and frozen effective settings.
- `selector-parity.json`: 2,406 historical checks, zero differences between the SQL live selector and offline selector; 84 ready selections.
- `execution-parity.json`: all 281 prepared requests and six-scenario bundles exactly match the previous execution outputs. This establishes calculation continuity, not complete market coverage.
- `fidelity-admission/`: refreshed standard audit over 1,190 actual attempts, September 1 through September 13 at 15:30 UTC. Only 62 of 281 prepared strict predictions are complete. The verdict remains diagnostic.
- `replay-final/`: 2,406 opportunity captures through September 15 at 10:47:13.635 UTC. There are 920 complete target-score sets, 84 adaptive execution replays, and 1,486 unavailable inputs. A recorded gap ends the comparable account at September 13, 14:43:14.595 UTC. This capture cannot prove a continuous supported day.
- Bot tests: 986 passed locally and on the host. Research tests: 330 passed. Both TypeScript checks passed. Existing baseline guard and integer execution tests remain in the suites.
- `curve-validation.log`: laptop arithmetic validation was attempted and blocked by HTTP 429. It is not a pass.

## Operational handoff

The release is prepared from running build `646773264b83b08d37fb9ec366a5b74fc8c735d2` plus the files in `release-files.json`. Private rollback material is in the host's `data/release-backups/20260915-indicator-repair/`.

Live verification of the first deployment caught an SQL error: the admission insert supplied eight placeholders for seven columns. The correction names all seven columns explicitly. A new test runs the actual processor against temporary databases and verifies admission writes plus independent source retries. This failure was missed by the original component tests.

Build `b86bc143f821ada291dc0742a61be5dff7fa5b98` runs model `08d89d54dce03ef63ff19ccddedfec1068654cbab7815a62bf6df7c587d14b37`. `lock-admission.json` records the new verification cutoff. `deploy-admission-fix.log` contains the host test and snapshot result. `selector-parity-admission.json` repeats the 2,406 historical selector checks for this model. Earlier artifacts retain their earlier model identities.

Auto remained stopped, with zero open positions confirmed immediately before restart. New compatible outcomes and publication progress still require runtime verification. No historical accounting was reset.

## Runtime verification at 13:31 UTC

`progress-6.json` records ten captures since 13:20:40 UTC. Six completed the seven-target scoring step, one mature job was retrying RPC acquisition, and three were pending. Later jobs completed while the older failed job retried. No fallback virtual trade was admitted. All 42 p50-after target calculations across those six launches matched independent laptop replay of their frozen requests (`live-target-parity-2.json`).

These are TP warmup observations, not twenty certified shadow account outcomes. There are zero new published guard outcomes. `prospective-admission.json` fails the required sample and coverage gates. The active indicator remains unavailable while its required evidence is incomplete.

Measured collection delay across ten launches: mean 13.45 s, median 10.27 s, population SD 7.95 s. Target publication delay across six completed launches: mean 269.04 s, median 228.91 s, population SD 92.13 s, maximum 473.13 s. Publication delay includes the required 190-second eligibility wait. This sample does not demonstrate sustained throughput or absence of execution contention.

The 13:25 UTC endpoint probe still found monthly-capacity HTTP 429 responses for all three authenticated methods. Public latest-block reads succeeded, but its log probe took 4,235 ms. Acquisition also recorded public `Too Many Requests` failures. Live log health varied between unhealthy and healthy during the observations. Actual provider usage totals were not retrieved; no projected bot usage was substituted for them.

`source-verification-admission.json` confirms all twenty release-file hashes match the host. Auto remains stopped. Provider access restoration has been requested without changing billing. The worker retains its bounded retries and continues observation.

Remaining acceptance work: complete a compatible TP window, independently verify at least twenty subsequent complete shadow outcomes, prove a supported full-day worker/replay comparison, and demonstrate sustained collection and publication performance. Historical cash fidelity and the rate-limited laptop curve check remain failed or unavailable. Dashboard backfill and Auto activation are outside this repair.

Reproduce the new live TP arithmetic check from `bot/` with Node 22:

```sh
node --import tsx data/releases/20260915-indicator-repair/verify-live-targets.mjs data/releases/20260915-indicator-repair/live-target-inputs-2.json data/releases/20260915-indicator-repair/live-target-parity-recheck.json
```

Verify at least 20 new, complete, compatible shadow outcomes after the final lock using `scripts/verify-execution-scenarios.ts`. Preserve source gaps, actual-trade accuracy requirements, and the separate Auto activation decision. A successful process, a healthy heartbeat, or passing unit tests does not satisfy those gates.
