#!/usr/bin/env python3
"""The simulator. One engine, three windows, calibrated against booked P&L.

Everything that replays a counterfactual goes through this file. That is the whole point
of it: before 2026-08-27 the box carried thirty-three scripts that each replayed the curve
their own way, and twenty-six of them were wrong in the same three ways at once. A sweep
run on one of those claimed +$0.72/trade for buying everything, in a 24h window where the
live bot lost money. The scripts are gone; this is what replaced them.

THE THREE FIXES, which are the difference between that number and a real one:

  1. ENTRY LATENCY. The bot decides at block 20 (2.0s in) and the fill LANDS at block 32.
     Measured over 492 live fills in 48h: median 32, p75 52, p90 71. A sweep that enters at
     its own decision block is pricing a fill nobody can get, and on a curve moving this
     fast those twelve blocks are most of the edge it thinks it found.

  2. EXIT LAG. A sell that triggers at block N settles at N+6, not N+2. Calibrated against
     481 booked trades: total error +8.1% at lag 2, +3.6% at lag 6, +14.2% at lag 12.

  3. POLL. The bot reads the mark over HTTP on a cadence, so a spike that opens and closes
     between two samples never existed as far as it is concerned. The engine left alone
     evaluates the rule at every curve event and happily sells into exactly those spikes.
     Calibrated over 768 booked trades: total error -3.0% at poll=1, -1.2% at poll=12,
     +10.8% at poll=25. Twelve blocks, which independently matches the live-vs-sim hold gap.

Together they take the harness from +9% aggregate error to -1.2% over 768 booked trades,
with 91% agreement on the exit REASON. `--verify` re-runs that gate on live data and is
the only thing that entitles any number out of this file to be believed.

THE TWO WINDOWS, ALWAYS BINNED, ALWAYS ENDING NOW. Every question gets asked twice:

    last 24h, in 8 bins of 3 hours    -- is this working today
    last 7d,  in 7 bins of 1 day      -- is it a strategy or a mood

The bins are the point, not decoration. A single 7-day total hides that one hot afternoon
paid for six flat days, and this venue does exactly that: the top 5% of trades routinely
carry more than the whole net. A config that only wins in one bin is a config that won that
bin, and it gets labelled as one rather than promoted.

Nothing here hardcodes a strategy number. The live configuration is read from what the bot
published to chain_truth.strategy_json, so `live` in a table is whatever is actually
running, and it cannot silently drift from it.
"""

import bisect
import json
import os
import sqlite3
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import chainio  # noqa: E402
import engine  # noqa: E402
import stats  # noqa: E402
from chainio import BOT_DB, GATE_DB, CURVE_TOPICS, NON_TRADE_REASONS  # noqa: E402

CACHE = os.environ.get("SIM_CACHE", os.path.join(HERE, "..", "data", "fresh_cache.db"))
ETHUSD = engine.ETHUSD

# ---------------------------------------------------------------- calibration
# The three numbers the docstring is about. They are not tunable knobs: they are measured
# properties of our own execution, and the only reason to touch one is a fresh measurement
# from `--verify` saying execution itself has changed.
LATENCY = int(os.environ.get("SIM_LATENCY", 12))
XLAG = int(os.environ.get("SIM_XLAG", 6))
POLL = int(os.environ.get("SIM_POLL", 12))

# The bot's decision block: 2.0s in, at the chain's 100ms cadence.
DECIDE_BLK = 20
# Blocks of curve history to keep per launch. 1200 covers a 120s hold, the longest clock
# worth testing, and the rest is slack for entry latency plus the exit lag on top of it.
HORIZON = 1560
# eth_getLogs silently truncates instead of erroring. A response sitting exactly on a round
# number is the signature, and it once gutted the newest 70% of a dataset and invalidated a
# live fit before anyone noticed. Treated as a fetch failure, never cached.
LOG_CAPS = (1000, 2000, 5000, 10000)

# ---------------------------------------------------------------- the windows
WINDOWS = ("24h", "7d")
# window -> (bin count, hours per bin). The product is the window length; there is no
# separate constant for it, so the two cannot drift apart.
BINS = {"24h": (8, 3.0), "7d": (7, 24.0)}


