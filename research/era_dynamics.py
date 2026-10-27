"""Does the sim model the thing the gate is actually for: catching a run of losses fast
and getting back in fast?

Three corrections to the earlier runs, each in the direction of being LESS optimistic:

  TICK   the live gate re-evaluates only when gatewatch wakes, every 5 minutes. Letting
         state flip at every launch flatters both the halt and the resume.
  BARRIER a launch's outcome is unknown until hold+watcher. Earlier this looked negligible,
         but that was measured on a tape running 25-70 passed launches a DAY. This era runs
         ~14 an hour, so the same blind spot now hides ~7 launches instead of ~1.
  DECOMPOSE score the two error types separately, because they are what shut and open
         actually trade against each other:
            LATE-TO-HALT   losses taken after the venue turned, before the gate shut
            LATE-TO-RESUME profit forgone after it recovered, before the gate reopened
"""
import sys, os, random, statistics as st, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import era_gate as G
P, N, PT, PR = G.P, G.N, G.PT, G.PR
TO = [r["touch"] for r in P]
GAS, REV, X, E = 0.07, 5 / 124.0, 0.005, 2145
NET = [r - GAS for r in PR]


def gate(w, shut, opn, barrier=345, tick=300):
    """tick = the gate may only change state on a 5-minute boundary, like gatewatch."""
    mask = [0] * N; res = []; run = 0; j = 0; state = "open"; trips = []
    last_eval = -1e18
    for i in range(N):
        while j < i and PT[j] + barrier <= PT[i]:
            res.append(TO[j]); run += TO[j]
            if len(res) > w: run -= res[-w - 1]
            j += 1
        if len(res) >= w and PT[i] - last_eval >= tick:
            last_eval = PT[i]
            rate = 100.0 * run / w; was = state
            state = "open" if (rate >= opn if was == "shut" else rate > shut) else "shut"
            if was == "open" and state == "shut": trips.append(i)
        mask[i] = 1 if state == "open" else 0
    return mask, trips


def decompose(mask, bad_run=5):
    """Find genuine bad stretches from the OUTCOMES (hindsight), then ask how much of each
    the gate sat through, and how much good time it sat out afterwards."""
    # a bad stretch: a maximal run where the trailing-5 mean net return is negative
    bad = [0] * N
    for i in range(N):
        w = NET[max(0, i - bad_run + 1):i + 1]
        if len(w) == bad_run and st.mean(w) < 0:
            bad[i] = 1
    late_halt = sum(NET[i] for i in range(N) if bad[i] and mask[i])       # lost inside bad stretches
    forgone = sum(NET[i] for i in range(N) if not bad[i] and not mask[i])  # missed while good
    caught = sum(NET[i] for i in range(N) if bad[i] and not mask[i])       # avoided (the win)
    return dict(bad_n=sum(bad), late_halt=late_halt, forgone=forgone, caught=caught)


def risk(mask, seed=3, bh=4):
    rng = random.Random(seed); eq = 0; peak = 0; dd = 0; buck = {}
    for i in range(N):
        if mask[i]:
            v = -0.02 if rng.random() < REV else NET[i]
            eq += v; k = int(PT[i] // (bh * 3600)); buck[k] = buck.get(k, 0) + v
        peak = max(peak, eq); dd = max(dd, peak - eq)
    bv = list(buck.values())
    return dict(usd=eq / 100 * X * E, dd=dd / 100 * X * E,
                sharpe=st.mean(bv) / st.stdev(bv) if len(bv) > 2 and st.stdev(bv) > 0 else 0)


# ---------- 1. are losses actually clustered in this era?
print("1. DO LOSSES COME IN RUNS?  (this is the premise; if not, no gate can help)")
sgn = [1 if x > 0 else 0 for x in NET]
runs = []; c = 1
for a, b in zip(sgn, sgn[1:]):
    if a == b: c += 1
    else: runs.append((a, c)); c = 1
runs.append((sgn[-1], c))
lose = [c for s, c in runs if s == 0]
rng = random.Random(9)
sh = sgn[:]; exp = []
for _ in range(400):
    rng.shuffle(sh); r2 = []; c2 = 1
    for a, b in zip(sh, sh[1:]):
        if a == b: c2 += 1
        else: r2.append((a, c2)); c2 = 1
    r2.append((sh[-1], c2))
    L = [c for s, c in r2 if s == 0]
    exp.append(max(L))
print("   win rate %.0f%%   longest losing run OBSERVED %d   shuffled expectation %.1f (p95 %d)"
      % (100 * sum(sgn) / N, max(lose), st.mean(exp), sorted(exp)[int(.95 * len(exp))]))
print("   losing runs >=5: observed %d, shuffled %.1f"
      % (sum(1 for c in lose if c >= 5),
         st.mean([sum(1 for c in [x for s, x in r2 if s == 0] if c >= 5) for r2 in [runs]])))

# ---------- 2. what the three corrections cost
print("\n2. WHAT MY EARLIER SIM WAS MISSING, config 20/15/25")
base = risk([1] * N)
print("   no gate                                    $%.2f  maxDD $%.2f" % (base["usd"], base["dd"]))
for lab, bar, tk in (("earlier sim (state flips per launch)", 345, 0),
                     ("+ 5-min gatewatch tick", 345, 300),
                     ("+ perfect info, no resolve lag", 0, 300),
                     ("+ optimistic 45s lag only", 45, 300)):
    m, tr = gate(20, 15, 25, barrier=bar, tick=tk)
    r = risk(m); d = decompose(m)
    print("   %-42s $%.2f  maxDD $%.2f  halts %d  late-halt %+.0f  forgone %+.0f"
          % (lab, r["usd"], r["dd"], len(tr), d["late_halt"], d["forgone"]))

# ---------- 3. the actual trade-off surface
print("\n3. THE TRADE-OFF YOU DESCRIBED, with the 5-min tick modelled")
print("   shut too low -> sit through the loss run.  open too high -> miss the recovery.")
print("   %-14s %8s %8s %9s %10s %10s %7s" % ("shut/open", "$P&L", "$maxDD", "halts", "late-halt", "forgone", "Sharpe"))
best = []
for shut in (5, 10, 15, 20, 25):
    for opn in (15, 20, 25, 30, 40):
        if opn <= shut: continue
        m, tr = gate(20, shut, opn, tick=300)
        r = risk(m); d = decompose(m)
        best.append((r["usd"], shut, opn, r, d, len(tr)))
for usd, shut, opn, r, d, tr in sorted(best, reverse=True)[:10]:
    print("   %-14s %8.2f %8.2f %9d %10.0f %10.0f %7.2f"
          % ("%d / %d" % (shut, opn), r["usd"], r["dd"], tr, d["late_halt"], d["forgone"], r["sharpe"]))
print("   %-14s %8.2f %8.2f %9d %10s %10s %7.2f" % ("no gate", base["usd"], base["dd"], 0, "-", "-", base["sharpe"]))
