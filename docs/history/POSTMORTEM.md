# Post-mortem: live pilot, 2026-08-17

**Result: -$35 in ~90 minutes (22 trades, 1 winner). Called off by choice at half the -$75 stop.**
Execution was clean (fills matched the model to <1%). The loss was 100% selection.

## What happened

The live book bought launches with big dev buys and snipe-tax exemption lists
(the "bundle" signal, +21% ROT on Aug 13-16). By Aug 17 those launches were
farm output: a bundler-tool preset (13-15 exempt wallets, dev buy 0.16-0.48,
ctax 0, twitter set, fresh deployer each time) that pumps and dumps faster
than any exit we can land. Even positions that peaked 1.6-1.8x lost 26-35%;
one sell filled 60% below its computed value inside the ~200ms exit lag.

## The mistakes, ranked

1. **Every filter feature was attacker-controlled.** Exemptions, dev buy,
   twitter, ctax: all written by the launcher, none costly to fake (the dev
   buy round-trips back to him when he dumps). Never selected on a costly
   signal. The red-team question ("what would a launcher do if he knew bots
   buy bundles?") predicts this failure with zero data.
2. **Ignored the professionals leaving.** All three persistently profitable
   wallets quit or went negative by Aug 15-16. Loudest leading indicator we
   had. Filed as trivia.
3. **The decay was in the forward window, hidden by aggregation.** ex 13-15
   was -2.8% and ex 30+ was -10% in the freshest 26h; blended they read +4.4%.
   Bundle share exploding 4-7% -> 21-33% was the industrialization tell.
4. **Quoted the honeymoon number.** $142-146/day came from the window before
   the crowd learned. Edges built on follower flow decay at learning speed;
   this market decays ~daily.

## What worked (keep doing)

Small size ($9.40/trade), hard stop (-$75), real-time watch, willingness to
pull the plug. The pilot bought the answer for $35. Cheapest experiment run
so far.

## Rules for next time

1. Red-team every signal: cost to fake < value extracted from us => bait.
2. Track winner wallets continuously. They quit => we quit.
3. Newest window, band by band. Aggregates are where dead edges hide.
4. Go live into strength: trailing shadow ROT must already clear +3%.
5. Ship the death detector before the strategy (now: comeback watch on the
   box, trailing-50 shadow ROT, farm-band share of entries).

## Current state

Bot in shadow on example-host, logging everything, broadcasting nothing.
Wallet holds 0.08047 ETH (~$172), ready to redeploy. Comeback gate: trailing-50
shadow ROT >= 3%, re-verified against a fresh band-level backtest before any flip.