def _hours(w):
    n, h = BINS[w]
    return n * h


def window_ms(w, now=None):
    """(start_ms, end_ms) for a standard window. The end is NOW, every time it is called.

    Never anchored to a wall-clock hour. An anchored window silently ages: it looks live,
    it is named for the last 24 hours, and by the following afternoon it is reporting on a
    regime that ended. On this venue that is a real failure mode and not a hypothetical --
    a filter cohort once stopped five hours before the trading it was being used to judge.
    """
    if w not in BINS:
        raise KeyError(f"window must be one of {WINDOWS}, got {w!r}")
    end = int(time.time() * 1000) if now is None else int(now)
    return end - int(_hours(w) * 3600_000), end


def bins(w, now=None):
    """[(label, lo_ms, hi_ms)] oldest first, the newest bin ending now."""
    n, h = BINS[w]
    lo, hi = window_ms(w, now)
    step = int(h * 3600_000)
    out = []
    for i in range(n):
        a = lo + i * step
        b = a + step
        fmt = "%m-%d" if h >= 24 else "%m-%d %Hh"
        out.append((time.strftime(fmt, time.gmtime(a / 1000)), a, b))
    return out


# ---------------------------------------------------------------- live config
def live_config():
    """The strategy the bot published, as a sim config.

    Read rather than copied. A monitor or a sim that keeps its own copy of a strategy
    number is the most expensive recurring bug in this project, because a stale literal
    never throws: it just quietly grades the wrong thing until someone notices the numbers
    make no sense. Same rule as recon.py's load_hold and gatewatch.py's load_strategy.
    """
    db = sqlite3.connect(f"file:{BOT_DB}?mode=ro", uri=True)
    row = db.execute("SELECT value FROM chain_truth WHERE key='strategy_json'").fetchone()
    db.close()
    if not row:
        raise RuntimeError("no strategy_json in chain_truth: is the bot running?")
    s = json.loads(row[0])
    dead_ms = s.get("deadCoinAfterMs") or 0
    return cfg(
        label="live",
        tp=s.get("takeProfitOtherwise"),
        hold_s=float(s["maxHoldMs"]) / 1000.0,
        stop=s.get("hardStopMultiple"),
        dead_s=(dead_ms / 1000.0) if dead_ms else None,
        dead_below=s.get("deadCoinBelowMult"),
        size_eth=float(s.get("tradeSizeEth", 0.0075)),
    )


def cfg(label, tp=None, hold_s=90.0, stop=0.5, dead_s=None, dead_below=None,
        wait_s=0.0, size_eth=None):
    """One strategy under test.

    Times are in SECONDS at this boundary and blocks below it, because every strategy
    number the operator ever says out loud is in seconds and every off-by-ten in this
    project came from a conversion someone did in their head.

    wait_s delays the entry DECISION past the default 2.0s. Latency is added on top of it,
    never folded into it: a rule that reads the curve up to its decision block still cannot
    be filled before that block plus 12, and pretending otherwise is the look-ahead trap
    that manufactured a +10.9% signal out of nothing on 08-18.
    """
    dead_blk = max(1, int(round(dead_s * 10)) - LATENCY) if dead_s else None
    # The live clock starts at `openedAt`, which the bot stamps when it SEQUENCES the buy
    # (bot.ts:601), not when the fill lands. The sim's `off` is measured from the fill block,
    # which is LATENCY blocks later, so a 45s setting replayed literally holds 45s + 1.2s.
    # Subtracting the latency puts both clocks on the same origin. It is 2.7% of a 45s hold
    # and 1.3% of a 90s one, which is small per trade and systematically favours whichever
    # config holds longest -- exactly the comparison these configs are being ranked on.
    hold_blk = max(1, int(round(hold_s * 10)) - LATENCY)
    return {
        "label": label,
        "tp": tp,
        "hold": hold_blk,                         # 100ms blocks, fill-relative
        "stop": stop,
        "dead_blk": dead_blk,
        # the bar is meaningless with no time to apply it at, and carrying it anyway made
        # the live config compare unequal to an identical sweep point and print twice
        "dead_below": dead_below if dead_blk else None,
        "entry_blk": DECIDE_BLK + int(round(wait_s * 10)) + LATENCY,
        "size_eth": size_eth,
    }


