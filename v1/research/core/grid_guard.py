"""Parameterized recovery guards, evaluated only on production decision clocks."""
from dataclasses import dataclass, asdict
from itertools import product
import bisect

@dataclass(frozen=True)
class GridRule:
    n: int = 20
    m: int = 8
    off: float = -1
    fresh_on: float = 1
    full_on: float = 2
    age_min: int = 180
    mode: str = 'fresh'
    normalized: bool = False

    @property
    def name(self):
        return '_'.join(str(v) for v in asdict(self).values())


def grid():
    for n, m, off, fresh, age, norm in product((10,15,20,30,40),(3,5,8,10,15),(-.5,-1,-1.5,-2),(.5,1,1.5,2),(30,60,120,180),(False,True)):
        if m>n: continue
        yield GridRule(n,m,off,fresh,2,age,'fresh',norm)
        for full in (1,2,3):
            yield GridRule(n,m,off,fresh,full,age,'either',norm)
    for n,off,full,age,norm in product((10,15,20,30,40),(-.5,-1,-1.5,-2),(1,2,3),(30,60,120,180),(False,True)):
        yield GridRule(n,n,off,1,full,age,'full',norm)


class GridGuard:
    def __init__(self,tape,rule,size,start,entries=(),controls=()):
        self.records=tape.records
        if not hasattr(tape, "grid_features"):tape.grid_features={}
        self.features=tape.grid_features
        self.publications=tape.times
        self.rule,self.size=rule,size
        self.allowed=False
        self.cursor=start-1
        self.visible=[]
        self.index=0
        self.last={}
        self.last_at=None
        self.expiries=[r['launched']+rule.age_min*60000+1 for r in self.records]
        self.resumes={at for at,action in controls if action=='resume'}
        self.times=sorted(set(tape.times+self.expiries))
        self.schedule=set(self.times)|set(entries)|self.resumes|{start}
        self.transitions=[]

    def read(self,at):
        if self.last and (at not in self.schedule or at==self.last_at):return self.last
        r=self.rule
        hi=bisect.bisect_right(self.publications,at)
        self.index=hi
        if at in self.resumes:self.allowed=False;self.cursor=at
        changed=bool(hi and self.records[hi-1]['available']>self.cursor)
        self.cursor=at
        key=(at,r.n,r.m,r.age_min)
        feature=self.features.get(key)
        if feature is None:
            visible=self.records[:hi]
            mainkey=('main',at,r.n)
            main=self.features.get(mainkey)
            if main is None:
                rows=sorted(visible,key=lambda z:(z['block'],z['token']),reverse=True)[:r.n]
                main=(sum(z['value'] for z in rows),len(rows),max((at-z['launched'] for z in rows),default=0))
                self.features[mainkey]=main
            shortkey=('recent',at,r.m,r.age_min)
            shortfeature=self.features.get(shortkey)
            if shortfeature is None:
                recent=sorted((z for z in visible if at-z['launched']<=r.age_min*60000),key=lambda z:(z['launched'],z['token']),reverse=True)[:r.m]
                shortfeature=(sum(z['value'] for z in recent),len(recent))
                self.features[shortkey]=shortfeature
            feature=(main[0],shortfeature[0],main[1]==r.n and shortfeature[1]==r.m and main[2]<=r.age_min*60000)
            self.features[key]=feature
        total,short,fresh=feature
        off=r.off*r.n/20 if r.normalized else r.off
        on=r.fresh_on*r.m/8 if r.normalized else r.fresh_on
        full=r.full_on*r.n/20 if r.normalized else r.full_on
        recovered=(r.mode in ('fresh','either') and short>on) or (r.mode in ('full','either') and total>full)
        before=self.allowed;reason='hold'
        if not fresh:self.allowed=False;reason='stale_or_warmup'
        elif self.allowed and total<off:self.allowed=False;reason='score_brake'
        elif not self.allowed and changed and recovered:self.allowed=True;reason='fresh_recovery' if r.mode=='fresh' else 'recovery'
        self.last_at=at
        self.last=dict(allow=self.allowed,score20=total,fresh_sum=short,fresh=fresh,reason=reason,evidence=hi)
        if before!=self.allowed:self.transitions.append(dict(at=at,**self.last))
        return self.last

    def entry(self,at,trade,active):
        return self.size,None if self.read(at)['allow'] else 'venue'
    def entered(self,trade):pass
    def closed(self,trade):pass
    def definition(self):return asdict(self.rule)
