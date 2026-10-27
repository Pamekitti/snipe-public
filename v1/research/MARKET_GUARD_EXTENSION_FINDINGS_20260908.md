# Expanded market guard results, 8 September 2026

The larger dataset covers **35 hours and 281 completed trades**, plus five failed attempts. It includes a full 24-hour slice with 191 completed trades. No tested setting can yet be called an optimum.

The full interval is 6 September 23:06 to 8 September 10:06 London time. The 24-hour interval starts on 7 September at 10:06 London time. The frozen endpoint is 8 September 09:06:52.972 UTC.

| Dataset | Duration | Completed actual trades | Stake |
|---|---:|---:|---|
| Previous test | 16 h 44 min | 155 | 0.02 ETH |
| Extended current-size episode | 19 h 11 min | 155 | 0.02 ETH |
| Earlier episode, separate diagnostic | 14 h 16 min | 106 | 0.02 ETH |
| Intervening smaller-stake episode | 1 h 34 min | 20 | 0.01 ETH |
| Complete expanded history | 35 h 1 min | 281 | Actual stake schedule |
| Last 24 hours within that history | 24 h | 191 | 171 at 0.02 ETH; 20 at 0.01 ETH |

The additional completed trades come from older history. Since the previous snapshot, the bot has made **zero new real trades**. The new 2 h 28 min supplies 210 usable observer outcomes, of which 30 meet the current market-sensor floors. It does not provide new real-money validation.

## Full 24-hour comparison

Each policy uses the same historical stake schedule and the account-risk settings read from the new live snapshot. Market windows and thresholds are fixed. The model carries risk state from the start of the 35-hour history through the 24-hour boundary.

| Policy | Window | Pause below / resume above, stakes | New recovery updates | Modeled 24 h profit | Versus baseline | Largest 24 h drawdown |
|---|---:|---|---:|---:|---:|---:|
| Baseline, today’s rules | 20 | -1 / +1 | 1 | $754 | $+0 | $156 |
| Faster window | 10 | -1 / +0 | 1 | $840 | $+86 | $124 |
| Two recovery updates | 20 | -1 / +1 | 2 | $796 | $+42 | $138 |
| Three recovery updates | 20 | -1 / +1 | 3 | $840 | $+86 | $100 |
| Five recovery updates | 20 | -1 / +1 | 5 | $854 | $+100 | $100 |
| Previous historical winner | 15 | -2 / +2 | 2 | $877 | $+123 | $100 |
| New historical winner | 20 | -2 / +2 | 5 | $887 | $+133 | $101 |

These are conditional recorded-trade replays, not profits the wallet earned. Actual recorded cash over those 24 hours was **$622**. The modeled baseline is higher because it applies today’s rules retrospectively to older trades. It can remove losses the historical configuration admitted.

The model cannot price newly permitted real fills from receipts that do not exist. Those opportunities are included only in the separate hypothetical scenarios below. The 0.01 ETH trades retain their actual cash results; no half-size profit was doubled to invent a 0.02 ETH result.

Dollars use the same frozen conversion throughout: $2,480.05 per ETH.

## All 35 hours

Older and current strategy periods are combined only in this historical-stake diagnostic. It does not create 35 hours under an unchanged live implementation.

| Policy | Net ETH | Illustrative profit | Largest drawdown | Completed trades retained |
|---|---:|---:|---:|---:|
| Baseline, today’s rules | +0.476223 | $1,181 | $212 | 223/281 |
| Faster window | +0.504821 | $1,252 | $199 | 219/281 |
| Two recovery updates | +0.493282 | $1,223 | $212 | 221/281 |
| Three recovery updates | +0.510719 | $1,267 | $212 | 210/281 |
| Five recovery updates | +0.516617 | $1,281 | $214 | 206/281 |
| Previous historical winner | +0.525882 | $1,304 | $212 | 205/281 |
| New historical winner | +0.526240 | $1,305 | $184 | 203/281 |

The full grid reran 207 existing definitions, or 206 distinct settings after the baseline update. Its new numerical winner is **20 launches, pause below −2, resume after five distinct readings above +2**. It beats the previous 15-launch winner by only **$1 across all 35 hours**. The unrounded gap is +0.000358 ETH, less than one dollar. This is a hindsight ranking.

