"""ADAPTIVE BAR. For each launch, look at the previous N launches, find which bar would
have been best on THEM, and use that bar now. No threshold to fit, no look-ahead. Sweep N.
Compare against every fixed bar on the same launches, and against 'yesterday's best bar'."""
import json, sqlite3, sys, statistics as st, datetime as dt, collections
sys.path.insert(0, "scripts")
import engine, chainio
from chainio import BOT_DB
HOLD, ENTRY_BLK, X, XLAG, POLL, STOP = 450, 20, 0.005, 6, 12, 0.50
STAKE = 10.72
BARS=[1.25,1.36,1.50,1.75,2.00,2.50,3.00]
def polled(rule, poll=POLL):
    s={"next":0.0}
    def w(c):
        if c["off"]<s["next"]: return None
        s["next"]=c["off"]+poll; return rule(c)
    return w
def mk(tp):
    def rule(x):
        if x["m"]>=tp: return (1.0,"tp")
        if x["m"]<=STOP: return (1.0,"sl")
        if x["off"]>=200 and x["peak"]<1.03: return (1.0,"dead")
        return None
    return polled(rule)
have={}
for path in ("/tmp/gap_cache.db","/tmp/regime_cache.db"):
    try:
        c=sqlite3.connect("file:%s?mode=ro"%path,uri=True)
        for t,js in c.execute("SELECT token, js FROM seq"): have.setdefault(t,js)
    except Exception: pass
b=sqlite3.connect("file:%s?mode=ro"%BOT_DB,uri=True); b.row_factory=sqlite3.Row
cut=int(dt.datetime(2026,8,28,tzinfo=dt.timezone.utc).timestamp()*1000)
rows=[r for r in b.execute("SELECT token,curve,block,deployer,creator_tax_bps ctax,detected_at FROM launches "
      "WHERE passed=1 AND block IS NOT NULL AND curve IS NOT NULL AND creator_tax_bps BETWEEN 50 AND 200 "
      "AND detected_at>? ORDER BY detected_at",(cut,)) if r["token"] in have]
L=[]
for r in rows:
    seq=chainio.decode_seq(json.loads(have[r["token"]]))
    if not seq: continue
    l=dict(token=r["token"],curve=r["curve"],block=r["block"],deployer=r["deployer"],tx="")
    try: P=engine.path(l,X,seq,r["ctax"] or 0,entry_blk=ENTRY_BLK,comp=0,haircut=0.0,horizon=HOLD+50,tick=5)
    except Exception: continue
    if P is None: continue
    pts=[p for p in P["pts"] if p[0]<=HOLD]
    d=dict(at=r["detected_at"], day=dt.datetime.fromtimestamp((r["detected_at"] or 0)/1000,dt.timezone.utc).strftime("%m-%d"),
           peak=max(p[1] for p in pts) if pts else 1.0)
    for tp in BARS: d[tp]=engine.evaluate(P,mk(tp),exit_lag=XLAG,hold=HOLD)["mult"]-1
    L.append(d)
L.sort(key=lambda x:x["at"] or 0)
DAYS=sorted(set(x["day"] for x in L))
print("%d taxed launches, %s to %s, $/trade at 0.005\n" % (len(L),DAYS[0],DAYS[-1]))

def score(picks):
    return sum(L[i][picks[i]] for i in range(len(L)))*STAKE
print("=== FIXED BARS (the incumbents) ===")
for tp in BARS:
    v=sum(x[tp] for x in L)*STAKE
    dn={d:sum(x[tp] for x in L if x["day"]==d) for d in DAYS}
    print("   flat %.2f   $%8.2f   days+ %d/%d" % (tp,v,sum(1 for d in DAYS if dn[d]>0),len(DAYS)))
print()
print("=== ADAPTIVE: use whichever bar was best on the previous N launches ===")
print("   (before N launches exist, fall back to 1.36)")
for N in (10,20,40,60,100,200):
    picks=[]
    for i in range(len(L)):
        if i<N: picks.append(1.36); continue
        w=L[i-N:i]
        picks.append(max(BARS,key=lambda tp: sum(x[tp] for x in w)))
    v=score(picks)
    dn=collections.defaultdict(float)
    for i,x in enumerate(L): dn[x["day"]]+=x[picks[i]]
    switches=sum(1 for i in range(1,len(picks)) if picks[i]!=picks[i-1])
    print("   N=%-4d  $%8.2f   days+ %d/%d   vs flat1.36 %+8.2f   bar switches %d   mode bar %.2f" % (
        N,v,sum(1 for d in DAYS if dn[d]>0),len(DAYS),v-sum(x[1.36] for x in L)*STAKE,switches,collections.Counter(picks).most_common(1)[0][0]))
print()
print("=== ADAPTIVE, DAY SCALE: use yesterday's best bar all of today ===")
prev=None; picks=[]
for x in L:
    picks.append(prev if prev else 1.36)
day_best={}
for d in DAYS: day_best[d]=max(BARS,key=lambda tp: sum(x[tp] for x in L if x["day"]==d))
picks=[]
for x in L:
    i=DAYS.index(x["day"]); picks.append(day_best[DAYS[i-1]] if i>0 else 1.36)
v=score(picks)
print("   $%8.2f   vs flat1.36 %+8.2f    (best bar by day: %s)" % (v,v-sum(x[1.36] for x in L)*STAKE," ".join("%s:%.2f"%(d[3:],day_best[d]) for d in DAYS)))
print()
print("=== ADAPTIVE on the PEAK signal: trailing median peak of prior N -> bar by threshold, threshold FIT on first 4 days ===")
fit_days=set(DAYS[:4]); test_days=set(DAYS[4:])
for N in (20,40,60):
    best=None
    for thr in (1.15,1.20,1.25,1.30,1.35,1.40,1.50):
        for hi in (1.75,2.00,2.50):
            picks=[]
            for i in range(len(L)):
                if i<N: picks.append(1.36); continue
                mp=st.median(x["peak"] for x in L[i-N:i])
                picks.append(hi if mp>=thr else 1.36)
            fitv=sum(L[i][picks[i]] for i in range(len(L)) if L[i]["day"] in fit_days)
            if best is None or fitv>best[0]: best=(fitv,thr,hi,picks)
    fitv,thr,hi,picks=best
    testv=sum(L[i][picks[i]] for i in range(len(L)) if L[i]["day"] in test_days)*STAKE
    base=sum(x[1.36] for x in L if x["day"] in test_days)*STAKE
    wide=sum(x[hi] for x in L if x["day"] in test_days)*STAKE
    print("   N=%-3d fitted: peak>=%.2f -> %.2f else 1.36 | held-out days %s: adaptive $%.2f  flat1.36 $%.2f  flat%.2f $%.2f" % (
        N,thr,hi,",".join(d[3:] for d in sorted(test_days)),testv,base,hi,wide))
