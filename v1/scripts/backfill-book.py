"""Score the BOOK coins the minute-timer will never reach.

gatewatch's `pending()` takes the NEWEST unscored launches (`out[-limit:]`), which is right
for a regime detector: a stale reading is the failure that costs money, an unscored coin from
last week is not. The consequence is that the tail never gets scored. On 2026-09-13 there
were 12,961 unscored passed launches, and everything before 2026-09-05 had no `bars` at all.

The dashboard's paper wallet and its venue panes both read `obs.bars`, and both join
`launches` on the book floors first (see venue-sensor-measures-the-book: `obs` is ~80% coins
the bot declines). So the useful backlog is not 12,961 coins, it is the 1,575 BOOK coins from
2026-09-01 to 09-05. This scores exactly those, oldest first, so the chart fills from the left
edge the operator is looking at.

DELIBERATELY NOT gatewatch:
  - it never stamps `state.ran_at`. That heartbeat is the bot's liveness proof for the LIVE
    scoring path, and a backfill finishing does not prove the live path ran.
  - it never touches `state.gate` or the template block. Those are the live timer's outputs.
  - it takes the OLDEST first, the opposite of `pending()`, because the point is the tail.

It writes `obs` rows for coins days old. Nothing live reads them: the venue guard takes the
newest outcomes by block, and the shadow publisher only looks up tokens it already holds jobs
for. It reads bot.db read-only and cannot hold a position.

  python3 backfill-book.py --from 2026-09-01 --to 2026-09-06 --pause 6
  python3 backfill-book.py --status
"""

import os
import signal
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gatewatch  # noqa: E402
from chainio import BOT_DB  # noqa: E402

# The public RPC is shared with the bot's fallback read path. snipe-gate.timer runs every
# minute at GATE_BATCH=10 because 25/min produced 20+ 429s a minute (see the unit's
# batch.conf). This process is the SECOND consumer, so it defaults well under that and backs
# off on its own errors rather than trusting a constant.
PAUSE = 6.0
BACKOFF_AFTER = 3  # consecutive failures before slowing down
BACKOFF_MAX = 60.0

STOP = False


def _stop(signum, frame):
    global STOP
    STOP = True
    print("\nstopping after the current coin", flush=True)


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def day_ms(s):
    return int(time.mktime(time.strptime(s, "%Y-%m-%d")) - time.timezone)


def todo(bot, gate, lo, hi):
    """Book coins in [lo,hi) seconds with no usable outcome yet, OLDEST first."""
    done = {
        r[0]
        for r in gate.execute(
            "SELECT token FROM obs WHERE error IS NULL AND bars IS NOT NULL"
        )
    }
    rows = bot.execute(
        "SELECT token, curve, block, launched_at, deployer, creator_tax_bps "
        "FROM launches WHERE passed = 1 AND launched_at >= ? AND launched_at < ? "
        "AND creator_tax_bps >= ? AND COALESCE(exemptions,0) >= ? "
        "ORDER BY block ASC",
        (lo, hi, gatewatch.B_TAX, gatewatch.B_EX),
    ).fetchall()
    return [
        dict(token=t, curve=c, block=b, at=a, deployer=d, ctax=x or 0)
        for t, c, b, a, d, x in rows
        if t not in done
    ]


def main():
    args = sys.argv[1:]

    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default

    gatewatch.load_strategy()
    gate = gatewatch.open_gate_db()
    bot = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True)
    lo = day_ms(opt("--from", "2026-09-01"))
    hi = day_ms(opt("--to", "2026-09-06"))
    work = todo(bot, gate, lo, hi)

    if "--status" in args:
        print(
            "%d book coins still unscored in [%s, %s)"
            % (len(work), opt("--from", "2026-09-01"), opt("--to", "2026-09-06"))
        )
        return

    pause = float(opt("--pause", PAUSE))
    limit = int(opt("--limit", len(work)))
    work = work[:limit]
    started = time.time()
    print(
        "%d book coins to score, oldest %s, pause %.1fs, about %.1f h"
        % (
            len(work),
            (
                time.strftime("%Y-%m-%d %H:%M", time.gmtime(work[0]["at"]))
                if work
                else "-"
            ),
            pause,
            len(work) * pause / 3600,
        ),
        flush=True,
    )

    ok = bad = 0
    streak = 0
    for i, row in enumerate(work):
        if STOP:
            break
        try:
            peak, bars = gatewatch.score(row)
            gate.execute(
                "INSERT OR REPLACE INTO obs (token,curve,block,launched_at,peak,touch,at,error,bars) "
                "VALUES (?,?,?,?,?,?,?,NULL,?)",
                (
                    row["token"],
                    row["curve"],
                    row["block"],
                    row["at"],
                    peak,
                    1 if peak >= gatewatch.TOUCH else 0,
                    int(time.time() * 1000),
                    bars,
                ),
            )
            ok += 1
            streak = 0
        except Exception as e:
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
            streak += 1
        gate.commit()
        if (i + 1) % 50 == 0:
            rate = (i + 1) / max(1e-9, time.time() - started) * 60
            print(
                "  %d/%d  ok %d  failed %d  %.1f/min  at %s"
                % (
                    i + 1,
                    len(work),
                    ok,
                    bad,
                    rate,
                    time.strftime("%m-%d %H:%M", time.gmtime(row["at"])),
                ),
                flush=True,
            )
        # Back off on OUR OWN error streak. A 429 storm shows up here first, and the bot's
        # fallback read path is on the same endpoint.
        time.sleep(min(BACKOFF_MAX, pause * (2 ** min(6, streak // BACKOFF_AFTER))))

    print(
        "scored %d, failed %d, %.1f min elapsed%s"
        % (ok, bad, (time.time() - started) / 60, ", STOPPED EARLY" if STOP else ""),
        flush=True,
    )


if __name__ == "__main__":
    main()
