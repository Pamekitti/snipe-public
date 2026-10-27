"""Hard validation of the exempt>=1 filter before it goes live.

The first pass compared a 41h research window against a 17h bot window and called them
independent. They are not - they overlap on blocks 39.18M-39.66M. This redoes it with
disjoint splits and asks every way it could be a mirage:

  1. is the edge in the MEDIAN or only the mean (i.e. carried by a few lottery wins)?
  2. does it hold in every 4h window, or is it one good afternoon?
  3. does it survive on data never used to find it (last 25% held out)?
  4. is 'exempt' just a proxy for the creator buy we already filter on?
  5. does it survive different exit rules, or is it wired to tp=1.21 by luck?
"""
import sys, os, json, collections, random, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("DATASET", "fresh")
from realistic import *
import engine

X, HOLD, TP, BIN_H, ETHUSD = 0.005, 450, 1.21, 4, 2145.0
META = json.load(open(os.path.join(HERE, "data", "meta.json")))
prior = collections.defaultdict(int); PRIOR = {}
for l in sorted(eth, key=lambda x: x["block"]):
    d = l["deployer"].lower(); PRIOR[l["token"]] = prior[d]; prior[d] += 1

def mk(tp=TP, hold=HOLD, stop=0.5):
    def r(c):
        if tp and c["m"] >= tp: return (c["held"], "tp")
        if stop and c["m"] <= stop: return (c["held"], "sl")
        return None
    return r

ROWS = []
for l in sorted(eth, key=lambda x: x["block"]):
    tok = l["token"]
    if not (DEV[tok] >= 0.08 and PRIOR[tok] == 0 and CTAX[tok] <= 100): continue
    m = META.get(tok) or {}
    if m.get("err") or m.get("exempt") is None: continue
    P = engine.path(l, X, build_seq(l), CTAX[tok], entry_blk=20, comp=0, haircut=0.0,
                    horizon=900, tick=5)
    if P: ROWS.append(dict(P=P, ts=ts_of(l["block"]), blk=l["block"], ex=m["exempt"], dev=DEV[tok]))
for r in ROWS:
    e = engine.evaluate(r["P"], mk(), exit_lag=2, hold=HOLD)
    r["usd"] = e["pnl"]*ETHUSD; r["rot"] = e["pnl"]/X*100
