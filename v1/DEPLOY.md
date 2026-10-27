> Historical document. Snipe was retired on 25 October 2026. Operational statements below describe their original era. Start at the root README for this public edition.

# Runbook

## The box

`operator@localhost`, tailnet only (port 22 is closed to the internet),
SSH key `~/.ssh/snipe-example`. EC2 `example-host`, t4g.small, us-east-2, the
same region as the sequencer (18 ms RTT). If `report` prints UNREACHABLE, Tailscale on
the laptop is down: `tailscale up`.

| what | where |
|---|---|
| bot process | v2: pm2 `snipe-v2-live` in `~/snipe-v2` (see the next section). v1: pm2 `compute-1`, `npm run bot` in `~/snipe/bot`, STOPPED since the 2026-09-16 cutover |
| logs | `pm2 logs compute-1`; timers: `journalctl -u snipe-gate -u snipe-recon -u snipe-push -u snipe-edge` |
| data | `~/snipe/v1/data/` (bot.db, gate.db, recon.db, deployers.json) |
| secrets and switches | `~/snipe/v1/.env` (keys listed in `.env.example`) |
| dashboard | `http://127.0.0.1:8787` from any tailnet device (`tailscale serve` proxies the loopback port); `curl localhost:8787/api/state` on the box; `report` from the laptop. The STOP/START buttons stay in the workspace header, and the tailnet is their only authentication |
| snapshots | `~/snipe/bot` is its own git repo; `deploy.sh` commits after every green deploy |
| swap | 2 GiB at `/swapfile`, `vm.swappiness=10`. Added 2026-09-14: the box has 1.8 GB and had none, so a page-cache surge had nowhere to go and stalled the trading loop |
| disk | 20 GiB gp3 root volume. The `disk` alert warns under 15% free and crits under 8% |
| timers | `systemctl list-timers 'snipe-*'`: gate 1 min, recon 10 min, push 5 min, edge daily 11:30 UTC |

## v2, which is what is trading

v2 is the event-sourced rewrite and it took over on 2026-09-16. `compute-1` (v1) is stopped.
Everything below in this file describes v1 and still applies to v1 only; where the two differ,
v2 wins, because v2 is the process with the wallet.

| what | where |
|---|---|
| process | pm2 `snipe-v2-live`, `./run-live.sh` in `~/snipe-v2`, one process, no timers |
| logs | `pm2 logs snipe-v2-live` |
| the tape | `~/snipe-v2/data/tape.db`, append-only, every event the fold ever saw. It IS the state; there is no other database |
| secrets | `~/snipe/v1/.env`, shared with v1 and read for the key and the endpoints only |
| money switches | `~/snipe-v2/.env`: `MODE`, `TRADE_SIZE_ETH`. Per-book size overrides and STOP/AUTO live on the tape. See `v2/.env.example` |
| strategy | `~/snipe-v2/config/strategy.toml`, the books and their bands, reloaded live |
| dashboard | `http://<box tailnet ip>:8787` from any tailnet device, or `curl localhost:8787/api/state` on the box. `report` reads the same endpoint |

### Ship v2

```bash
cd v2 && ./deploy.sh                 # code only; the box keeps the strategy it is running
cd v2 && WITH_CONFIG=1 ./deploy.sh   # also ships config/strategy.toml, and prints the diff first
```

### Restarting without the wait

Boot rebuilds the bot's memory by folding the whole tape, which is ~2M events and grew to a
thirteen-minute restart on 2026-09-18. It now resumes from a saved fold instead: the process
writes one every five minutes when it is flat, and on the way out of a clean stop, so an
ordinary `pm2 restart` comes back in seconds with no extra step.

A DEPLOY IS THE ONE CASE THAT NEEDS A STEP, AND THE AGENT RUNS IT. The user does not. A
snapshot is stamped with a hash of the code that wrote it and refused by any other build
(`v2/io/codeid.ts`), because a field added inside a stored position, or a rules change, would
otherwise be restored as something the running code never computed. So after shipping, the
agent that is about to restart folds the new build's snapshot BESIDE the running bot ,  it
reads the tape, touches nothing else, and the bot keeps trading throughout ,  and restarts
after, only when flat:

```bash
ssh operator@localhost 'cd ~/snipe-v2 && npx tsx tools/build-snapshot.ts data/tape.db config/strategy.toml'
ssh operator@localhost 'pm2 restart snipe-v2-live'   # only when flat
```

Skipping it is safe and costs one slow boot. `v2/tools/snapshot-proof.ts` is the check that
resuming is the same as never stopping: it folds a tape straight through and again with a
save-and-reload in the middle, and compares the state, the history and every decision after
the break. Run it on a tape copy after touching anything inside `State` or `History`.

