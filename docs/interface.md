# The interface and what its numbers mean

The dashboard began as an operating screen for a wallet. It later had to explain why a book stopped, whether execution matched the model, and which evidence was missing.

[Open the visual gallery](../assets/screenshots/index.html).

## Historical screenshots

| Capture | Date or era | Status | What it establishes |
|---|---|---|---|
| [Early live dashboard](../assets/screenshots/v1-early-live.png) | Exact capture time unknown; screen baseline reads September 6 | User-supplied historical live capture | Displayed +$469.37 since baseline and +$460.55 over 256 trades in 24 hours |
| [Compact desktop](../assets/screenshots/v1-compact-preview.png) | September 7 refinement, documented historically | Historical preview of captured data | Displayed +$910.45 in the 24-hour column; not independently recomputed for publication |
| [Policy view](../assets/screenshots/v1-policy-preview.jpg) | September 12 preview, captured state documented in original QA | Historical preview | Separates today's cash, account value, drawdown, and policy state |
| [Phone view](../assets/screenshots/v1-phone-preview.png) | September compact-layout work | Historical preview | Shows the responsive operating layout |
| [V2 desktop](../assets/screenshots/v2-demo-desktop.jpg) | Prepared for this edition from a September 19 ledger view | New historical reconstruction | Demonstrates the preserved renderer with sanitized records |
| [V2 phone](../assets/screenshots/v2-demo-phone.jpg) | Same reconstructed view | New historical reconstruction | Demonstrates phone layout; not an original live capture |

Original captures are preserved privately. Selected published images contain no direct owner-wallet or transaction identifiers. New demo images are explicitly labeled reconstructions.

## Try the demo

Open [the static dashboard](../demo/index.html), or run `npm run demo` and visit the loopback address printed by the server.

Choose taxed or untaxed, then select a chart window. Hover or touch the chart for a tooltip. Expand a recent-trade row for recorded details. Choose the retirement view to see the final quiet period, or the missing-data fixture to inspect unavailable evidence.

The chart sums recorded position deltas. Separately booked wallet gas is excluded. The demo does not invent observer outcomes, historical guard states, wallet paths, or dollar conversions. Those fields stay unavailable. The final wallet balance appears only in the retirement view at its captured timestamp.

## Design decisions

- Show a missing reading as unavailable, rather than zero.
- Keep the wallet-wide outcome separate from a selected book.
- Keep account value, booked returns, and open-position estimates distinct.
- Preserve chart controls and trade-row interaction in the historical edition.
- Remove trading controls entirely from the demo.

The [original QA notes](DASHBOARD_QA.md) and [policy-alignment notes](DASHBOARD_POLICY_QA.md) preserve the interface changes and their historical verification limits.
