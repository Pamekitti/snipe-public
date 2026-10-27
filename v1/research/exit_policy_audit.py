"""Read-only exit policy research on the frozen production export."""
from __future__ import annotations
import argparse
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sqlite3
import statistics as st
import sys

ROOT = Path(os.environ.get('SNIPE_EXIT_AUDIT_DIR', Path(__file__).resolve().parents[1] / 'data/exit-policy-audit')).resolve()
sys.path.insert(0, str(ROOT / 'live/scripts' if (ROOT / 'live/scripts').is_dir() else Path(__file__).resolve().parents[1] / 'scripts'))
import engine
import chainio

HOUR=3_600_000
DAY=24*HOUR
BARS=[1.25,1.36,1.5,1.75,2.,2.5,3.]
NON={'buy-reverted','buy-never-mined','recovered-flat'}

def desc(xs):
    xs=list(xs)
    return dict(n=len(xs),sum=sum(xs),mean=st.mean(xs) if xs else None,
                median=st.median(xs) if xs else None,sd=st.stdev(xs) if len(xs)>1 else None,
                positive=sum(x>0 for x in xs),minimum=min(xs) if xs else None)

def iso(ms): return dt.datetime.fromtimestamp(ms/1000,dt.timezone.utc).isoformat()
def net(r): return int(r['onchain_pnl_wei'] if r['onchain_pnl_wei'] is not None else r['pnl_wei'] or 0)/1e18
def eligible(r): return bool(r and r['passed'] and 50<=(r['creator_tax_bps'] or 0)<=200 and (r['exemptions'] or 0)>=3)
def argmax(rows,bars=BARS):
    if len(rows)<20: return 1.75
    return max(bars,key=lambda b:sum(r.get(f'{b:.2f}',0) for r in rows[:20]))

class Data:
    def __init__(self):
        self.raw=json.load(gzip.open(ROOT/'snapshot.json.gz','rt'))
        self.now=self.raw['now']; self.cut=self.now-6*HOUR; self.tables=self.raw['tables']
        self.facts={r['token']:r for r in self.tables['bot.launches']}
        self.obs=[]
        for r in self.tables['gate.obs']:
            if not r['error'] and r['bars']:
                z=dict(r);z['bars']=json.loads(r['bars']);z['eligible']=eligible(self.facts.get(r['token']))
                self.obs.append(z)
        self.obs.sort(key=lambda r:r['at']);self.start=min(r['at'] for r in self.obs)
        self.positions=[r for r in self.tables['bot.positions'] if r['live'] and r['closed'] and r['cohort']!='probe']
        self.trades=[r for r in self.positions if r['exit_reason'] not in NON]
        self.obyt={r['token']:r for r in self.obs}
    def signal(self,at,book=False,delay=0):
        rows=sorted((r for r in self.obs if r['at']<=at-delay and (not book or r['eligible'])),key=lambda r:r['block'],reverse=True)[:20]
        return argmax([r['bars'] for r in rows]),rows

def windows(d,rows,get_at,get_value,start=None):
    out={}
    for label,span,n in [('24h',DAY,8),('7d',7*DAY,7)]:
        bins=[]
        for i in range(n):
            a=d.now-span+i*span/n;b=a+span/n
            xs=[get_value(r) for r in rows if a<=get_at(r)<b and (start is None or get_at(r)>=start)]
            bins.append(dict(start=iso(a),end=iso(b),coverage='pre-era' if start and b<=start else 'partial' if start and a<start else 'in-era',stats=desc(xs)))
        out[label]=bins
    return out

