# Static historical dashboard

This demo reuses the retired V2 renderer and chart code. It does not load the trading entry point, signer, environment reader, or provider client.

Run `npm run setup`, `npm run demo:build`, then `npm run demo` from the repository root. Open the printed loopback URL. The prebuilt `index.html`, `views.js`, and `client.js` can be served by any static HTTP server. No application backend is required.

The three bundled states are the September 19 trading-history view, the October 25 retirement view, and a deliberately missing-data interface fixture. Both books and six chart windows are available.

Numerical history comes from sanitized stored positions. Historical feed and market-observer series are unavailable and are not reconstructed as zeros. Position P&L excludes wallet gas recorded separately. The configuration shown is the retired configuration, not proof of every historical switch value.

The local server refuses non-read requests. Its content-security policy blocks connection APIs. The static client has no network or trading control code. No service worker, analytics, CDN, or remote font is used.