Do not use a full replay when current configuration would rewrite historical decisions. A
transport-only release can migrate the stopped process's shutdown snapshot instead. Pass
`--transport-only-source` with the extracted pre-deploy tree. The tool requires a flat wallet,
zero in-flight work, a shutdown snapshot at the tape tip, and byte-identical `core/`, history,
and snapshot code. It preserves wallet amounts, positions, attempts, halts, and controls.

### The tape will need a prune; not today

RAM is not the thing that grows. The live book is capped (`POSITIONS_KEPT`, `CURVES_TRACKED`,
seven days of charts) and the snapshot is a copy of that book. Ordinary restarts stay fast.

What grows is `~/snipe-v2/data/tape.db`. Pre-build after a deploy has to read the whole file,
so that wait creeps up (80 seconds on 2026-09-19). Trading does not get worse.

`Tape.prune` already knows the budget ,  14 days or 2 GB, whichever bites first, plus a 3 GB
free-disk floor ,  and the tests cover it. Nothing in the live process calls it. That is why
the file still grows. Do not turn it on as a drive-by: once old events are gone you cannot
rebuild the book from seq 1, so a snapshot that matches the remaining tape is required, not
optional.

Watch two numbers. Act when either is annoying, not before:

- size of `data/tape.db` (the written budget is 2 GB; measured growth on 2026-09-16 was
  0.30 GB/day)
- how long `tools/build-snapshot.ts` takes after a deploy

The job then is: wire `prune` (or start a new tape), prove a snapshot still resumes to the
same book, and keep pre-building after every deploy. A bigger box is not the fix.

Tests run on the box and a failure stops the deploy. It never restarts anything. `config/` is
excluded by default and that is a money rule: `main.ts` watches `strategy.toml` and folds a
`config-applied` within a second of it changing, so a tar that carried the file would move the
live bands with nobody deciding to. The 2026-09-16 deploy logged `spec reload refused: missing
the [risk] table` because the watcher read the file while tar was still writing it.

### The two switches

`~/snipe-v2/.env` is the only source for MODE and the default size. `run-live.sh` deliberately
exports neither, because an exported value wins over a file and that is how v1 spent a day in
2026-09-06 with a `.env` that said one thing and a process doing another.

**Hot, applies on save, no restart:** `TRADE_SIZE_ETH` is the default for books without a
dashboard override. Each book's numeric dashboard control records its own `switch-set` on the
tape. `USE DEFAULT` clears that override. Both paths change new entries only; open positions
keep their pinned size and exit rules. Every per-book value is refused below 0.0005 ETH or above
the book's declared ceiling, and every confirmation shows the resulting drawdown limit.

**Needs a restart:** `MODE` (`live` or `shadow`). Restart only when flat (`open 0`):

```bash
ssh operator@localhost 'cd ~/snipe-v2 && pm2 restart snipe-v2-live'
```

Never move `MODE` to `shadow` with positions open: shadow signs and never sends, so the tokens
strand. A missing file or `MODE=observe` refuses to boot. There is no file `HALT`. Stop new
buys with STOP ALL on the dashboard.

### RPC economy during STOP ALL

`RPC_STOPPED_ECONOMY=1` in `~/snipe/v1/.env` allows public-first log polling only while
STOP ALL is set. It is disabled by default. The wallet must also be flat, startup
reconciliation must be complete, and no transaction or driver work can remain. Automatic
halts and combinations of per-book stops do not qualify.

The launch subscription, metadata reads, execution reads, and wallet reconciliation stay on
their existing routes. A failed or lagging public poll falls back to the paid endpoint at the
original block range. Two consecutive public failures start a 60-second paid cooldown. The
`rpcRouting` block in `/api/state` reports route counts, failures, fallbacks, estimated compute
units, eligibility, and cooldown state. Estimated units are not provider billing.

START keeps STOP ALL set while it restores paid polling and catches up through the keyed
head. It waits for the driver to process that batch and for launch work to settle. The button
shows `PREPARING...` for up to ten seconds. A failed preparation leaves STOP ALL set and says
why. A newer STOP cancels the pending START.

### Proving a change to the fold

Any edit to `v2/core/` changes what the bot decides, so it is checked against the real tape
rather than argued about:

```bash
# on the box: snapshot the tape (VACUUM INTO is consistent under WAL), then pull it
ssh operator@localhost 'cd ~/snipe-v2 && node -e "const D=require(\"better-sqlite3\");new D(\"data/tape.db\",{readonly:true}).exec(\"VACUUM INTO '\''/tmp/t.db'\''\")"'
scp operator@localhost:/tmp/t.db v2/data/tape-box.db
cd v2 && npx tsx tools/replay-proof.ts data/tape-box.db config/strategy.toml
```