T0, T1 = min(r["ts"] for r in ROWS), max(r["ts"] for r in ROWS)
BIN0 = int(T0//(BIN_H*3600))
for r in ROWS: r["bin"] = int(r["ts"]//(BIN_H*3600))-BIN0
A = lambda rs: [r for r in rs if r["ex"] >= 1]
B = lambda rs: [r for r in rs if r["ex"] == 0]
print("n=%d over %.1fh\n" % (len(ROWS), (T1-T0)/3600))

def dist(g, lab):
    v = sorted(r["rot"] for r in g)
    pos = [x for x in v if x > 0]
    top5 = sum(v[-max(1, len(v)//20):])
    return ("%-14s n=%3d  mean %+6.2f  MEDIAN %+6.2f  sd %5.2f  win %5.1f%%  top5%% carries %5.1f%% of gains"
            % (lab, len(v), st.mean(v), st.median(v), st.stdev(v), 100*len(pos)/len(v),
               100*top5/sum(pos) if pos else 0))

print("=" * 100)
print("1. IS IT THE MEDIAN OR JUST THE MEAN?  (a mean-only edge is a lottery)")
print("=" * 100)
print("  " + dist(A(ROWS), "exempt >= 1")); print("  " + dist(B(ROWS), "exempt = 0"))
print()

print("=" * 100)
print("2. EVERY 4h WINDOW, or one good afternoon?")
print("=" * 100)
w = t = 0
for b in sorted(set(r["bin"] for r in ROWS)):
    a = [r["rot"] for r in ROWS if r["bin"] == b and r["ex"] >= 1]
    c = [r["rot"] for r in ROWS if r["bin"] == b and r["ex"] == 0]
    if len(a) < 5 or len(c) < 5: continue
    t += 1; ok = st.median(a) > st.median(c); w += ok
    print("  win %2d  exempt>=1 n=%3d med %+7.2f   exempt=0 n=%3d med %+7.2f   %s"
          % (b, len(a), st.median(a), len(c), st.median(c), "OK" if ok else "  <-- FAILS"))
print("  exempt>=1 had the better median in %d of %d windows" % (w, t))
print()

print("=" * 100)
print("3. HELD OUT: last 25%% of the window, never used to find this")
print("=" * 100)
CUT = T0 + (T1-T0)*0.75
for lab, sel in (("search 75%", lambda r: r["ts"] < CUT), ("HELD OUT 25%", lambda r: r["ts"] >= CUT)):
    rs = [r for r in ROWS if sel(r)]
    print("  %-13s %s" % (lab, dist(A(rs), "exempt>=1")))
    print("  %-13s %s" % ("", dist(B(rs), "exempt=0")))
print()

print("=" * 100)
print("4. IS 'exempt' JUST THE CREATOR BUY IN DISGUISE?  (we already filter on that)")
print("=" * 100)
print("  %-16s %-28s %s" % ("dev buy band", "exempt >= 1", "exempt = 0"))
for lo, hi in ((0.08,0.15),(0.15,0.30),(0.30,99)):
    a = [r["rot"] for r in ROWS if lo <= r["dev"] < hi and r["ex"] >= 1]
    c = [r["rot"] for r in ROWS if lo <= r["dev"] < hi and r["ex"] == 0]
    if len(a) < 15 or len(c) < 15:
        print("  %.2f-%-6.2f     n=%3d/%3d  too thin" % (lo, hi, len(a), len(c))); continue
    print("  %.2f-%-6.2f     n=%3d med %+7.2f win %5.1f%%   n=%3d med %+7.2f win %5.1f%%"
          % (lo, hi, len(a), st.median(a), 100*sum(1 for x in a if x > 0)/len(a),
             len(c), st.median(c), 100*sum(1 for x in c if x > 0)/len(c)))
print()

print("=" * 100)
print("5. DIFFERENT EXIT RULES  (is it wired to tp=1.21 by luck?)")
print("=" * 100)
for tp, hold in ((1.10,450),(1.21,450),(1.35,450),(1.21,250),(1.21,900),(None,450)):
    for r in ROWS:
        e = engine.evaluate(r["P"], mk(tp,hold), exit_lag=2, hold=hold)
        r["t"] = e["pnl"]/X*100
    a = [r["t"] for r in A(ROWS)]; c = [r["t"] for r in B(ROWS)]
    print("  tp %-5s hold %3ds   exempt>=1 med %+7.2f win %5.1f%%   exempt=0 med %+7.2f win %5.1f%%   gap %+6.2f"
          % (tp or "off", hold//10, st.median(a), 100*sum(1 for x in a if x > 0)/len(a),
             st.median(c), 100*sum(1 for x in c if x > 0)/len(c), st.median(a)-st.median(c)))
print()

print("=" * 100)
print("BOOTSTRAP on the MEDIAN gap, resampling whole 4h windows (3000 draws)")
print("=" * 100)
for r in ROWS:
    e = engine.evaluate(r["P"], mk(), exit_lag=2, hold=HOLD); r["rot"] = e["pnl"]/X*100
bins = collections.defaultdict(list)
for r in ROWS: bins[r["bin"]].append(r)
ks = list(bins); rng = random.Random(17); dr = []
for _ in range(3000):
    pick = [rng.choice(ks) for _ in ks]
    a = [r["rot"] for k in pick for r in bins[k] if r["ex"] >= 1]
    c = [r["rot"] for k in pick for r in bins[k] if r["ex"] == 0]
    if len(a) > 10 and len(c) > 10: dr.append(st.median(a)-st.median(c))
dr.sort()
print("  median-gap %+.2f pp   90%% CI [%+.2f, %+.2f]   95%% CI [%+.2f, %+.2f]   P(positive) %.1f%%"
      % (st.median(dr), dr[int(.05*len(dr))], dr[int(.95*len(dr))],
         dr[int(.025*len(dr))], dr[int(.975*len(dr))],
         100*sum(1 for x in dr if x > 0)/len(dr)))