def describe(c):
    # add LATENCY back so the label shows the setting an operator would recognise
    bits = [f"TP{c['tp']:.2f}" if c["tp"] else "no TP", f"{(c['hold']+LATENCY)/10:.0f}s"]
    if c["dead_blk"]:
        bits.append(f"bail{(c['dead_blk']+LATENCY)/10:.0f}s/{c['dead_below']:.2f}")
    if c["stop"]:
        bits.append(f"stop{c['stop']:.2f}")
    if c["entry_blk"] != DECIDE_BLK + LATENCY:
        bits.append(f"enter+{(c['entry_blk'] - LATENCY)/10:.0f}s")
    return " ".join(bits)


# ---------------------------------------------------------------- exit rules
def polled(rule, poll=POLL):
    """Restrict a rule to poll boundaries: the bot cannot act on a price it never saw."""
    if poll <= 1:
        return rule
    state = {"next": 0.0}

    def wrapped(c):
        if c["off"] < state["next"]:
            return None
        state["next"] = c["off"] + poll
        return rule(c)

    return wrapped


def mk_rule(c):
    tp, stop, dead_blk, dead_below = c["tp"], c["stop"], c["dead_blk"], c["dead_below"]

    def rule(x):
        if tp and x["m"] >= tp:
            return (1.0, "tp")
        if stop and x["m"] <= stop:
            return (1.0, "sl")
        if dead_blk is not None and x["off"] >= dead_blk and x["peak"] < dead_below:
            return (1.0, "dead")
        return None

    return polled(rule)


# ---------------------------------------------------------------- data
def _cache(write=False):
    if write:
        db = sqlite3.connect(CACHE, timeout=30)
        db.execute("CREATE TABLE IF NOT EXISTS seq (token TEXT PRIMARY KEY, js TEXT, at INTEGER)")
        return db
    return sqlite3.connect(f"file:{CACHE}?mode=ro", uri=True)


def launches(w, cohort="book", now=None):
    """Launch rows in a standard window. cohort 'book' is what the live filter admitted."""
    lo, hi = window_ms(w, now)
    return launches_range(lo, hi, cohort)


def launches_range(lo, hi, cohort="book"):
    """Launch rows between two timestamps.

    Exists so an out-of-sample window runs through THIS loader rather than a copy of it.
    A holdout that is loaded by different code from the discovery set is not a holdout, it
    is two experiments, and the difference between them shows up as a result.
    """
    db = sqlite3.connect(f"file:{BOT_DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    q = (
        "SELECT token, curve, deployer, block, detected_at, creator_tax_bps ctax, "
        "dev_buy_wei dev, exemptions ex, prior_launches priors, passed, live_book, "
        "has_twitter tw FROM launches "
        "WHERE detected_at>=? AND detected_at<? AND block IS NOT NULL AND curve IS NOT NULL"
    )
    if cohort == "book":
        q += " AND passed=1"
    rows = [dict(r) for r in db.execute(q, (lo, hi))]
    db.close()
    return rows


def topup_range(lo, hi, cohort="book", **kw):
    return _topup(launches_range(lo, hi, cohort), f"{cohort} range", **kw)


def topup(w, cohort="book", now=None, limit=None, quiet=False):
    """Fetch any curve sequences the window needs and does not have.

    This is what makes the windows live rather than a snapshot. Paced, because the public
    RPC 429s under load and the live bot's poller is sharing it.
    """
    return _topup(launches(w, cohort, now), f"{w}/{cohort}", limit=limit, quiet=quiet)