It prints a kernel id: this fold's decisions over that tape, as one number. Same id before and
after a change means the change cannot have altered a single decision on those events. A
different id is not automatically wrong, but it is a thing to explain before restarting.

TAKE THE BEFORE NUMBER BEFORE YOU DEPLOY, because deploying overwrites the code you would
need to produce it. `~/snipe-v2-rollbacks/*-replaced.tgz` is the tree each deploy replaced,
kept for exactly this (last 20), so a missed baseline can still be recovered:

```bash
scp operator@localhost:'~/snipe-v2-rollbacks/<stamp>-replaced.tgz' /tmp/
mkdir -p /tmp/before && tar -C /tmp/before -xzf /tmp/<stamp>-replaced.tgz
ln -s "$PWD/node_modules" /tmp/before/node_modules
cd /tmp/before && npx tsx tools/replay-proof.ts <tape> config/strategy.toml
```

When the id moves, the answer is a list of the decisions that moved, not a shrug. Dump both
decision streams (`replay()` returns them) and diff: on 2026-09-17 the 12 differing lines
were 5 buys with a looser `minTokensOut` and 2 recovery reads, which is an explanation. A
count is not.

## Ship code (v1)

```bash
cd bot && ./deploy.sh
```

Packs the source, vendored dashboard assets and tests, and copies the release over. It synchronizes dependencies and runs the whole suite ON THE BOX (one retry for a flake), and commits a snapshot
there. `data/`, `logs/`, `.env` and `node_modules` are never in the tar. It prints the
restart command and stops: deploying and restarting are two decisions. The suite reads
`.env.example` (`vitest.config.ts`), never the box's `.env`: a changed limit cannot fail a
deploy, and no test worker loads `MODE=live`.

The code snapshot stages release paths only. Private environment/database backups under
`data/` stay outside git. The dashboard page and vendored uPlot assets are included under `src/` in each snapshot.

Merged is not shipped, and shipped is not running. `report` prints a BOX block with the
last snapshot, the bot's start time and whether the box's source tree hashes the same as
the laptop's; a mismatch or a bot older than its snapshot is a FLAG. On 2026-09-06 the
hot-config commit sat merged and undeployed for an hour while a `.env` edit did nothing.

Restart only when flat (`open 0` in `report`):

```bash
ssh operator@localhost 'cd ~/snipe/bot && pm2 restart compute-1 --update-env'
```


## Roll back

```bash
cd ~/snipe/bot && git log --oneline | head
git checkout <sha> -- src scripts test && pm2 restart compute-1
```

## Switches in `.env`

`.env.example` documents every key; `src/config/schema.ts` is the machine-readable list and
a test keeps the two in step. Two classes, and the class decides whether a restart is needed.

**Hot: edit the file and it applies, no restart.** `TRADE_SIZE_ETH`, `BANKROLL_ETH`,
`MAX_DRAWDOWN_ETH`, `ETHUSD`, `ENTRY_UTC_HOURS` (blank = all day), `HALT`,
`ENTRY_MIN_TAX_BPS` and `ENTRY_MAX_TAX_BPS`, the `VENUE_*`
and `DD_RESUME_*` sensors, `BROKEN_GAP_PP`, and the `PROBE*` keys. Within a second the bot logs what moved, records the seam in
`chain_truth.filter_changes`, and republishes `strategy_json` so the monitors stop quoting
the old book. A position already open keeps the rules it opened under; the new values apply
to the next entry.

```bash
ssh operator@localhost 'cd ~/snipe/bot && vi .env'
ssh operator@localhost 'pm2 logs compute-1 --lines 20 --nostream | grep config'
```

Still money decisions, still asked for one at a time and never inside a checklist:
`HALT`, `TRADE_SIZE_ETH`, `MAX_DRAWDOWN_ETH`, `ENTRY_MIN_TAX_BPS`, `ENTRY_MAX_TAX_BPS`. Not needing a restart
makes them easier to change, not smaller.

Two refusals are built in. An invalid or out-of-range value is rejected WHOLE, the previous
numbers keep running, and the dashboard raises a crit `config` alert; nothing is applied
half way. And `HALT=1` applies live while `HALT=0` does not, because stopping is always safe
and resuming is a decision to put money back to work. Raising `MAX_DRAWDOWN_ETH` while the
drawdown stop is holding moves the number and leaves the halt exactly where it is.

