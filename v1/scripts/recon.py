#!/usr/bin/env python3
"""Live-vs-sim reconciliation. Runs on the box every 10 minutes from a systemd timer.

For every closed live trade it replays the exact same coin through the research
engine (scripts/engine.py, deployed alongside this script) at the real fill block
with calibrated frictions (comp=0, haircut=0), and stores sim-vs-live per trade in
data/recon.db. The dashboard and livewatch render the running gap: when the sim
drifts from reality it shows up as a number within hours, not as a surprise loss
after a week. Both P&L sides are GROSS of gas: gas is venue-independent and the
question here is whether the curve replay prices the coins we trade.

stdlib only, throttled hard: the box's public-RPC budget already runs hot from the
bot's own log poller (53 eth_getLogs 429s/hour measured), so this batches <=20 rows,
spaces calls ~250ms, and backs off on any error. A failed row retries next cycle.

Acceptance (must reproduce the 2026-08-18 hand replay): `python3 recon.py --verify`
on rows 151-171 gives sim -$4.85 vs live -$3.94, 8/19 exact, mean gap -0.45pp.
"""

import json
import os
import sqlite3
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # engine.py and chainio.py are deployed next to this file
import engine  # noqa: E402
import chainio  # noqa: E402
from chainio import BOT_DB, CURVE_TOPICS, NON_TRADE_SQL  # noqa: E402

RECON_DB = os.path.join(HERE, "..", "data", "recon.db")
# FALLBACK ONLY. The live value is read from what the bot published, by load_hold() below.
# A grader replaying a different clock than the bot ran reports execution error that is
# really a strategy mismatch: at 450 blocks against a 90s bot, every coin still climbing at
# 45s scores as "the sim lost money the bot made".
HOLD_BLOCKS = 450
BATCH = int(os.environ.get("RECON_BATCH", 20))
PACE_S = 0.5


def load_hold():
    """Take the exit clock from what the bot published, like gatewatch.py's load_strategy.

    HOLD_BLOCKS used to be a hand-maintained literal kept in step with STRATEGY.maxHoldMs
    by a comment and, later, by a source-regex test. That is a test-time check on a runtime
    duplication, and this exact class of bug is the most expensive recurring one in the
    project: recon kept its own copy of the exit rule, the bot grew a take profit, and recon
    reported 5-25pp of imaginary sim-vs-live gap for a day.

    maxHoldMs, not gateHoldMs: this replays OUR trades under OUR exit policy, so it must
    follow the exit clock. gatewatch.py reads gateHoldMs instead, because the gate is a
    fixed yardstick for the venue. The two are deliberately decoupled and this is the half
    that moves.

    Only the window length is read here. The exit RULE stays local on purpose, for the
    reason live_exit_rule's docstring gives: sourcing the whole rule from a JSON blob would
    let a schema change silently turn the exit back into a bare clock. A scalar window
    cannot fail that way -- it is either a number or the fallback stands.
    """
    global HOLD_BLOCKS
    try:
        db = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True)
        row = db.execute(
            "SELECT value FROM chain_truth WHERE key='strategy_json'"
        ).fetchone()
        db.close()
        if not row:
            return False
        ms = json.loads(row[0]).get("maxHoldMs")
        if not ms:
            return False
        HOLD_BLOCKS = int(round(float(ms) / 100.0))  # 100ms blocks
        return True
    except Exception:
        return False


rpc = chainio.make_rpc("snipe-recon/1", timeout=30, tries=4, backoff=2.0, pace_s=PACE_S)


def open_recon():
    db = sqlite3.connect(RECON_DB)
    db.execute("PRAGMA journal_mode=WAL")  # the dashboard reads while we write
    db.execute(
        """CREATE TABLE IF NOT EXISTS recon (
             position_id INTEGER PRIMARY KEY, token TEXT, at INTEGER,
             sim_pnl_wei TEXT, live_pnl_wei TEXT, gap_pp REAL, ok INTEGER, error TEXT)"""
    )
    return db


