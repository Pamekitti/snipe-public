#!/usr/bin/env python3
"""The daily edge check: is each rule the bot runs still paying?

Every filter the bot trades on was measured on a window and is right until the market
moves. Two of them have already flipped once: coins with 1-2 exempt wallets made +$112 in
the 2.50-bar era (08-25/26) and lost $46 in the 1.75-bar era (09-04/05); the take-profit
bar itself went 2.50 -> 1.36 -> 1.75 in a week. Nothing in the process re-measured any of
it. This does, every morning before the entry window opens, and the dashboard turns a
rule that stopped paying into an alert the phone receives.

NO REPLAY OF ITS OWN AND NO RPC. gatewatch.py already replays every book-passing launch,
taxed or not, at every bar the bot trades, under the bot's own exit rule, and stores the
result in gate.db obs.bars. So this is a join (obs.bars x launches.exemptions/creator_tax
x positions) and a few sums. It can therefore never disagree with the scorer that feeds
the adaptive bar, and it cannot rate-limit the bot.

CALIBRATION, stated once: the replay is ~2x optimistic on LEVEL and right on SIGN and on
RANKING (140 paired real trades on 2026-09-06: real +6.4%/trade, replay +12.2%, sign
agreement 91%). Every replay number below is a ranking instrument, and every real number
is real. The verdicts compare replay to replay and real to zero, never replay to real.

Writes one JSON row to gate.db state 'edgecheck' (the table gatewatch owns and the
dashboard already reads) and prints a summary. Runs from snipe-edge.timer at 11:30 UTC.
"""

import collections
import datetime as dt
import json
import os
import sqlite3
import statistics as st
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BOT_DB = os.environ.get("BOT_DB", os.path.join(HERE, "..", "data", "bot.db"))
GATE_DB = os.environ.get("GATE_DB", os.path.join(HERE, "..", "data", "gate.db"))
ETH_USD = float(os.environ.get("ETHUSD", 2145))
# mirrors telemetry/db.ts NON_TRADE_REASONS; keep in step (configdrift.test.ts polices the
# other two copies in livewatch.cjs and recon.py the same way)
NON_TRADE = ("recovered-flat", "buy-reverted", "buy-never-mined")
WINDOWS = {"24h": 24 * 3600, "7d": 7 * 86400}
MIN_N_REAL = 30  # below this a real-money verdict is noise
MIN_N_REPLAY = 30
RESOLUTION_LAG_S = (
    120  # the adaptive bar's window may only use launches whose hold has closed
)


def strategy(bot):
    row = bot.execute(
        "SELECT value FROM chain_truth WHERE key='strategy_json'"
    ).fetchone()
    s = json.loads(row[0]) if row else {}
    bars = [
        float(x)
        for x in str(
            s.get("takeProfitAdaptiveBars", "1.25 1.36 1.50 1.75 2.00 2.50 3.00")
        ).split()
    ]
    # The 12-24 UTC entry clock, kept as a MEASUREMENT after the rule was deleted on
    # 2026-09-07. The bot trades 24 hours now, so this is no longer a verdict about a
    # filter; it is the day/night split of the same replay, which is the number that would
    # tell us the night has turned bad again. Hard-coded because there is no longer a
    # published window to read: this is the historical boundary, not a live setting.
    window = (12, 24)
    return dict(
        bars=bars,
        otherwise=float(s.get("takeProfitOtherwise", 1.75)),
        adaptive_window=int(s.get("takeProfitAdaptiveWindow", 20)),
        min_exempt=int(s.get("minExemptionsToEnter", 3)),
        window=window,
        min_tax=int(s.get("minCreatorTaxBps", 50)),
        max_tax=int(s.get("maxCreatorTaxBps", 200)),
        # The untaxed cohort is still MEASURED even though the probe book that traded it
        # was deleted on 2026-09-07: the daily check is what would tell us it started
        # paying again. These are no longer published (there is no book to publish), so
        # they are local constants: untaxed means a zero creator tax, and 16 exempt
        # wallets was the floor the cohort was measured at.
        probe_min_exempt=16,
        probe_tax=0,
    )


