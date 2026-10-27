"""Separate preceding sell inclusion bounds from recorded close/receipt delay.

Bounds come from verified one-second chain stamps and the local exit trigger.
Current-attempt execution records are never supplied to its prediction.
"""
import argparse
import collections
import copy
import json
from pathlib import Path
import shutil

from .execution_discrepancies import preceding, run, timing_samples, REFERENCE
from .expanded_sample import read, write
from .inclusion_study import inclusion_interval
from .shared_execution import execute_batch
from .unified_fidelity import BOT, read_database, sha


def sell_sample(p, marks, request):
    triggers = [m for m in marks if m['reason']]
    own = [l for l in request['logs'] if l['transactionHash'].lower() == (p['exit_hash'] or '').lower()]
    times = {l['at'] for l in own}
    if not triggers or len(times) != 1:
        return None
    bounds = inclusion_interval(triggers[0]['at'], next(iter(times)), p['exit_at'])
    if bounds is None:
        return None
    return dict(id=p['id'], completedAt=p['exit_at'], availableAt=p['updated_at'],
        triggerAt=triggers[0]['at'], blockAt=next(iter(times)), **bounds)


def prepare(root, base, database):
    root.mkdir(parents=True, exist_ok=False)
    db = read_database(database)
    ps = [dict(p) for p in db.execute('SELECT * FROM positions WHERE live=1')]
    mm = collections.defaultdict(list)
    for m in db.execute('SELECT * FROM trade_marks ORDER BY at'):
        mm[m['position_id']].append(dict(m))
    db.close()
    qq=read(base/'requests.json'); byid={int(q['id']):q for q in qq}; positions={p['id']:p for p in ps}
    valid,_=timing_samples(ps,mm)
    samples=[];missing=[]
    for raw in valid:
        p=positions[raw['id']]
        s=sell_sample(p,mm[p['id']],byid[p['id']]) if p['id'] in byid else None
        if s:samples.append(s)
        else:missing.append(dict(id=p['id'],reason='missing_or_inconsistent_sell_inclusion_bounds'))
    fit=[preceding(samples,q['entryAt']) for q in qq]
    proofs=[dict(id=q['id'],n=len(prior),ids=[s['id'] for s in prior],cutoff=q['entryAt']-21600000,
                 supported=len(prior)>=20) for q,prior in zip(qq,fit)]
    calibrations=[]
    for bound in ('lower','midpoint','upper'):
        for q,prior in zip(qq,fit):
            calibrations.append(dict(samples=[dict(completedAt=s['completedAt'],availableAt=s['availableAt'],
                sendMs=0,confirmationMs=600,observationMs=600,sellMs=s[bound]) for s in prior],
                frozenAt=q['entryAt'],evaluationEnd=q['entryAt']))
    all_timings=execute_batch('calibrate-many',requests=calibrations)
    candidates={}
    for j,bound in enumerate(('fixed','lower','midpoint','upper')):
        for order in ('before','after'):
            name=('fixed' if bound=='fixed' else 'inclusion-'+bound)+'-'+order
            vv=[]
            for i,(q,proof) in enumerate(zip(qq,proofs)):
                if not proof['supported']:vv.append(None);continue
                q=copy.deepcopy(q);q['timing']['label']=name;q['timing']['sameTimeOrder']=order
                if bound!='fixed':
                    timing=next(t for t in all_timings[(j-1)*len(qq)+i] if t['label']=='preceding-p50')
                    q['timing'].update(sellMs=timing['sellMs'],n=timing['n'],fitThrough=timing['fitThrough'])
                vv.append(q)
            candidates[name]=vv
    write(root/'candidate-requests.json',candidates)
    write(root/'timing-evidence.json',dict(samples=samples,missingSamples=missing,fitProofs=proofs))
    p=read(base/'protocol.json')
    write(root/'protocol.json',dict(fromUtc=p['fromUtc'],throughUtc=p['throughUtc'],
        purpose='Test sell execution clocks separately from receipt/close clocks',
        variants=['fixed','inclusion-lower','inclusion-midpoint','inclusion-upper'],orders=['before','after'],
        sample='last 100 successful closes with valid marks, durable availability and verified sell block stamps; minimum 20',
        embargoHours=6,formula='lower=max(0, blockStamp-trigger); upper=min(blockStamp+1000-trigger, recordedClose-trigger); midpoint=(lower+upper)/2',
        selection='Use preceding median of each bound; midpoint is the declared central hypothesis, endpoints are stresses. No best-fit selection.',
        unchanged='all other fixed-reference timing, buy order, costs, rules, target and stake',
        limitations='Chain stamps bound inclusion but do not identify exact execution time. Missing clocks stay missing. No new outcomes.',
        retrospective=True,prospectiveValidation=False,liveChanges=False))
    names=['research/core/sell_clock_study.py','research/core/execution_discrepancies.py','research/core/inclusion_study.py',
           'research/core/shared_execution.py','research/core/unified_fidelity.py','research/core/execution.py','research/core/fidelity.py']
    basefiles=['requests.json','rows.json','excluded.json','run-freeze.json','protocol.json',
               'results/'+REFERENCE+'.json','results/q5000-rank0.5-sell1200-before.json']
    identity=execute_batch('identity')
    if identity['modelHash']!=read(base/'run-freeze.json')['modelHash']:raise ValueError('model changed')
    write(root/'freeze.json',dict(base=str(base),database=str(database),databaseHash=sha(database),
        modelHash=identity['modelHash'],sources={n:sha(BOT/n) for n in names},baseline={n:sha(base/n) for n in basefiles},
        inputs={n:sha(root/n) for n in ['protocol.json','timing-evidence.json','candidate-requests.json']}))
    for n in names:
        target=root/'objects'/n;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(BOT/n,target)
    return dict(samples=len(samples),supported=sum(p['supported'] for p in proofs),missingSampleBounds=len(missing))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('stage',choices=['prepare','run']);p.add_argument('--root',required=True)
    p.add_argument('--base');p.add_argument('--database');a=p.parse_args();root=Path(a.root).resolve()
    print(json.dumps(prepare(root,Path(a.base).resolve(),Path(a.database).resolve()) if a.stage=='prepare' else run(root)))
