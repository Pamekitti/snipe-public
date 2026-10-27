"""Reprice recovery probes and stress uncertain graduation exits, offline."""
import argparse
from dataclasses import replace
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3

import market_guard_longer as m
import recovery_policy_audit as r
from guard_audit import Trade, SIZE, DAY, HOUR, net_wei, describe, iso
from market_guard_audit import ERA


def price(path, tp, gas, lag=.6, hold=45, dead=20):
    z=m.replay(path,tp,{'hold':hold,'dead':dead},gas=gas,lag=lag)
    if z['ret'] is None:return None
    pt=next(x for x in path['pts'] if abs(x[0]/10-z['age'])<1e-8)
    unavailable=pt[3]<=m.engine.RES+1e-7
    virtual=(m.engine.sell_value(path,pt[2],pt[3])-path['X']-gas)/path['X'] if unavailable else z['ret']
    return {**z,'virtual_ret':virtual,'graduated_unpriced':unavailable}


def build(root):
    d=json.load(gzip.open(root/'snapshot.json.gz','rt'));now=d['snapshot_at'];facts=m.targets(d)
    fee,fee_stats=m.costs(d,ERA,now-6*HOUR)
    positions={p['token'].lower():p for p in d['bot_positions'] if p['live'] and p['closed']
               and (p['cohort'] or 'main')=='main' and (p['t_decide'] or p['t_detect'])>=ERA
               and p['exit_reason'] not in m.NON_TRADE and p['onchain_pnl_wei'] is not None}
    out={};actual_variants={};calibration=[];missing=[]
    with sqlite3.connect(f'file:{root / "paths.db"}?mode=ro',uri=True) as db:
        cache={a:b for a,b in db.execute('select token,js from paths where error is null')}
    for i,(token,f) in enumerate(sorted(facts.items(),key=lambda x:x[1]['block'])):
        if token not in cache:missing.append([token,'no_logs']);continue
        seq=m.chainio.decode_seq(json.loads(cache[token]));native=m.make_path(f,seq,.01,native=True)
        if native is None:missing.append([token,'no_native_entry']);continue
        row=dict(token=token,launched=f['launched_at']*1000,block=f['block'],observer_return=m.observer_return(native),sizes={})
        for size in [.005,.01,.02]:
            P=m.make_path(f,seq,size)
            if P is None:continue
            c=m.engine.Curve(f['creator_tax_bps'] or 0);got,_=c.buy(size,m.engine.snipe_bps(2,f['creator_tax_bps'] or 0))
            if got/P['tok']>=4.5:continue
            row['sizes'][str(size)]={str(lag):price(P,1.75,fee,lag) for lag in [.6,1.2]}
        out[token]=row
        p=positions.get(token)
        if p and p['fill_block'] and p['take_profit']:
            entry=p['fill_block']-f['block'];variants={}
            rules=json.loads(p['context_json'] or '{}').get('rules',{})
            for size in [.005,.01,.02]:
                P=m.make_path(f,seq,size,entry=entry)
                if not P:continue
                gas=fee
                if size==int(p['spend_wei'])/1e18:
                    gas=(int(p['proceeds_wei'] or 0)-int(p['spend_wei'])-net_wei(p))/1e18
                z=price(P,p['take_profit'],gas,hold=rules.get('maxHoldMs',45000)/1000,
                        dead=(p['dead_after_ms'] or 20000)/1000)
                if z:
                    variants[str(size)]=z
                    if size==int(p['spend_wei'])/1e18:
                        actual=net_wei(p)/1e18
                        calibration.append(dict(id=p['id'],at=p['t_decide'],actual_eth=actual,
                            modeled_eth=z['ret']*size,virtual_eth=z['virtual_ret']*size,
                            gap_pp=100*(z['ret']-actual/size),unpriced=z['graduated_unpriced']))
            actual_variants[str(p['id'])]=variants
        if i%500==0:print('repriced',i,'/',len(facts),flush=True)
    model=dict(snapshot=iso(now),fees=fee_stats,gas=fee,paths=out,actual_variants=actual_variants,
               calibration=calibration,missing=missing)
    (root/'model_paths.json').write_text(json.dumps(model))
    print('saved',len(out),'paths',len(calibration),'calibration pairs',flush=True)