def in_window(ts, w):
    if not w:
        return True
    h = dt.datetime.fromtimestamp(ts, dt.timezone.utc).hour
    a, b = w
    return (a <= h < b) if a < b else (h >= a or h < b)


def key(bar):
    return "%.2f" % bar


def replay_rows(gate, bot, since_s):
    """every scored launch since `since_s`, with its per-bar outcomes and its launch facts"""
    obs = gate.execute(
        "SELECT token, launched_at, bars FROM obs WHERE error IS NULL AND bars IS NOT NULL AND launched_at >= ?",
        (since_s,),
    ).fetchall()
    out = []
    toks = [o[0] for o in obs]
    facts = {}
    for i in range(0, len(toks), 500):
        chunk = toks[i : i + 500]
        q = (
            "SELECT token, creator_tax_bps, exemptions FROM launches WHERE token IN (%s)"
            % ",".join("?" * len(chunk))
        )
        for t, tax, ex in bot.execute(q, chunk):
            facts[t] = (tax, ex)
    for token, at, bars in obs:
        f = facts.get(token)
        if not f or f[0] is None:
            continue
        try:
            b = {k: float(v) for k, v in json.loads(bars).items()}
        except Exception:
            continue
        out.append(
            dict(
                token=token,
                at=int(at or 0),
                tax=int(f[0]),
                ex=f[1] if f[1] is None else int(f[1]),
                bars=b,
            )
        )
    return out


def real_rows(bot, since_ms):
    q = """SELECT p.exit_at, COALESCE(p.cohort,'main') cohort,
                  CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei) AS REAL) pnl, l.exemptions ex, l.creator_tax_bps tax
           FROM positions p LEFT JOIN launches l ON l.token = p.token
           WHERE p.live = 1 AND p.closed = 1 AND p.buy_ok = 1 AND p.exit_at >= ?
             AND p.exit_reason NOT IN (%s)""" % ",".join("'%s'" % r for r in NON_TRADE)
    return [
        dict(at=r[0], cohort=r[1], pnl=(r[2] or 0.0) / 1e18, ex=r[3], tax=r[4])
        for r in bot.execute(q, (since_ms,))
    ]


def reverted_buys(bot, gate, since_ms):
    """Buys the chain reverted: how many, what the gas cost, and whether refusing them
    left money on the table. The revert is the 50% buy slippage fuse tripping on a coin
    that moved more than half between our quote and our fill, i.e. an in-flight pump.
    Counterfactual: the replay of THOSE coins at our bar, from a launch+2s entry (about
    2x optimistic, and it prices the entry BEFORE the pump we would actually have paid).
    2026-09-06: 14 reverts in 3 days, $0.68 of gas, replay mean +9% before the pump."""
    q = """SELECT p.token, CAST(COALESCE(p.onchain_pnl_wei, p.pnl_wei, '0') AS REAL) pnl
           FROM positions p WHERE p.live = 1 AND p.closed = 1 AND p.exit_reason = 'buy-reverted' AND p.exit_at >= ?"""
    rows = list(bot.execute(q, (since_ms,)))
    sent = bot.execute(
        "SELECT COUNT(*) FROM positions WHERE live = 1 AND closed = 1 AND buy_ok = 1 AND exit_at >= ? AND exit_reason NOT IN (%s)"
        % ",".join("'%s'" % r for r in NON_TRADE),
        (since_ms,),
    ).fetchone()[0]
    bar_key = None
    replay = []
    for tok, _ in rows:
        r = gate.execute("SELECT bars FROM obs WHERE token = ? AND bars IS NOT NULL", (tok,)).fetchone()
        if not r:
            continue
        try:
            b = json.loads(r[0])
        except Exception:
            continue
        for k in ("1.75", "1.50"):
            if isinstance(b.get(k), (int, float)):
                replay.append(float(b[k]))
                break
    return dict(
        n=len(rows),
        pct_of_sends=round(100.0 * len(rows) / max(1, len(rows) + sent), 1),
        gas_usd=round(sum((r[1] or 0.0) for r in rows) / 1e18 * ETH_USD, 2),
        replay_n=len(replay),
        replay_mean=round(st.mean(replay), 4) if replay else 0.0,
        replay_win=round(100 * sum(1 for x in replay if x > 0) / len(replay), 1) if replay else 0.0,
    )


