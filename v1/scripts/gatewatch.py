"""Is the venue worth trading right now?

The bot was halted on 2026-08-18 not because it broke but because the venue stopped
paying: the filtered cohort's rate of touching 1.21x inside 45s fell from ~70% to 12.5%
over six hours and we traded straight down the slope. Nothing visible at buy time
distinguishes a good-regime launch from a bad one (creator buy 0.070 vs 0.066 ETH,
exempt wallets 5.0 vs 4.7, twitter 90% vs 90%), so no filter can see it coming. The only
thing that separates them is what the crowd does after launch, and that is measurable
without holding anything.

So this watches the cohort instead of trading it. For every launch the bot SCREENED AND
PASSED, replay the curve from chain logs and ask one question: did it touch 1.21x within
45 seconds? A rolling window of that is the regime.

Deliberately holds no positions and reads bot.db read-only. It cannot lose money and it
cannot interfere with the bot; the worst it can do is be wrong about when to come back.

  python3 gatewatch.py            one pass, then print the status block
  python3 gatewatch.py --status   print the status block, pull nothing
  python3 gatewatch.py --backfill N   work through up to N unprocessed launches
"""

import json
import os
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # engine.py and chainio.py are deployed next to this file
import engine  # noqa: E402
import chainio  # noqa: E402
from chainio import BOT_DB, GATE_DB, CURVE_TOPICS  # noqa: E402

# The measurement, fixed on purpose, and DECOUPLED from the exit policy on 2026-08-19.
# TOUCH and HOLD are the gate's own bar and its own window (gateTouchMultiple, gateHoldMs),
# not the bot's take profit and max hold. A regime detector has to be a fixed yardstick or
# its own history stops being comparable: you can no longer tell whether the venue moved or
# your ruler did. See v1/src/config.ts STRATEGY.gate for the measured cost of coupling them.
#
# Every one of these is READ FROM THE BOT at startup, never trusted from here. recon.py
# learned this the hard way: it kept its own copy of the exit rule, the bot grew a take
# profit, and recon spent a day reporting 5-25pp of imaginary sim-vs-live gap. A watcher
# whose thresholds drift from the thing it is gating is worse than no watcher. The values
# below are only the fallback for a database that has not published yet.
TOUCH, HOLD, ENTRY_BLK = 1.21, 450, 20
WINDOW = 40
OPEN_AT, SHUT_AT = 25.0, 20.0
# The template gate (STRATEGY.book.templateGate): per exact dev-buy value, block when the
# trailing window holds >= T_MIN_OBS scored launches touching under T_SHUT_PCT. Same
# read-from-the-bot rule as everything above; these are only the fallback.
T_WINDOW_MS, T_MIN_OBS, T_SHUT_PCT = 86_400_000, 4, 15.0
X = 0.010  # notional, only to shape our own price impact in the replay
# THE ADAPTIVE TAKE PROFIT (STRATEGY.takeProfit.adaptive, 2026-09-05). Every scored launch
# also gets its outcome at each bar the bot trades, replayed under the bot's OWN exit rule
# (dead bail, hard stop, clock) with the same poll and lag the simulator uses. The bot
# takes the argmax over the trailing window at position open. Bar set and exit rule are
# read from the published strategy; these are only the fallback.
BARS = [1.25, 1.36, 1.50, 1.75, 2.00, 2.50, 3.00]
# THE BOT'S P&L SENSOR (src/strategy/gate.ts readVenue), for the status line only. Read
# from the published strategy like everything else here; these are the fallback.
V_WINDOW, V_OFF, V_ON, V_FRESH_MS, V_BAR = 40, -3.0, 0.5, 6 * 3600_000, 1.75
# The sensor counts only launches THE BOOK WOULD BUY (creator tax and exempt-wallet floors,
# strategy/entry.ts). This script scores every launch the screen passes on purpose, and
# 80% of those are coins the bot declines; summing them paused the bot on 2026-09-06 23:46
# on coins it would never have held. Published as minCreatorTaxBps / maxEntryTaxBps /
# minExemptionsToEnter. B_TAX_HI is the entry CEILING (new 2026-09-15, ENTRY_MAX_TAX_BPS),
# not the book screen's 200bps bound: with an untaxed-only book the floor alone would still
# sum every taxed launch and describe a book nobody is holding.
B_TAX, B_TAX_HI, B_EX = 50, 10000, 3
EXIT_HOLD, DEAD_BLK, DEAD_BELOW, STOP = 450, 200, 1.03, 0.50  # blocks of 100ms
XLAG, POLL = (
    6,
    12,
)  # sim.py's SIM_XLAG / SIM_POLL: the bot cannot act on a price it never saw
BATCH = int(os.environ.get("GATE_BATCH", 25))
PAUSE = 0.5  # 0.25 -> 0.5 on 2026-09-06: the public RPC 429s under load and the bot's poller shares it