def _topup(rows, label, limit=None, quiet=False):
    have = {r[0] for r in _cache().execute("SELECT token FROM seq")}
    todo = [r for r in rows if r["token"] not in have]
    if limit:
        todo = todo[:limit]
    if not todo:
        if not quiet:
            print(f"  cache complete for {label}: {len(rows)} launches", flush=True)
        return 0
    if not quiet:
        print(f"  fetching {len(todo)} of {len(rows)} for {label} "
              f"(~{len(todo) * 0.3 / 60:.1f} min)", flush=True)
    rpc = chainio.make_rpc("snipe-sim/1", timeout=30, tries=4, backoff=2.0, pace_s=0.25)
    db = _cache(write=True)
    got = 0
    for i, r in enumerate(todo):
        try:
            logs = rpc("eth_getLogs", [{
                "fromBlock": hex(r["block"]),
                "toBlock": hex(r["block"] + HORIZON),
                "address": r["curve"],
                "topics": [CURVE_TOPICS],
            }])
        except Exception:
            continue
        if len(logs) in LOG_CAPS:  # truncated, not empty: never cache a lie
            if not quiet:
                print(f"    TRUNCATED {r['token'][:10]} at {len(logs)} logs", flush=True)
            continue
        db.execute("INSERT OR REPLACE INTO seq VALUES (?,?,?)",
                   (r["token"], json.dumps(chainio.decode_seq(logs)), int(time.time() * 1000)))
        got += 1
        if got % 50 == 0:
            db.commit()
            if not quiet:
                print(f"    {got}/{len(todo)}", flush=True)
    db.commit()
    db.close()
    return got


def load(w, cohort="book", now=None):
    """(launch_row, seq) for every launch in the window that has a usable sequence."""
    return load_rows(launches(w, cohort, now))


def load_range(lo, hi, cohort="book"):
    return load_rows(launches_range(lo, hi, cohort))


def load_rows(rows):
    have = dict(_cache().execute("SELECT token, js FROM seq"))
    out = []
    for r in rows:
        js = have.get(r["token"])
        if not js:
            continue
        seq = json.loads(js)
        if seq:
            out.append((r, seq))
    return out


# ---------------------------------------------------------------- replay
def run(data, c, size_eth=None):
    """Replay one config over loaded launches. Returns [(detected_at, pnl_usd, token)]."""
    X = size_eth or c.get("size_eth") or live_config()["size_eth"]
    out = []
    for l, seq in data:
        P = engine.path(
            l={"token": l["token"], "curve": l["curve"], "block": l["block"],
               "deployer": l["deployer"] or "0x0", "tx": ""},
            X=X, seq=seq, ctax=l["ctax"] or 0,
            entry_blk=c["entry_blk"], comp=0, haircut=0.0, horizon=HORIZON,
        )
        if P is None:
            continue
        # rebuilt per launch, not hoisted: polled() carries the next-sample cursor, so a
        # shared rule would let one coin's poll phase leak into the next one's
        r = engine.evaluate(P, mk_rule(c), exit_lag=XLAG, hold=c["hold"])
        out.append((l["detected_at"], r["pnl"] * ETHUSD, l["token"]))
    return out


# ---------------------------------------------------------------- scoring
def summary(vals):
    """Never a mean alone. Median, spread and n travel with every average here."""
    v = sorted(vals)
    n = len(v)
    if not n:
        return {"n": 0, "net": 0.0, "per": 0.0, "median": 0.0, "sd": 0.0,
                "win": 0.0, "p25": 0.0, "p75": 0.0, "top5": 0.0, "ex_tail": 0.0}
    net = sum(v)
    k = max(1, int(round(n * 0.05)))
    top = sum(v[-k:])
    body = v[:-k] if n > k else []
    return {
        "n": n,
        "net": net,
        "per": net / n,
        "median": statistics.median(v),
        "sd": statistics.pstdev(v) if n > 1 else 0.0,
        "win": 100.0 * sum(1 for x in v if x > 0) / n,
        "p25": v[int(n * 0.25)],
        "p75": v[min(n - 1, int(n * 0.75))],
        # what fraction of the whole result rides on the best 5% of trades
        "top5": (top / net * 100.0) if net else 0.0,
        # per-trade profit after deleting that best 5%: edge, or a lottery ticket
        "ex_tail": (sum(body) / len(body)) if body else 0.0,
    }


HDR = (f"{'config':<34}{'n':>5}{'net$':>9}{'per$':>8}{'med$':>8}"
       f"{'sd':>7}{'win%':>7}{'ex5$':>8}{'top5%':>7}{'maxDD$':>9}")


