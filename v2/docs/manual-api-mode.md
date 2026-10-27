# Manual Economy and Paid API routing

The dashboard selects API routing independently of live/shadow mode and the trading controls.
Economy uses public APIs for monitoring, launch metadata, entry preparation and ordinary maintenance.
It disconnects the paid launch socket. It can still buy and sell under the existing strategy and freshness checks.

Economy permits uncapped paid rescue for existing positions and signed transactions.
A public failure, timeout or missing receipt can use the paid provider after checking the obligation again.
Rescue reads carry an owner identifier. Broad monitoring and new entry preparation never receive paid rescue.
Existing transaction retry limits and receipt accounting still apply.

Paid restores the existing provider routing and public fallback. Provider account limits remain external to this control.
API meters show estimates for this bot, not the Alchemy invoice or other applications.
The rolling 24-hour and seven-day windows separate ordinary paid API traffic from Economy exit rescue.

## Switching

`POST /api/control` accepts `{"action":"set-api-mode","apiMode":"economy"}` or `"paid"`.
The live process retains its same-origin checks. The read-only monitor refuses control requests.

Economy selection requires completed reconciliation, a flat wallet, no unresolved transactions,
no pending launches and an idle driver. An unsafe selection returns 409 without changing routing.
Preparation holds entries, covers the previous processed cursor, checks chain identity and refreshes gas and nonce state.
An upgrade with open obligations refreshes gas without resetting the nonce ladder.
Public catch-up waits for a lagging endpoint within the existing ten-second preparation timeout.
Failure leaves entries held and the previous selection in place. Retry the selection or perform START preparation.
STOP cancels preparation and never stops exit management.

Successful selection updates only `API_MODE` in the v2 switches file atomically.
Missing `API_MODE` defaults to `paid`. Invalid saved values refuse startup.
Dashboard changes apply immediately. Direct file edits take effect on restart.
START and restart recovery use the saved selection; neither silently promotes Economy to paid entry routing.
The older quiet/halted controllers cannot override manual Economy or its preparation hold.

`/api/state.rpcRouting.api` reports selection, effective routing, preparation and failures.
`paidUsage` reports rolling estimates; `lastExitRescue` identifies the latest paid rescue request.
The dashboard recommends Paid when current public coverage or feed/readiness checks fail.
The recommendation never spends money or switches providers.

## Activation evidence

This change starts in Paid unless Economy was previously selected. Do not activate Economy in production from unit tests alone.
Collect 24 hours of paired arrival and candidate-preparation evidence, with the final six hours held out
and at least 20 eligible opportunities. Use the running Paid baseline as the reference.
Collect the public comparison without signing or broadcasting, and without extra paid reference calls.

Check complete ordered coverage and existing entry deadlines during quiet periods.
During busy periods, check that stale data refuses new entries and the dashboard recommends Paid.
Record position and graduation recovery timings separately. Same-input replay proves decision parity;
it does not prove arrival timing, opportunity coverage, profitability or savings.
If the evidence is incomplete, leave production on Paid and record the missing evidence.

Deploy code separately from activation. Follow the v2 runbook for code-only deployment, snapshot preparation
and a restart while flat. Preserve strategy, sizes, drawdown and operator stops.
Measure provider usage after activation before claiming savings.

## Local verification, 2026-10-14

- v2: 785 tests passed across 40 files. Typecheck passed.
- v1 support tools: 1,128 tests passed across 92 files. Typecheck passed.
- Curve validation: 60/60 curves, 99,080/99,080 core checks and 409/409 tax checks were exact.
- Recorded replay: baseline and candidate produced identical output over 250,000 events, including kernel `6dba46ec4da1ee25`.
- Both replays retain 42 historical differences from recorded signatures. This comparison establishes no new difference; it does not establish live-fill equivalence.
- Chrome fixture: desktop and 390-pixel phone layouts showed the selector, preparation state, completed selection and uncapped rescue disclosure.
- HTTP tests verified recommendation escaping, same-origin protection and the read-only monitor's lack of controls.

The UI fixture had no signing key or provider connections. Transport tests used mocked endpoints.
Curve validation used the public RPC. Production was not deployed, restarted or switched.
The 24-hour timing comparison, six-hour holdout, 20 eligible opportunities and measured billing savings remain pending.
