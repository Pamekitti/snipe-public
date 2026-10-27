"""Trace execution errors and isolate preceding-delay substitutions, offline.

Uses the existing shared TypeScript engine. No outcome offsets or live defaults.
Prepare freezes candidates before prediction. Missing preceding clocks stay missing.
"""
import argparse
import collections
import copy
import datetime as dt
import json
from pathlib import Path
import shutil
import time

from .expanded_sample import read, write
from .execution import describe
from .shared_execution import execute_batch
from .unified_fidelity import BOT, matched_score, read_database, sha

REFERENCE = 'q5000-rank0.5-sell1200-after'
VARIANTS = ('fixed', 'sell-p50', 'adoption-p50', 'both-p50', 'both-p90')


def timing_samples(positions, marks):
    samples, missing = [], []
    for p in positions:
        mm = marks.get(p['id'], [])
        triggers = [m for m in mm if m['reason']]
        if not (p['closed'] and p['buy_ok'] and p['exit_reason'] not in ('buy-reverted', 'buy-never-mined')):
            continue
        if not (mm and triggers and p['exit_at'] and p['updated_at'] and p['t_sent']):
            missing.append(dict(id=p['id'], reason='missing_marks_or_durable_clock'))
            continue
        adoption = (p['t_confirmed'] or mm[0]['at']) - p['t_sent']
        sell = p['exit_at'] - triggers[0]['at']
        if min(adoption, sell) < 0:
            missing.append(dict(id=p['id'], reason='inconsistent_clock'))
            continue
        samples.append(dict(id=p['id'], completedAt=p['exit_at'], availableAt=p['updated_at'],
            sendMs=0, confirmationMs=adoption, sellMs=sell, observationMs=0,
            adoptionSource='confirmation' if p['t_confirmed'] else 'first_mark_upper_bound',
            sellSource='first_recorded_trigger_to_recorded_exit'))
    return samples, missing


def preceding(samples, at):
    cutoff = at - 21600000
    return sorted((s for s in samples if s['completedAt'] < cutoff and s['availableAt'] < cutoff),
                  key=lambda s: (s['completedAt'], s['id']), reverse=True)[:100]


def substitute(request, variant, order, timing):
    q = copy.deepcopy(request)
    q['timing']['sameTimeOrder'] = order
    q['timing']['label'] = variant + '-' + order
    if variant != 'fixed':
        q['timing']['n'] = timing['n']
        q['timing']['fitThrough'] = timing['fitThrough']
        if variant.startswith('sell') or variant.startswith('both'):
            q['timing']['sellMs'] = timing['sellMs']
        if variant.startswith('adoption') or variant.startswith('both'):
            q['timing']['confirmationMs'] = timing['confirmationMs']
    # Observation latency is not identifiable from first marks. Do not relabel
    # adoption as observation latency, or change any other execution component.
    return q


