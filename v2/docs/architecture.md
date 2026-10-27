# How the bot is put together

Two diagrams. Both are checked by `test/diagrams.test.ts`, which fails when an event kind or a
refusal bucket exists in code and not here, or here and not in code. A diagram nothing checks
is a diagram that is wrong within a week, and this repo has already paid for that lesson: the
old `CLAUDE.md` said "no silent killers" in the same week a silent killer stopped the
measurement pipeline, and `levels.ts` opened with "a threshold lives here" while nineteen of
its twenty thresholds sat inline somewhere else.

## 1. Events in, intents out

Everything the bot knows is a fold over one append-only tape. The transports do not decide
anything, the core decides everything and touches nothing, and the drivers are the only code
that can act on the world.

```mermaid
flowchart TB
  subgraph world["the world"]
    feed["sequencer feed"]
    rpc["RPC"]
    gatedb["gate.db"]
    operator["operator"]
    specfile["config/strategy.toml"]
  end

  subgraph io["io/ ,  transports, may not import core/decide"]
    logs_in["logs subscriber"]
    feed_in["feed client"]
    reads["chain reads"]
    sensors_in["sensor reads"]
    loader["config loader"]
  end

  appender["appender ,  stamps seq and at.<br/>THE ONLY CLOCK"]
  tape[("tape ,  append only,<br/>the only source of truth")]

  subgraph core["core/ ,  pure. No node:, no npm, no clock"]
    fold["fold: decide(state, event)"]
    state["state ,  recomputable from seq 0"]
    intents["intents + refusals"]
  end

  subgraph drivers["drivers/"]
    live["live ,  signs and sends"]
    replay["replay ,  never sends,<br/>compares against recorded effects"]
  end

  subgraph projections["projections/ ,  may NEVER import core/decide"]
    readmodel["read model"]
    alerts["alerts"]
    server["/api/state"]
  end

  feed -->|feed-block, feed-gap, feed-status| feed_in
  rpc -->|logs, logs-status| logs_in
  rpc -->|chain-read, receipt| reads
  gatedb -->|sensor| sensors_in
  operator -->|operator, switch-set, epoch-reset| appender
  specfile -->|config-applied| loader

  logs_in --> appender
  feed_in --> appender
  reads --> appender
  sensors_in --> appender
  loader --> appender
  live -->|clock| appender
  live -->|nonce, tx-signed, tx-send-result| appender
  live -->|gap, seed, recovery-start, recovery-complete| appender

  appender --> tape
  tape --> fold
  fold <--> state
  fold --> intents
  intents --> live
  tape --> replay
  state --> readmodel
  readmodel --> alerts
  readmodel --> server
```

Three things the picture is making a claim about.

**The feed is on the tape.** Every entry price and every exit mark is computed from confirmed
logs *plus* the unconfirmed feed overlay. In the old bot the feed was recorded nowhere, so a
replay could not reproduce a live decision and the existing replay quietly sidestepped it by
rebuilding from `eth_getLogs` instead. That made it an independent second opinion rather than
a reproduction, which is the real reason the paper account matched none of 49 real trades.

**The clock is one arrow.** `appender` stamps `at`, and nothing downstream reads a clock.
Every time rule reads `event.at`.

**Projections point away from core.** They may read `state`, never `decide`. That import ban
is what kills the eleven cases where the old dashboard re-derived a decision the bot had
already made, including replaying the regime gate on every poll and discarding the answer.

## 2. What refuses a trade, and in what order

Read top to bottom. The first refusal wins and nothing below it runs, which is what makes the
funnel's denominators mean anything. Every box is a bucket in `RefusalBucket`, counted, and a
bucket that becomes the whole of a trailing window is an alert.

