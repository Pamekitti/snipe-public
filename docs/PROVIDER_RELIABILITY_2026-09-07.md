> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Provider reliability verification, 7 September 2026

Provider failure handling is running in release 5a1b54e. It preserves the launch subscription and trading rules. Provider availability and billing limits can still affect execution.

## Changes

- Normal receipt, balance and recovery reads prefer the provider. Each endpoint has a 750 ms timeout with no transport retry loop.
- Launch reads retain their three explicit attempts. The transport no longer adds hidden retries.
- Public log-poll failures fall back to the provider. Provider log requests use ten-block slices, compatible with the free tier.
- Missing results and failed slices cannot advance log coverage or freshness.
- Poll requests have an independent completion deadline, including response-body processing. Error bodies are cancelled.
- Historical accounting log scans retain their public route and longer deadline.
- Provider fallback, nonce and graduation requests contribute to the local usage estimate. Transaction lookup cost was corrected from 17 to the published 20 CU.
- The API reports the poll cursor, observed tip, pending request and request age.

The quota estimate never stops a trade. No launch-stream replacement, spending cap, throughput cap or paid subscription was activated by this work.

## Validation and rollout

All 677 tests passed locally in the isolated release and on the box. Type checking passed. Tests cover HTTP 403/429/500, hung endpoints, both endpoints failing, successful provider responses, batch accounting, historical-log routing, provider log slicing, partial failures and response bodies that ignore cancellation.

Laptop curve validation passed 99,080 state transitions and 409 tax checks across 60 curves. These matched chain history exactly.

The first release, 15e35c2, stalled the poller after startup. Its stale-data guard rejected entries. Live verification detected the stall, and the prior version was restored while flat. The exact underlying stall was not reproduced in the isolated probe. An explicit completion deadline and progress diagnostics were added before the second release.

The second activation preserved operator_stop, epoch_base_id, dd_resume_budget, effective configuration and strategy. The activation guard checked API positions, reserved capacity and open live database rows before restarting. No size or drawdown limit changed.

At 122.8 seconds of the second run:
- The bot was enabled with no open position.
- Log freshness was 92 ms, against the 3,000 ms guard.
- Provider fallback had rescued 53 reads; complete poll failures were zero.
- Four book checks matched, with zero drift.
- The launch socket was up with 43 delivered launches.
- Trades had completed, and receipt backfill was operating.

Final check at 4.66 minutes: 132 rescued reads, 0 complete poll failures, 89 ms log freshness, no open position and no configuration error. The new short-run pace was 124.18M CU per month, about $55.88 if sustained.

This is a short live verification, not proof of future uptime or unchanged long-term latency. The first rollout failure is retained here because a green unit suite alone did not establish live health.

## Expected cost and accident protection

The user's Alchemy page showed 2,383,566 CU consumed and about 27.6M remaining on the 30M free allowance. Those are consumed units, not a monthly bill.

At the published PAYG rate of $0.45 per million CU below 300M:
- 60M CU costs $27.
- 120M CU costs $54.
- 200M CU costs $90.

The earlier running setup projected about 60M/month. The first 122.8-second sample after hardening projected 81.71M HTTP CU plus 34.68M socket CU, approximately $52.38 per full month if that rate continued. This short startup sample is not a reliable monthly forecast. A $60 initial planning budget allows for the added fallback requests; it is not a promise that usage stays below it.

Suggested account settings are alerts at $30 and $50, plus a $100 monthly usage limit. They have not been set. A $100 limit corresponds to about 222.2M CU at the first pricing band. Alchemy documents that its Usage Limit caps charges; taxes or other services are outside this CU calculation. A hard cap can deny provider access during an exit. Public fallback is available but cannot guarantee equal latency or availability.

Do not confuse the paid throughput allowance with a monthly cost limit. It limits request rate, not the month's total spend.

Sources: [Alchemy PAYG pricing and usage limits](https://www.alchemy.com/docs/reference/pay-as-you-go-pricing-faq), [compute-unit costs](https://www.alchemy.com/docs/reference/compute-unit-costs).

## Evidence

The deployed files matched the tested isolated release byte for byte. Test and deployment logs on the laptop:
- /tmp/provider-release-tests.log
- /tmp/provider-hardening-validate.log
- /tmp/provider-hardening-deploy-2.log

Activation and monitoring evidence (unavailable historical artifact: `../v1/data/provider-audit/reliability-activation-2026-09-07.json`).

The local usage meter still resets on restart and excludes other processes. Alchemy's account Usage page remains the authority for monthly consumption and remaining allowance.