def prepare(root, base, database):
    root.mkdir(parents=True, exist_ok=True)
    if (root/'freeze.json').exists():
        raise ValueError('already frozen; use run or a new directory')
    protocol = read(base/'protocol.json')
    db = read_database(database)
    positions = [dict(p) for p in db.execute('SELECT * FROM positions WHERE live=1')]
    marks = collections.defaultdict(list)
    for m in db.execute('SELECT * FROM trade_marks ORDER BY at'):
        marks[m['position_id']].append(dict(m))
    db.close()
    samples, missing_samples = timing_samples(positions, marks)
    requests = read(base/'requests.json')
    proofs, calibration = [], []
    for q in requests:
        prior = preceding(samples, q['entryAt'])
        proofs.append(dict(id=q['id'], n=len(prior), ids=[s['id'] for s in prior],
                           cutoff=q['entryAt']-21600000, supported=len(prior)>=20))
        calibration.append(dict(samples=prior, frozenAt=q['entryAt'], evaluationEnd=q['entryAt']))
    timings = execute_batch('calibrate-many', requests=calibration)
    candidates = {}
    for variant in VARIANTS:
        for order in ('before', 'after'):
            name = variant + '-' + order
            qq = []
            for q, proof, tt in zip(requests, proofs, timings):
                if not proof['supported']:
                    qq.append(None)
                    continue
                target = 'preceding-p90' if variant == 'both-p90' else 'preceding-p50'
                timing = next(t for t in tt if t['label'] == target)
                qq.append(substitute(q, variant, order, timing))
            candidates[name] = qq
    write(root/'timing-evidence.json', dict(samples=samples, missingSamples=missing_samples, fitProofs=proofs))
    write(root/'candidate-requests.json', candidates)
    write(root/'protocol.json', dict(fromUtc=protocol['fromUtc'], throughUtc=protocol['throughUtc'],
        purpose='Component ablation of sell and adoption timing; not a policy search or default selection',
        variants=list(VARIANTS), orders=['before', 'after'], precedingCount=100, minimumCount=20,
        embargoHours=6, adoption='recorded confirmation or first-mark upper bound',
        sell='recorded close minus first recorded exit trigger; includes unseparated receipt lag',
        observation='fixed 600 ms; adoption is not evidence of feed delay',
        unchanged='recorded send, stake, target, limits; inclusion 300 ms, buy rank 0.5, all costs and rules',
        selection='No default promotion without cross-period and new-observation evidence. No outcome offset.',
        retrospective=True, prospectiveValidation=False, liveChanges=False))
    names=['research/core/execution_discrepancies.py', 'research/core/shared_execution.py',
           'research/core/unified_fidelity.py', 'research/core/execution.py', 'research/core/fidelity.py']
    source_hashes={n:sha(BOT/n) for n in names}
    baseline_files=['requests.json', 'rows.json', 'excluded.json', 'run-freeze.json', 'protocol.json',
                    'results/'+REFERENCE+'.json', 'results/q5000-rank0.5-sell1200-before.json']
    identity=execute_batch('identity')
    if identity['modelHash'] != read(base/'run-freeze.json')['modelHash']:
        raise ValueError('model differs from baseline')
    write(root/'freeze.json', dict(base=str(base), database=str(database), databaseHash=sha(database),
        modelHash=identity['modelHash'], sources=source_hashes,
        baseline={n:sha(base/n) for n in baseline_files},
        inputs={n:sha(root/n) for n in ['protocol.json','timing-evidence.json','candidate-requests.json']}))
    for n in names:
        target=root/'objects'/n
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BOT/n, target)
    return dict(attempts=len(requests), samples=len(samples), supported=sum(p['supported'] for p in proofs))


def verify(root):
    f=read(root/'freeze.json')
    for directory, hashes in [(root, f['inputs']), (Path(f['base']), f['baseline']), (BOT, f['sources'])]:
        for name, expected in hashes.items():
            if sha(directory/name) != expected:
                raise ValueError('hash changed: '+name)
    if sha(f['database']) != f['databaseHash'] or execute_batch('identity')['modelHash'] != f['modelHash']:
        raise ValueError('database or shared model changed')
    return f


def score(rows, values):
    result=matched_score(rows, values)
    pairs=[(r,v) for r,v in zip(rows,values) if v.get('pnlWei') is not None and v.get('exitAt') is not None]
    result['falseLosers']=[r['id'] for r,v in pairs if int(r['actualWei'])>0>int(v['pnlWei'])]
    result['falseProfitsOnZero']=[r['id'] for r,v in pairs if int(r['actualWei'])==0<int(v['pnlWei'])]
    result['reproductionKpis']={key:100*result['predicted'][key]/result['actual'][key] if result['actual'][key] else None
                              for key in ('winners','losers')}
    for key in ('profit_wei','loss_wei'):
        result['reproductionKpis'][key]=100*int(result['predicted'][key])/int(result['actual'][key]) if int(result['actual'][key]) else None
    return result