```mermaid
flowchart TB
  launch["TokenLaunched in a logs batch"] --> pair{"ETH pair?"}
  pair -->|no| screen_pair["screen-pair"]
  pair -->|yes| tax_seen{"creator tax readable?"}
  tax_seen -->|no| screen_tax["screen-tax"]
  tax_seen -->|yes| devbuy{"dev buy acceptable?"}
  devbuy -->|no| screen_devbuy["screen-devbuy"]
  devbuy -->|yes| prior{"deployer seen before?"}
  prior -->|blocked| screen_prior["screen-prior"]
  prior -->|ok| meta{"launch metadata parsed?"}
  meta -->|no| screen_meta["screen-meta"]

  meta -->|yes| book{"a book whose band holds this tax?"}
  book -->|none| entry_no_book["entry-no-book"]
  book -->|one| band{"inside that book's band?"}
  band -->|no| entry_tax["entry-tax"]
  band -->|yes| exempt{"enough exempt wallets?"}
  exempt -->|no| entry_exempt["entry-exempt"]
  exempt -->|yes| template{"template lost within the block window?"}
  template -->|yes| entry_template["entry-template-loss"]

  template -->|no| halted{"book halted?"}
  halted -->|yes| risk_halted["risk-halted"]
  halted -->|no| entered{"token ever entered?"}
  entered -->|yes| risk_entered["risk-entered"]
  entered -->|no| capacity{"slot ceiling set and full?"}
  capacity -->|yes| risk_capacity["risk-capacity"]
  capacity -->|no| size{"size within the ceiling?"}
  size -->|no| risk_size["risk-size"]
  size -->|yes| bankroll{"bankroll set and would overflow?"}
  bankroll -->|yes| risk_bankroll["risk-bankroll"]
  bankroll -->|no| loghealth{"log stream healthy?"}
  loghealth -->|no| risk_logs_unhealthy["risk-logs-unhealthy"]
  loghealth -->|yes| logage{"logs fresh enough?"}
  logage -->|no| risk_logs_stale["risk-logs-stale"]
  logage -->|yes| overlay{"overlay fresh enough?"}
  overlay -->|no| risk_degraded["risk-degraded"]

  overlay -->|yes| sensor_ok{"guard readable?"}
  sensor_ok -->|unreadable| sensor_unreadable["sensor-unreadable"]
  sensor_ok -->|too old| sensor_stale["sensor-stale"]
  sensor_ok -->|no rows| sensor_no_rows["sensor-no-rows"]
  sensor_ok -->|yes| simulated{"fresh vs live price simulated?"}
  simulated -->|failed| guard_sim_failed["guard-sim-failed"]
  simulated -->|ok| pumped{"already pumped past the ceiling?"}
  pumped -->|yes| guard_pumped["guard-pumped"]

  pumped -->|no| send["BUY INTENT"]
  send --> sent{"accepted by the sequencer?"}
  sent -->|refused| send_refused["send-refused"]
  sent -->|rejected| send_rejected["send-rejected"]
  sent -->|yes| open["position open"]

  open --> venue{"will the curve still sell?"}
  venue -->|yes| exitpath{"exit attempt"}
  exitpath -->|parked| exit_parked["exit-parked"]
  exitpath -->|stuck| exit_stuck["exit-stuck"]
  exitpath -->|sequenced, never settled| exit_unsettled["exit-unsettled"]
  exitpath -->|zero on-chain balance, no sale| exit_abandoned["exit-abandoned"]

  venue -->|"graduated: the curve refuses every sell"| gradpath{"sell on the V4 pool"}
  gradpath -->|"12 sends, 6 reverts or 5% of stake in gas"| exit_grad_budget["exit-grad-budget"]
  gradpath -->|"the factory or the wallet contradicts us"| exit_grad_blocked["exit-grad-blocked"]
  gradpath -->|"swap receipt proves an ETH sale"| gradclosed["position closed, graduated-swap"]

  routing["feed-routing-divergence: the fold's own routing<br/>predicate disagreed with what the live run selected"]
  cfg["config-refused: a spec that would not load.<br/>The previous one stays in force"]
  sw["switch-refused: halt, size or broadcast out of bounds"]
```

The last three sit apart because they are not part of a launch's journey. They are refusals of
an input rather than of a trade.

**The two exit paths are two venues, not two outcomes.** A curve refuses every sell the moment
its sellable supply hits zero, so a bag still held at that point has not failed to exit: it has
changed market, and the tokens are reachable only through the graduated V4 pool. `graduationExitAt`
exists to leave before that happens and mostly does; when it does not, the position flips venue
and the right-hand path sells it there. v2 parked those bags instead, which is why the path is
drawn: three positions would have sat open forever, showing as healthy on every projection. The
two refusals on it are both "a person has to look" ,  a spend ceiling reached, or the factory and
the wallet disagreeing with what we believe we hold.

**Why the order is this order.** The screen comes first because it defines the observation
universe every sensor measures on, and it must run on launches the bot will never buy or the
gate would only ever see its own choices. Capacity is claimed before any `await`, so two
launches arriving in one batch cannot both take the last slot. The graduation guard runs last
because it costs two curve simulations and there is no point paying for them on a launch that
eight cheaper checks would have refused.