def variants(paths,start,lag=.6,valuation='zero'):
    ts=[];vs={};key='virtual_ret' if valuation=='virtual' else 'ret'
    for i,(token,z) in enumerate(sorted(paths.items(),key=lambda x:(x[1]['launched'],x[0]))):
        at=z['launched']+2000
        if at<start or not z['sizes'].get('0.02',{}).get(str(lag)):continue
        for size,prices in z['sizes'].items():
            p=prices[str(lag)]
            if not p:continue
            sz=round(float(size)*1e18)
            t=Trade(i+1,token,at,round(at+p['age']*1000),round(p[key]*sz),sz)
            vs[i+1,sz]=t
            if sz==SIZE:ts.append(t)
    return ts,vs


def run(root):
    d=json.load(gzip.open(root/'snapshot.json.gz','rt'));mdata=json.load(open(root/'model_paths.json'))
    now=d['snapshot_at'];start=now-14*DAY;ps=r.policies(d['state']['config']['values']);spans=m.intervals(now)
    spans.update(all_current=(ERA,now),fit=(ERA,now-6*HOUR),recent_6h=(now-6*HOUR,now))
    obs=r.live_observations(d);known={o.token for o in obs}
    for token,z in mdata['paths'].items():
        if token not in known:obs.append(m.Observation(token,z['block'],z['launched'],m.scoring_time(z['launched'],300000),{'1.75':z['observer_return']}))
    output=dict(snapshot=iso(now),eth_usd=d['state']['truth']['priceUsd'],coverage=dict(recorded=len(known),
                reconstructed=sum(o.token not in known for o in obs),paths=len(mdata['paths'])),fees=mdata['fees'],scenarios={})
    cases=[('zero_recovery',.6,'zero',False,0),('virtual_curve_value',.6,'virtual',False,0),
           ('execution_halt',.6,'zero',True,0),('virtual_with_execution_halt',.6,'virtual',True,0),
           ('slower_sell',1.2,'zero',False,0),('clock_15s',.6,'zero',False,15000)]
    for name,lag,value,broken,phase in cases:
        ts,vs=variants(mdata['paths'],start,lag,value)
        output['scenarios'][name]=r.compare(obs,ts,ps,start,now,spans,variants=vs,broken=broken,phase=phase)
        print('scenario complete',name,flush=True)
    actual=r.recorded(d,ERA);byid={t.id:t for t in actual};av={}
    for tid,szs in mdata['actual_variants'].items():
        old=byid[int(tid)]
        for size,z in szs.items():
            sz=round(float(size)*1e18)
            av[old.id,sz]=replace(old,size=sz,pnl=round(z['ret']*sz),exit=round(old.entry+z['age']*1000))
    output['recorded_with_probe_estimates']=r.compare(r.live_observations(d),actual,ps,ERA,now,spans,variants=av)
    output['isolated_live_episode']=r.compare(r.live_observations(d),actual,ps,1788865233293,1788868383313,
        {'episode':(1788865233293,1788868383313)},variants=av,
        initial={'venue_halted':True,'realized':-round(.006029190672729674*1e18),'peak':0})
    cal=mdata['calibration']
    output['calibration']=dict(n=len(cal),gap_pp=describe(x['gap_pp'] for x in cal),
        actual_eth=sum(x['actual_eth'] for x in cal),modeled_eth=sum(x['modeled_eth'] for x in cal),
        virtual_eth=sum(x['virtual_eth'] for x in cal),unpriced=sum(x['unpriced'] for x in cal))
    (root/'model_results.json').write_text(json.dumps(output,indent=2))
    print('model results saved',flush=True)


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('action',choices=['build','run']);ap.add_argument('--root',type=Path,default=Path('v1/data/recovery-policy-20260908'))
    args=ap.parse_args();(build if args.action=='build' else run)(args.root)
