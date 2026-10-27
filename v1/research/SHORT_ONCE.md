# One-shot short tester

`core/short_once.py` implements a user-operated short-opening and closing test on Robinhood Chain Lighter. Preview is the default. Authenticated execution has not been validated with funds.

The tester applies to a listed perpetual market. It does not make newly launched Pons tokens shortable and does not add taxed or untaxed short books to Snipe.

## Preview

From the repository root:

```sh
python3 -B v1/research/core/short_once.py --symbol PONS --max-eth 0.001
```

`--max-eth` is converted into a cap on position exposure using Lighter's current ETH mark price. It is not a leveraged collateral amount. The preview uses public market data and does not load an API signing key or inspect an account.

On 22 September 2026, the checked PONS minimum was 20 contracts, approximately 12.70 quote-currency units. Both 0.001 ETH and 0.0005 ETH exposure budgets were below that minimum and were refused. A preview with `--max-quote 15` selected 20 contracts and sent zero orders. Prices and venue minimums can change.

## Function

```python
result = await short_once(venue, trade_plan, journal, execute=False)
```

`plan(market, book, cap)` calculates the minimum legal quantity from current market data. It enforces a hard maximum of 20 quote units of estimated initial exposure. It will not silently increase a smaller caller-supplied cap. Prices and quantities use decimal arithmetic and venue increments.

With execution enabled by the user, the function makes at most one opening attempt. It waits for terminal order evidence, handles partial fills, and uses only reduce-only buys to close. There are at most three close attempts. A stale flat account response cannot override a confirmed opening fill. An uncertain opening is never automatically retried.

## User-run execution prerequisites

- A separate Lighter account used only for this test, with no positions or pending/resting orders. Do not run another trader on it concurrently.
- A dedicated Lighter API signing key, index 2 through 254. This is not the Snipe wallet private key. Provide it locally through `LIGHTER_TEST_API_PRIVATE_KEY`; never paste it into chat or commit it.
- The official `lighter-sdk` package with the documented `SignerClient` interface and Robinhood signing chain ID 466324. `certifi` supplies a certificate bundle where Python's system CA configuration is missing. SDK installation and funded authentication were not performed during development.
- An explicitly selected symbol and exposure cap. The tester requires available collateral of at least twice the estimated initial exposure. This reserve is a conservative tester rule, not a venue requirement or a guarantee against losses.
- A new private journal path. The script refuses to reuse an existing journal. Each intent and observed result is flushed before continuing.

The user-only execution arguments are `--execute`, `--account-index`, `--api-key-index`, and `--journal`, in addition to the symbol and budget. Without `--execute`, the CLI cannot construct the signing client or submit orders.

The tester does not deposit, withdraw, change leverage, create accounts or keys, load Snipe's environment, control Snipe, or deploy anything. Account eligibility and SDK compatibility must be verified independently before funded use.

## Limits and results

A 0.5% price bound applies to each opening or closing attempt. It limits acceptable execution prices, not total loss. A move between quotes, a process crash, an API outage, an unfilled close or a liquidation can leave the test incomplete. There is no background recovery service. The user must inspect the test account after an abort and handle any remaining exposure.

- `preview_only`: no order submitted.
- `NO_OPEN_FILL`: the opening order was terminal with zero confirmed fill.
- `OPEN_AND_CLOSE_CONFIRMED`: opening and closing quantities matched, the final reported position was flat, and no active/pending orders or unresolved order IDs remained.
- `UNRESOLVED_CHECK_ACCOUNT` or `ABORT_CHECK_ACCOUNT`: the test is not proven complete; inspect the account and journal.

Even `OPEN_AND_CLOSE_CONFIRMED` is API evidence, not an independent on-chain settlement certificate. The collateral change is recorded, but it is not labeled reconciled wallet P&L. Fees, funding, collateral assets and any external changes need separate accounting.

## Verification performed

Fourteen offline tests passed for minimum sizing, budget/depth refusals, preview isolation, existing-position/order refusals, partial fills, partial closes, stale account reads, timeouts, unresolved orders and zero-fill handling. Three public previews were run. No signer was constructed and no real-money or testnet order was sent.

```sh
python3 -B -m unittest bot.research.test_short_once -v
```

API references: [Robinhood Lighter guide](https://apidocs.rh.lighter.xyz/docs/get-started), [order endpoint specification](https://apidocs.rh.lighter.xyz/reference/orderbookorders), and [official SDK source](https://github.com/elliottech/lighter-python/blob/main/lighter/signer_client.py).