def observed(d):
    out={'snapshot':iso(d.now),'fit_end':iso(d.cut),'bars_start':iso(d.start)}
    regimes=[('size_002_since_2001',lambda r:r['id']>=2001 and int(r['spend_wei'])==20_000_000_000_000_000),
             ('current_size_001',lambda r:r['id']>=2108),
             ('adaptive_market_period',lambda r:r['t_sent']>=d.start)]
    for name,fn in regimes:
        ps=[r for r in d.positions if fn(r)];ts=[r for r in ps if r['exit_reason'] not in NON]
        out[name]={'pnl_eth':desc(net(r) for r in ps),'trade_return_pct':desc(100*net(r)/(int(r['spend_wei'])/1e18) for r in ts),
                   'hold_seconds':desc(r['hold_ms']/1000 for r in ts),'trade_n':len(ts),'nontrade_n':len(ps)-len(ts),
                   'receipts_missing':sum(r['onchain_pnl_wei'] is None for r in ps),
                   'by_exit':{reason:{'pnl_eth':desc(net(r) for r in ts if r['exit_reason']==reason),
                                      'hold_seconds':desc(r['hold_ms']/1000 for r in ts if r['exit_reason']==reason)} for reason in sorted({r['exit_reason'] for r in ts})}}
        if ts:out[name]['bins']=windows(d,ts,lambda r:r['exit_at'],net,min(r['t_sent'] for r in ts))
    checks=[]
    for p in d.trades:
        if p['t_sent']<d.start:continue
        tp,w=d.signal(p['t_sent'],delay=30_000)
        checks.append({'id':p['id'],'pred':tp,'actual':p['take_profit'],'n':len(w)})
    out['target_reproduction']={'n':len(checks),'matches':sum(r['pred']==r['actual'] for r in checks),'details':checks}
    latest=sorted(d.obs,key=lambda r:r['block'],reverse=True)[:20]
    out['latest_signal']={'n':len(latest),'eligible':sum(r['eligible'] for r in latest),
       'span_minutes':(max(r['launched_at'] for r in latest)-min(r['launched_at'] for r in latest))/60,
       'age_seconds':(d.now-max(r['at'] for r in latest))/1000,'target':argmax([r['bars'] for r in latest]),
       'scores':{str(b):desc(r['bars'].get(f'{b:.2f}',0) for r in latest) for b in BARS}}
    rows=[]
    for r in d.obs:
        at=(r['launched_at'] or 0)*1000+2000
        if not r['eligible'] or at<d.start or at>d.now-100_000:continue
        tp,w=d.signal(at,delay=30_000);btp,bw=d.signal(at,book=True,delay=30_000)
        vals={f'fixed_{b:g}':r['bars'].get(f'{b:.2f}') for b in BARS}
        vals['adaptive_all']=r['bars'].get(f'{tp:.2f}');vals['adaptive_book']=r['bars'].get(f'{btp:.2f}')
        rows.append(dict(token=r['token'],at=at,resolved=r['at'],values=vals,tp=tp,booktp=btp,
                         window_eligible=sum(z['eligible'] for z in w),window_span_min=(w[0]['launched_at']-w[-1]['launched_at'])/60 if len(w)==20 else None,
                         book_window_span_min=(bw[0]['launched_at']-bw[-1]['launched_at'])/60 if len(bw)==20 else None))
    names=list(rows[0]['values']);train=[r for r in rows if r['resolved']<d.cut]
    winner=max(names,key=lambda n:sum(r['values'][n] for r in train if r['values'][n] is not None))
    out['observed_bars_selection']={'winner':winner,'candidate_count':len(names),'fit_n':len(train)}
    out['observed_bars']={n:{label:desc(r['values'][n] for r in rows if r['values'][n] is not None and pred(r))
                              for label,pred in [('fit',lambda r:r['resolved']<d.cut),('recency',lambda r:r['at']>=d.cut),('all',lambda r:True)]} for n in names}
    out['observed_bars_bins']={n:windows(d,rows,lambda r:r['at'],lambda r:r['values'][n],d.start) for n in names}
    out['signal_composition']={'eligible_in_twenty':desc(r['window_eligible'] for r in rows),
       'window_span_minutes':desc(r['window_span_min'] for r in rows if r['window_span_min'] is not None),
       'book_window_span_minutes':desc(r['book_window_span_min'] for r in rows if r['book_window_span_min'] is not None),
       'target_differs':sum(r['tp']!=r['booktp'] for r in rows),'n':len(rows)}
    out['observed_rows']=rows
    paired=[dict(at=r['at'],resolved=r['resolved'],outcomes={n:{'ret':v} for n,v in r['values'].items()}) for r in rows]
    out['observed_deltas']={n:{label:bootstrap_delta(group,n,base='adaptive_all')
       for label,group in [('fit',[r for r in paired if r['resolved']<d.cut]),('recency',[r for r in paired if r['at']>=d.cut])]} for n in names}
    out['score_latency_seconds']=desc((r['at']-r['launched_at']*1000)/1000 for r in d.obs if r['launched_at']*1000>=d.start)
    return out

