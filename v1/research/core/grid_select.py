"""Training-only Pareto selection and one-coordinate neighborhood refinement."""
import argparse
from dataclasses import asdict, replace
from pathlib import Path
from .data import read_json, write_json, digest
from .grid_guard import GridRule
from .grid_jobs import SCENARIOS, FIT_END
from .grid_scorecards import collect


def frontier(rows):
    # Minimize all coordinates. Keep ties so a training tie cannot choose a future policy.
    groups={}
    for key, value in rows.items():
        vector=(-value['worst_net_wei'],value['worst_dd_wei'],value['worst_recovery_loss_wei'],value['worst_losing_recoveries'])
        groups.setdefault(vector,[]).append(key)
    kept=[]
    for vector,keys in sorted(groups.items()):
        if any(all(a<=b for a,b in zip(other,vector)) for other,_ in kept):continue
        kept.append((vector,keys))
    return [key for _,keys in kept for key in keys]


def neighbors(rule):
    steps={'n':2,'m':1,'off':.25,'fresh_on':.25,'full_on':.5,'age_min':15}
    bounds={'n':(10,40),'m':(3,15),'off':(-2,-.5),'fresh_on':(.5,2),'full_on':(1,3),'age_min':(30,180)}
    for field,step in steps.items():
        if field in ('m','fresh_on') and rule.mode=='full':continue
        if field=='full_on' and rule.mode=='fresh':continue
        for sign in (-1,1):
            value=getattr(rule,field)+sign*step
            if not bounds[field][0]<=value<=bounds[field][1]:continue
            candidate=replace(rule,**{field:value})
            if candidate.mode=='full':candidate=replace(candidate,m=candidate.n)
            if candidate.m<=candidate.n:yield candidate


def select(root,phase):
    root=Path(root);done=read_json(root/phase/'completed.json')
    if done['plan_sha256']!=digest(root/phase/'jobs.json'):raise ValueError('Training job manifest mismatch')
    jobs=read_json(root/phase/'jobs.json')['jobs']
    by_exit={};sources={}
    for job in jobs:
        path=Path(job['output']);design=read_json(path/'design.json')
        if design['end']!=FIT_END:raise ValueError('Selection cannot read validation or reserved outcomes')
        score=collect(path)
        sources[str(path)]=score['design_sha256']
        write_json(path/'scorecards.json',score)
        by_exit.setdefault(job['exit'],{})[(job['mode'],job['variant'])]=score
    rows={}
    for exit_name,scenarios in by_exit.items():
        if set(scenarios)!=set(SCENARIOS):raise ValueError('All six training scenarios are required')
        names=set.intersection(*(set(score['cards']) for score in scenarios.values()))
        for name in sorted(names):
            cards=[scenarios[s]['cards'][name] for s in SCENARIOS]
            if not all(c['complete'] and scenarios[s]['reference_complete'] for c,s in zip(cards,SCENARIOS)):continue
            if not any(c['metrics']['winners']+c['metrics']['losers'] for c in cards):continue
            key=exit_name+'::'+name
            rows[key]=dict(exit=exit_name,rule=cards[0]['rule'],worst_net_wei=min(int(c['metrics']['net_wei']) for c in cards),
                           worst_dd_wei=max(int(c['metrics']['drawdown_wei']) for c in cards),
                           worst_recovery_loss_wei=max(int(c['recovery_loss_wei']) for c in cards),
                           worst_losing_recoveries=max(c['losing_recoveries'] for c in cards),
                           scenarios={mode+'--'+variant:scenarios[(mode,variant)]['cards'][name] for mode,variant in SCENARIOS})
    selected=frontier(rows)
    artifact=dict(fit_end=FIT_END,phase=phase,sources=sources,frontier=selected,candidates={key:rows[key] for key in selected},
                  method='Pareto frontier of worst net, worst cumulative drawdown, worst losing-recovery cash and count across six training scenarios. No weighted score. Zero-trade candidates excluded. Ties retained.',
                  selection_source_sha256=digest(Path(__file__)))
    target=root/(phase+'-selection.json')
    if target.exists() and read_json(target)!=artifact:raise ValueError('Frozen selection changed')
    write_json(target,artifact)
    if phase=='joint_coarse':
        rules={}
        for key in selected:
            item=rows[key];rule=GridRule(**item['rule'])
            bucket=rules.setdefault(item['exit'],{})
            for r in [rule,*neighbors(rule),GridRule()]:bucket[r.name]=asdict(r)
        write_json(root/'refinement-rules.json',{name:list(values.values()) for name,values in rules.items()})
    print('Training frontier',len(selected),'of',len(rows),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',default='data/research/20260912-grid');parser.add_argument('--phase',choices=['joint_coarse','refinement'],required=True)
    args=parser.parse_args();select(args.root,args.phase)
