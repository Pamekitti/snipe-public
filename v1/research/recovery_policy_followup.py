"""Exploratory attribution and timing checks after the fixed recovery comparison."""
import gzip
import json
from dataclasses import replace, asdict
from pathlib import Path
import recovery_policy_audit as r
import recovery_policy_models as models
import market_guard_longer as m


def main():
    root=Path('v1/data/recovery-policy-20260908')
    d=json.load(gzip.open(root/'snapshot.json.gz','rt')); paths=json.load(open(root/'model_paths.json'))['paths']
    now=d['snapshot_at'];start=now-14*r.DAY;b=r.policies(d['state']['config']['values'])[0]
    normal2=replace(b,name='venue_plus2_only',on=2)
    combined=replace(normal2,name='venue2_dd_once24',rolling_lifts=1)
    ps=[b,replace(b,name='restart_plus2',on=2,ron=2),normal2,replace(b,name='dd_plus2_only',ron=2),
        replace(b,name='both_plus1p5',on=1.5,ron=1.5),replace(b,name='both_plus2p5',on=2.5,ron=2.5),
        replace(b,name='plus2_confirm3',on=2,ron=2,on_count=3,recovery_count=3),combined]
    spans={k:v for k,v in m.intervals(now).items() if k in ['1d','2d','7d','14d','first_7d','last_6h']}
    spans['all_current']=(r.ERA,now)
    native=r.live_observations(d);known={o.token for o in native};actual=r.recorded(d,r.ERA)
    out={'policies':[asdict(p) for p in ps]}
    out['recorded']=r.compare(native,actual,ps,r.ERA,now,spans)
    out['isolated']=r.compare(native,actual,ps,1788865233293,1788868383313,
        {'episode':(1788865233293,1788868383313)},
        initial={'venue_halted':True,'realized':-round(.006029190672729674*1e18),'peak':0})
    def observations(delay):
        return native+[m.Observation(t,z['block'],z['launched'],m.scoring_time(z['launched'],delay),
            {'1.75':z['observer_return']}) for t,z in paths.items() if t not in known]
    for name,lag,phase in [('zero',.6,0),('slower',1.2,0),('phase15',.6,15000)]:
        ts,vs=models.variants(paths,start,lag)
        out[name]=r.compare(observations(300000),ts,ps,start,now,spans,variants=vs,phase=phase)
        print('done',name,flush=True)
    ts,vs=models.variants(paths,start)
    for delay in [120000,600000]:
        out[f'delay_{delay}']=r.compare(observations(delay),ts,[b,normal2,combined],start,now,spans,variants=vs)
    stressed=[replace(t,pnl=t.pnl-round(.05*t.size)) for t in ts]
    out['trade_minus5pp']=r.compare(observations(300000),stressed,[b,normal2,combined],start,now,spans)
    (root/'ablation_results.json').write_text(json.dumps(out,indent=2))
    print('saved followup',flush=True)


if __name__=='__main__':main()