`MAX_DRAWDOWN_ETH` is in ETH, the same unit as the trade size, since 2026-09-07. Divided by
`TRADE_SIZE_ETH` it is the stake multiple every replay fits: `0.112 / 0.02` is 5.6 stakes.
It was in dollars before, which coupled it to `ETHUSD`, and a stale price silently widened
it (a configured 2145 against a real 2515 made a "$240" limit really $282). `ETHUSD` is now
display only and the bot refreshes it hourly from Coinbase, publishing it to
`chain_truth.eth_usd` for the monitors; the `.env` value is the boot seed and the offline
fallback. The daily cap (`MAX_DAILY_LOSS_USD`) was deleted in the same change: it could not
lift before 00:00 UTC and on 2026-09-05 would have sat out $731 of the day.

### The creator-tax band

`ENTRY_MIN_TAX_BPS` and `ENTRY_MAX_TAX_BPS` are the band the book buys, bps, both ends
inclusive. Hot since 2026-09-15; before that the floor was a compiled-in 50 and moving it
cost a deploy and a restart.

| band | what it buys |
|---|---|
| `50` / `10000` | the book from 2026-08-28 to 2026-09-15: every taxed launch, nothing untaxed |
| `0` / `0` | untaxed launches only. A different policy, not a looser version of the old one |
| `0` / `10000` | everything the screen passes. NOT the same as `0`/`0` |

Neither bound touches the book screen. `STRATEGY.maxCreatorTaxBps` still sets
`launches.passed` at 200bps and is not an operator setting, because the screen is the
observation universe every sensor and `scripts/edgecheck.py` measure against. Narrowing it
would delete the control group instead of changing the book.

Three readers follow the band automatically, so they keep describing the book that holds the
money rather than a different one: `strategy/gate.ts` (the venue sum and the drawdown
auto-resume), `scripts/gatewatch.py` (via published `maxEntryTaxBps`), and
`strategy/entry.ts` itself. Check them after a change with `report`, not by re-querying
`obs` by hand: about 80% of `obs` is coins the book would never buy.

**Restart-only: captured when the process starts.** `MODE`, `LIVE`, `PRIVATE_KEY`,
`LOGS_WS_URL`, `RPC_URL`, `RPC_KEY_URL`, `GATE_LIVE`, `DB_FILE`, `GATE_DB`, `DASH`,
`DASH_PORT`, `REBASELINE`, `REQUIRE_DEV_BUY`, `ENV_FILE`. Editing one of these is detected
and reported (a warn `config-restart` alert and a log line), never applied. Restart when
flat to take it. On the free tier leave the two RPC keys unset; `eth_getLogs` is capped at
10 blocks there. `REBASELINE=1` is a one-boot flag and must be removed afterwards.

### pm2 caches the environment, and that used to beat this file

`pm2 start` saves the environment it was given, `pm2 restart --update-env` replays that
saved copy into the process, and `dotenv` never overrides a variable already present. On
2026-09-06 a stale `TRADE_SIZE_ETH=0.005` in pm2's copy silently beat an edited `.env` for
twenty minutes across three restarts, while the boot banner printed the old value as if it
were the file's.

The store now reads the FILE for every hot key and lets it win, so the trap cannot bite
those again. If pm2's copy still carries stale values, clear it once while flat:

```bash
cd ~/snipe/bot && pm2 delete compute-1 && pm2 start npm --name compute-1 --cwd ~/snipe/bot -- run bot && pm2 save
```

What the process is ACTUALLY running is printed at boot in every mode and served at
`/api/state` under `config` (with the file path, the last change time and any pending
restart-only edit). `grep -v PRIVATE_KEY .env` shows what the file says, which is now the
same thing for every hot key.

## Reset the drawdown stops (money decision, ask first)

Since 2026-09-07 the bot does this ITSELF when the drawdown stop lifts, so the hand tool is
for the cases the automatic rule refuses: a third stop in one day, a stop sitting under
`broken` or `manual`, or a deliberate reset after a top-up.

**RESET DRAWDOWN on the dashboard does this, from any tailnet device, with no restart.**
Two taps, beside STOP and RESUME AUTO. It runs the same transaction as the command below
and moves the in-memory `epochBaseId` too, which is the only thing the command line needs a
restart for. It refuses while a position is open, and refuses under `broken` and `manual` --
those are not the operator's to lift. It does NOT resume trading: the reset clears what the
stop measures, and every other guard still gets its say, so a `stopped` halt still needs
START. Added 2026-09-13, after an ssh-only reset cost a run of the tape that peaked at 4.75x.

The command line is still here for a box with no working dashboard:

```bash
cd ~/snipe/bot && npm run newepoch -- "why"   # refuses while a position is open
pm2 restart compute-1 --update-env
```