def pending_rows(bot, recon, limit, id_range=None):
    base = bot.execute(
        "SELECT value FROM chain_truth WHERE key='epoch_base_id'"
    ).fetchone()
    epoch = int(base[0]) if base else 150
    done = {r[0] for r in recon.execute("SELECT position_id FROM recon WHERE ok=1")}
    q = (
        "SELECT p.id, p.token, p.buy_hash, p.spend_wei, p.proceeds_wei, p.take_profit, "
        "p.dead_after_ms, p.dead_below, "
        "l.block, l.curve, l.deployer, l.creator_tax_bps "
        "FROM positions p JOIN launches l ON l.token = p.token "
        "WHERE p.id > ? AND p.live = 1 AND p.closed = 1 AND p.buy_ok = 1 "
        f"AND p.exit_reason NOT IN ({NON_TRADE_SQL}) ORDER BY p.id"
    )
    rows = [
        dict(
            zip(
                (
                    "id",
                    "token",
                    "buy_hash",
                    "spend_wei",
                    "proceeds_wei",
                    "take_profit",
                    "dead_after_ms",
                    "dead_below",
                    "block",
                    "curve",
                    "deployer",
                    "ctax",
                ),
                r,
            )
        )
        for r in bot.execute(q, (epoch,))
    ]
    if id_range:
        rows = [r for r in rows if id_range[0] <= r["id"] <= id_range[1]]
    return [r for r in rows if r["id"] not in done][:limit]


HARD_STOP = 0.5  # STRATEGY.hardStopMultiple

# What a position was exiting on before positions.take_profit existed. Every row opened
# before 2026-08-19 12:44 has a NULL there, and the value it actually ran was whatever
# src/config.ts said at the time -- 1.21 until 2026-08-19 11:41, then 1.25.
#
# Encoding a timeline of config changes here would be worse than the problem: it is the
# same duplicated-constant trap the docstring below warns about, one entry longer every
# time the policy moves. So there is ONE fallback, it is the last scalar the bot ran, and
# every row that uses it is COUNTED and printed. A silent fallback is the failure mode; a
# counted one is a number you can look at.
LEGACY_TAKE_PROFIT = 1.25
_fallbacks = [0]


def live_exit_rule(take_profit=None, dead_after_ms=None, dead_below=None):
    """The exit the BOT actually ran FOR THIS POSITION.

    This used to be `lambda c: None`, a bare clock. Correct until the take profit shipped
    on 2026-08-18 11:06, after which recon replayed a 45s clock against a bot that sells at
    1.21x, so every coin that kept running past +21% scored as "the sim beat live".
    Measured on 60 trades: clock exits reconcile at +0.01pp under either rule, take-profit
    exits at +18.29pp under the old one and +2.52pp under this one, dragging the headline
    from +6.41pp (past the 1.5pp alarm) to +0.89pp (inside it). A monitor comparing two
    different strategies cannot see a real execution problem under its own noise.

    THE SAME FAILURE, SECOND TIME, 2026-08-19. The take profit stopped being a scalar and
    became a schedule over the venue's trailing gate rate (1.25 / 1.36 / 1.50 at cuts
    25/35), so the book now holds several at once and NO constant here can be right. Worse,
    the constant standing here was 1.21 while the bot had been running 1.25 since 11:41,
    so recon was already replaying a rule the bot did not run before the schedule landed.
    It now reads the rung off the position's own row, which is the only version of this
    that cannot go stale: the bot writes what it used, and recon replays that.

    HARD_STOP stays duplicated on purpose. It is genuinely a constant, and reading the
    whole rule from chain_truth.strategy_json would let a schema change silently turn the
    exit back into a bare clock, which is the failure this comment exists to describe.
    """
    tp = take_profit
    if tp is None:
        tp = LEGACY_TAKE_PROFIT
        _fallbacks[0] += 1
    # The dead-coin bailout, read off the row like the take profit (positions.dead_after_ms
    # / dead_below, pinned at open). NULL means the row predates the bailout and replays
    # without one -- NOT a fallback constant, because "no rule" is the truth for old rows.
    # The bar is bot-scale against the engine's sim-scale mark, the same accepted ~1pp
    # bias as the take profit above. ms -> blocks at the chain's 100ms cadence.
    dead_blk = int(dead_after_ms / 100) if dead_after_ms else None

    def rule(c):
        if tp and c["m"] >= tp:
            return (c["held"], "tp")
        if HARD_STOP and c["m"] <= HARD_STOP:
            return (c["held"], "sl")
        if (
            dead_blk is not None
            and c["off"] >= dead_blk
            and c["peak"] < (dead_below or 0)
        ):
            return (c["held"], "dead")
        return None

    return rule