def summarise_real(rows):
    if not rows:
        return dict(n=0, pnl_usd=0.0, win=0.0, median_usd=0.0)
    pn = [r["pnl"] * ETH_USD for r in rows]
    return dict(
        n=len(pn),
        pnl_usd=round(sum(pn), 2),
        win=round(100 * sum(1 for x in pn if x > 0) / len(pn), 1),
        median_usd=round(st.median(pn), 2),
    )


def summarise_replay(rows, bar):
    v = [r["bars"][key(bar)] for r in rows if key(bar) in r["bars"]]
    if not v:
        return dict(n=0, mean=0.0, win=0.0, median=0.0)
    return dict(
        n=len(v),
        mean=round(st.mean(v), 4),
        win=round(100 * sum(1 for x in v if x > 0) / len(v), 1),
        median=round(st.median(v), 4),
    )


def adaptive_walk_forward(rows, bars, window, fallback):
    """the live rule (argmax of the trailing window's summed outcomes) against fixed bars"""
    rows = sorted(rows, key=lambda r: r["at"])
    keys = [key(b) for b in bars]
    rows = [r for r in rows if all(k in r["bars"] for k in keys)]
    if not rows:
        return dict(
            n=0,
            adaptive=0.0,
            fixed={},
            fixed_otherwise=0.0,
            best_fixed=0.0,
            best_bar=None,
        )
    total = 0.0
    picks = collections.Counter()
    for i, x in enumerate(rows):
        hist = [y for y in rows[:i] if y["at"] <= x["at"] - RESOLUTION_LAG_S][-window:]
        if len(hist) < window:
            bar = key(fallback)
        else:
            bar = max(keys, key=lambda k: sum(y["bars"][k] for y in hist))
        picks[bar] += 1
        total += x["bars"][bar]
    fixed = {k: round(sum(r["bars"][k] for r in rows), 3) for k in keys}
    best = max(fixed, key=fixed.get)
    return dict(
        n=len(rows),
        adaptive=round(total, 3),
        fixed=fixed,
        fixed_otherwise=fixed.get(key(fallback), 0.0),
        best_fixed=fixed[best],
        best_bar=best,
        picks=dict(picks),
    )


def window_report(gate, bot, S, secs, now_ms):
    since_s = now_ms // 1000 - secs
    rep = replay_rows(gate, bot, since_s)
    real = real_rows(bot, now_ms - secs * 1000)
    taxed = [r for r in rep if S["min_tax"] <= r["tax"] <= S["max_tax"]]
    untaxed = [r for r in rep if r["tax"] == S["probe_tax"]]
    ex = lambda r: (r["ex"] or 0)
    ex12 = [r for r in taxed if 1 <= ex(r) <= 2]
    ex3 = [r for r in taxed if ex(r) >= S["min_exempt"]]
    inside = [r for r in ex3 if in_window(r["at"], S["window"])]
    outside = [r for r in ex3 if not in_window(r["at"], S["window"])]
    un16 = [r for r in untaxed if ex(r) >= S["probe_min_exempt"]]
    bar = S["otherwise"]
    # how much of the window the replay actually covers. obs.bars only exists since
    # 2026-09-05 17:17 UTC, so a "7d" window is hours of data until 09-12, and a verdict
    # must say so rather than borrow the label's authority.
    oldest = min((r["at"] for r in rep), default=None)
    coverage_h = round((now_ms / 1000 - oldest) / 3600, 1) if oldest else 0.0
    return dict(
        coverage_h=min(coverage_h, round(secs / 3600, 1)),
        # cohort != 'probe' still, and it must stay: history has probe rows at a tenth the
        # size behind the boundary, and averaging them in would understate this era.
        real_main=summarise_real([r for r in real if r["cohort"] != "probe"]),
        replay=dict(
            exempt_1_2=summarise_replay(ex12, bar),
            exempt_3plus=summarise_replay(ex3, bar),
            inside=summarise_replay(inside, bar),
            outside=summarise_replay(outside, bar),
            untaxed_16plus=summarise_replay(un16, bar),
            untaxed_16plus_136=summarise_replay(un16, 1.36),
            untaxed_all=summarise_replay(untaxed, bar),
            taxed_all=summarise_replay(taxed, bar),
        ),
        adaptive=adaptive_walk_forward(
            ex3, S["bars"], S["adaptive_window"], S["otherwise"]
        ),
        reverted=reverted_buys(bot, gate, now_ms - secs * 1000),
        scored=len(rep),
    )