Moves `epoch_base_id` and clears the chain baseline in one transaction, and records what
it replaced. `REBASELINE=1` alone leaves the session drawdown where it was. The restart is
needed only for the HAND reset: the bot holds `epochBaseId` from boot, and its own reset
moves the in-memory value too.

## When something looks wrong

- **`disk` alert.** The volume is 20 GiB and everything the bot knows is a sqlite write, so
  a full disk does not slow it down, it stops it recording what it did. Check `df -h /`, then
  the two databases: `ls -la data/*.db`. Stale copies (`data/*.db.*`, `data/alignment-*`,
  `data/research-grid-*`) are safe to delete and are usually gigabytes. If `bot.db` itself is
  the size, it is `shadow_coverage`; see the VACUUM step below. Warn is under 15% free, crit
  under 8%, which was about a day and a half and half a day at the 2026-09-13 growth rate.
- **`memory` alert.** Which process is in the alert text, and `/api/state` carries the same
  under `resources` with `captureHealth` beside it. The box has 1.8 GB for three node
  processes plus the page cache; the OOM killer picks by size, so the process it takes is
  usually the bot rather than the worker that grew. Restart when flat.
- **`shadow_coverage` has millions of rows.** The shadow service merges it hourly since
  2026-09-14, but a backlog needs one pass with the bot stopped and flat:
  `node --import tsx scripts/coalesce-coverage.ts data/bot.db`, then reclaim the pages with
  `node -e "require('better-sqlite3')('data/bot.db').exec('VACUUM')"`. VACUUM rewrites the
  file, so it needs roughly twice its size free while it runs. Merging changes no verdict:
  the verifier asks only whether a block range is covered end to end, and the union is
  unchanged.
- **`bot.db` keeps growing.** Since 2026-09-15 the shadow service also prunes, on the same
  hour: `shadow_source_logs` past 48 h, `shadow_decisions` past 8 days, and the replay
  payloads on jobs of any config that is no longer live. `health` is pruned to 8 days from
  the telemetry handle, and the guard decision log keeps one snapshot instead of one per
  row. For a backlog, one pass with the bot stopped:
  `node --import tsx scripts/prune-bot-db.ts data/bot.db`, then VACUUM as above. `launches`
  is deliberately never pruned: `bot.ts` seeds the deployer registry from it on every boot
  and `deployers.json` is frozen, so dropping a row silently weakens the deployer filter.
- **`bot.simulation.db` keeps growing.** Growth stopped, history did not. Since 2026-09-15 a
  scenario bundle stores one log array instead of six, `results.request` stores a digest and
  the fills map instead of the log bodies, and the `verified-logs` and `cost-model`
  checkpoints are pruned hourly. The rows written before that keep their bodies and CANNOT be
  deleted: `captures`, `results` and `scenario_results` all carry RAISE(ABORT) triggers on
  UPDATE and DELETE. VACUUM reclaims free pages, not those rows. The only way to get that
  space back is to rotate the file, which costs the whole paper ledger and the 31-day report,
  and is the operator's call.
- **No trades for hours.** Check, in order: `ENTRY_UTC_HOURS` (blank = all day, which is
  the live setting); the wallet's last transaction on blockscout; `report`'s gate line and
  halt kind; the dashboard alerts `venue`, `gatestale` and `regime gate rate is Xh old`. Do
  not widen the book to get volume.
- **Stop it now.** The STOP button on the dashboard, from any tailnet device including a
  phone. It halts entries and keeps selling, survives a restart, and `start` (two taps)
  puts it back. `HALT=1` in `.env` is the same thing by file, and stays one-way: only a
  restart lifts that one. Never `pm2 stop`, which kills the exit managers and strands bags.