def replay(row):
    rc = rpc("eth_getTransactionReceipt", [row["buy_hash"]])
    fill = int(rc["blockNumber"], 16)
    lb = row["block"]
    logs = rpc(
        "eth_getLogs",
        [
            {
                "fromBlock": hex(lb),
                "toBlock": hex(fill + HOLD_BLOCKS + 60),
                "address": row["curve"],
                "topics": [CURVE_TOPICS],
            }
        ],
    )
    seq = chainio.decode_seq(logs)  # the replay must not contain our own trades

    X = int(row["spend_wei"]) / 1e18
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
        row["ctax"] or 0,
        entry_blk=fill - lb,
        comp=0,
        haircut=0.0,
        horizon=HOLD_BLOCKS + 50,
    )
    if P is None:
        raise RuntimeError("no path (curve empty at entry)")
    e = engine.evaluate(
        P,
        live_exit_rule(
            row.get("take_profit"), row.get("dead_after_ms"), row.get("dead_below")
        ),
        # 2 -> 6 on 2026-08-27, matching sim.XLAG. Two graders that disagree about how long
        # a sell takes to settle cannot both be right, and 6 is the calibrated one: total
        # error against booked P&L is +8.1% at lag 2, +3.6% at lag 6, +14.2% at lag 12 over
        # 481 real trades. recon is the live monitor, so it was the one reporting a gap that
        # was partly its own clock.
        exit_lag=6,
        hold=HOLD_BLOCKS,
    )
    sim_pnl_wei = int((e["mult"] - 1) * int(row["spend_wei"]))  # gross of gas
    live_pnl_wei = int(row["proceeds_wei"] or 0) - int(row["spend_wei"])
    gap_pp = (sim_pnl_wei - live_pnl_wei) / int(row["spend_wei"]) * 100
    return sim_pnl_wei, live_pnl_wei, gap_pp


def main():
    verify = "--verify" in sys.argv
    # before any replay: the clock we grade against must be the clock the bot ran
    if not load_hold():
        print(
            f"recon: strategy_json unreadable, replaying at the fallback "
            f"{HOLD_BLOCKS} blocks ({HOLD_BLOCKS / 10:.0f}s)",
            file=sys.stderr,
        )
    bot = sqlite3.connect(f"file:{BOT_DB}?mode=ro", uri=True)
    recon = open_recon()
    rows = pending_rows(
        bot, recon, 25 if verify else BATCH, (151, 171) if verify else None
    )
    if verify:
        # re-run the acceptance rows even if already reconciled
        done = {r[0] for r in recon.execute("SELECT position_id FROM recon WHERE ok=1")}
        rows = pending_rows(bot, recon, 25, (151, 171)) or []
        if not rows:  # everything reconciled already: recompute from the stored table
            out = recon.execute(
                "SELECT position_id, sim_pnl_wei, live_pnl_wei, gap_pp FROM recon "
                "WHERE ok=1 AND position_id BETWEEN 151 AND 171 ORDER BY position_id"
            ).fetchall()
            _summary([(r[0], int(r[1]), int(r[2]), r[3]) for r in out])
            return
    results = []
    for row in rows:
        try:
            sim, live, gap = replay(row)
            recon.execute(
                "INSERT OR REPLACE INTO recon VALUES (?,?,?,?,?,?,1,NULL)",
                (
                    row["id"],
                    row["token"],
                    int(time.time() * 1000),
                    str(sim),
                    str(live),
                    gap,
                ),
            )
            results.append((row["id"], sim, live, gap))
        except Exception as ex:
            recon.execute(
                "INSERT OR REPLACE INTO recon VALUES (?,?,?,NULL,NULL,NULL,0,?)",
                (row["id"], row["token"], int(time.time() * 1000), str(ex)[:200]),
            )
        recon.commit()
    if verify:
        _summary(results)
    else:
        n = recon.execute("SELECT COUNT(*) FROM recon WHERE ok=1").fetchone()[0]
        fb = (
            f", {_fallbacks[0]} on the legacy {LEGACY_TAKE_PROFIT} take profit"
            if _fallbacks[0]
            else ""
        )
        print(f"recon: +{len(results)} rows this run, {n} total{fb}")


def _summary(results):
    E = float(os.environ.get("ETHUSD", 2145))
    sim = sum(r[1] for r in results) / 1e18
    live = sum(r[2] for r in results) / 1e18
    exact = sum(1 for r in results if abs(r[3]) < 0.005)
    gaps = sorted(r[3] for r in results)
    mean = sum(gaps) / len(gaps) if gaps else 0.0
    # median leads, mean trails. see livewatch.cjs: one trade can carry the whole mean,
    # and on 2026-08-26 exactly one did (-215pp on a single row, median 0.00).
    median = statistics.median(gaps) if gaps else 0.0
    print(
        f"n={len(results)}  sim ${sim * E:+.2f}  live ${live * E:+.2f}  "
        f"exact {exact}/{len(results)}  median gap {median:+.2f}pp  (mean {mean:+.2f}pp)"
    )


if __name__ == "__main__":
    main()
