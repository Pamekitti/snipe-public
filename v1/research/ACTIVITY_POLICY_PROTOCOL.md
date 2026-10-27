# Activity and recovery research, 8 September 2026

Preserve Market +2 with its existing stale exception as the benchmark. This study
changes no live code, settings, capital, or controls. Earlier results remain at
`v1/data/recovery-policy-20260908`; record their hashes before and after this run.

The screenshot suggests profit coincides with more launches and positive stakes.
Launch counts are not ETH turnover. More opportunities can increase total profit
without improving profit per attempt. Compare conditional returns within stake
bands using signals available strictly before the next entry.

Freeze these distinct entry overlays before calculating their performance:

1. Launch pace: the last hour's book-compatible detected launch count is at least
   the hourly rate over the preceding six hours.
2. Turnover per coin: mean external buy plus sell quote in a launch's first 45
   seconds, across coins scored in the last hour, is at least its preceding
   six-hour mean.
3. Buyer participation per coin: the same comparison for unique external buyers.
4. Net buying: external buy quote exceeds external sell quote over the last hour.
5. Broad gains: the last 20 scored returns remain positive after removing their
   largest winner.
6. Recent direction: the newest five scored returns sum above zero.
7. Demand and pace: both buyer participation and launch pace pass.

Every overlay keeps Market +2, DD +1, the original position sizes, capacity and
account-risk simulation. It may reject a new entry but never changes an exit.
This is a comparison of entry permission policies, not a search over thresholds.
Do not tune the rules after viewing the final six hours.

Use detected_at for launch activity. Use only score records with scored time
strictly before entry. Raw curve logs come from the earlier complete path cache.
Aggregate first-45-second activity and reveal it no earlier than the launch's
recorded scoring time and 45 seconds after launch. Cached paths approximate age
using the same 100 ms block convention as the existing replay. Exclude our own
wallet and the coin's deployer as sender or recipient. Repeated wallets may still
be related and volume may still be manufactured. This is turnover on cached,
screened launch curves, not total exchange or chain volume.

An activity comparison needs at least five recent and 20 preceding coins and 80%
cache coverage in both windows. Missing evidence falls back to +2. Record fallback
frequency. This fallback prevents missing paths from being treated as zero demand.
Broad gains needs 20 fresh scores; direction needs five fresh scores. Freshness
uses the existing three-hour oldest-launch rule. Launch pace needs a full seven
hours of detection history. Its tax and exemption floors match the market sensor.

Primary evidence is current-size actual closed attempts from the new read-only
snapshot. Report the last 24 hours in eight bins and the last seven days in seven
bins ending at this snapshot. Mark periods outside the current era unavailable.
Preserve actual receipts via COALESCE(onchain_pnl_wei,pnl_wei), including failed
attempt costs. Do not invent fills during manual stops or scale smaller trades.

Keep the final six hours out of policy selection. The screenshot and prior
conversation already reveal some outcomes there, so this is a protected diagnostic
split, not an untouched holdout. Count its actual attempts before claiming a test.

Secondary evidence reuses the frozen 14-day opportunity model and exact +2 baseline.
Run base, slower exits, a five-percentage-point execution haircut, and alternative
graduation valuation. The latter is not an executable price or upper bound.
Use a second score-delay assumption to check reconstructed signal timing.
Compare whole-account paths, drawdown, missed winners, avoided losses, and per-day
deltas. These scenarios are not independent samples. Historical eligibility,
adaptive exits, funding, execution and counterparties' reactions remain imperfect.

Validate strict timing with synthetic tests, match the old benchmark's exact cash
and actions, reconcile daily totals and added/removed cash, record every mean with
median, sample standard deviation and n, and save sources and input hashes.
No deployment decision follows from this retrospective exploration alone.
