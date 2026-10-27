"""Research-only guard families with causal publication and explicit score scales."""
from dataclasses import dataclass, asdict, replace
from itertools import product, combinations
import bisect
import math
from .grid_guard import GridRule, GridGuard

@dataclass(frozen=True)
class Rule(GridRule):
    fresh_brake: float | None = None
    recovery_floor: float | None = None
    new_outcomes: int = 1
    weighting: str = 'sum'
    half_life: int = 30
    win_cap: float | None = None
    participation: float | None = None

    @property
    def name(self):
        return '_'.join(format(v,'g') if isinstance(v,float) else str(v) for v in asdict(self).values())

FAMILIES = {
    'fresh_brake': [-1, -.5, 0],
    'recovery_floor': [-1, 0, 1],
    'new_outcomes': [1, 2, 4],
    'half_life': [15, 30, 60],
    'win_cap': [.5, 1, 2],
    'participation': [.25, .375, .5],
}

def core():
    for n,m,b,r,a,norm in product((10,15,20,30,40),(3,5,8,10,15),(-2,-1.5,-1,-.5,0,.5),(.5,1,1.5,2),(30,60,120,180),(False,True)):
        if m>n: continue
        yield Rule(n,m,b,r,2,a,'fresh',norm)
        for h in (1,2,3):
            for mode in ('either','both'):
                yield Rule(n,m,b,r,h,a,mode,norm)
    for n,b,h,a,norm in product((10,15,20,30,40),(-2,-1.5,-1,-.5,0,.5),(1,2,3),(30,60,120,180),(False,True)):
        yield Rule(n,n,b,1,h,a,'full',norm)

def family_rules(family):
    bases=(variant for base in core() for variant in ([replace(base,m=m) for m in (3,5,8,10,15) if m<=base.n] if base.mode=='full' and family in ('fresh_brake','participation') else [base]))
    for rule in bases:
        # A floor constrains the fresh recovery branch; it has no effect on full-only recovery.
        if family=='recovery_floor' and rule.mode=='full': continue
        for value in FAMILIES[family]:
            if family=='half_life':
                # Normalized scores use native thresholds. The two raw-threshold scales
                # become identical here, so enumerate the effective policy only once.
                if rule.normalized: continue
                yield replace(rule,weighting='exponential',half_life=value)
            else: yield replace(rule,**{family:value})
        if family=='half_life' and not rule.normalized:
            yield replace(rule,weighting='uniform')

