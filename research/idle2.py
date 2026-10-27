"""Which clause is starving us, and is the coin it rejects actually bad?

For every launch we skip, attribute the reject to the clause(s) that fired, then score
what that clause's rejects were WORTH. A clause that rejects money-losers is doing its
job; a clause that rejects winners is the reason we sit idle for 2.7h.
"""
import sys, os, json, random, statistics as st, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(HERE, "data", "era_table2.json")))["rows"]
R.sort(key=lambda r: (r["t"], r["blk"]))
GAS, REV, X, E = 0.07, 5/124.0, 0.005, 2145
U = dt.timezone.utc
def ts(x): return dt.datetime.fromtimestamp(x, U).strftime("%m-%d %H:%M")

def money(rows, seed=3):
    if not rows: return 0.0, 0.0, 0.0
    rng = random.Random(seed); eq = 0.0
    for r in rows: eq += -0.02 if rng.random() < REV else r["rot"] - GAS
    v = [r["rot"] for r in rows]
    return eq/100*X*E, st.median(v), 100*sum(1 for x in v if x > 0)/len(v)

CL = [
    ("dev  >= 0.08",       lambda r: r["dev"] >= 0.08),
    ("prior == 0",         lambda r: r["prior"] <= 0),
    ("ctax <= 1%",         lambda r: r["ctax"] <= 100),
    ("ex   >= 1 (known)",  lambda r: r["ex"] >= 1),
]

def report(rows, title):
    print("\n" + "="*104)
    print("%s   n=%d   %s -> %s" % (title, len(rows), ts(rows[0]["t"]), ts(rows[-1]["t"])))
    p = [r for r in rows if all(f(r) for _, f in CL)]
    u, m, w = money(rows); pu, pm, pw = money(p)
    print("  buy EVERYTHING          n=%4d  $%+8.2f  median %+7.2f%%  win %3.0f%%" % (len(rows), u, m, w))
    print("  live book               n=%4d  $%+8.2f  median %+7.2f%%  win %3.0f%%" % (len(p), pu, pm, pw))
    print("\n  %-22s %6s %9s %8s %6s | %-38s"
          % ("clause", "kills", "$ killed", "median", "win", "verdict"))
    for name, f in CL:
        killed = [r for r in rows if not f(r)]
        if not killed: continue
        ku, km, kw = money(killed)
        v = "GOOD, those lose money" if ku < 0 else "COSTLY, it is killing winners"
        print("  %-22s %6d %+9.2f %+7.2f%% %5.0f%% | %s" % (name, len(killed), ku, km, kw, v))
    # sole-reason: the ONLY clause standing between us and the trade
    print("\n  %-22s %6s %9s %8s %6s | sole reason for the reject"
          % ("clause", "kills", "$ killed", "median", "win"))
    for name, f in CL:
        others = [g for n2, g in CL if n2 != name]
        sole = [r for r in rows if not f(r) and all(g(r) for g in others)]
        if not sole: continue
        su, sm, sw = money(sole)
        print("  %-22s %6d %+9.2f %+7.2f%% %5.0f%% |" % (name, len(sole), su, sm, sw))
    # unknown-exemption blind spot
    unk = [r for r in rows if r["ex"] < 0 and r["dev"] >= 0.08 and r["prior"] <= 0 and r["ctax"] <= 100]
    if unk:
        uu, um, uw = money(unk)
        print("\n  ex UNKNOWN (meta never fetched) but passes everything else:")
        print("  %-22s %6d %+9.2f %+7.2f%% %5.0f%% | the live bot reads calldata, the sim does not"
              % ("", len(unk), uu, um, uw))

report(R, "WHOLE ERA")
IDLE_A, IDLE_B = 1755571140, 10**11
w = [r for r in R if r["t"] >= 1755570000]
report([r for r in R if r["t"] >= R[-1]["t"] - 2.75*3600], "THE 2.7h IDLE WINDOW (08-19 02:39 -> 05:23)")