def verdicts(w7, w24):
    """each rule: ok, and why. 7d when it has the numbers, 24h otherwise; silent below MIN_N."""
    out = []
    W = w7 if (w7["real_main"]["n"] >= MIN_N_REAL or w7["scored"] >= 200) else w24
    tag = "7d" if W is w7 else "24h"
    rm = W["real_main"]
    out.append(
        dict(
            rule="main-book",
            ok=not (rm["n"] >= MIN_N_REAL and rm["pnl_usd"] < 0),
            why=f"{tag} real: n={rm['n']} ${rm['pnl_usd']:+.2f} win {rm['win']:.0f}%",
        )
    )
    r = W["replay"]
    a, b = r["exempt_1_2"], r["exempt_3plus"]
    out.append(
        dict(
            rule="exempt-floor",
            ok=not (
                a["n"] >= MIN_N_REPLAY
                and b["n"] >= MIN_N_REPLAY
                and a["mean"] > b["mean"]
            ),
            why=f"{tag} replay/trade: 1-2 exempt {a['mean']*100:+.1f}% (n={a['n']}) vs 3+ {b['mean']*100:+.1f}% (n={b['n']})",
        )
    )
    # DAY vs NIGHT, a watch rather than a verdict since 2026-09-07. The clock rule it used
    # to police is deleted (it kept 73% of September's profit), so there is nothing here
    # that can "stop paying". What it still answers is the question that would bring the
    # clock back: is 00-12 UTC materially worse than 12-24 again? A verdict that cannot
    # fail is honest; one that fails against a rule nobody runs is noise.
    i, o = r["inside"], r["outside"]
    out.append(
        dict(
            rule="day-night-watch",
            ok=True,
            why=f"{tag} replay/trade: 12-24 UTC {i['mean']*100:+.1f}% (n={i['n']}) vs 00-12 {o['mean']*100:+.1f}% (n={o['n']}); traded 24h since 09-07",
        )
    )
    ad = W["adaptive"]
    out.append(
        dict(
            rule="adaptive-bar",
            ok=not (
                ad["n"] >= 100
                and ad["adaptive"] < 0.9 * ad["fixed_otherwise"]
                and ad["fixed_otherwise"] > 0
            ),
            why=f"{tag} walk-forward: adaptive {ad['adaptive']:+.2f} vs fixed {ad['fixed_otherwise']:+.2f} (best fixed {ad['best_bar']} {ad['best_fixed']:+.2f}) n={ad['n']}",
        )
    )
    # The untaxed 16+ cohort, replay only since 2026-09-07: the probe book that used to
    # trade it with real money is deleted, so there is no real arm to compare any more.
    # Kept as a WATCH rather than a verdict -- it can no longer fail, because nothing is
    # being risked on it. If the replay turns strongly positive for a week, that is the
    # signal to have the conversation about trading it again, and the line below is where
    # it would show up.
    u = r["untaxed_16plus"]
    out.append(
        dict(
            rule="untaxed-watch",
            ok=True,
            why=f"{tag} untaxed 16+ replay {u['mean']*100:+.1f}% (n={u['n']}); not traded since 09-07, replay only",
        )
    )
    rv = W.get("reverted") or dict(n=0, pct_of_sends=0.0, gas_usd=0.0, replay_n=0, replay_mean=0.0, replay_win=0.0)
    # the fuse is paying while the coins it refuses would not have paid even at the
    # optimistic replay entry; a positive replay mean on 20+ of them, or reverts above
    # 10% of sends, is worth a look (widen the bound, or the quote is stale)
    out.append(
        dict(
            rule="buy-revert",
            ok=not (
                (rv["replay_n"] >= 20 and rv["replay_mean"] > 0.05)
                or rv["pct_of_sends"] > 10.0
            ),
            why=f"{tag}: {rv['n']} reverted ({rv['pct_of_sends']:.1f}% of sends), gas ${rv['gas_usd']:+.2f}; replay of those coins from a 2s entry {rv['replay_mean']*100:+.1f}%/trade (n={rv['replay_n']}, ~2x optimistic, before the in-flight pump)",
        )
    )
    t, ua = r["taxed_all"], r["untaxed_all"]
    out.append(
        dict(
            rule="tax-floor",
            ok=not (t["n"] >= 100 and ua["n"] >= 100 and ua["mean"] > t["mean"] + 0.05),
            why=f"{tag} replay/trade: taxed {t['mean']*100:+.1f}% (n={t['n']}) vs untaxed {ua['mean']*100:+.1f}% (n={ua['n']}); untaxed is not traded",
        )
    )
    return out