rpc = chainio.make_rpc("gatewatch", timeout=25, tries=4, backoff=2.0)


def load_strategy():
    """Take the gate thresholds, take profit and hold from what the bot published."""
    global TOUCH, HOLD, WINDOW, OPEN_AT, SHUT_AT
    try:
        db = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True)
        row = db.execute(
            "SELECT value FROM chain_truth WHERE key='strategy_json'"
        ).fetchone()
        db.close()
        if not row:
            return False
        spec = json.loads(row[0])
        # gateTouchMultiple, NOT takeProfitMultiple. The gate is a fixed yardstick for the
        # venue, and inheriting the exit policy made the ruler move whenever the policy
        # did: raising the take profit to 1.25 would have taken the share of windows
        # below shutAt from 6.9% to 14.8% with nobody touching a gate setting. Falls
        # back to the module constant (1.21), never to the take profit.
        TOUCH = float(spec.get("gateTouchMultiple", TOUCH))
        # gateHoldMs, NOT maxHoldMs, for the same reason as gateTouchMultiple: the exit
        # clock is policy and may move, the gate's observation window is a measurement and
        # may not. Falls back to the module constant, never to the exit clock.
        HOLD = int(
            round(float(spec.get("gateHoldMs", HOLD * 100)) / 100.0)
        )  # 100ms blocks
        WINDOW = int(spec.get("gateWindow", WINDOW))
        OPEN_AT = float(spec.get("gateOpenAt", OPEN_AT))
        SHUT_AT = float(spec.get("gateShutAt", SHUT_AT))
        global T_WINDOW_MS, T_MIN_OBS, T_SHUT_PCT
        T_WINDOW_MS = int(spec.get("templateWindowMs", T_WINDOW_MS))
        T_MIN_OBS = int(spec.get("templateMinObs", T_MIN_OBS))
        T_SHUT_PCT = float(spec.get("templateShutBelowPct", T_SHUT_PCT))
        global BARS, EXIT_HOLD, DEAD_BLK, DEAD_BELOW, STOP
        global V_WINDOW, V_OFF, V_ON, V_FRESH_MS, V_BAR, B_TAX, B_TAX_HI, B_EX
        B_TAX = int(spec.get("minCreatorTaxBps", B_TAX))
        B_TAX_HI = int(spec.get("maxEntryTaxBps", B_TAX_HI))
        B_EX = int(spec.get("minExemptionsToEnter", B_EX))
        V_WINDOW = int(spec.get("venuePauseWindow", V_WINDOW))
        V_OFF = float(spec.get("venuePauseOff", V_OFF))
        V_ON = float(spec.get("venuePauseOn", V_ON))
        V_FRESH_MS = float(spec.get("venueFreshMs", V_FRESH_MS))
        V_BAR = float(spec.get("venueBar", V_BAR))
        if spec.get("takeProfitAdaptiveBars"):
            BARS = [float(b) for b in str(spec["takeProfitAdaptiveBars"]).split()]
        EXIT_HOLD = int(round(float(spec.get("maxHoldMs", EXIT_HOLD * 100)) / 100.0))
        DEAD_BLK = int(
            round(float(spec.get("deadCoinAfterMs", DEAD_BLK * 100)) / 100.0)
        )
        DEAD_BELOW = float(spec.get("deadCoinBelowMult", DEAD_BELOW))
        STOP = float(spec.get("hardStopMultiple", STOP))
        return True
    except Exception:
        return False


