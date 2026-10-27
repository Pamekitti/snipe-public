# Lighter coverage of the coins Snipe actually bought

The current Lighter market list cannot support taxed and untaxed short books that mirror Snipe's existing Pons books.

## Result

This check used every signed Pons buy in the current V2 tape, from 16 September 2026 16:44 UTC through 22 September 2026 10:28 UTC.

| Cohort | Distinct bought tokens | Exact Lighter identity matches |
|---|---:|---:|
| Untaxed | 614 | 0 |
| Taxed, 50 to 200 bps | 192 | 0 |
| Total | 806 | 0 |

All 806 token symbols were read successfully from their contracts. Lighter listed 57 active perpetual markets at the time of the check.

Three Pons tokens had tickers that also appeared in Lighter: one `OPENAI` and two unrelated contracts named `HYPE`. These were ticker collisions, not identity matches. None of their contract addresses appeared in Lighter's asset registry. Each Lighter market also existed before the corresponding Pons token launched. Two different Pons contracts sharing the `HYPE` ticker demonstrates why the ticker cannot identify the underlying asset.

## What Lighter exposes

Lighter's public perpetual metadata identifies a market by market ID and symbol and publishes its oracle index price. It does not publish an underlying Pons token contract address. Its separate asset registry does publish Robinhood Chain contract addresses for registered transferable assets. None of the 806 Pons token addresses matched that registry.

Pons warns that names and symbols can be copied and that users should identify tokens by contract address. The same rule is required here. A ticker match alone cannot route money.

## Verdict

Shorting works on Lighter for assets that Lighter has explicitly listed. It does not provide a general short transaction for arbitrary new Pons coins.

Therefore:

- A Lighter strategy for listed assets such as PONS, CASHCAT, ETH or HYPE remains technically possible.
- Two short books matching the existing taxed and untaxed launch books are not technically available through Lighter today.
- Research on listed-asset shorts would be a separate strategy with a different asset universe. It cannot be treated as the inverse of the Pons launch strategy.

## Reproduction and limits

Run from the repository root:

```sh
node v1/research/core/short_coverage.mjs
```

The instrument reads the local tape, resolves each bought token through a batched read-only chain call, and compares addresses and symbols with Lighter's current public APIs. It writes a timestamped `coverage.json` and hashes the source and result in `manifest.json`.

The preserved result is under `v1/data/research/short-coverage-2026-09-22T11-38-32-839Z/`. The result applies to Lighter's catalog at 22 September 2026 11:38 UTC and the recorded tape cutoff above. It does not prove that no short venue exists elsewhere, and later Lighter listings may change coverage.

No wallet key was loaded, no order was submitted, and live trading was unchanged.