def policies():
    ps={'baseline':{'hold':45}}
    for h in (15,20,30,60,75): ps[f'cap_{h}']={'hold':h}
    for t in (0,10,15,25):ps[f'dead_{t}']={'dead':t}
    for arm in (1.10,1.25):
        for trail in (.15,.25):ps[f'trail_{arm:g}_{trail:g}']={'arm':arm,'trail':trail}
    ps['creator_sell']={'seller':'creator'};ps['early_sell']={'seller':'early'}
    for t in (15,20):ps[f'flow_{t}']={'flow_age':t}
    return ps

def replay(P,tp,policy,gas=0.,lag=.6,poll=1.2):
    peak=1.;next_poll=0.;pending=None;flows=[];prevq=engine.PH;prevt=engine.SUP
    events=[]
    for off,m,q,t,grad,ev in P['pts']:
        age=off/10
        if pending and off>=pending[0]:
            gross=0. if t<=engine.RES+1e-7 else engine.sell_value(P,q,t)
            return dict(ret=(gross-P['X']-gas)/P['X'],age=age,reason=pending[1],trigger=(pending[0]-round(lag*10))/10,peak=peak,mark=m)
        if m>peak:peak=m
        seller=False
        if ev:
            flow=ev.get('eth',0) if ev['s']=='B' else -prevq*ev.get('tok',0)/(prevt+ev.get('tok',0))
            flows.append((age,flow))
            if ev['s']=='S':
                events.append((age,ev.get('creator',False),ev.get('early',False),m))
                seller=bool(policy.get('seller') and ev.get(policy['seller']))
        prevq,prevt=q,t
        if pending:continue
        reason=None
        check=off>=next_poll
        if check:next_poll=off+round(poll*10)
        if grad:reason='grad'
        elif check and m>=tp:reason='tp'
        elif age>=policy.get('hold',45):reason='time'
        elif check and m<=.5:reason='stop'
        elif check and policy.get('dead',20)>0 and age>=policy.get('dead',20) and peak<1.03:reason='dead'
        elif seller:reason=policy['seller']+'_sell'
        elif check and 'trail' in policy and peak>=policy['arm'] and m<=peak*(1-policy['trail']):reason='trail'
        elif check and 'flow_age' in policy and age>=policy['flow_age'] and m<1.03 and sum(f for a,f in flows if age-5<a<=age)<=0:reason='flow'
        if reason:pending=(off+round(lag*10),reason)
    return dict(ret=None,age=None,reason='insufficient_path')