def publish_template_block(bot, gate):
    """The template gate's blocklist: exact dev-buy wei values whose trailing-window
    scored launches did not pay. The regime gate's own mechanism applied per value --
    the farms stamp identical launches from fresh deployers, so the exact wei value is
    the one legible handle, and OUTCOME is what separates 0.089 (farm, win 14%) from
    0.1 (organic, fine). Published into gate.db state; the bot merges its seed on top,
    so an empty list here never unblocks a seeded value.
    """
    now_ms = int(time.time() * 1000)
    # Bounded to the same trailing window as the obs query below. This used to read the
    # WHOLE launches table on every 5-minute tick, with no window and no LIMIT, and build a
    # dict of it -- while the only rows it could ever use are the ones an in-window obs
    # joins to. `launches` accumulates for the life of the deployment (over 800/hour), so on
    # a 1.1GB box that read and that dict grew without bound forever. Rows are keyed by
    # detected_at, and a launch is always detected before it is scored, so the window is
    # widened by one hour to cover an obs whose launch was detected just before the cut.
    dev = dict(
        bot.execute(
            "SELECT token, dev_buy_wei FROM launches "
            "WHERE dev_buy_wei IS NOT NULL AND detected_at >= ?",
            (now_ms - T_WINDOW_MS - 3_600_000,),
        )
    )
    stats = {}
    for tok, touch in gate.execute(
        "SELECT token, touch FROM obs WHERE error IS NULL AND at >= ?",
        (now_ms - T_WINDOW_MS,),
    ):
        v = dev.get(tok)
        if v is None:
            continue
        n, t = stats.get(v, (0, 0))
        stats[v] = (n + 1, t + (touch or 0))
    blocked = sorted(
        v
        for v, (n, t) in stats.items()
        if n >= T_MIN_OBS and 100.0 * t / n < T_SHUT_PCT
    )
    # ALWAYS written, same lesson as the gate verdict above: a missing row must mean
    # "never computed", never "computed nothing lately".
    gate.execute(
        "INSERT OR REPLACE INTO state (key,value) VALUES ('template_block',?)",
        (
            json.dumps(
                dict(
                    at=now_ms, minObs=T_MIN_OBS, shutBelowPct=T_SHUT_PCT, values=blocked
                )
            ),
        ),
    )
    gate.commit()
    return blocked