def run(root):
    f=verify(root); base=Path(f['base']); started=time.monotonic()
    candidates=read(root/'candidate-requests.json'); rows=read(base/'rows.json')
    results={}; parity=[]
    for job,(name,qq) in enumerate(candidates.items()):
        values=[]
        for start in range(0,len(qq),100):
            batch=qq[start:start+100]
            computed=iter(execute_batch('predict', requests=[q for q in batch if q]))
            values.extend(next(computed) if q else dict(status='unavailable',reason='fewer_than_20_preceding_timing_samples',pnlWei=None,exitAt=None) for q in batch)
            write(root/'progress.json',dict(stage='predict',completedJobs=job,totalJobs=len(candidates),
                completedRows=start+len(batch),totalRows=len(qq),elapsedSeconds=time.monotonic()-started,
                heartbeat=dt.datetime.now(dt.timezone.utc).isoformat()))
        results[name]=values
        if name.startswith('fixed'):
            order=name.split('-')[-1]
            old=read(base/f'results/q5000-rank0.5-sell1200-{order}.json')['results']
            for q,a,b in zip(qq,values,old):
                if q:
                    a=dict(a);b=dict(b);a.pop('scenario');b.pop('scenario')
                    parity.append(a==b)
    if not all(parity):raise ValueError('baseline parity failed')
    write(root/'results.json', results)
    excluded={v['id'] for v in read(base/'excluded.json')}
    common=[i for i,r in enumerate(rows) if r['id'] not in excluded and
            all(v[i].get('pnlWei') is not None and v[i].get('exitAt') is not None for v in results.values())]
    start=int(dt.datetime.fromisoformat(read(root/'protocol.json')['fromUtc'].replace('Z','+00:00')).timestamp()*1000)
    end=int(dt.datetime.fromisoformat(read(root/'protocol.json')['throughUtc'].replace('Z','+00:00')).timestamp()*1000)
    groups={'All supported':(start,end),'Before Sep8':(start,1788825600000),
            'Sep8-9':(1788825600000,1788998400000),'Sep10-13':(1788998400000,end),'Final six hours':(end-21600000,end)}
    groups.update({f'Sep{d:02}':(start+(d-1)*86400000,min(start+d*86400000,end)) for d in range(1,14)})
    groups.update({f'24h bin {i+1}':(end-86400000+i*10800000,end-86400000+(i+1)*10800000) for i in range(8)})
    groups.update({f'7d bin {i+1}':(end-7*86400000+i*86400000,end-7*86400000+(i+1)*86400000) for i in range(7)})
    cards={}
    for group,(lo,hi) in groups.items():
        indices=[i for i in common if lo<=rows[i]['entryAt']<hi]
        cards[group]={name:score([rows[i] for i in indices],[vv[i] for i in indices]) for name,vv in results.items()}
    write(root/'scorecards.json', cards)
    write(root/'coverage.json',dict(attempts=len(rows),commonIds=[rows[i]['id'] for i in common],
        missing=[dict(id=r['id'],receiptUnverified=r['id'] in excluded,
            reasons={name:vv[i]['reason'] for name,vv in results.items() if vv[i].get('pnlWei') is None})
            for i,r in enumerate(rows) if i not in common],
        beforeSep8=sum(rows[i]['entryAt']<1788825600000 for i in common),
        prospectiveObservations=0,diagnosticOnly=True))
    verify(root)
    write(root/'verification.json',dict(baselineParityChecks=len(parity),mismatches=0,common=len(common),
        uniqueIds=len({r['id'] for r in rows})==len(rows),modelHash=f['modelHash'],liveChanges=False))
    return dict(common=len(common),baselineParity=len(parity),elapsedSeconds=time.monotonic()-started)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('stage',choices=['prepare','run']);p.add_argument('--root',required=True)
    p.add_argument('--base');p.add_argument('--database');a=p.parse_args();root=Path(a.root).resolve()
    print(json.dumps(prepare(root,Path(a.base).resolve(),Path(a.database).resolve()) if a.stage=='prepare' else run(root)))