- **Halted.** `haltKind` names the stop, stickiest first, and only two of the six need you:
  - `gate` and `venue` lift themselves the moment their sensor reads good again. `gate` is
    the touch rate, `venue` is the same venue measured in money, on the launches the book
    would have bought only (gatewatch scores four unbuyable coins for every buyable one,
    and summing all of them paused the bot on 2026-09-06 on coins it never held).
  - `stopped` is the STOP button on the dashboard. Only the start button lifts it, and
    only while nothing stickier holds. It survives a restart (`chain_truth.operator_stop`),
    because a stop you have to remember to re-apply after every reboot is not a stop.
  - `venue` has one more path since 2026-09-13. With `VENUE_FRESH_RECOVERY=1` the adaptive
    shadow observer decides, and its outcome window does NOT survive a restart: it comes
    back at 0/20 and needs a full refill. While it is merely WARMING UP the bot now asks
    gatewatch instead of holding entries, and says so on the dashboard ("gatewatch is
    answering"). A shadow observer that is FAULTING still halts, and still waits for you.
  - `drawdown` lifts itself once `DD_RESUME_WINDOW` buyable launches SCORED SINCE IT FIRED
    sum above `DD_RESUME_ON` stakes, at most twice a UTC day, and only while flat. The lift
    includes a new epoch, so both stops restart from zero; the chain baseline re-records at
    the next flat sample. The third stop in a day, or one sitting under a stickier kind,
    waits for you and needs the hand reset above.
  - `broken` means WE are losing where the venue paid: our last trades came in far under
    what the same coins replayed at. It never lifts itself. Find the bug, then restart.
    This is the one to wake up for.
  - `manual` is `HALT=1`.
- **Graduated holding.** The swap exit keeps the position open and immediately starts
  a native ETH sale through Pons' V4 router. It confirms exact approvals and the sale,
  then books the receipt after hook fees. A missing pool or receipt leaves the holding
  visible and retries with backoff. Six reverted transactions, reverted gas of 5% of
  the stake, or twelve submitted transactions stop further broadcasts and raise an
  operator alert. These budgets survive restarts. A restart does not reset them.
- **Historical stranded entry.** Older code closed these rows at -stake. They are an
  inventory requiring explicit reconciliation, not proof of zero token value. The new
  exit manager does not silently reopen or sell historical closed positions.
- **Wallet and book disagree.** Gas the book cannot see: reverted sells (`burned_gas_wei`),
  or a retry loop. `research/recon2.py` compares the transaction count with the ledger.
- **`model` alert.** Real sale over the model's estimate has drifted from 1.00: the
  confirmed state is wrong (a block-number or log-ordering bug), and every exit rule is
  firing on a wrong price.
- **Feed `ok=0` rows, `feedGaps` climbing, `param read failed` in the hundreds per hour.**
  See the memory note `rpc-and-feed-path`; `research/feedgaps2.ts` and
  `research/wsgap.ts` are the instruments, and both run from the laptop (a second feed
  decoder on the box competes with the bot for its two cores).
- **A number in `.env` is not what the bot is running.** Read `/api/state` `config`, or the
  boot banner: it prints the effective values in every mode. A crit `config` alert means the
  file was refused and the previous values are still live; the alert says which value and
  why. A warn `config-restart` alert means the edit needs a restart.
- **Tests fail on the box but pass locally.** vitest served a cached transform of an
  older-mtime file; `deploy.sh` already ships with fresh mtimes and clears the cache.

## Watch-only second instance (one-hour tool, never permanent)

```bash
cd ~/snipe/bot && sed 's/^ENTRY_UTC_HOURS=.*/ENTRY_UTC_HOURS=0-24/' .env > .env.observe
MODE=observe DASH=0 DB_FILE=data/observe-ws.db ENV_FILE=.env.observe \
  pm2 start npm --name observe-ws -- run bot     # then pm2 delete observe-ws
```

`MODE`, `DASH` and `DB_FILE` are restart-only, so the environment still wins for them and
they can stay on the command line. `ENTRY_UTC_HOURS` is hot, and for a hot key the file
wins, so the second instance needs its own file via `ENV_FILE`.

A second poller adds ~15% to the public rpc's 429s, which slows the live bot.

## Approval accounting and restart budgets (2026-09-07)

Approval hashes are saved before broadcast. Receipt backfill includes every mined
approval, including a reverted attempt, and preserves those costs on repeat runs.
The current-era historical repair uses `research/approval_backfill.py`; it fetches
receipts without a wallet key and backs up the database before applying exact costs.

The daily drawdown restart budget is stored in `chain_truth.dd_resume_budget` as part
of the automatic epoch transaction. Boot restores it. The first boot after this change
migrates today's count from recorded restart events. Neither a process restart nor a
manual accounting reset grants extra automatic restarts on the same UTC day.

The selected market settings are `VENUE_PAUSE_WINDOW=20`, `VENUE_PAUSE_OFF=-1`,
`VENUE_PAUSE_ON=2`, and `VENUE_FRESH_H=3`. The drawdown limit remains 0.06 ETH,
with 20 post-stop observations summing strictly above +1 stake required for an automatic
restart. The market and drawdown recovery thresholds are separate (updated 2026-09-08).

### Resume automatic operation after a dashboard stop

The dashboard's RESUME AUTO button clears the operator stop and checks the market
recovery rule before allowing entries. A remembered open reading cannot bypass the
recovery threshold. With fresh data, the latest 20 scored launches must sum strictly
above +2 stakes. The existing stale-window exception still applies. Missing or
unreadable evidence keeps the recovery wait in place. Other active guards still apply.

The pending wait survives process restarts in `chain_truth.operator_recovery`. Start
does not reset drawdown, spend a drawdown recovery allowance or change trade size.
The button requires two taps. Its response says whether checks passed or entries
remain paused. Updating this control requires the normal flat-only process restart.

## Graduation exit rollout

The safety change preserves entry filters and the pre-graduation exit threshold. It
supports this bot's native ETH pools and the verified Pons hook only. Like the existing
emergency curve exit, the swap accepts any positive ETH fill (minimum one wei). The
router call is simulated before broadcast; a falling quote cannot block a valid sale.
A quote-service outage cannot block the exit either. Approval amounts equal the held
balance; Permit2 expires after ten minutes. Pending signed transactions are stored before broadcast and replayed with
the same hash after an uncertain response. Successful receipts require the expected
pool, router, hook deductions and token transfer, plus zero remaining balance.

Deploy with the existing shipping command above. Activation needs the existing flat-only
restart. Preserve every account stop, trade size and restart budget. After activation,
check the running build, the effective config and the open-position count. HUSDP 2167's
manual recovery has already been reconciled at +0.059881385438513322 ETH after gas.
The pre-repair database backup and receipt evidence remain on the box.

The exit reads through the provider key with public RPC fallback, a 750 ms timeout per
endpoint, and no transport retries. Receipt checks run every 150 ms. Temporary failures
retry after 250 ms, increasing to at most one second. An uncertain send rebroadcasts the
same signed transaction after one second without allocating another nonce.

A ready curve that has not been swept uses the permissionless `graduate` step. A swept
curve without a pool uses `createGraduatedPool`. Both are simulated first, have zero
transaction value, and share the existing attempt budgets. They never use owner-only
forced sweeps or rescue functions. Successful preparation gas is stored separately from
revert gas and remains charged across a restart or accounting rebuild. A confirmed
curve closure bypasses the ordinary buy/sell receipt waiting timers.

`research/graduation_fork_check.ts` exercises the automatic owner loop against a local
Anvil fork before HUSDP's pool creation. It uses a clean, funded test account on loopback,
executes real contract code, and requires zero remaining tokens plus an exact match
between receipt proceeds and the fork wallet after every transaction's gas. Its archive
proxy refuses all write methods. This test never spends from the live wallet.

## Provider reliability (2026-09-07)

The launch subscription remains enabled. Quota projections do not throttle entries or
exits. Normal receipt, balance and recovery reads prefer the provider, with a 750 ms
timeout per endpoint and no transport retries. Launch reads retain their three explicit
attempts with the same bounded transport. Historical accounting log scans retain their
public route and longer deadline. Graduation timing and transaction budgets are unchanged.

The authoritative poller keeps public RPC as its primary. A failed request falls back
to the provider. Provider log requests use at most ten blocks per request, which also
works before a paid-plan upgrade. A missing result or failed slice does not advance the
cursor or freshness. The next poll retries. `plumbing.providerLogFallbacks` counts rescued
reads; `providerLogCalls` counts attempts. Poll failures now mean neither route completed.

Provider fallback and receipt calls add paid usage. The dashboard's CU estimate is still
a process-lifetime estimate, not the account's monthly remaining allowance. Reconcile it
against Alchemy's Usage page. The free-tier warning does not verify the billing plan.
The operator chooses the billing cap separately. A cap can deny provider access to exits
as well as entries; public fallback cannot guarantee equal latency or availability.

### Small RPC cleanup (2026-09-07)

Receipt accounting runs one backfill batch at a time. Overlapping housekeeping ticks
still sample balances and run risk checks; they do not start another batch or spend
its retry attempts. The guard clears after completion or failure. The display-only
ETH/USD refresh runs independently of fee, nonce and accounting checks, with its
existing hourly schedule, overlap guard and timeout.

This removes duplicate maintenance during slow requests. Savings have not been measured.
It adds no monthly quota reservation and does not change launch or exit timing.
While using Alchemy's free tier, check actual account usage daily. Upgrade manually at
20M of the 30M monthly allowance, or earlier when the latest 24 hours of usage imply
fewer than three days remaining: remaining CUs divided by the last day's CUs is below
three. Use Alchemy's account usage, not the bot's process-lifetime estimate. No automatic
purchase, billing-cap change or new entry-stop rule is part of this cleanup.


## Adaptive fresh-recovery rollout

Keep operator STOP set while collecting the new indicator. Capture `/api/state`, the current
snapshot SHA and a private `.env` backup before deploying. Deploy through `./deploy.sh`,
confirm `risk.open` is zero, then use the flat-position restart command above.

Set `VENUE_FRESH_RECOVERY=1` in `.env` while STOP remains set. This hot switch starts the
background shadow collector and selects its indicator. It does not remove operator STOP.
Keep size, bankroll, drawdown limits and accounting unchanged.

Check `/api/state` at `risk.venue`: source, warmup `n`, `sum` across 20 outcomes, `recentSum`
across eight outcomes, age, `observerError`, `pending`, `configId`, `publicationAt` and
`verified`. Missing or invalid evidence closes the market guard. There is no fixed-bar fallback.

After at least 20 newly captured complete outcomes, run on the box:

```bash
cd ~/snipe/bot
DOTENV_CONFIG_QUIET=true node --import tsx scripts/verify-shadow.ts data/bot.db --certify
```

The certificate independently fetches each historical execution interval, checks the frozen
original replay engine twice (original inputs and fetched inputs), and verifies publication
ordering. It reads `shadow_jobs.request` and `.result` for every published row of the LIVE
config with no time window, which is why the 2026-09-15 retention blanks those two columns
only on configs that are no longer live. Certification requires operator STOP in the same database transaction that saves
the proof. Version 2 requires ten-second-settled history and two matching scans one second apart.
It does not certify profitability. The worker must report `verified: true` with no observer
error before the operator enables Auto in the dashboard. Auto remains subject to every stop.
Observe recorded market decisions for the first recovery and subsequent pause.

If integration fails, keep or restore operator STOP so real exit management continues.
Do not delete unresolved evidence to obtain a passing certificate. Pending jobs retain their
execution-source hash; changing the execution engine requires explicit repair of old jobs.
Before rollback, preserve the new evidence and confirm zero open positions.

## Version 3 capture and diagnostic paper accounts

Use the normal deployment script and flat-position restart above. The child writer creates
`data/bot.simulation.db` automatically. Preserve this database with the trading databases.
Do not change the active guard, operator stop, stake, bankroll or drawdown settings for this rollout.

Since 2026-09-14 the worker's heartbeat and its report rebuild are separate. The `writer`
checkpoint ticks every 5 s and carries `reportAt`; the `report` checkpoint is rebuilt only
when a capture, result or scenario lands, with a 10 s floor and a 60 s ceiling. So a report
several minutes old is normal on a quiet stretch and is NOT a stale worker: every staleness
test downstream reads the heartbeat. Chain logs are no longer captured one row each; the main
process keeps a 30-minute ring of arrival times and writes one `curve-arrivals` row per
opportunity, five seconds after that launch's window closes.

Since 2026-09-15 a published scenario bundle stores the log array once at the bundle level
instead of a clone per scenario; `expandBundle` rebuilds the six from it, and a row written
before the change is returned untouched. `results.request` stores `logsDigest`, `logCount` and
the `fills` map in place of the bodies, which is everything the report read from them. The
evidence digest on both tables is still taken over the FULL request, so row identity means what
it always meant. Measured on real rows from the box: a bundle went 4.19 MB to 0.72 MB and a
request 1,304 kB to 69 kB, both round-tripping byte for byte.

Verify `captureHealth` advances in `/api/state`, including its `ringSize` and
`pendingPromotions`. Check `activeGuard` against the predeploy
snapshot. `candidateIndicator` remains unvalidated. `/api/chart.paper` shows the existing continuous estimates with an explicit partial-history label.
Strict `policy` and `continuous` accounts remain under Details; both withhold complete monthly
totals while coverage is missing. Display estimates never replace active guard evidence.
Check the simulation database's `gaps` and `processor` checkpoint before interpreting results.
A capture fault does not stop real exit management. Old captures and results must not be deleted
or rewritten to obtain a certificate. Latest-eight activation remains a separate money decision.

## Forward simulation ledger

Deploy and restart only while flat and operator STOP is set. The first worker boot for a new
model or policy records a forward boundary in `data/bot.simulation.db`. It does not import the
old reconstructed chart artifacts or reset real accounting. Paper Wallet, Coins and Market
Indicator remain empty until the first compatible result is published, then append from the
immutable `forward_publications` and `forward_indicators` rows.

After restart, verify the `forward-ledger` checkpoint and the open `simulation_epochs` row.
Every published execution must have six scenario rows. A colored p50 coin must have one admitted
p50 publication and its P&L must equal the corresponding wallet cash delta. If the worker stops,
the charts retain committed history and show a gap. The market guard becomes stale and blocks new
entries; real exits continue. Auto stays stopped until the ordinary release certificate passes.