def open_gate_db():
    db = sqlite3.connect(GATE_DB)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS obs (
             token TEXT PRIMARY KEY, curve TEXT, block INTEGER, launched_at INTEGER,
             peak REAL, touch INTEGER, at INTEGER, error TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS state (
             key TEXT PRIMARY KEY, value TEXT)""")
    # 2026-09-05: per-bar outcomes for the adaptive take profit. Additive, NULL on every
    # row scored before it existed; pending() treats NULL as "not yet scored" so the
    # newest rows are rescored first and the bot's window fills within one pass.
    cols = {r[1] for r in db.execute("PRAGMA table_info(obs)")}
    if "bars" not in cols:
        db.execute("ALTER TABLE obs ADD COLUMN bars TEXT")
        db.commit()
    # every reader of obs sorts by block: this pass's rolling window, the bot's
    # RegimeGate.read() (synchronously, on the exit pump's settle path), and the
    # dashboard's replay. Without the index each of those is a full scan plus a temp
    # sort of a table that only grows.
    db.execute("CREATE INDEX IF NOT EXISTS idx_obs_block ON obs(block)")
    return db


def head():
    return int(rpc("eth_blockNumber", []), 16)


def pending(bot, gate, limit, tip):
    """Passed launches whose 45s window has fully closed and that we have not scored."""
    # bars IS NOT NULL: a row scored before the per-bar schema is rescored, newest first
    done = {
        r[0]
        for r in gate.execute(
            "SELECT token FROM obs WHERE error IS NULL AND bars IS NOT NULL"
        )
    }
    rows = bot.execute(
        "SELECT token, curve, block, launched_at, deployer, creator_tax_bps "
        "FROM launches WHERE passed = 1 ORDER BY block"
    ).fetchall()
    out = []
    for tok, curve, blk, at, dep, ctax in rows:
        if tok in done:
            continue
        if blk + HOLD + 60 > tip:  # still resolving; come back next run
            continue
        out.append(
            dict(token=tok, curve=curve, block=blk, at=at, deployer=dep, ctax=ctax or 0)
        )
    return out[-limit:]  # newest first matters more than ancient backfill


def _polled(rule, poll):
    """Restrict a rule to poll boundaries: the bot cannot act on a price it never saw."""
    state = {"next": 0.0}

    def wrapped(c):
        if c["off"] < state["next"]:
            return None
        state["next"] = c["off"] + poll
        return rule(c)

    return wrapped


def _rule(tp):
    """The bot's exit stack at one take-profit bar: tp, hard stop, dead bail. Same order
    and same comparisons as src/strategy/exit.ts evaluate() and sim.py mk_rule()."""

    def rule(x):
        if tp and x["m"] >= tp:
            return (1.0, "tp")
        if STOP and x["m"] <= STOP:
            return (1.0, "sl")
        if x["off"] >= DEAD_BLK and x["peak"] < DEAD_BELOW:
            return (1.0, "dead")
        return None

    return _polled(rule, POLL)


def score(row):
    """Replay the curve. Returns (peak multiple inside the gate window, per-bar outcomes
    as a JSON string of mult-1 keyed by bar with two decimals)."""
    lb = row["block"]
    logs = rpc(
        "eth_getLogs",
        [
            {
                "fromBlock": hex(lb),
                "toBlock": hex(lb + HOLD + 60),
                "address": row["curve"],
                "topics": [CURVE_TOPICS],
            }
        ],
    )
    # our own fills dropped inside: measure the VENUE, not ourselves
    seq = chainio.decode_seq(logs)
    l = {
        "token": row["token"],
        "curve": row["curve"],
        "block": lb,
        "deployer": row["deployer"],
        "tx": "",
    }
    P = engine.path(
        l,
        X,
        seq,
        row["ctax"],
        entry_blk=ENTRY_BLK,
        comp=0,
        haircut=0.0,
        horizon=HOLD + 50,
        tick=5,
    )
    if P is None:
        raise RuntimeError("no path (curve empty at entry)")
    peak = max(p[1] for p in P["pts"] if p[0] <= HOLD)
    bars = {}
    for tp in BARS:
        try:
            bars["%.2f" % tp] = (
                engine.evaluate(P, _rule(tp), exit_lag=XLAG, hold=EXIT_HOLD)["mult"]
                - 1.0
            )
        except Exception:
            pass  # one bar failing must not cost the row; the bot treats a missing key as 0
    return peak, json.dumps(bars)


def rolling(gate, n=None):
    rows = gate.execute(
        "SELECT block, touch, launched_at FROM obs WHERE error IS NULL ORDER BY block DESC LIMIT ?",
        (n or WINDOW,),
    ).fetchall()
    if not rows:
        return None, 0, None
    return 100.0 * sum(r[1] for r in rows) / len(rows), len(rows), rows[0][2]


def venue_sum(gate, bot):
    """The bot's P&L sensor, recomputed here so the operator sees the number the bot is
    deciding on (src/strategy/gate.ts readVenue). Read-only and advisory: this script does
    not decide the venue pause and must never look as though it does.

    The window, the bar, the freshness limit and the book floors come from the published
    strategy, like every other threshold in this file. A monitor quoting a bound the bot is
    not running is worse than one that stays quiet. Only launches the book would buy count
    (B_TAX / B_EX, joined through bot.db), the same set the bot's own query keeps."""
    # over-fetch: four in five scored launches are outside the book and drop out below
    rows = gate.execute(
        "SELECT token, bars, launched_at FROM obs WHERE error IS NULL AND bars IS NOT NULL "
        "AND launched_at > 0 ORDER BY block DESC LIMIT ?",
        (V_WINDOW * 12,),
    ).fetchall()
    book = set()
    toks = [r[0] for r in rows]
    for i in range(0, len(toks), 500):
        chunk = toks[i : i + 500]
        book.update(
            t
            for (t,) in bot.execute(
                "SELECT token FROM launches WHERE token IN (%s) "
                "AND creator_tax_bps >= ? AND creator_tax_bps <= ? "
                "AND COALESCE(exemptions, 0) >= ?"
                % ",".join("?" * len(chunk)),
                (*chunk, B_TAX, B_TAX_HI, B_EX),
            )
        )
    key = "%.2f" % V_BAR
    total, kept, oldest, seen = 0.0, 0, 0, 0
    for tok, js, la in rows:
        if kept >= V_WINDOW:
            break
        seen += 1
        if tok not in book:
            continue
        try:
            v = json.loads(js).get(key)
        except Exception:
            continue
        if not isinstance(v, (int, float)):
            continue
        total += float(v)
        kept += 1
        oldest = la
    if not kept:
        return None
    age_h = (time.time() - oldest) / 3600.0
    return dict(
        sum=total,
        n=kept,
        seen=seen,
        fresh=(kept >= V_WINDOW and age_h * 3600_000 <= V_FRESH_MS),
        age_h=age_h,
    )


def status(gate, bot, quiet=False):
    rate, n, last_at = rolling(gate)
    prev = gate.execute("SELECT value FROM state WHERE key='gate'").fetchone()
    was = prev[0] if prev else "shut"
    if rate is None:
        print("gate: no observations yet")
        return None, was
    # hysteresis so we do not flap across a single threshold
    now = "open" if (rate >= OPEN_AT if was == "shut" else rate > SHUT_AT) else "shut"
    # ALWAYS write the verdict, not only when it changes. The bot reads this row and maps
    # a missing one to "open"; `was` defaults to "shut" up there. So a gate.db born during
    # a bad regime used to agree with itself (shut -> shut, no write) while telling the bot
    # to keep trading - the two halves disagreeing in precisely the state that costs money.
    gate.execute("INSERT OR REPLACE INTO state (key,value) VALUES ('gate',?)", (now,))
    if now != was:
        gate.execute(
            "INSERT OR REPLACE INTO state (key,value) VALUES ('changed_at',?)",
            (str(int(time.time() * 1000)),),
        )
    gate.commit()
    total = gate.execute("SELECT COUNT(*) FROM obs WHERE error IS NULL").fetchone()[0]
    # launches.launched_at is the block timestamp, in SECONDS (detected_at is the ms one)
    age = (time.time() - last_at) / 60.0 if last_at else -1
    bar = "#" * int(rate / 2.5)
    if not quiet:
        print("=" * 64)
        print(
            "  GATE %-5s   touch-1.21 %5.1f%%  (last %d launches)"
            % (now.upper(), rate, n)
        )
        print("  %s" % bar)
        print(
            "  opens at %.0f%%, shuts below %.0f%%   |  %d scored, newest %.0f min old"
            % (OPEN_AT, SHUT_AT, total, age)
        )
        v = venue_sum(gate, bot)
        if v is not None:
            print(
                "  venue  %+.2f stakes over %d book launches (of %d scored) at %.2fx%s   (pauses below %.1f, resumes above %.1f)"
                % (
                    v["sum"],
                    v["n"],
                    v["seen"],
                    V_BAR,
                    (
                        ""
                        if v["fresh"]
                        else "  [NO WINDOW: %.1fh old, the bot has no opinion]"
                        % v["age_h"]
                    ),
                    V_OFF,
                    V_ON,
                )
            )
        hb = gate.execute("SELECT value FROM state WHERE key='ran_at'").fetchone()
        hb_age = (time.time() * 1000 - float(hb[0])) / 60000.0 if hb else None
        # the bot shuts the gate on a stale heartbeat, so show the operator the same clock
        print(
            "  heartbeat %s   (the bot reads >30 min as SHUT)"
            % ("NEVER" if hb_age is None else "%.0f min ago" % hb_age)
        )
        if now != was:
            print("  *** REGIME CHANGED: %s -> %s ***" % (was.upper(), now.upper()))
            if now == "open":
                print("  the venue is paying again. to resume: set HALT=0 in bot/.env,")
                print("  then pm2 restart compute-1 --update-env")
        print("=" * 64)
    return now, was


def main():
    published = load_strategy()
    if not published:
        print(
            "warning: no published strategy; using fallback tp %.2f hold %ds gate %.0f/%.0f"
            % (TOUCH, HOLD // 10, OPEN_AT, SHUT_AT)
        )
    gate = open_gate_db()
    bot = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True)
    if "--status" in sys.argv:
        status(gate, bot)
        return
    limit = BATCH
    if "--backfill" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--backfill") + 1])
    tip = head()
    todo = pending(bot, gate, limit, tip)
    ok = bad = 0
    for row in todo:
        try:
            peak, bars = score(row)
            gate.execute(
                "INSERT OR REPLACE INTO obs (token,curve,block,launched_at,peak,touch,at,error,bars) "
                "VALUES (?,?,?,?,?,?,?,NULL,?)",
                (
                    row["token"],
                    row["curve"],
                    row["block"],
                    row["at"],
                    peak,
                    1 if peak >= TOUCH else 0,
                    int(time.time() * 1000),
                    bars,
                ),
            )
            ok += 1
        except Exception as e:
            # record the failure so we do not spin on it, but leave it re-tryable
            gate.execute(
                "INSERT OR REPLACE INTO obs (token,curve,block,launched_at,peak,touch,at,error,bars) "
                "VALUES (?,?,?,?,NULL,0,?,?,NULL)",
                (
                    row["token"],
                    row["curve"],
                    row["block"],
                    row["at"],
                    int(time.time() * 1000),
                    str(e)[:120],
                ),
            )
            bad += 1
        gate.commit()
        time.sleep(PAUSE)
    # Heartbeat, stamped only after a pass that actually reached the chain. The bot treats
    # a stale one as SHUT: a frozen gate.db reads as "open" forever, so a watcher that dies
    # mid-regime-break is the one way this design can fail towards losing money. Not
    # stamped by --status, which pulls nothing and proves nothing.
    gate.execute(
        "INSERT OR REPLACE INTO state (key,value) VALUES ('ran_at',?)",
        (str(int(time.time() * 1000)),),
    )
    gate.commit()
    blocked = publish_template_block(bot, gate)
    print("scored %d launches (%d failed), chain tip %d" % (ok, bad, tip))
    if blocked:
        print(
            "template gate: %d value(s) blocked: %s"
            % (len(blocked), " ".join("%.4g" % (int(v) / 1e18) for v in blocked[:8]))
        )
    status(gate, bot)


# Guarded. Without this, merely IMPORTING this module for its constants runs a full
# scoring pass: it hits the RPC, writes obs rows, stamps ran_at and rewrites the gate
# state row. Tripped on 2026-08-19 by a one-line `import gatewatch` that only wanted to
# read TOUCH and HOLD, and which instead raced the systemd timer for the write lock.
# systemd runs `python3 gatewatch.py`, so __name__ is "__main__" there and this is a no-op
# for the real entry point.
if __name__ == "__main__":
    main()
