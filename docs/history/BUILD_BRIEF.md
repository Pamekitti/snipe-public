# Pons sniper ,  build brief

Written 2026-08-17 after the rev-3 research pass. Everything here is measured from
chain data unless marked ASSUMPTION. Research and raw data in `research/`.
Report: https://claude.ai/code/artifact/c15e991b-52eb-471e-bb20-fb1574d39386

Goal set by the user: **top-quartile performance from day one.** Median bots lose money,
so "decent" is not a viable target. This brief is organised around what actually
separates the winners from the median, which is mostly exit discipline, not entry cleverness.

---

## 1. Calibrated expectations

Being top quartile in this business is worth roughly **$100–160/day on ~$500 of working
capital**, not more. The two best live bots earn +5.9% and +11.3% return on turnover;
the median round-tripping bot loses. The edge is also decaying (see §7). Build for
top quartile because anything less is negative, not because the ceiling is high.

| Cohort | Return on turnover | Notes |
|---|---|---|
| Best live bot (`0x03c724b1c5`) | +11.3% | 268 trades, entry 4 s, hold 55 s |
| Second (`0xe224ef47ac`) | +5.9% | 1,007 trades, entry 1.8 s, hold 34 s |
| My simulation with full frictions | +1 to +3% | the gap to the winners is unexplained; see §8 |
| Median round-tripping bot | −9.6% to −15.5% | 24% of V2-era bots profitable |

---

## 2. The venue (all verified on-chain)

- Chain: Robinhood Chain, **chainId 4663** (`0x1237`), Arbitrum Orbit, gas token ETH.
- Blocks **100 ms** (measured 9.97/s). Single sequencer, **first-come-first-served, no
  public mempool, no Timeboost**. Gas price 0.02–0.03 gwei.
- Sequencer: `https://sequencer.mainnet.chain.robinhood.com` ,  accepts JSON-RPC, resolves
  to AWS **us-east-2 (Ohio)**.
- Feed: `wss://feed.mainnet.chain.robinhood.com` (Nitro sequencer feed, sees ordered txs
  ~100 ms before RPC). Decoder reference: github.com/chainstacklabs/robinhood-chain-sequencer-feed
- Public RPC: `https://rpc.mainnet.chain.robinhood.com` (rate limited, ~100 req/s per IP,
  1 websocket per IP). Alchemy/QuickNode/dRPC also support the chain.
- Explorer API used throughout: `https://robinhoodchain.blockscout.com/api/v2/...`

### Pons V2 contracts
| Role | Address |
|---|---|
| `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| `PonsV2LaunchAndBuy` (launcher) | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |

Events:
- `TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)`
  topic `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`
- `CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)`
  topic `0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455`
- `CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)`
  topic `0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df`

Curve interface: `buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable`
(~98k gas, $0.0055) and `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)`
(~177k gas, $0.0101). No router. Buys need no approval; sells need ERC20 approval.

### Launch config (read live before trading ,  Pons can retune)
`getLaunchConfig(0)`: supply 1e27, curveFeeBps 100, phantomQuote 1.68 ETH,
graduationThreshold 4.2 ETH, poolFee 0, tickSpacing 200.
Factory: `snipeTaxStartBps 9900`, `snipeTaxSeconds 3`, `maxCreatorTaxBps 1000`, `launchFee 5e14`.

Pricing is constant product on `(phantomQuote + realQuote)` vs token reserve, with
`reservedTokens = supply * phantom / (phantom + threshold)` held back for the graduated pool.
Exact replay lives in `research/realistic.py` (validated to <1e-6 vs on-chain outputs).

### Snipe tax ,  the thing that shapes the whole strategy
`currentSnipeTaxBps = snipeTaxStartBps >> ((elapsed_seconds * 14) / 3)`, taken off the
quote leg **before** pricing. So: second 0 → 98%, second 1 → 6.2%, second 2 → 0.19%,
second 3+ → 0. Creator plus up to 32 declared wallets are exempt.

**Consequence: enter at elapsed 2 s (block ≈ +20).** Verified best across every window.
Earlier is taxed, later decays. You are waiting on a clock, not racing anyone.

---

## 3. Strategy spec

```
UNIVERSE   pairToken == 0x0 (ETH-paired)          ~61% of launches
FILTER     creatorTaxBps <= 100                    kills the 24% that set 10%
FILTER     creator's same-tx CurveBuy >= 0.05 ETH  ~20% of launches pass
ENTRY      first block with timestamp >= launchedAt + 2
SIZE       0.005-0.01 ETH live pilot; 0.02 ETH max ever (see §5)
EXIT       trailing stop 20% armed at +20%; hard stop -40%; hard cap 5 min
           (winners actually hold 2-55 s ,  prefer tighter caps, see §4)
