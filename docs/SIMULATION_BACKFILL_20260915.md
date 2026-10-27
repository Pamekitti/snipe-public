> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Shared simulation backfill, September 15

The new shared engine replayed 913 of 2397 archived opportunities. 1484 remain unavailable. This is diagnostic reconstruction, not activation evidence.

## Frozen coverage

- Capture starts: 2026-09-13T14:36:46.809000+00:00.
- Capture ends: 2026-09-15T09:06:04.010000+00:00.
- Comparable account prefix ends: 2026-09-13T14:42:17.105000+00:00.
- Missing frozen execution inputs: 1451.
- Incomplete source coverage: 32.
- Missing source publication: 1.

Earlier September research records are not imported because their timing, entry limits and approval costs do not meet this production model's evidence requirements. Historical price paths alone cannot recover those missing observations.

## Calculation and display

The replay calls the production execution engine, six execution scenarios, adaptive target scorer, account reducer and selected 15/8 guard. It recalculates each outcome. It never copies old P&L into the new model. Each virtual entry pins a target using preceding compatible scores. Missing selector evidence leaves the real-policy accounts blocked; the independent shadow account may warm up using the existing default target.

Recorded stakes, filters, capacity, template history and non-market stops remain in force. The capture includes both 0.02 ETH and 0.005 ETH stake eras. It is not a current-stake rerun of all September. Historical source/capture completion floors provide modeled availability. They are not new prospective publications.

The account stops at its first unresolved admitted execution or capture gap. Later individual replays remain in the outcome ledger, but do not extend the wallet curve. Win retained and loss retained remain unavailable when their reference denominators are zero.

The dashboard has separate Live capture and Replayed history views. Actual wallet cash remains receipt-based. Replayed history is frozen at capture and cannot supply live guard evidence.

## Reproduction

Run from bot/:

```sh
ENV_FILE=.env.example MODE=observe LIVE=0 node --import tsx research/core/shared_backfill.ts data/research/20260915-shared-backfill-v1/input.json.gz data/research/20260915-shared-backfill-v1/replay
```

The input and model hashes are in replay/manifest.json. The complete outcome ledger and unavailable reasons are in replay/history.json. The display artifact has its own SHA-256 manifest. The input contains no trading key or environment file.

## Remaining blockers

A continuous September paper-wallet reconstruction remains blocked by missing historical execution inputs and unresolved capture gaps. Historical cash fidelity and prospective actual-trade accuracy remain unpassed. Auto stays stopped.

## Deployment verification

Build `af61d4f` serves the replay view under operator STOP. All 971 host tests passed, including the 8,056 historical baseline checks. Both TypeScript checks passed. The 56 focused local dashboard tests passed.

The original eight-pane rendering check was insufficient: most panes contained no usable data. The corrected interface replaces unavailable plots with their reasons, exposes all 913 individual launch results in a paginated table, and offers a direct zoom to the four continuous paper trades before the first gap. That incomplete paper segment lost 0.020139123 ETH at its recorded stake sizes. It is not a complete wallet result. Incomplete indicator windows do not render as zero lines.

Live desktop and 390-pixel mobile checks passed with no JavaScript errors or page overflow. Checks covered pagination, explicit unavailable retention, incomplete-cash labeling, the prefix zoom and the live view's history link. Screenshots were inspected. The artifact SHA-256 is `e863f68d73fac3eb391f80cf8a2b61de30e5e315dfb6264b658a20664f98e796`.

Open the available paper segment at http://127.0.0.1:8787 Live capture remains available at http://127.0.0.1:8787 The header always describes current live status.

After restart the bot had zero open positions and operator STOP remained effective. The capture worker responded without a queue error. Live guard evidence remains unverified and blocked by `selector_unresolved_execution`. The display correction does not resolve that execution or restore historical coverage. No trading settings or accounting were changed.
