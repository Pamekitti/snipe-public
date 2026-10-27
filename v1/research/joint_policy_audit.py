"""Combined market-conditioned size, target and clock study. No live writes.

Run from bot/: PYTHONHASHSEED=0 python3 research/joint_policy_audit.py
See JOINT_POLICY_PROTOCOL.md. Uses only the exit audit's frozen local data.
"""
import bisect
import collections
import copy
import functools
import itertools
import json
from pathlib import Path
import sqlite3
import sys

import exit_policy_audit as a
import guard_audit as g

OUT=Path(__file__).resolve().parents[1]/'data/joint-policy-audit'

def profile(policy,score,fresh,base_tp,normal):
    if policy['kind']=='unknown_size':return (normal if fresh else normal*.5),base_tp,45
    if policy['kind']=='baseline' or (not fresh and not policy.get('unknown_weak')):
        return normal,base_tp,45
    weak=not fresh or score<=policy.get('cut',1)
    kind=policy['kind']
    size=normal*.5 if weak and kind in ('joint','size') else normal
    tp=(policy.get('weak_tp',1.36) if weak else policy.get('strong_tp',2.)) if kind in ('joint','tp','exits') else base_tp
    if kind=='fixed':tp=2.
    hold=policy.get('weak_hold',30) if weak and kind in ('joint','clock','exits') else 45
    return size,tp,hold

def candidates():
    out={n:{'kind':n} for n in ('baseline','size','tp','clock','exits','fixed')}
    for tp,h,high in itertools.product((1.25,1.36,1.5),(20,30),(1.75,2.,2.5)):
        out[f'joint_{tp:g}_{h}_{high:g}']=dict(kind='joint',weak_tp=tp,weak_hold=h,strong_tp=high)
    return out

PRIMARY='joint_1.36_30_2'