## Missed trades change the answer

The scenario analysis prices 189 eligible original halt rejections; three additional opportunities have no usable outcome. It uses a causal adaptive exit target, the historical stake schedule, measured fitting-period gas, and a 45-second holding proxy. The return assumptions are shifted by −20, zero or +20 percentage points.

| Policy | Extra profit, conservative returns | Extra profit, unchanged replay | Extra profit, stronger returns |
|---|---:|---:|---:|
| Faster window | $-797 | $+171 | $+851 |
| Two recovery updates | $+21 | $+67 | $+155 |
| Three recovery updates | $+30 | $+104 | $+199 |
| Five recovery updates | $+11 | $-93 | $-166 |
| Previous historical winner | $+117 | $+75 | $-153 |
| New historical winner | $-27 | $-89 | $-220 |

Each cell compares a policy with the baseline under the same hypothetical fills across the full 35-hour interval. The observer’s native stake is 0.01 ETH, so it does not establish executable 0.02 ETH profits. These are scenarios, not confidence intervals or profit forecasts.

The new historical winner falls behind the baseline in **all three scenarios**. The previous winner falls behind when the missed opportunities earn stronger returns. Two and three recovery updates remain ahead in all three scenarios. That supports keeping them on the research shortlist rather than adopting the highest numerical winner.

The additional period after the old snapshot has no real cash results. In the hypothetical scenarios, the faster 10-launch policy is the only named candidate with additional cash activity in that period. Its result changes sign with the assumed fill return. The other named candidates add no hypothetical trades after that boundary.

## What changed from the first table

The live account setting `DD_RESUME_ON` changed from zero to +1 at 06:47 UTC. The new headline table applies +1 uniformly to every market-policy alternative. The old setting is also replayed separately in results.json. This research did not make the live edit.

The earlier 0.02 ETH episode is assessed separately. Two and three recovery updates tie the baseline there. Their benefit still comes from the previously inspected later episode, not from fresh independent trading.

The initial account state matters. Starting a new account-risk simulation at the 24-hour boundary yields different cash totals from carrying the preceding 11 hours of state. Both are saved. The table above uses continuity. Every displayed alternative stays above baseline in the clean-start recorded-trade sensitivity, but that does not resolve hypothetical-fill uncertainty.

## Conclusion

The best recorded-trade result remains fragile. It is not a supported live optimum. I would keep **two recovery updates above +1 on a 20-launch window** as the conservative research candidate and **three updates** as its challenger. Both retain the immediate pause below −1. This preference is based on simplicity and the missed-fill scenarios, not a claim that two beats three on independent data.

A five-percentage-point adverse shift in each market outcome removes the advantage of both persistence candidates on the current-size episode. The largest numerical winners survive that signal stress but fail missed-fill tests. No candidate dominates across these uncertainties. More independent current-era execution evidence is still missing.

## Verification

- All six previously reported policies reproduce their prior saved profit and drawdown exactly under the old snapshot and settings.
- All 286 actual attempts in the expanded scope are closed and have receipt-booked cash. There are no unresolved positions in the snapshot.
- Historical stake boundaries match every actual attempt. Mixed-stake return statistics use each trade’s actual stake as denominator.
- No usable observer outcome was rewritten between snapshots. Ten failed observation rows were retried without producing usable bars.
- Wallet accounting excludes falsely flat historical samples during the repaired holding. The net residual is −0.000004661 ETH, with no unallocated residual.
- Thirty-five focused tests pass. They cover cash accounting, timing, distinct confirmations, risk continuity, mixed-stake return denominators and actual-size capacity.
- No live setting, code deployment, automatic monitor or scheduled task was created by this research.

## Required time bins and spread

The following bins end at the fresh snapshot. Older-era cash remains a separate diagnostic. A current-era unavailable bin has no current-era evidence, even when the older diagnostic has rows. Values are in ETH; standard deviation is the sample estimate. These bins describe actual historical cash, not a selected policy.

**24h**