VOLUME     ~280-350 signals/day
```

Rules that are non-negotiable, because they are what separates winners from losers:

1. **One entry per token, ever. Never average down.** Winners buy 1.0–1.24 times per
   token; losers buy 3–17 times per token. This is the single cleanest divider in the data.
2. **Always exit.** 64 of 101 wallets studied were effectively bag-holders (sells < 50%
   of buys) and they are the bulk of the −568 ETH the cohort lost. An exit that fails must
   retry, not give up.
3. **Hold seconds, not minutes.** Profitable bots: 2–55 s median. Losing bots: 100–850 s.
4. **Do not hold to graduation.** Lost money in every test. Only 0.81% graduate.

---

## 4. Where the money actually is: the exit

Friction ladder, same trades, measured (dev≥0.05 cohort, 0.02 ETH):

| | Return on turnover |
|---|---|
| Frictionless fantasy | +17.7% |
| **+ exit lag 200 ms** | **+8.7%** ← biggest single loss |
| + 2 rival bots | +7.2% |
| + 10% order-flow haircut | +4.0% |
| + 5% missed, 5% reverted | +4.0% |

Exit lag cost ~9 points; everything else combined cost ~4.7. So engineering effort belongs
on the exit path, in this order:

1. **Maintain local curve state from the event stream.** Mirror `quoteReserve`/`tokenReserve`
   for every open position by applying `CurveBuy`/`CurveSell`/`BuybackLocked` as they arrive.
   Exit decisions and `minQuoteOut` must require **zero RPC round trips**.
2. **Pre-sign and pre-approve.** Approve the curve for max tokens immediately after the buy
   confirms, not at exit time ,  otherwise the sell needs an approve first and you eat an
   extra round trip exactly when it matters. VERIFY: check whether `sell()` pulls via
   `transferFrom` (it does ,  `safeTransferFrom` in the curve source), so approval is required.
3. **Pre-build the exit transaction** at entry time with a range of `minQuoteOut` values, so
   firing is a signature and a socket write.
4. Marginal after that: exit lag 200 ms → 1 s costs only 0.5 pp. Do not over-invest here.

Latency reference: UK → sequencer ~480 ms measured; US-East VPS ~15–25 ms; AWS Ohio ~1–2 ms.
Entry latency is irrelevant (2,000 ms of headroom). Only exit lag matters, and modestly.

---

## 5. Capacity ,  hard ceiling around $500

Daily P&L peaks at ~0.02 ETH/trade and goes negative by 0.05 ETH, because your own impact
is what you sell into (0.01 ETH moves a fresh curve 1.2%; 0.05 ETH moves it 6.0%).

| Size | Bankroll needed | ROT | Gross $/day |
|---|---|---|---|
| 0.005 ETH | $132 | +3.1% | +$90 |
| 0.01 ETH | $264 | +2.6% | +$152 |
| 0.02 ETH | $528 | +1.7% | +$193 |
| 0.03 ETH | $792 | +0.6% | +$107 |
| 0.05 ETH | $1,320 | −1.4% | −$418 |

Max 14 concurrent positions at a 5-minute cap. **Do not fund beyond ~$500.**

---

## 6. Rollout plan

**Phase 0 ,  latency canary (before anything else).** Send yourself 0-value txs at random
intervals from laptop and from a candidate VPS; measure send → landed-block distribution.
~$0.005 per probe. This answers the hosting question with real numbers.

**Phase 1 ,  shadow mode.** Full production path: same subscription, same decision logic,
same tx construction, real signing, **no broadcast**. Log t_detect / t_decide / t_signed /
t_would_send, target block, calldata. Reconstruct fills afterwards with the replay engine in
`research/realistic.py`. Expect paper to be optimistic by 2–4 pp (it cannot model your own
impact or rival reaction).

**Phase 2 ,  live pilot, $150 at 0.005 ETH, 7–10 days, ~1,500–2,000 trades.** That is the
sample needed to distinguish +1% from 0% given per-trade dispersion. Expected P&L −$40 to +$40.
Run shadow and live on the same signals; the gap between them is your measured impact cost.

**Go/no-go:** scale to $500 only if live return on turnover clears **3% over 500+ trades**.
That threshold is roughly the top quartile, and since bot performance persists across periods
(Spearman +0.86), clearing it is genuinely predictive. Below it, stop ,  the data says you are
the median bot and the median bot loses.

**Hosting:** laptop is fine for Phase 0–1 (480 ms sits inside a 2,000 ms entry window).
Personal $6/month VPS in Ashburn/Virginia for Phase 2 (~10–15 ms from Ohio, worth $2–5/day
versus true colocation). **Not the employer's AWS account** ,  declined, and the measured
benefit does not justify it.

---

## 7. Kill switches and decay

The edge decayed from +11.6% to +1.8% return on turnover over 13 days while early-bot density
per launch doubled (0.64 → 1.34). Assume a half-life of roughly a week.

- Stop if 30-day return on turnover < 2%, or on any $150 drawdown.
- **Re-test the dev-buy filter against no-filter monthly.** It is regime-specific: worth
  +4.8% in the V2 era but +0.57% in the V1 era, where it was *worse* than no filter.
- **Watch for a Pons V3.** When V1 → V2 happened, V1's economics hit −5.5% within days.
  A migration is an extinction event for a bot tuned to the old venue.
- Re-read factory params on startup; Pons can retune snipe tax and fee splits at will.

---

## 8. Known unknowns (worth attacking during the build)

1. **The winners beat my simulation** (+5.9%, +11.3% vs my +1–3%). Either my friction
   assumptions are too harsh, or they select on something I did not find. Resolving this is
   the highest-value research left ,  it is the difference between "marginal" and "good".
2. **The order-flow haircut is a judgement**, not a measurement (10% central, 5% kind).
   It moves the answer more than anything else. The live pilot measures it directly.
3. **Late-entry archetype unexplained.** Several persistent winners enter 2–41 min after
   launch with 48–73% win rates, but every mechanical version of that I tested lost 3–20%.
   They are using information not in chain state.
4. **Non-ETH pairs untested** ,  39% of launches pair against tokenized stocks/stables.
5. Pools.trade (Uniswap's launchpad) and Noxa.fun untested entirely.

---

## 9. Repo map

```
research/
  realistic.py        friction simulator (exit lag, rivals, bankroll cap, haircut, miss/revert)
  load.py             V2 dataset loader + curve replay primitives
  freshtest.py        forward test harness on post-cutoff data
  v1sim.py            in-tick Uniswap V3 replay (validated p99 2.1e-16) + fee calibration
  v1_backtest.py      V1-era strategy backtest
  combined.py         cross-era results table
  botpersist.py       skill-vs-luck persistence test
  winners.py          reverse-engineering profitable wallets
  lateentry.py        late-entry hypothesis (negative)
  impact.py           own-order price impact, V1 vs V2
  data/               all raw pulls (trades, launches, states, V1 swaps, results JSON)
