"""Cache-only 7-day exit-aware replay of the taxed cohort. No RPC except one blockNumber."""
import json, os, sqlite3, sys, time, statistics as st, collections
sys.path.insert(0, "scripts")
import engine, chainio
from chainio import BOT_DB
rpc = chainio.make_rpc("fresh7d", timeout=25, tries=2, backoff=2.0)
HOLD, ENTRY_BLK, X = 450, 20, 0.010
XLAG, POLL = 6, 12
DEAD_BLK, DEAD_BELOW, STOP = 200, 1.03, 0.50
def polled(rule, poll=POLL):
    state = {"next": 0.0}
    def wrapped(c):
        if c["off"] < state["next"]: return None
        state["next"] = c["off"] + poll
        return rule(c)
    return wrapped
def mk_rule(tp):
    def rule(x):
        if tp and x["m"] >= tp:      return (1.0, "tp")
        if STOP and x["m"] <= STOP:  return (1.0, "sl")
        if x["off"] >= DEAD_BLK and x["peak"] < DEAD_BELOW: return (1.0, "dead")
        return None
    return polled(rule)
cache = sqlite3.connect("file:/tmp/regime_cache.db?mode=ro", uri=True)
b = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True); b.row_factory = sqlite3.Row
tip = int(rpc("eth_blockNumber", []), 16)
now = int(time.time()*1000); cut = now - 7*86400*1000
rows = [r for r in b.execute("SELECT token,curve,block,launched_at,deployer,creator_tax_bps ctax,detected_at,exemptions ex FROM launches WHERE passed=1 AND detected_at>? AND block IS NOT NULL AND curve IS NOT NULL AND creator_tax_bps BETWEEN 50 AND 200 ORDER BY block", (cut,))]
rows = [r for r in rows if r["block"] + HOLD + 60 <= tip]
have = {r[0] for r in cache.execute("SELECT token FROM seq")}
print("taxed passed launches 7d: %d, cached: %d" % (len(rows), sum(1 for r in rows if r["token"] in have)), flush=True)
BARS=[1.25,1.36,1.50,1.75,2.00,2.50]
out=[]; t0=time.time()
for i,r in enumerate(rows):
    js = cache.execute("SELECT js FROM seq WHERE token=?", (r["token"],)).fetchone()
    if not js: continue
    seq = chainio.decode_seq(json.loads(js[0]))
    if not seq: continue
    l = dict(token=r["token"], curve=r["curve"], block=r["block"], deployer=r["deployer"], tx="")
    try: P = engine.path(l, X, seq, r["ctax"] or 0, entry_blk=ENTRY_BLK, comp=0, haircut=0.0, horizon=HOLD+50, tick=5)
    except Exception: continue
    if P is None: continue
    inw=[p for p in P["pts"] if p[0] <= HOLD]
    if not inw: continue
    rec=dict(at=r["launched_at"], ex=r["ex"], term=inw[-1][1], peak=max(p[1] for p in inw))
    for tp in BARS:
        try: rec["b%.2f"%tp] = engine.evaluate(P, mk_rule(tp), exit_lag=XLAG, hold=HOLD)["mult"] - 1
        except Exception: rec["b%.2f"%tp] = None
    out.append(rec)
print("replayed %d in %.0fs" % (len(out), time.time()-t0), flush=True)
def net(rs, bar):
    v=[x["b%.2f"%bar] for x in rs if x.get("b%.2f"%bar) is not None]
    return (st.mean(v), 100*sum(1 for y in v if y>0)/len(v), len(v)) if v else (0,0,0)
print("\n=== 7d by exemption bucket, taxed, mean return/trade at bar ===")
for lo,hi in [(1,3),(3,6),(6,11),(11,16),(16,99)]:
    sel=[x for x in out if x["ex"] is not None and lo<=x["ex"]<hi]
    if not sel: continue
    cells=" ".join("%.2f:%+.3f/%2.0f%%"%(bar,net(sel,bar)[0],net(sel,bar)[1]) for bar in BARS)
    print("exempt %2d-%-2d n=%4d term_med=%.3f  %s"%(lo,hi-1,len(sel),st.median(x["term"] for x in sel),cells))
print("\n=== 7d by DAY: exempt<=2 vs >=3 at bar 1.75 ===")
days=collections.defaultdict(list)
for x in out: days[(x["at"]//86400)*86400].append(x)
for k in sorted(days):
    lo=[x for x in days[k] if x["ex"] is not None and x["ex"]<=2]; hi=[x for x in days[k] if x["ex"] is not None and x["ex"]>=3]
    print(time.strftime("%m-%d",time.gmtime(k)), "exempt<=2 n=%3d %+.3f/%2.0f%% | exempt>=3 n=%3d %+.3f/%2.0f%%"%(len(lo),net(lo,1.75)[0],net(lo,1.75)[1],len(hi),net(hi,1.75)[0],net(hi,1.75)[1]))
print("\n=== 7d by 3h UTC bin, taxed exempt>=3, bars 1.36 and 1.75 (n>=8) ===")
bins=collections.defaultdict(list)
for x in out:
    if x["ex"] is None or x["ex"]<3: continue
    bins[(x["at"]//10800)*10800].append(x)
inside=[];outside=[]
for k in sorted(bins):
    v=bins[k]
    if len(v)<8: continue
    h=(k%86400)//3600; tag="IN " if 12<=h<21 else "out"
    m136,w136,_=net(v,1.36); m175,w175,_=net(v,1.75)
    (inside if tag=="IN " else outside).append(m175)
    print(time.strftime("%m-%d %H:00",time.gmtime(k)), tag, "n=%3d  1.36:%+.3f/%2.0f%%  1.75:%+.3f/%2.0f%%  term_med=%.3f"%(len(v),m136,w136,m175,w175,st.median(x["term"] for x in v)))
print("inside 12-21: %d bins, %d negative at 1.75, mean %+.3f"%(len(inside),sum(1 for x in inside if x<0),st.mean(inside) if inside else 0))
print("outside     : %d bins, %d negative at 1.75, mean %+.3f"%(len(outside),sum(1 for x in outside if x<0),st.mean(outside) if outside else 0))
print("\n=== same bins, ALL taxed (exempt>=1) at 1.75 ===")
bins2=collections.defaultdict(list)
for x in out: bins2[(x["at"]//10800)*10800].append(x)
i2=[];o2=[]
for k in sorted(bins2):
    v=bins2[k]
    if len(v)<8: continue
    h=(k%86400)//3600
    (i2 if 12<=h<21 else o2).append(net(v,1.75)[0])
print("inside 12-21: %d bins, %d negative | outside: %d bins, %d negative"%(len(i2),sum(1 for x in i2 if x<0),len(o2),sum(1 for x in o2 if x<0)))
