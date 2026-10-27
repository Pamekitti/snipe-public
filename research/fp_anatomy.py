import sys; sys.path.insert(0,'..')
from sim2 import *
import statistics as st
COH=cohort(0.05,100); COH.sort(key=lambda l:l['block'])
paths=[p for p in (path(l,0.005,horizon=3000) for l in COH) if p]
LATE=set(DAYS_ALL[9:]); EARLY=set(DAYS_ALL[2:9])
def mult_at(P,off):
    m=1.0
    for o,mm,q,t,g in P['pts']:
        if o>off: break
        m=mm
    return m
def peak_by(P,off):
    return max(mm for o,mm,q,t,g in P['pts'] if o<=off)
def net_at(P,off):
    """proceeds multiple if I sold everything at exactly `off`."""
    last=None
    for o,mm,q,t,g in P['pts']:
        if o>off: break
        last=(q,t)
    q,t=last
    return sell_value(P,q,t,1.0)/P['X']
for name,S in (('ALL',set(DAYS_ALL)),('EARLY aug6-12',EARLY),('LATE aug13-16',LATE),('LAST2 aug15-16',set(DAYS_ALL[-2:]))):
    ps=[p for p in paths if DAY[p['l']['token']] in S]
    n=len(ps)
    print(f"\n=== {name}: {n} entries ===")
    print(f"{'horizon':>8s} {'mark p25':>9s} {'mark med':>9s} {'mark p75':>9s} {'mark p90':>9s} | {'peak med':>9s} {'peak p75':>9s} {'peak p90':>9s} | {'NET mean if sold here':>22s} {'win%':>6s}")
    for off in (0,10,20,30,50,100,150,200,300,450,600,900,1200,1800,3000):
        ms=sorted(mult_at(p,off) for p in ps); pk=sorted(peak_by(p,off) for p in ps)
        nets=[net_at(p,off) for p in ps]
        print(f"{off/10:>7.0f}s {ms[n//4]:9.3f} {ms[n//2]:9.3f} {ms[3*n//4]:9.3f} {ms[9*n//10]:9.3f} | {pk[n//2]:9.3f} {pk[3*n//4]:9.3f} {pk[9*n//10]:9.3f} | {(st.mean(nets)-1)*100:+21.2f}% {sum(1 for x in nets if x>1)/n*100:5.1f}%")
    # when does the peak (over 300s) occur?
    pk_off=[]
    for p in ps:
        best=(1.0,0)
        for o,mm,q,t,g in p['pts']:
            if mm>best[0]: best=(mm,o)
        pk_off.append(best)
    movers=[o for m,o in pk_off if m>=1.2]
    print(f"  share reaching +20% at any point within 300s: {len(movers)/n*100:.1f}%; of those, peak time p25 {sorted(movers)[len(movers)//4]/10:.0f}s med {st.median(movers)/10:.0f}s p75 {sorted(movers)[3*len(movers)//4]/10:.0f}s")
    movers=[o for m,o in pk_off if m>=1.5]
    if movers: print(f"  share reaching +50%: {len(movers)/n*100:.1f}%; peak time med {st.median(movers)/10:.0f}s p75 {sorted(movers)[3*len(movers)//4]/10:.0f}s")
    movers=[o for m,o in pk_off if m>=2.0]
    if movers: print(f"  share reaching 2x: {len(movers)/n*100:.1f}%; peak time med {st.median(movers)/10:.0f}s p75 {sorted(movers)[3*len(movers)//4]/10:.0f}s")
    # no follow-on buy at all after entry?
    flat=sum(1 for p in ps if all(abs(mm-1.0)<1e-9 for o,mm,q,t,g in p['pts']))
    print(f"  entries with NO price change at all in 300s (nobody traded after us): {flat/n*100:.1f}%")
    # what does the entry cost? mult at off 0 is 1 by construction; net_at(0) shows round-trip cost
    print(f"  immediate round-trip cost (sell right after buy): {(1-st.mean(net_at(p,0) for p in ps))*100:.2f}%")