| UTC interval | Current-era coverage | Current net | Current mean | Median | Sample sd | n | Older diagnostic net / n |
|---|---|---:|---:|---:|---:|---:|---|
| 2026-09-07 09:06 to 2026-09-07 12:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | -0.070315 / 13 |
| 2026-09-07 12:06 to 2026-09-07 15:06 | partial | -0.000144 | -0.000007 | -0.000836 | 0.010234 | 22 | 0.086479 / 24 |
| 2026-09-07 15:06 to 2026-09-07 18:06 | current-era | 0.059232 | 0.002369 | -0.001051 | 0.014536 | 25 | unavailable / 0 |
| 2026-09-07 18:06 to 2026-09-07 21:06 | current-era | 0.183434 | 0.002912 | -0.000975 | 0.017401 | 63 | unavailable / 0 |
| 2026-09-07 21:06 to 2026-09-08 00:06 | current-era | 0.037870 | 0.001262 | 0.000017 | 0.006618 | 30 | unavailable / 0 |
| 2026-09-08 00:06 to 2026-09-08 03:06 | current-era | -0.025408 | -0.001954 | -0.001825 | 0.006215 | 13 | unavailable / 0 |
| 2026-09-08 03:06 to 2026-09-08 06:06 | current-era | -0.014565 | -0.004855 | -0.005119 | 0.000697 | 3 | unavailable / 0 |
| 2026-09-08 06:06 to 2026-09-08 09:06 | current-era | -0.005979 | -0.001993 | -0.004694 | 0.005872 | 3 | unavailable / 0 |

**7d**

| UTC interval | Current-era coverage | Current net | Current mean | Median | Sample sd | n | Older diagnostic net / n |
|---|---|---:|---:|---:|---:|---:|---|
| 2026-09-01 09:06 to 2026-09-02 09:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | unavailable / 0 |
| 2026-09-02 09:06 to 2026-09-03 09:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | unavailable / 0 |
| 2026-09-03 09:06 to 2026-09-04 09:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | unavailable / 0 |
| 2026-09-04 09:06 to 2026-09-05 09:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | unavailable / 0 |
| 2026-09-05 09:06 to 2026-09-06 09:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | unavailable / 0 |
| 2026-09-06 09:06 to 2026-09-07 09:06 | unavailable | unavailable | unavailable | unavailable | unavailable | 0 | 0.102640 / 90 |
| 2026-09-07 09:06 to 2026-09-08 09:06 | partial | 0.234439 | 0.001474 | -0.000872 | 0.013397 | 159 | 0.016164 / 37 |

**Full historical-stake replay trade-return distributions**

| Policy | Mean return | Median | Sample sd | n |
|---|---:|---:|---:|---:|
| Baseline, today’s rules | 12.91% | -4.54% | 74.15% | 223 |
| Faster window | 13.80% | -4.12% | 72.59% | 219 |
| Two recovery updates | 13.41% | -4.36% | 74.37% | 221 |
| Three recovery updates | 14.53% | -4.33% | 75.80% | 210 |
| Five recovery updates | 14.96% | -4.33% | 76.45% | 206 |
| Previous historical winner | 15.25% | -4.12% | 76.52% | 205 |
| New historical winner | 15.41% | -4.33% | 76.83% | 203 |

## Reproduction

```bash
python3 -m unittest discover -s bot/research -p "test*guard_audit.py"
PYTHONHASHSEED=0 python3 v1/research/market_guard_extension.py \
  --snapshot v1/data/market-guard-extension-20260908/snapshot.json.gz \
  --previous v1/data/market-guard-audit-20260908/snapshot.json.gz \
  --out v1/data/market-guard-extension-20260908/results.json
python3 v1/data/market-guard-extension-20260908/render_report.py
```

Snapshot SHA-256: `f8d752aa6b5ab1d8854263b82aeadaf45eb139c98c26ac0403e506da773a9f32`.

The test boundaries and comparisons are in [MARKET_GUARD_EXTENSION_PROTOCOL.md](MARKET_GUARD_EXTENSION_PROTOCOL.md). The full results, old-account controls, source copies, policy definitions and raw snapshot are in `v1/data/market-guard-extension-20260908/`.