def line(label, s):
    t = (f"{label:<34}{s['n']:>5}{s['net']:>9.2f}{s['per']:>8.2f}{s['median']:>8.2f}"
         f"{s['sd']:>7.2f}{s['win']:>7.1f}{s['ex_tail']:>8.2f}{s['top5']:>7.0f}"
         f"{s.get('max_dd', 0):>9.2f}")
    if "ci_lo" in s:
        t += f"{s['ci_lo']:>8.2f}{s['ci_hi']:>8.2f}"
    return t


# ---------------------------------------------------------------- regime
def gate_rate_fn():
    """Trailing-20 touch rate as the GATE would have read it at that instant.

    obs.launched_at is SECONDS and every caller works in milliseconds. Converted here,
    once, rather than letting each caller get it wrong its own way: that mismatch silently
    handed every launch the same take-profit rung for a day on 08-26.

    Returns (rate_at_ms, n_obs). rate_at_ms is None before 20 observations exist, which is
    a real state and not a zero: the gate cannot score a book it has not seen.
    """
    g = sqlite3.connect(f"file:{GATE_DB}?mode=ro", uri=True)
    g.row_factory = sqlite3.Row
    obs = [(r["launched_at"] * 1000, r["touch"]) for r in g.execute(
        "SELECT launched_at, touch FROM obs WHERE error IS NULL AND touch IS NOT NULL "
        "ORDER BY launched_at")]
    g.close()
    ts = [o[0] for o in obs]

    def rate(t_ms):
        i = bisect.bisect_left(ts, t_ms)
        if i < 20:
            return None
        return 100.0 * sum(x for _, x in obs[i - 20:i]) / 20

    return rate, len(obs)


# ---------------------------------------------------------------- scoring, part 2
def score(res, ci=False):
    """Full distribution for one config's replay output, in trade order.

    Drawdown and the bootstrap both need the real sequence, which is why this takes run()'s
    output rather than a bare list of numbers. The bootstrap is a BLOCK bootstrap on that
    order, never iid: launches on this venue cluster hard into good and bad hours, and an
    iid resample prices that correlation as free precision.
    """
    res = sorted(res, key=lambda r: r[0])
    vals = [p for _, p, _ in res]
    s = summary(vals)
    s["max_dd"] = stats.max_dd(vals)
    if ci and len(vals) >= 40:
        lo, hi = stats.block_boot(vals, stat=stats.med, n=2000, block=20, seed=7)
        s["ci_lo"], s["ci_hi"] = lo, hi
    return s


# ---------------------------------------------------------------- the gate
# The live exit vocabulary against the engine's. Same events, different spellings, and
# comparing them raw scored a perfectly agreeing replay at 36%.
REASON_MAP = {"time": "time", "tp": "tp", "stop": "sl", "dead": "dead", "graduating": "grad"}


def clock_at(t, times, span_ms=7200_000):
    """The exit clock in force at time t, in blocks, read off our own timeout exits.

    A trade that exited on the clock held for the clock, so the median hold of nearby
    `time` exits IS the setting, to within a poll interval. Derived rather than declared
    because positions do not record the clock they ran under, and the alternative is a
    hardcoded changeover date that silently grades every future config change wrong. The
    median also shrugs off the outliers a stopped process leaves behind: three trades in
    this table have holds of 100 seconds to 30 hours, and a mean would follow them.
    """
    near = [h for ts, h in times if abs(ts - t) <= span_ms]
    if not near:
        near = [h for _, h in times]
    if not near:
        return None
    return int(round(statistics.median(near) / 100.0 / 50.0)) * 50


def verify(w, now=None):
    """Replay what we actually traded, under the settings each trade actually ran, and
    compare to booked P&L.

    This is the only thing that entitles anything else in this file to be believed. It is
    the same gate that caught a sweep claiming +$0.72/trade in a window where the bot lost
    money, which is how the three fixes above were found in the first place.

    Two numbers come back, and they fail for different reasons:

      exec  enters at the fill block the chain recorded. Isolates the EXIT model, so it
            moves when XLAG or POLL is wrong.
      cf    enters at decide+LATENCY, knowing only what was knowable at launch. This is
            the mode every sweep runs in, so this is the number that licenses them, and
            it additionally moves when LATENCY is wrong.
    """
    lo, hi = window_ms(w, now)
    return verify_range(lo, hi)