```

---

## 10. Corrections from the build (2026-08-17)

Everything below was verified against the live chain or the factory's verified Solidity
source while building `bot/`. Where it contradicts an earlier section, this section wins.

**The curve source is available and now ported exactly.** The per-token curve is not
verified on blockscout, but the factory is, and its verification bundle contains
`PonsV2BondingCurve.sol` and `PonsV2BondingCurveMath.sol`. All 46 selectors derived from
that source are present in deployed curve bytecode. `v1/src/state/curve.ts` is a bigint
port of it, validated by replaying 90 curves from genesis: **128,393/128,393 trades
reproduced exactly**, plus 565/565 on the snipe-tax schedule. Not to 1e-6 ,  exactly.

Three things the earlier research had wrong or missing, each of which would have caused
silent mispricing:

1. **Buy slippage is a ratio bound, not a quantity bound.** The contract reverts when
   `spent * minTokensOut > received * tokensOut`. It only reduces to `tokensOut >=
   minTokensOut` when the fill is not clamped.
2. **`FeesSwept` moves reserves and was never captured in the research pull.** Five curves
   in the first validation run diverged; all five turned out to have sweeps. The full set
   of reserve-mutating events is seven, not three: CurveBuy, CurveSell, BuybackLocked,
   FeesSwept, FeesRescued, CurveCompleted, plus the launch itself.
3. **The final buy of a curve's life partially refunds.** It clamps at the reserved-token
   floor, grosses the fee legs back up with a ceiling division, and emits
   `CurveBuyRefunded`. The constant-product result is an upper bound, not the answer.

Also: the fee legs are three *independent* floor divisions on the full spend, not
successive deductions from a running remainder; and `snipeTaxSeconds` is snapshotted per
curve at initialize, so it must be read per launch rather than assumed from the factory.

**The entry clock was subtly wrong and is now driven by the chain.** The snipe tax reads
`block.timestamp - launchedAt` in whole seconds. Firing on wall-clock arithmetic cannot
see that boundary, because the launch block could have been produced anywhere inside its
own second. Landing 150ms early is not a 150ms mistake, it is a whole bracket: **618bps at
elapsed 1 against 19bps at elapsed 2**. The bot now waits to *observe* a feed block whose
timestamp has crossed `launchedAt + 2` and fires on that, with a deliberately late wall
clock fallback if the feed is down. Overshooting into elapsed 3 costs 19bps; undershooting
costs 618. Bias late, always.

**Endpoint facts, measured.**
- The public RPC has **no websocket at all** (upgrade returns 400; `/ws` and `/websocket`
  404). The "1 websocket per IP" note in §2 was wrong. Authoritative logs need either a
  provider websocket (Alchemy/QuickNode) or HTTP polling, which measured **median 497ms,
  max 1042ms** from a laptop. Historical block *headers* are served, but historical
  `eth_call` state is pruned.
- The sequencer speaks HTTP/2, accepts only `eth_sendRawTransaction` and
  `eth_sendRawTransactionConditional`, and has no websocket. Cold request **358ms**, warm
  **96-97ms** ,  exactly one round trip. Keeping two clients warm is worth ~260ms per send.
- `eth_maxPriorityFeePerGas` returns 0 and tips are refunded, confirming FCFS. Base fee
  observed at 0.0201 gwei.
- The feed carries a `confirmedSequenceNumberMessage` frame with no `messages` array; a
  decoder that assumes the array crashes on it. One frame is one L2 block, ~100ms apart,
  ~210 tx/s chain-wide, and viem parses every transaction in it (13.4µs each, 100% of
  8,293 sampled).

**The design consequence.** Because polling truth is 100-1000ms behind and the steep part
of the exit-lag curve is the first 200ms, the feed is not a nice-to-have. The bot keeps
confirmed state (logs only, so reverts cannot corrupt it) plus an optimistic overlay from
the feed, and simulates each pending transaction before applying it to drop the ones that
will revert on their own slippage bound. Exit *triggers* read the fast book; exit
*minQuoteOut* reads the confirmed book, so an optimistic error can mistime a fire but can
never book a bad fill. `npm run observe` reports the false-positive rate of that prediction
against what actually landed ,  if it exceeds a few percent, turn the overlay off.

**Where the code lives:** `bot/`, with `v1/README.md` for design and `v1/DEPLOY.md` for
the runbook. `npm run validate` is the gate that must pass before any deploy.

## 11. First-principles pass on the strategy (2026-08-17 evening)

The exit-parameter sweep in §10's spirit was knob-turning. This pass asked where the P&L
actually comes from and let that decide the rules. Scripts: `research/fp_*.py` on top of
`research/sim2.py` (a path-level simulator sharing `realistic.py`'s exact replay and
frictions; cross-checked against it within 0.3pp). Two datasets: the 13-day pull
(Aug 4-16) and a forward window pulled after every rule below was fixed (Aug 16 17:48 UTC
to Aug 17 19:09 UTC, 1,450 ETH launches; `DATASET=fresh`).

**Where the money is.** After a +2s entry the median token does nothing for ~60s and then
bleeds: mark 0.996 at 30s, 0.94 at 120s, 0.90 at 300s (Aug 13-16). The mean is carried
by a right tail: 14-16% of entries reach 2x, and their peaks come at a median of 3 minutes.
"Mean proceeds if sold at horizon h" rises to +7.5% at 120s and falls to +1.2% at 300s.
So the whole game is: capture ~2 minutes of post-crowd inflow, then leave before the
early holders distribute. Nothing about the exit is a signal problem.

**The exit is a clock.** 133 exit variants were scored on a date split, then per day, then
on the forward window: flat caps, trails, momentum gates ("leave at 30s if not up 5%"),
two-stage gates, time-decaying trails, partial take-profits, and behavioural triggers
(exit on creator sell, on early-bot sell, on any sell above x% of pool, on the first sell
after t). **"Sell everything at 120s" is within noise of the best and beats most.** Every
signal-based early exit sold into a dip the clock would have ridden through; sell-triggered
exits were 2-14 points worse than the clock. The stop and trail are kept only as loose
insurance (0.5x hard stop fired 22 times in 1,548 trades for a 0.06pp cost; a 50%-off-peak
trail fires on <1%). Bot config: `maxHoldMs 120_000, hardStopMultiple 0.5, trailPct 0.5`.

**Selection is the lever, and it is behavioural.** Profit is follow-on flow, so the
question is which launches attract buyers after the sniper crowd. The dev-buy size looked
like the answer at first (Aug 13-16, flat 120s: 0.05-0.08 -1.3%, 0.08-0.12 +10.5%,
0.12-0.20 +26%), and it is a real effect (the 0.05-0.08 band is where every public filter
sits, 24% of launches do a dev buy of exactly 0.05, it has the most rivals and the least
follow flow), but it turned out to be a proxy for something the launch transaction states
outright.

`launchAndBuy` takes a `snipeTaxExemptions` array. Creators who fill it (almost always
with exactly three wallets, i.e. one particular bundler tool) are running a launch
operation: tax-free entry across wallets at +0s, then promotion. Pulled for 7,218
launches (`research/pull_meta.mjs`, `data/meta.json`; the feed carries the same calldata
at +0s so the bot sees it before the entry clock fires):

| | bundled | not bundled |
|---|---|---|
| Aug 13-16: median follow flow, +3s to +120s | 0.595 ETH (78% get >= 0.1) | 0.006 ETH (29%) |
| Aug 13-16: ROT flat 120s | **+21.0%** (n=518, 90% CI +16 to +26) | **-1.4%** (n=1,952) |
| forward window: median follow flow | 0.439 ETH (83%) | 0.006 ETH (32%) |
| forward window: ROT flat 120s | **+4.4%** (n=191, CI -1.0 to +10.3) | **-2.0%** (n=368) |

Within every dev-buy band the bundled launches carry the return and the unbundled ones
sit at or below zero (0.08-0.12: +19.8% vs -2.2%; 0.12+: +21.1% vs +9.8%). 64% of
dev>=0.08 launches are bundles, which is why the dev floor "worked". The bundle share of
launches went from 4-7% before Aug 12 to 21-33% after, which is the regime change: the
volume wave was operators arriving. Bundle wallets sell inside 120s on ~7% of launches and
cost about 1.6pp when they do; the 120s hold survives that. Requiring a twitter link on
top drops the ~8% of bundles with none (negative in both windows) and reads as "was this
launch marketed", not as a tuned number: bundle+twitter is +23.4% / +5.7% (forward CI
+0.3 to +12.5, the only candidate whose forward CI excludes zero).

Checked and rejected as not robust: creator repeat count (flips sign on the forward
window), hour of day, launch density, gating a +3s entry on the size of the crowd that
already bought (noise both ways), and every logo/description/name feature once the bundle
flag is known.

Bot: the **live book** is `bundle && twitter && dev >= 0.02 && creator tax <= 1%`;
**shadow** trades the live book plus the legacy `dev >= 0.05` cohort so the weak bands
stay measured, records the calldata per launch (`launches.exemptions/has_twitter/
live_book`), and `stats.ts` / the dashboard score the live book separately. Selection
config lives in `STRATEGY.liveBook` / `STRATEGY.shadowBook`.

**Entry timing does not matter and crowd-gated late entry does not work.** +2s beats +3s
by ~0.5-1pp everywhere (the 19bps tax saving is smaller than the crowd's price move), and
gating a +3s entry on the size of the crowd that already bought is noise in both
directions. The best real wallet (0x03c7..., +11.3%) entered at ~4s after seeing 2-3
buyers, held <=60s, traded 268 tokens, and stopped on Aug 12; the +5.9% 2s-entry wallet
(0xe224...) went from +18% to +1.7% as volume tripled on Aug 13 and stopped after Aug 14.
All three persistent winners quit or turned negative by Aug 15-16.

**The simulator is calibrated, the market moved.** On the exact 105 launches shadow run 1
traded (Aug 17 15:00-18:47 UTC), shadow marked -1.59% and the simulator with its default
frictions (2 rivals, 10% flow haircut, 200ms lag) marked -2.44%, per-trade correlation
+0.91. Frictionless would have said +9.7%. So the "3pp sim-to-live gap" quoted earlier
was really "Aug 17 vs the average of Aug 13-16": the frictions are doing their job and
the venue's edge is decaying, from +20% days on Aug 8-10 to +1% to +4% on Aug 16-17.
Same trades, flat 120s exit: +9.3% in the simulator.

**Size.** With rivals held at their real size, ROT falls slowly with trade size in the
simulator (dev>=0.08 late regime: +15.1% at 0.005 ETH, +14.5% at 0.02, +13.0% at 0.05),
but the flow-displacement haircut does not scale with size in the model and should, so
treat that slope as too flat. Capital never binds: ~200 signals/day at 120s each is under
one concurrent position on average.

**Honest bottom line.** The strategy is "buy at +2s on launches whose creator registered
a snipe-tax-exempt bundle and posted a twitter link, sell at 120s". On the forward day it
returned about +4% to +6% before any paper-to-live discount, on ~180 trades a day, with a
90% CI of roughly 0 to +12. That is meaningfully better than the dev-buy floor (+3%, CI
includes zero) and it has a mechanism behind it (100x the follow flow), but one day cannot
distinguish +4% from +1%, and the whole venue has decayed from +20% days a week ago; the
professionals have left. The 3%-over-500-trades gate stands. The one thing that would
move the estimate is 2-3 more days of shadow on the new selection, which is now running.
