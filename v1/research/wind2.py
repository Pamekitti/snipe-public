import json, sqlite3, sys, statistics as st, datetime as dt, collections, random
sys.path.insert(0, "scripts")
exec(open("research/wind.py").read().split("def score(picks)")[0])   # reuse the data load: L, DAYS, BARS, STAKE
random.seed(42)
def run_adaptive(seq, N):
    out=0.0
    for i,x in enumerate(seq):
        if i<N: out+=x[1.36]; continue
        w=seq[i-N:i]; out+=x[max(BARS,key=lambda tp: sum(y[tp] for y in w))]
    return out*STAKE
flat136=sum(x[1.36] for x in L)*STAKE; flat175=sum(x[1.75] for x in L)*STAKE
print("=== 1. FINER N SWEEP (real order) ===")
print("   N     adaptive$   vs flat1.36   vs flat1.75")
for N in (5,8,10,12,15,20,25,30,40,50,60):
    v=run_adaptive(L,N); print("   %-4d  %9.2f   %+9.2f    %+9.2f" % (N,v,v-flat136,v-flat175))
print()
print("=== 2. SHUFFLE CONTROL: destroy the time order, keep everything else (300 draws) ===")
print("   if the adaptive rule still wins on shuffled data, it is the METHOD, not the wind")
for N in (10,20,40):
    real=run_adaptive(L,N)
    sh=[]
    for _ in range(300):
        s=L[:]; random.shuffle(s); sh.append(run_adaptive(s,N))
    sh.sort()
    print("   N=%-3d real $%.2f   shuffled median $%.2f  p95 $%.2f   real beats shuffle %.0f%% of draws" % (
        N,real,st.median(sh),sh[int(.95*len(sh))],100*sum(1 for v in sh if real>v)/len(sh)))
print()
print("=== 3. BAR x TIME OF DAY (UTC), $/trade at 0.005, all 9 days ===")
blk=lambda x: (dt.datetime.fromtimestamp((x["at"] or 0)/1000,dt.timezone.utc).hour//3)*3
byb=collections.defaultdict(list)
for x in L: byb[blk(x)].append(x)
print("   block    n   " + "".join("%8.2f"%b for b in BARS) + "    best")
for h in sorted(byb):
    v=byb[h]; means={b:st.mean(x[b] for x in v)*STAKE for b in BARS}
    print("   %02d-%02dh %4d  " % (h,h+3,len(v)) + "".join("%+8.2f"%means[b] for b in BARS) + "    %.2f" % max(BARS,key=lambda b:means[b]))
aft=[x for x in L if 12<=blk(x)<21]; night=[x for x in L if not (12<=blk(x)<21)]
print()
print("   12-21h  n=%d  " % len(aft) + "  ".join("%.2f:%+.2f"%(b,st.mean(x[b] for x in aft)*STAKE) for b in BARS))
print("   other   n=%d  " % len(night) + "  ".join("%.2f:%+.2f"%(b,st.mean(x[b] for x in night)*STAKE) for b in BARS))
print()
print("=== 4. CLOCK-SPLIT BAR vs the alternatives, whole 9 days ===")
best_aft=max(BARS,key=lambda b: sum(x[b] for x in aft)); best_night=max(BARS,key=lambda b: sum(x[b] for x in night))
clock=sum(x[best_aft] for x in aft)*STAKE+sum(x[best_night] for x in night)*STAKE
print("   flat 1.36                     $%8.2f" % flat136)
print("   flat 1.75                     $%8.2f" % flat175)
print("   clock: %.2f afternoon / %.2f night   $%8.2f   (zero lag, two numbers)" % (best_aft,best_night,clock))
print("   adaptive N=20                 $%8.2f" % run_adaptive(L,20))