def verify_range(lo, hi):
    db = sqlite3.connect(f"file:{BOT_DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    bad = ",".join(f"'{r}'" for r in NON_TRADE_REASONS)
    pos = db.execute(
        f"SELECT p.token, p.spend_wei, p.proceeds_wei, p.exit_reason, p.hold_ms, "
        f"p.t_detect, p.fill_block, p.take_profit, p.dead_after_ms, p.dead_below, "
        f"l.curve, l.deployer, l.block, l.creator_tax_bps ctax "
        f"FROM positions p JOIN launches l ON l.token=p.token "
        f"WHERE p.t_detect>=? AND p.t_detect<? AND p.live=1 AND p.closed=1 AND p.buy_ok=1 "
        f"AND p.proceeds_wei IS NOT NULL AND p.exit_reason NOT IN ({bad})",
        (lo, hi),
    ).fetchall()
    # the clock reference is drawn from the whole tape, not just this window: a 6h window
    # can easily hold too few clock exits to place its own median
    times = db.execute(
        "SELECT t_detect, hold_ms FROM positions WHERE live=1 AND closed=1 AND buy_ok=1 "
        "AND exit_reason='time' AND hold_ms IS NOT NULL"
    ).fetchall()
    db.close()
    times = [(t, h) for t, h in times]
    have = dict(_cache().execute("SELECT token, js FROM seq"))

    out = {"n": 0, "live": 0.0, "skipped": len(pos), "stake": 0.0}
    for mode in ("exec", "cf"):
        out[mode] = {"sim": 0.0, "agree": 0, "gaps": []}
    seen = 0
    for r in pos:
        js = have.get(r["token"])
        if not js:
            continue
        seq = json.loads(js)
        if not seq:
            continue
        hold = clock_at(r["t_detect"], times)
        if not hold:
            continue
        # each trade replayed under ITS OWN settings, not today's. Replaying the current
        # config against trades booked under the previous one scored +476% error and was
        # measuring the config change, not the harness.
        c = cfg("booked", tp=r["take_profit"], hold_s=hold / 10.0, stop=0.5,
                dead_s=(r["dead_after_ms"] / 1000.0) if r["dead_after_ms"] else None,
                dead_below=r["dead_below"])
        X = int(r["spend_wei"]) / 1e18
        base = {"token": r["token"], "curve": r["curve"], "block": r["block"],
                "deployer": r["deployer"] or "0x0", "tx": ""}
        entries = {"cf": c["entry_blk"]}
        if r["fill_block"]:
            entries["exec"] = int(r["fill_block"]) - r["block"]
        ok = False
        for mode, eb in entries.items():
            if eb < 0:
                continue
            P = engine.path(l=base, X=X, seq=seq, ctax=r["ctax"] or 0,
                            entry_blk=eb, comp=0, haircut=0.0, horizon=HORIZON)
            if P is None:
                continue
            e = engine.evaluate(P, mk_rule(c), exit_lag=XLAG, hold=c["hold"])
            sp = e["pnl"] * ETHUSD
            out[mode]["sim"] += sp
            out[mode]["gaps"].append(sp - (int(r["proceeds_wei"]) - int(r["spend_wei"])) / 1e18 * ETHUSD)
            if e["reason"] == REASON_MAP.get(r["exit_reason"]):
                out[mode]["agree"] += 1
            ok = True
        if not ok:
            continue
        seen += 1
        out["stake"] += int(r["spend_wei"]) / 1e18 * ETHUSD
        out["live"] += (int(r["proceeds_wei"]) - int(r["spend_wei"])) / 1e18 * ETHUSD
    out["n"] = seen
    out["skipped"] = len(pos) - seen
    out["notional"] = (out["stake"] / seen) if seen else 16.0
    for mode in ("exec", "cf"):
        d = out[mode]
        g = sorted(d.pop("gaps"))
        d["err_pct"] = ((d["sim"] - out["live"]) / abs(out["live"]) * 100.0) if out["live"] else float("nan")
        d["reason_agree"] = (100.0 * d["agree"] / seen) if seen else 0.0
        # The aggregate percentage is unusable on a short window: 6h of booked P&L sits
        # near zero, so a $20 disagreement on 94 trades reads as 36% error and looks like
        # a broken harness. The median per-trade gap is the scale-free version of the same
        # question, and on that same window it came to -$0.008 against a $16 notional.
        d["gap_median"] = statistics.median(g) if g else 0.0
        d["gap_mean"] = (sum(g) / len(g)) if g else 0.0
        # how much of the total disagreement rides on the five worst trades. High means a
        # handful of coins that moved inside one poll interval, not a biased model.
        top = sorted(g, key=lambda x: -abs(x))[:5]
        tot = sum(g)
        d["gap_top5_pct"] = (sum(top) / tot * 100.0) if abs(tot) > 1e-9 else 0.0
        # PASS is judged on the robust statistic and on whether we agree about WHY each
        # trade ended. One percent of NOTIONAL is the bar, where notional means the size of
        # the trade, not its result.
        #
        # The first version of this line divided total booked P&L by the trade count and
        # called that notional. That is the average outcome, not the stake, and it collapses
        # toward zero exactly when a window nets out flat -- so a perfectly healthy replay of
        # a break-even period failed its own gate. It flagged the 08-17..08-20 holdout as
        # FAIL at a median gap of one cent. Notional now comes from what we actually staked.
        d["pass"] = abs(d["gap_median"]) <= 0.01 * out["notional"] and d["reason_agree"] >= 80.0
    return out


# ---------------------------------------------------------------- the slate
def slate():
    """The configs every run reports on, with the live one always present and marked.

    Deliberately small. The count of variants tried is part of the result: a p-value at
    try 300 is not a p-value at try 3, and a slate that grows every session turns the
    leaderboard into a search for the luckiest bin rather than the best rule.
    """
    live = live_config()
    out = [live]
    # the clock, at the live take profit. 08-27's dose response said 45s sells into the
    # middle of the move now that coins peak at 70-90s rather than ~30s.
    for hs in (45, 60, 90, 120):
        out.append(cfg(f"clock {hs}s", tp=live["tp"], hold_s=hs))
    # the take profit, at the live clock
    for tp in (1.25, 1.36, 1.50, 1.75, 2.50):
        out.append(cfg(f"TP{tp:.2f}", tp=tp, hold_s=live["hold"] / 10.0))
    out.append(cfg("no TP", tp=None, hold_s=live["hold"] / 10.0))
    # the dead-coin bail, which inverted in this era: it was selling coins that recover
    for ds, db in ((20, 1.02), (25, 1.02), (20, 1.03)):
        out.append(cfg(f"bail {ds}s/{db:.2f}", tp=live["tp"], hold_s=live["hold"] / 10.0,
                       dead_s=ds, dead_below=db))
    # what we were actually running before 08-27 16:00, for a like-for-like reference
    out.append(cfg("prior live TP1.25 45s bail20", tp=1.25, hold_s=45, dead_s=20, dead_below=1.03))
    # dedupe on the parameters rather than the label: the live config usually coincides
    # with one of the sweep points, and two identical rows in a leaderboard invite the
    # reader to treat one result as two pieces of evidence
    seen = {}
    uniq = []
    for c in out:
        k = (c["tp"], c["hold"], c["stop"], c["dead_blk"], c["dead_below"], c["entry_blk"])
        if k in seen:
            continue
        seen[k] = 1
        uniq.append(c)
    return uniq, live


def sweep(w, cohort="book", ci=False, now=None):
    """Every config in the slate, over one window, whole and per bin."""
    data = load(w, cohort, now)
    cs, live = slate()
    bs = bins(w, now)
    rows = []
    for c in cs:
        res = run(data, c)
        r = {"label": c["label"], "spec": describe(c), "is_live": c is live,
             "overall": score(res, ci=ci), "bins": []}
        for lbl, lo, hi in bs:
            r["bins"].append({"bin": lbl,
                              "s": summary([p for t, p, _ in res if lo <= t < hi])})
        # how many of the bins this config finished in front on. Consistency, not total:
        # ranking on the sum lets one lucky afternoon buy the top slot outright.
        rows.append(r)
    for i, _ in enumerate(bs):
        best = max(rows, key=lambda r: r["bins"][i]["s"]["net"])
        best.setdefault("wins", 0)
        best["wins"] = best.get("wins", 0) + 1
    for r in rows:
        r.setdefault("wins", 0)
        pos = [b for b in r["bins"] if b["s"]["n"] and b["s"]["net"] > 0]
        r["bins_positive"] = len(pos)
        r["bins_with_trades"] = len([b for b in r["bins"] if b["s"]["n"]])
    return {"window": w, "cohort": cohort, "n_launches": len(data),
            "bins": [b[0] for b in bs], "configs": rows,
            "n_variants": len(cs),
            "generated_at": int(time.time() * 1000)}


# ---------------------------------------------------------------- cli
def main():
    args = sys.argv[1:]
    wins = [a for a in args if a in WINDOWS] or list(WINDOWS)
    cohort = "all" if "--all-launches" in args else "book"
    ci = "--ci" in args
    if "--no-fetch" not in args:
        print("topping up the cache so the windows are live:", flush=True)
        for w in wins:
            topup(w, cohort)
    print(f"\nsim  latency {LATENCY} blk   exit lag {XLAG} blk   poll {POLL} blk"
          f"   eth ${ETHUSD:.0f}", flush=True)
    c = live_config()
    print(f"live config from chain_truth: {describe(c)}  size {c['size_eth']} ETH")
    out = {}
    for w in wins:
        v = verify(w)
        lo, hi = window_ms(w)
        n, h = BINS[w]
        print(f"\n=== {w}  {n} bins x {h:g}h  ({cohort})  "
              f"{time.strftime('%m-%d %H:%M', time.gmtime(lo/1000))} -> "
              f"{time.strftime('%m-%d %H:%M', time.gmtime(hi/1000))} UTC")
        if v["n"]:
            print(f"  gate  n={v['n']} booked ${v['live']:.2f}"
                  + (f"  ({v['skipped']} unreplayable)" if v["skipped"] else ""))
            for mode in ("exec", "cf"):
                d = v[mode]
                flag = "PASS" if d["pass"] else "FAIL"
                print(f"    {mode:<5}[{flag}] sim ${d['sim']:8.2f}  aggregate {d['err_pct']:+6.1f}%"
                      f"   per-trade gap median ${d['gap_median']:+.3f}"
                      f"   top5 {d['gap_top5_pct']:.0f}% of it   reasons {d['reason_agree']:.0f}%")
            if not all(v[m]["pass"] for m in ("exec", "cf")):
                print("    GATE FAILED: the tables below are not entitled to be believed.")
        else:
            print("  gate [SKIP] no closed trades in this window")
        sw = sweep(w, cohort, ci=ci)
        out[w] = {"gate": v, "sweep": sw}
        print(f"  {sw['n_launches']} replayable launches, {sw['n_variants']} variants tried")
        hdr = HDR + (f"{'ciLo$':>8}{'ciHi$':>8}" if ci else "") + f"{'bins+':>7}{'wins':>6}"
        print("  " + hdr)
        rows = sorted(sw["configs"], key=lambda r: -r["overall"]["net"])
        for r in rows:
            tag = r["spec"] + (" *LIVE*" if r["is_live"] else "")
            print("  " + line(tag, r["overall"])
                  + f"{r['bins_positive']}/{r['bins_with_trades']:<5}{r['wins']:>6}")
    for a in args:
        if a.startswith("--json="):
            with open(a.split("=", 1)[1], "w") as f:
                json.dump(out, f)
            print(f"\nwrote {a.split('=', 1)[1]}")


if __name__ == "__main__":
    if os.environ.get("PYTHONHASHSEED") != "0":
        # engine.path seeds its rival slots from hash(token), which CPython randomises per
        # process. Setting the env var in-process is too late: the seed is fixed at
        # interpreter startup, so the only honest fix is to start over with it set.
        os.environ["PYTHONHASHSEED"] = "0"
        os.execv(sys.executable, [sys.executable] + sys.argv)
    main()