class Study:
    def __init__(self):
        self.d=a.Data();self.policies=candidates()
        db=sqlite3.connect(a.ROOT/'paths.db')
        self.raw={t:json.loads(js) for t,js in db.execute('select token,js from paths where error is null')};db.close()
        self.seqs={t:a.chainio.decode_seq(ls) for t,ls in self.raw.items()}
        self.facts=self.d.facts
        self.obs=[g.Observation(r['token'],r['block'],r['launched_at']*1000,r['at'],r['bars']) for r in self.d.obs if r['eligible']]
        self.guard=g.Policy(name='current',window=20,off=-1,on=1,fresh_h=3,dd=60_000_000_000_000_000,rwin=20,ron=0,lifts=2)
        costs=json.load(open(a.ROOT/'results.json'))['observed_costs_eth']
        self.costs=costs
        self.gas={float(k):v['median'] for k,v in costs.items() if v['n']}
        self.rows=[]
        for t in self.raw:
            f=self.facts[t];at=(f['launched_at'] or 0)*1000+2000
            if a.eligible(f) and self.d.start<=at<self.d.now-100_000:
                self.rows.append({'token':t,'at':at,'id':0})
        self.rows.sort(key=lambda r:r['at'])
        for i,r in enumerate(self.rows):r['id']=i+1

    @functools.lru_cache(maxsize=None)
    def feature(self,at,delay=0):
        tick=self.d.start+((at-self.d.start)//30_000)*30_000
        tp,_=self.d.signal(tick,delay=delay)
        _,rows=self.d.signal(tick,book=True,delay=delay)
        total=sum(r['bars']['1.75'] for r in rows)
        fresh=len(rows)==20 and tick-rows[-1]['launched_at']*1000<=3*a.HOUR
        return tp,total,fresh

    @functools.lru_cache(maxsize=None)
    def path(self,token,size,entry=20):
        f=self.facts[token]
        return a.engine.path({'token':token,'block':f['block'],'deployer':f['deployer'],'tx':''},size,self.seqs[token],
                              f['creator_tax_bps'] or 0,entry_blk=entry,comp=0,haircut=0,horizon=850,tick=5)

    def gas_for(self,size):
        return self.gas.get(size,self.gas[min(self.gas,key=lambda x:abs(x-size))])

    @functools.lru_cache(maxsize=None)
    def result(self,token,size,tp,hold,lag=.6,poll=1.2,entry=20,guard_quote=True):
        P=self.path(token,size,entry)
        if not P:return None
        if guard_quote:
            f=self.facts[token];c=a.engine.Curve(f['creator_tax_bps'] or 0)
            got,_=c.buy(size,a.engine.snipe_bps(entry/10,f['creator_tax_bps'] or 0))
            if got/P['tok']>=4.5:return None
        z=a.replay(P,tp,{'hold':hold},gas=self.gas_for(size),lag=lag,poll=poll)
        if z['ret'] is None:raise RuntimeError('Incomplete path')
        return dict(pnl=z['ret']*size,ret=z['ret'],age=z['age'],reason=z['reason'],size=size,tp=tp,hold=hold)

    def trades(self,name,normal,delay=0,lag=.6,poll=1.2,cut=None):
        policy=dict(self.policies[name])
        if cut is not None:policy['cut']=cut
        out=[];details=[]
        for row in self.rows:
            tp,score,fresh=self.feature(row['at'],delay)
            size,target,hold=profile(policy,score,fresh,tp,normal)
            z=self.result(row['token'],size,target,hold,lag,poll)
            details.append(dict(**row,score=score,fresh=fresh,weak=fresh and score<=policy.get('cut',1),result=z))
            if z:
                out.append(g.Trade(row['id'],row['token'],row['at'],round(row['at']+z['age']*1000),round(z['pnl']*1e18),round(size*1e18)))
        return out,details

    @functools.lru_cache(maxsize=None)
    def observer_tape(self,delay=0):
        return g.Tape(self.obs,[],self.d.start,self.d.now,delay=delay)

    def simulate(self,trades,delay=0,dd=True):
        tape=copy.copy(self.observer_tape(delay))
        tape.trades={t.id:t for t in trades}
        tape.events=tape.events+[(t.entry,2,t) for t in trades]+[(t.exit,0,t) for t in trades if t.exit<=self.d.now]
        tape.events.sort(key=lambda x:(x[0],x[1],getattr(x[2],'id',0)))
        policy=copy.copy(self.guard)
        if not dd:policy=g.replace(policy,drawdown=False)
        return tape.simulate(policy)

    def metrics(self,result,trades,lo,hi):
        ts={t.id:t for t in trades};cash=[v for v in result['cash'] if lo<=v[0]<hi]
        pnl=peak=dd=0
        for _,_,v in cash:
            pnl+=v;peak=max(peak,pnl);dd=max(dd,peak-pnl)
        spend=sum(ts[i].size for _,i,_ in cash)
        return dict(n=len(cash),pnl_eth=pnl/1e18,drawdown_eth=dd/1e18,spent_eth=spend/1e18,
                    rot_pct=100*pnl/spend if spend else None,
                    return_pct=a.desc(100*v/ts[i].size for _,i,v in cash),
                    trade_pnl_eth=a.desc(v/1e18 for _,_,v in cash),
                    skips=dict(collections.Counter(reason for at,i,reason in result['decisions'] if lo<=at<hi and reason)),
                    stops=sum(lo<=v['at']<hi and v['action']=='stop' for v in result['actions']),
                    resumes=sum(lo<=v['at']<hi and v['action']=='resume' for v in result['actions']))

    def summaries(self,result,trades):
        return {label:self.metrics(result,trades,lo,hi) for label,lo,hi in [('fit',self.d.start,self.d.cut),('recency',self.d.cut,self.d.now),('all',self.d.start,self.d.now)]}

    def bins(self,result,trades):
        out={}
        for label,span,n in [('24h',a.DAY,8),('7d',7*a.DAY,7)]:
            out[label]=[]
            for i in range(n):
                lo=self.d.now-span+i*span/n;hi=lo+span/n
                out[label].append(dict(start=a.iso(lo),end=a.iso(hi),coverage='unavailable' if hi<=self.d.start else 'partial' if lo<self.d.start else 'in sample',
                                      metrics=self.metrics(result,trades,max(lo,self.d.start),hi)))
        return out

    def matched(self,names=None):
        out=[]
        readings=self.simulate([],dd=False)['readings'];times=[r[0] for r in readings]
        for p in self.d.trades:
            if p['token'] not in self.raw or p['t_sent']<self.d.start or not p['fill_block']:continue
            normal=int(p['spend_wei'])/1e18;entry=p['fill_block']-self.facts[p['token']]['block']
            paid=int(p['proceeds_wei'] or 0)/1e18-normal-a.net(p)
            z=self.result(p['token'],normal,p['take_profit'] or 1.75,45,entry=entry,guard_quote=False)
            if not z:continue
            simulated=z['pnl']+self.gas_for(normal)-paid
            _,score,fresh=self.feature(p['t_sent'])
            pos=bisect.bisect_right(times,p['t_sent'])-1
            venue_open=pos<0 or not readings[pos][1]
            deltas={}
            for name in names or ['size','tp','clock','exits',PRIMARY]:
                size,tp,hold=profile(self.policies[name],score,fresh,p['take_profit'] or 1.75,normal)
                q=self.result(p['token'],size,tp,hold,entry=entry,guard_quote=False)
                if q:
                    alt=q['pnl']+self.gas_for(size)-paid*self.gas_for(size)/self.gas_for(normal)
                    deltas[name]=alt-simulated
            out.append(dict(id=p['id'],at=p['t_sent'],size=normal,venue_open=venue_open,score=score,fresh=fresh,
                            actual_pnl=a.net(p),simulated_pnl=simulated,gap_pp=100*(simulated-a.net(p))/normal,deltas=deltas))
        return out

def main():
    OUT.mkdir(exist_ok=True);s=Study();answer={'snapshot':a.iso(s.d.now),'cut':a.iso(s.d.cut),'start':a.iso(s.d.start),
      'primary':PRIMARY,'policies':s.policies,'costs':s.costs,'sizes':{},'limitations':'Retrospective reused data; synthetic opportunities; incomplete historical touch/manual/template guards; other-wallet response unknown.'}
    for normal in (.01,.02):
        runs={};scores={};records={}
        for name in s.policies:
            trades,rows=s.trades(name,normal)
            result=s.simulate(trades)
            runs[name]=(result,trades);records[name]=rows
            scores[name]=s.summaries(result,trades)
        allowed=[n for n in s.policies if (n=='baseline' or n.startswith('joint_')) and scores[n]['fit']['drawdown_eth']<=scores['baseline']['fit']['drawdown_eth']+1e-12]
        selected=max(allowed,key=lambda n:(scores[n]['fit']['pnl_eth'],n=='baseline'))
        (OUT/f'frozen_{normal:g}.json').write_text(json.dumps({'selected':selected,'fit':scores[selected]['fit'],'admissible':allowed},indent=2))
        item={'selected':selected,'scores':scores,'without_drawdown':{},'bins':{},'stress':{},'rows':{}}
        shortlist=list(dict.fromkeys(['baseline',PRIMARY,selected,'size','tp','clock','exits','fixed']))
        for name in shortlist:
            result,trades=runs[name]
            item['bins'][name]=s.bins(result,trades)
            item['without_drawdown'][name]=s.summaries(s.simulate(trades,dd=False),trades)
            item['rows'][name]=records[name]
        for delay,lag,poll in [(0,.6,.5),(0,1.2,1.2),(0,2.4,1.2),(60_000,.6,1.2),(180_000,.6,1.2)]:
            for name in dict.fromkeys(['baseline',PRIMARY,selected]):
                trades,_=s.trades(name,normal,delay,lag,poll)
                item['stress'][f'{name}/delay{delay}/lag{lag}/poll{poll}']=s.summaries(s.simulate(trades,delay=delay),trades)
        trades,_=s.trades(PRIMARY,normal,cut=0)
        item['zero_split_diagnostic']=s.summaries(s.simulate(trades),trades)
        answer['sizes'][str(normal)]=item
        print('complete normal size',normal,'selected',selected,flush=True)
    answer['matched']=s.matched()
    (OUT/'results.json').write_text(json.dumps(answer,indent=2));print('saved',OUT/'results.json',flush=True)

def missing_data_diagnostics():
    s=Study()
    s.policies.update(cautious_missing={**s.policies[PRIMARY],'unknown_weak':True},
                      size_missing={'kind':'size','unknown_weak':True},only_missing_size={'kind':'unknown_size'})
    out={'label':'Post-hoc missing-data diagnostics; no candidate reselection','sizes':{}}
    for normal in (.01,.02):
        out['sizes'][str(normal)]={}
        for name in ['baseline',PRIMARY,'cautious_missing','size_missing','only_missing_size']:
            trades,rows=s.trades(name,normal);run=s.simulate(trades)
            out['sizes'][str(normal)][name]={'scores':s.summaries(run,trades),'bins':s.bins(run,trades)}
        out['sizes'][str(normal)]['stress']={}
        for delay,lag,poll in [(0,.6,.5),(0,1.2,1.2),(0,2.4,1.2),(60_000,.6,1.2),(180_000,.6,1.2)]:
            for name in ['baseline','cautious_missing']:
                trades,_=s.trades(name,normal,delay,lag,poll)
                out['sizes'][str(normal)]['stress'][f'{name}/delay{delay}/lag{lag}/poll{poll}']=s.summaries(s.simulate(trades,delay=delay),trades)
    out['matched']=s.matched(['cautious_missing','size_missing','only_missing_size'])
    (OUT/'missing_data_diagnostics.json').write_text(json.dumps(out,indent=2));print('saved missing-data diagnostics',flush=True)

if __name__=='__main__':
    missing_data_diagnostics() if '--missing-data-diagnostics' in sys.argv else main()