def main():
    now_ms = int(time.time() * 1000)
    bot = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True)
    gate = sqlite3.connect(GATE_DB, timeout=15)
    gate.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)")
    S = strategy(bot)
    windows = {
        name: window_report(gate, bot, S, secs, now_ms)
        for name, secs in WINDOWS.items()
    }
    v = verdicts(windows["7d"], windows["24h"])
    prev = {}
    try:
        row = gate.execute("SELECT value FROM state WHERE key='edgecheck'").fetchone()
        prev = json.loads(row[0]) if row else {}
    except Exception:
        prev = {}
    main_ok = next(x["ok"] for x in v if x["rule"] == "main-book")
    streak = 0 if main_ok else int(prev.get("main_neg_streak", 0)) + 1
    doc = dict(
        ran_at=now_ms,
        bar=S["otherwise"],
        strategy=S,
        windows=windows,
        verdicts=v,
        main_neg_streak=streak,
    )
    gate.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('edgecheck', ?)",
        (json.dumps(doc),),
    )
    gate.commit()

    print(
        "edge check %s UTC  (replay = gatewatch's obs.bars under the bot's rule, ~2x optimistic on level)"
        % dt.datetime.fromtimestamp(now_ms / 1000, dt.timezone.utc).strftime(
            "%Y-%m-%d %H:%M"
        )
    )
    for name in ("24h", "7d"):
        w = windows[name]
        rm, r, ad = w["real_main"], w["replay"], w["adaptive"]
        print(
            f"[{name}, replay covers {w['coverage_h']}h] scored {w['scored']} | "
            f"real n={rm['n']} ${rm['pnl_usd']:+.2f} win {rm['win']:.0f}%"
        )
        print(
            f"      replay@{S['otherwise']:.2f}: exempt1-2 {r['exempt_1_2']['mean']*100:+.1f}%/{r['exempt_1_2']['n']}  "
            f"exempt3+ {r['exempt_3plus']['mean']*100:+.1f}%/{r['exempt_3plus']['n']}  "
            f"in {r['inside']['mean']*100:+.1f}%/{r['inside']['n']}  out {r['outside']['mean']*100:+.1f}%/{r['outside']['n']}  "
            f"untaxed16+ {r['untaxed_16plus']['mean']*100:+.1f}%/{r['untaxed_16plus']['n']}"
        )
        print(
            f"      adaptive {ad['adaptive']:+.2f} vs fixed {ad['fixed_otherwise']:+.2f} (best {ad['best_bar']} {ad['best_fixed']:+.2f}) n={ad['n']}"
        )
    for x in v:
        print(("  ok   " if x["ok"] else "  FAIL ") + x["rule"] + ": " + x["why"])
    if streak:
        print(f"  main book negative {streak} run(s) in a row")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # a monitor that crashes is worse than one that prints less
        print("edgecheck failed: %s" % e)
        sys.exit(0)
