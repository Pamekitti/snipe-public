"""Best gate config for the CURRENT era, across several candidate market signals.

Two changes from the earlier work, both aimed at robustness:

1. SIGNALS ARE MEASURED ON EVERY LAUNCH, not the ~10% that pass the book. That is 5x the
   sample for the same window. And most candidates are continuous (ETH of follow-on flow,
   buyer counts, median peak) rather than the incumbent's one bit per launch.

2. THRESHOLDS ARE EXPANDING-WINDOW PERCENTILES, not absolute numbers. "Shut when the
   current reading sits in the bottom 20% of everything seen so far" is scale-free, needs
   no magic constant per signal, and re-levels itself when the venue shifts. It is also
   strictly causal: the percentile is computed against past readings only.

Windows are wall-clock hours, because a launch-count window spanned 21 hours in the
organic era and 4 hours in this one, and an instrument that changes meaning with the
launch rate cannot be tuned.
"""
import sys, os, json, bisect, random, statistics as st, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
D = json.load(open(os.path.join(HERE, "data", "era_table.json")))["rows"]
D.sort(key=lambda r: (r["t"], r["blk"]))
GAS, REV, X, ETHUSD = 0.07, 5 / 124.0, 0.005, 2145
WATCH = 300                                   # gatewatch wakes every 5 min

P = [r for r in D if r["passed"]]             # what we trade
PT = [r["t"] for r in P]; PR = [r["rot"] for r in P]
N = len(P)

SIGNALS = {
    "touch@45 passed":  ("touch", 45, True),   # the incumbent
    "touch@45 all":     ("touch", 45, False),
    "peak@45 all":      ("peak", 45, False),
    "flow45 all":       ("f45", 45, False),
    "flow10 all":       ("f10", 10, False),
    "buyers10 all":     ("b10", 10, False),
    "buyers45 all":     ("b45", 45, False),
}


def window_values(field, resolve_s, passed_only, hours):
    """For each traded launch i, the mean of `field` over source launches whose outcome
    had resolved by t_i, inside the last `hours`. Strictly causal."""
    src = P if passed_only else D
    st_, sv = [r["t"] + resolve_s + WATCH for r in src], [r[field] for r in src]
    order = sorted(range(len(src)), key=lambda k: st_[k])
    rt = [st_[k] for k in order]; rv = [sv[k] for k in order]
    csum = [0.0]
    for v in rv: csum.append(csum[-1] + v)
    out = []
    for t in PT:
        hi = bisect.bisect_right(rt, t)
        lo = bisect.bisect_left(rt, t - hours * 3600, 0, hi)
        n = hi - lo
        out.append((csum[hi] - csum[lo]) / n if n >= 10 else None)
    return out


def gate(vals, shut_p, open_p, start_open=True):
    """Shut when the reading's expanding percentile rank falls below shut_p."""
    hist = []; mask = [0] * N; state = "open" if start_open else "shut"; trips = 0
    for i, v in enumerate(vals):
        if v is None:
            mask[i] = 1 if state == "open" else 0
            continue
        if len(hist) >= 40:
            rank = 100.0 * bisect.bisect_left(hist, v) / len(hist)
            was = state
            state = "open" if (rank >= open_p if was == "shut" else rank > shut_p) else "shut"
            if was == "open" and state == "shut":
                trips += 1
        bisect.insort(hist, v)
        mask[i] = 1 if state == "open" else 0
    return mask, trips


def risk(mask, idx=None, seed=3):
    rng = random.Random(seed); eq = 0; peak = 0; dd = 0; day = {}; n = 0
    rng2 = range(N) if idx is None else idx
    for i in rng2:
        if mask[i]:
            v = -0.02 if rng.random() < REV else PR[i] - GAS
            eq += v; n += 1
            d = dt.datetime.fromtimestamp(PT[i], dt.UTC).strftime("%m-%d %H")[:5]
            day[d] = day.get(d, 0) + v
        peak = max(peak, eq); dd = max(dd, peak - eq)
    dv = list(day.values())
    return dict(total=eq, dd=dd, n=n, usd=eq / 100 * X * ETHUSD, dd_usd=dd / 100 * X * ETHUSD,
                worst=min(dv) if dv else 0,
                sharpe=(st.mean(dv) / st.stdev(dv)) if len(dv) > 2 and st.stdev(dv) > 0 else 0,
                loss_days=100 * sum(1 for x in dv if x < 0) / len(dv) if dv else 0)


def matched_random(mask, draws=800, seed=17):
    runs = []; i = 0
    while i < N:
        if mask[i] == 0:
            j = i
            while j + 1 < N and mask[j + 1] == 0: j += 1
            runs.append(j - i + 1); i = j + 1
        else: i += 1
    if not runs: return None, 0
    rng = random.Random(seed); outs = []
    for _ in range(draws):
        b = bytearray(N)
        for L in runs:
            s0 = rng.randrange(0, max(1, N - L))
            for k in range(s0, min(N, s0 + L)): b[k] = 1
        outs.append(sum(PR[i] - GAS for i in range(N) if not b[i]))
    outs.sort()
    tot = sum(PR[i] - GAS for i in range(N) if mask[i])
    return outs, 100.0 * sum(1 for x in outs if x < tot) / len(outs)


base = risk([1] * N)
print("CURRENT ERA  %s -> %s UTC   %d launches, %d traded" % (
    dt.datetime.fromtimestamp(D[0]["t"], dt.UTC).strftime("%m-%d %H:%M"),
    dt.datetime.fromtimestamp(D[-1]["t"], dt.UTC).strftime("%m-%d %H:%M"), len(D), N))
print("NO GATE      total %7.0f  ($%.2f)  maxDD %6.0f ($%.2f)  Sharpe %.2f  worst4h %+.0f\n" % (
    base["total"], base["usd"], base["dd"], base["dd_usd"], base["sharpe"], base["worst"]))

res = []
for name, (field, res_s, po) in SIGNALS.items():
    for hours in (2, 4, 8, 12):
        vals = window_values(field, res_s, po, hours)
        if sum(1 for v in vals if v is not None) < N * 0.5: continue
        for sp, op in ((10, 30), (20, 40), (20, 60), (30, 50)):
            m, tr = gate(vals, sp, op)
            r = risk(m)
            if r["n"] < N * 0.4: continue
            res.append((name, hours, sp, op, r, tr))
res.sort(key=lambda z: -z[4]["total"])
print("TOP 14 BY TOTAL   (no gate = %.0f)" % base["total"])
print("  %-17s %5s %7s %8s %8s %8s %7s %6s %6s" % ("signal", "win", "shut/op", "total", "$P&L", "maxDD", "Sharpe", "halts", "took"))
for name, h, sp, op, r, tr in res[:14]:
    print("  %-17s %4dh %4d/%-3d %8.0f %8.2f %8.0f %7.2f %6d %6d" % (
        name, h, sp, op, r["total"], r["usd"], r["dd"], r["sharpe"], tr, r["n"]))
json.dump([dict(signal=n, hours=h, shut=sp, open=op, trips=tr, **r) for n, h, sp, op, r, tr in res],
          open(os.path.join(HERE, "data", "era_gate.json"), "w"))
print("\nwrote data/era_gate.json  (%d configs)" % len(res))
