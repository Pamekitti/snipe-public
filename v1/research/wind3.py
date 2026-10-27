import json, sqlite3, sys, statistics as st, datetime as dt, collections, random
sys.path.insert(0, "scripts")
exec(open("research/wind.py").read().split("def score(picks)")[0])
random.seed(7)
RESOLVE_MS = 120_000   # gatewatch scores after the 45s window + 60 blocks, then its own cadence: call it 2 min
def run(seq, N, resolved_only):
    out=0.0
    for i,x in enumerate(seq):
        if resolved_only:
            w=[y for y in seq[:i] if (x["at"] or 0)-(y["at"] or 0) >= RESOLVE_MS][-N:]
        else:
            w=seq[max(0,i-N):i]
        if len(w)<N: out+=x[1.36]; continue
        out+=x[max(BARS,key=lambda tp: sum(y[tp] for y in w))]
    return out*STAKE
flat175=sum(x[1.75] for x in L)*STAKE
print("=== RESOLVED-ONLY walk-forward: trailing window may only contain launches >=2 min old ===")
print("   N     any-order$   resolved-only$   vs flat1.75   shuffle beat%%")
for N in (10,15,20):
    a=run(L,N,False); r=run(L,N,True)
    sh=[]
    for _ in range(200):
        s=L[:]; random.shuffle(s)
        # keep the timestamps attached to the shuffled rows so the resolve filter still applies
        sh.append(run(s,N,True))
    print("   %-4d  %10.2f   %13.2f    %+9.2f      %3.0f%%" % (N,a,r,r-flat175,100*sum(1 for v in sh if r>v)/len(sh)))
print()
print("=== which bar does N=15 pick, and how often ===")
picks=collections.Counter()
for i,x in enumerate(L):
    w=[y for y in L[:i] if (x["at"] or 0)-(y["at"] or 0)>=RESOLVE_MS][-15:]
    picks[max(BARS,key=lambda tp: sum(y[tp] for y in w)) if len(w)>=15 else 1.36]+=1
for b,n in sorted(picks.items()): print("   %.2f  %4d  (%2.0f%%)" % (b,n,100*n/len(L)))