def bootstrap_delta(rows,name,base='baseline',seed=7):
    blocks=collections.defaultdict(list)
    for r in rows:blocks[int(r['at']//(3*HOUR))].append(r['outcomes'][name]['ret']-r['outcomes'][base]['ret'])
    vals=list(blocks.values());rng=random.Random(seed)
    if not vals:return None
    samples=[]
    for _ in range(2000):
        drawn=[v for _ in vals for v in rng.choice(vals)];samples.append(st.mean(drawn))
    samples.sort()
    return {'blocks_3h':len(vals),'mean_delta':st.mean(v for xs in vals for v in xs),'p05':samples[100],'p95':samples[1899]}

def cash_curve(rows,name):
    events=[]
    for r in rows:
        o=r['outcomes'][name]
        events.append((r['at'],1,0.))
        events.append((r['at']+o['age']*1000,-1,o['ret']))
    balance=0.;peak=0.;dd=0.;opened=0;max_open=0
    for _,delta,pnl in sorted(events):
        opened+=delta;max_open=max(max_open,opened);balance+=pnl;peak=max(peak,balance);dd=max(dd,peak-balance)
    return {'net_stakes':balance,'max_closed_cash_drawdown_stakes':dd,'max_concurrent':max_open}

def choose_clock(history,at):
    w=sorted((z for z in history if z['resolved']<=at-30_000),key=lambda z:z['at'],reverse=True)[:20]
    return max((20,30,45,60),key=lambda h:sum(z['outcomes'][f'adapt_clock_source_{h}']['ret'] for z in w)) if len(w)==20 else 45

def chain_analysis(d,obs_result):
    db=sqlite3.connect(ROOT/'paths.db');paths={t:json.loads(js) for t,js in db.execute('select token,js from paths where error is null')};db.close()
    actual={p['token']:p for p in d.trades if p['id']>=2001}
    costs={}
    for size in (0.005,.01,.02):
        rs=[p for p in d.trades if p['t_sent']<d.cut and p['t_sent']>=d.start and int(p['spend_wei'])==round(size*1e18)]
        gas=[(int(p['proceeds_wei'] or 0)/1e18-size)-net(p) for p in rs]
        costs[size]=desc(gas)
    # Current size has no fitting-period executions. Use observed .02 ETH median costs
    # as an explicitly stated absolute-ETH cost assumption, not a percentage rescale.
    gas=costs[.01]['median'] if costs[.01]['n'] else costs[.02]['median'] or 0
    ps=policies(); rows=[]; calibration=[]; pathstats=[];missing=[]
    for t,logs in paths.items():
        f=d.facts[t];seq=chainio.decode_seq(logs);l={'token':t,'block':f['block'],'deployer':f['deployer'],'tx':''}
        p=actual.get(t)
        if p and p['fill_block']:
            size=int(p['spend_wei'])/1e18
            P=engine.path(l,size,seq,f['creator_tax_bps'] or 0,entry_blk=p['fill_block']-f['block'],comp=0,haircut=0,horizon=850,tick=5)
            if P:
                paid=(int(p['proceeds_wei'] or 0)/1e18-size)-net(p)
                result=replay(P,p['take_profit'] or 1.75,{'dead':(p['dead_after_ms'] or 0)/1000},gas=paid)
                calibration.append({'id':p['id'],'at':p['t_sent'],'size':size,'live':net(p)/size,'sim':result['ret'],
                  'gap_pp':100*(result['ret']-net(p)/size),'live_hold':p['hold_ms']/1000,'sim_hold':result['age'],
                  'live_reason':p['exit_reason'],'sim_reason':result['reason'],'cost_eth':paid,
                  'policy_deltas':{n:replay(P,p['take_profit'] or 1.75,policy,gas=paid)['ret']-result['ret'] for n,policy in ps.items()}})
        at=(f['launched_at'] or 0)*1000+2000
        if not eligible(f) or at<d.start or at>d.now-100_000:continue
        P=engine.path(l,.01,seq,f['creator_tax_bps'] or 0,entry_blk=20,comp=0,haircut=0,horizon=850,tick=5)
        if not P:missing.append(t);continue
        tp,w=d.signal(at,delay=30_000)
        _,venue_rows=d.signal(at,book=True,delay=30_000)
        venue_sum=sum(z['bars'].get('1.75',0) for z in venue_rows) if len(venue_rows)==20 else None
        venue_fresh=len(venue_rows)==20 and at-venue_rows[-1]['launched_at']*1000<=3*HOUR
        results={n:replay(P,tp,policy,gas=gas) for n,policy in ps.items()}
        fresh=engine.Curve(f['creator_tax_bps'] or 0)
        fresh_tokens,_=fresh.buy(.01,engine.snipe_bps(2,f['creator_tax_bps'] or 0))
        r={'token':t,'at':at,'resolved':max(d.obyt.get(t,{}).get('at',at+120_000),at+90_000),
           'tp':tp,'outcomes':results,'P':P,'logs':logs,'entry_multiple_proxy':fresh_tokens/P['tok'],
           'venue_sum':venue_sum,'venue_fresh':venue_fresh}
        for h in (20,30,45,60):r['outcomes'][f'adapt_clock_source_{h}']=replay(P,tp,{'hold':h},gas=gas)
        peakpoints=[z for z in P['pts'] if z[0]<=750]
        maxp=max(peakpoints,key=lambda z:z[1]);first_creator=next((z for z in P['pts'] if z[5] and z[5]['s']=='S' and z[5]['creator']),None)
        first_early=next((z for z in P['pts'] if z[5] and z[5]['s']=='S' and z[5]['early']),None)
        pathstats.append({'token':t,'at':at,'peak_age_75':maxp[0]/10,'peak_75':maxp[1],
                          'venue_sum':venue_sum,'venue_fresh':venue_fresh,
                          'creator_sell_age':first_creator[0]/10 if first_creator else None,
                          'early_sell_age':first_early[0]/10 if first_early else None,
                          'creator_mark':first_creator[1] if first_creator else None})
        rows.append(r)
    rows.sort(key=lambda r:r['at'])
    for i,r in enumerate(rows):
        hold=choose_clock(rows[:i],r['at'])
        r['outcomes']['adaptive_clock']=r['outcomes'][f'adapt_clock_source_{hold}'];r['adaptive_hold']=hold
    names=list(ps)+['adaptive_clock']
    train=[r for r in rows if r['resolved']<d.cut];val=[r for r in rows if r['at']>=d.cut]
    winner=max(names,key=lambda n:sum(r['outcomes'][n]['ret'] for r in train))
    frozen={'snapshot':iso(d.now),'cut':iso(d.cut),'winner':winner,'candidates':names,'fit_n':len(train)}
    (ROOT/'frozen_clock_selection.json').write_text(json.dumps(frozen,indent=2))
    result={'gas_assumption':gas,'observed_costs_eth':costs,'selection':frozen,'n':len(rows),'missing':missing,
      'scores':{n:{label:desc(r['outcomes'][n]['ret'] for r in group) for label,group in [('fit',train),('recency',val),('all',rows)]} for n in names},
      'deltas':{n:{label:bootstrap_delta(group,n) for label,group in [('fit',train),('recency',val),('all',rows)]} for n in names},
      'cash_curves':{n:{label:cash_curve(group,n) for label,group in [('fit',train),('recency',val),('all',rows)]} for n in names},
      'bins':{n:windows(d,rows,lambda r:r['at'],lambda r:r['outcomes'][n]['ret'],d.start) for n in names},
      'calibration':calibration,'pathstats':pathstats}
    result['calibration_stats']={str(size):{label:desc(r['gap_pp'] for r in calibration if r['size']==size and pred(r))
         for label,pred in [('fit',lambda r:r['at']<d.cut),('recency',lambda r:r['at']>=d.cut),('all',lambda r:True)]} for size in (.01,.02)}
    result['entry_guard_sensitivity']={n:{label:desc(r['outcomes'][n]['ret']-r['outcomes']['baseline']['ret']
         for r in group if r['entry_multiple_proxy']<4.5) for label,group in [('fit',train),('recency',val)]} for n in names}
    folds=[];a=d.start+6*HOUR
    while a+3*HOUR<=d.now:
        fit=[r for r in rows if r['resolved']<a];test=[r for r in rows if a<=r['at']<a+3*HOUR]
        chosen=max(names,key=lambda n:sum(r['outcomes'][n]['ret'] for r in fit))
        folds.append({'start':iso(a),'end':iso(a+3*HOUR),'winner':chosen,'fit_n':len(fit),'test_n':len(test),
                     'delta':desc(r['outcomes'][chosen]['ret']-r['outcomes']['baseline']['ret'] for r in test)})
        a+=3*HOUR
    result['folds']=folds
    stress={}
    for lag in (.6,1.2,2.4):
        for poll in (.5,1.2):
            for n in dict.fromkeys(['baseline',winner,'cap_20','cap_30','trail_1.1_0.15','creator_sell']):
                policy=ps.get(n)
                for label,group in [('fit',train),('recency',val)]:
                    vals=[]
                    for r in group:
                        p=policy or {'hold':r['adaptive_hold']}
                        new=replay(r['P'],r['tp'],p,gas=gas,lag=lag,poll=poll)['ret']
                        base=replay(r['P'],r['tp'],ps['baseline'],gas=gas,lag=lag,poll=poll)['ret']
                        vals.append(new-base)
                    stress[f'{n}/lag{lag}/poll{poll}/{label}']=desc(vals)
    result['stress']=stress
    result['rows']=[{k:v for k,v in r.items() if k not in ('P','logs')} for r in rows]
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--chain',action='store_true');args=parser.parse_args()
    d=Data();out=observed(d)
    (ROOT/'observed.json').write_text(json.dumps(out,indent=2));print('observed saved',flush=True)
    if args.chain:
        out2=chain_analysis(d,out);(ROOT/'results.json').write_text(json.dumps(out2,indent=2));print('chain saved',flush=True)