class Guard(GridGuard):
    def __init__(self,tape,rule,size,start,entries=(),controls=()):
        # SignalTape validates duplicate delivery, values and publication clocks once.
        super().__init__(tape,rule,size,start,entries,controls)
        self.pause_index=0
        self.config=None

    def read(self,at):
        if self.last and (at not in self.schedule or at==self.last_at): return self.last
        r=self.rule
        hi=bisect.bisect_right(self.publications,at)
        self.index=hi
        if at in self.resumes:
            self.allowed=False; self.cursor=at; self.pause_index=hi
        changed=bool(hi and self.records[hi-1]['available']>self.cursor)
        self.cursor=at
        key=('v2',at,r.n,r.m,r.age_min,r.weighting,r.half_life,r.win_cap)
        feature=self.features.get(key)
        if feature is None:
            visible=self.records[:hi]
            config=visible[-1].get('config') if visible else None
            visible=[z for z in visible if z.get('config')==config]
            main_key=('v2-main-rows',at,r.n,config)
            main=self.features.get(main_key)
            if main is None:
                main=sorted(visible,key=lambda z:(z['block'],z['token']),reverse=True)[:r.n]
                self.features[main_key]=main
            recent_key=('v2-recent-rows',at,r.m,r.age_min,config)
            recent=self.features.get(recent_key)
            if recent is None:
                recent=sorted((z for z in visible if 0<=at-z['launched']<=r.age_min*60000),key=lambda z:(z['launched'],z['token']),reverse=True)[:r.m]
                self.features[recent_key]=recent
            valid=lambda z: math.isfinite(z['value']) and not z.get('invalid') and z['available']<=at and 0<=at-z['launched']<=r.age_min*60000
            fresh=len(main)==r.n and len(recent)==r.m and all(valid(z) for z in main+recent)
            def score(rows,scale):
                values=[min(z['value'],r.win_cap) if r.win_cap is not None else z['value'] for z in rows]
                if r.weighting=='sum': return sum(values)
                weights=[2**(-(at-z['launched'])/(r.half_life*60000)) if r.weighting=='exponential' else 1 for z in rows]
                return scale*sum(v*w for v,w in zip(values,weights))/sum(weights) if weights and sum(weights)>0 else 0
            feature=(score(main,20),score(recent,8),fresh,sum(z['value']>0 for z in recent)/len(recent) if recent else 0,config)
            self.features[key]=feature
        total,short,fresh,participation,config=feature
        if self.config is not None and config!=self.config:
            self.allowed=False; self.pause_index=hi; changed=False
        self.config=config
        scaled=r.normalized and r.weighting=='sum'
        off=r.off*r.n/20 if scaled else r.off
        on=r.fresh_on*r.m/8 if scaled else r.fresh_on
        full=r.full_on*r.n/20 if scaled else r.full_on
        fresh_ok=short>on and (r.recovery_floor is None or total>=r.recovery_floor)
        full_ok=total>full
        recovered={'fresh':fresh_ok,'full':full_ok,'either':fresh_ok or full_ok,'both':fresh_ok and full_ok}[r.mode]
        recovered=recovered and (r.participation is None or participation>=r.participation)
        before=self.allowed;reason='hold'
        if not fresh: self.allowed=False;reason='stale_or_warmup'
        elif self.allowed and (total<off or (r.fresh_brake is not None and short<r.fresh_brake)):
            self.allowed=False;reason='score_brake'
        elif not self.allowed and changed and hi-self.pause_index>=r.new_outcomes and recovered:
            self.allowed=True;reason='fresh_recovery' if r.mode=='fresh' else 'recovery'
        if before and not self.allowed:self.pause_index=hi
        self.last_at=at
        self.last=dict(allow=self.allowed,score20=total,fresh_sum=short,fresh=fresh,reason=reason,evidence=hi,participation=participation,new_outcomes=hi-self.pause_index)
        if before!=self.allowed:self.transitions.append(dict(at=at,**self.last))
        return self.last

STEPS={'n':1,'m':1,'off':.25,'fresh_on':.25,'full_on':.25,'age_min':15,'fresh_brake':.25,'recovery_floor':.25,'win_cap':.25,'new_outcomes':1,'half_life':15}
BOUNDS={'n':(10,40),'m':(3,15),'off':(-2,.5),'fresh_on':(.5,2),'full_on':(1,3),'age_min':(30,180),'fresh_brake':(-1,0),'recovery_floor':(-1,1),'win_cap':(.5,2),'new_outcomes':(1,4),'half_life':(15,60)}
EXPANDED={**BOUNDS,'n':(5,60),'m':(2,20),'off':(-3,1),'fresh_on':(.25,3),'full_on':(.5,4),'age_min':(15,240)}
def neighbors(rule,expand=False):
    bounds=EXPANDED if expand else BOUNDS
    edits=[]
    for field,step in STEPS.items():
        if getattr(rule,field) is None or (field=='half_life' and rule.weighting!='exponential'):continue
        fresh_sensitive=rule.mode!='full' or rule.fresh_brake is not None or rule.participation is not None
        if (field=='m' and not fresh_sensitive) or (field=='fresh_on' and rule.mode=='full') or (field=='full_on' and rule.mode=='fresh'):continue
        values=[getattr(rule,field)-step,getattr(rule,field)+step]
        if expand and getattr(rule,field)==BOUNDS[field][0]:
            values += [bounds[field][0]+i*step for i in range(round((BOUNDS[field][0]-bounds[field][0])/step))]
        if expand and getattr(rule,field)==BOUNDS[field][1]:
            values += [BOUNDS[field][1]+i*step for i in range(1,round((bounds[field][1]-BOUNDS[field][1])/step)+1)]
        for value in sorted(set(values)):
            if bounds[field][0]<=value<=bounds[field][1]:edits.append((field,value))
    emitted=set()
    for changes in [*((x,) for x in edits),*combinations(edits,2)]:
        if len({k for k,v in changes})!=len(changes):continue
        candidate=replace(rule,**dict(changes))
        if candidate.mode=='full' and candidate.fresh_brake is None and candidate.participation is None:candidate=replace(candidate,m=candidate.n)
        if candidate.m<=candidate.n and candidate.name not in emitted:
            emitted.add(candidate.name);yield candidate
