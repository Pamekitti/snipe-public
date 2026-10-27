# Decision rules, pre-committed

Written 2026-08-18, after the sim-vs-live reconciliation work. The point of writing
these down BEFORE the numbers come in is that we don't get to renegotiate with
ourselves mid-drawdown. Change this file only when flat and only with a dated note.

## The gates

1. **Run to n=100 closed live trades** before judging the strategy at all. At n=30
   the 90% sampling band is ~17pp wide; nothing inside it is signal. The only early
   exit is the kill switch.
2. **Kill switch: $75 drawdown**, now measured two ways at once:
   - chain: peak flat wallet balance vs current flat balance (persists across
     restarts; the pre-2026-08-18 version silently re-armed on every restart)
   - session: realized P&L from receipts, rebuilt from the DB at boot
3. **At n=100**: if live ROT sits below the sim's 5th percentile for n=100 (the
   dashboard's "90% band by sample size" line, currently about +2.0%), the sim is
   wrong or the era turned. Back to shadow, investigate, re-decide.
4. **At n=400**: judge against the +3% ROT scale gate from the original brief.
   Above it, scale toward $500 bankroll. Below it, stop and rethink.
5. **No strategy changes before n=100** except on a TROUBLE alarm from livewatch
   (clock regression, filter leak, sim drift >1.5pp on the last-50 mean, drawdown).

## Amendment, 2026-08-18 (bot flat and stopped, so this is a legal time to change it)

The pilot ran 50 trades for -$20.40 and was stopped by hand. Three things came out of
the post-mortem, in descending order of importance:

1. **The dataset the strategy was fitted on was missing 70% of the trades in the window
   the bot went live in.** `research/pull_more.mjs` doubled its getLogs chunk whenever a
   response came back small; the public RPC caps a response and returns the cap without
   an error, so oversized chunks silently lost their tail. 9,117 rows were absent from
   blocks 39.5M-39.6M. Dev-buy read 0.00 for all 36 live-traded tokens that were in the
   file, so **only 1 of 36 passed the research book** - the sim was scoring a population
   the bot was not buying from. Pull fixed (fixed 8k chunks, hard abort on a suspiciously
   full response), data repaired, everything below refitted on the repaired set.
2. **The exit had no way to take a profit.** The trail fired once in 656 simulated trades;
   the pilot's exit was a bare 45s clock. Five live trades peaked at +22%..+64% and closed
   at a loss. Added `takeProfitMultiple: 1.31`.
3. **The dev floor moves 0.05 -> 0.10 ETH.** Held out on the newer 40% of blocks the
   search never saw, this takes the median trade from +0.1% to +4.3% and the win rate
   from 50.2% to 58.2%, at the cost of halving the trade rate (16.5 -> 9.5 launches/h).

Consequences for the gates:

- **Gate 1 timing changes.** At 9.5 launches/h and the pilot's ~70% fill rate, n=100 is
  roughly 15 hours of running, not 6. Do not shorten the gate to compensate.
- **Gate 3's threshold is restated** against the new strategy: sim held-out mean is
  +9.03% with a 90% CI of [+5.90,+12.18] (n=153). The n=100 5th percentile to beat is
  therefore about +2.5% ROT.
- **The mean is explicitly NOT the thing that improved.** Paired block-bootstrap of the
  take profit against the clock: +0.34pp/trade, 90% CI [-1.22,+1.84]. It is a coin flip
  on the mean. What it buys is shape - median trade from losing to winning, win rate over
  50%, share of P&L riding on the best 5% of trades from 53% down to 29%, negative 4h
  sessions from 3/11 to 1/11. Judge it on those, because those are what were chosen.
- **New standing rule: never refit on a dataset that has not been completeness-checked.**
  Before any refit, confirm trades-per-curve and dev-buy>0 share are flat across the
  block range. A collapse in the newest band means a truncated pull, not a quiet market.

## Standing rules

- The sim must stay reconciled: scripts/recon.py replays every closed live trade at
  its real fill block; a last-50 mean gap past 1.5pp (5 sigma on the measured 2.12pp
  per-trade stdev) is an alarm, not a curiosity.
- Every number on the live dashboard is chain-sourced except the open-position marks,
  which are labeled "if sold now". If a derived number ever disagrees with the wallet,
  the wallet is right.
- **Wallet top-ups/withdrawals**: the baseline must be re-recorded or the P&L and the
  chain drawdown both lie. Set `REBASELINE=1` on the next boot (clears baseline AND
  peak), then remove it.
- One ETH price everywhere: env `ETHUSD` (default 2145), read by the bot config, the
  monitors, and the research stack alike.

## Where the numbers live

- Live truth: bot dashboard (tunnel to localhost:8787) ,  wallet card + sim-vs-live card.
- Monitoring: `node scripts/livewatch.cjs` on the box; a Monitor watches it here.
- Strategy selection: research sim dashboard (localhost:8788), HELD-OUT column and
  worst-slice, never the full-window mean alone.
