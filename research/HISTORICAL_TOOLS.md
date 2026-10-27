# Historical validation support

This directory is not the current research workspace. Current analysis lives in
`v1/research/`. Do not use files here to choose a live strategy.

The remaining files serve two purposes:

- `v1/scripts/validate.ts` reads the historical datasets under `research/data/` to
  prove the bot's integer curve math against chain history.
- Comments in the bot cite a small set of August investigations as historical evidence.

## Retained code

| Files | Reason retained |
|---|---|
| `engine.py`, `load.py`, `realistic.py`, `sim2.py` | Dependency chain for cited historical analyses. |
| `era_dynamics.py`, `era_gate.py`, `exempt_validate.py`, `fp_anatomy.py`, `idle2.py` | Files cited by source comments. Their numbers describe past eras. |
| `launches.mjs`, `pull_trades.mjs`, `pull_bb.mjs`, `state.mjs`, `params.mjs` | Acquisition tools for the validator's historical inputs. |
| `pull_more.mjs`, `meta_want.mjs`, `pull_meta.mjs`, `refresh.sh` | Corrected August refresh path retained for reproducibility. |

The original notebooks, parameter sweeps, dashboards, reports, backups, and intermediate
variants were removed from the active checkout. Git history remains the archive.

Read `DATA.md` before moving or deleting anything under `research/data/`.

## A note on `chain-log` captures (2026-09-14)

`bot.simulation.db` stopped capturing one row per chain log on 2026-09-14. It had reached
935,876 rows and 719 MB in twenty hours, of which the replay read 16%. The arrival times the
replay actually wanted now ride a 30-minute ring in the main process and land as a single
`curve-arrivals` capture per opportunity, holding `[transactionHash, logIndex, observedAt]`
and nothing else.

Anything reading `kind='chain-log'` (`core/unified_fidelity.py` does) still works on rows
captured before that date and will find none after it. To read the new shape, take
`payload.arrivals` from the `curve-arrivals` row for the curve instead.
