"""One predeclared execution-clock correction, using frozen historical evidence."""
import collections
import copy
import datetime as dt
import json
from pathlib import Path
import time

from .shared_execution import execute_batch
from .unified_fidelity import matched_score,read_database,sha
from .expanded_sample import read,write,integer
from .execution import describe

BOT=Path(__file__).resolve().parents[2]


def inclusion_interval(sent,block_at,adopted):
    """Chain time has one-second resolution; observed adoption bounds inclusion."""
    if not all(isinstance(v,(int,float)) for v in (sent,block_at,adopted)):
        return None
    lo=max(0,block_at-sent);hi=min(block_at+1000-sent,adopted-sent)
    if hi<lo:return None
    return {'lower':lo,'midpoint':(lo+hi)/2,'upper':hi}


def prior_samples(samples,at):
    cutoff=at-21600000
    return sorted((s for s in samples if s['completedAt']<cutoff and s['availableAt']<cutoff),
                  key=lambda s:(s['completedAt'],s['id']),reverse=True)[:100]


def run(root):
    root=Path(root).resolve();protocol=read(root/'protocol.json');base=Path(protocol['baselineRoot'])
    for name,expected in protocol['inputs'].items():
        if sha(base/name)!=expected:raise ValueError('baseline changed: '+name)
    started=time.monotonic();identity=execute_batch('identity');write(root/'model.json',identity)
    def progress(stage,n=0,total=1):
        write(root/'progress.json',dict(stage=stage,completed=n,total=total,elapsedSeconds=time.monotonic()-started,heartbeat=int(time.time()*1000),liveChanges=False))
    rows=read(base/'rows.json');bundles=read(base/'scenario-bundles.json');manifest=read(base/'run-manifest.json')
    db=read_database(manifest['inputs']['bot']['path']);positions={r['id']:dict(r) for r in db.execute('SELECT * FROM positions WHERE live=1')}
    first_marks={r['position_id']:r['at'] for r in db.execute('SELECT position_id,min(at) at FROM trade_marks GROUP BY position_id')}
    prepared=base.parent;jobs=read(prepared/'source-jobs.json');samples=[];missing_samples=[]
    for job in jobs:
        p=positions[job['id']]
        if not p['closed'] or not p['buy_ok'] or p['exit_reason'] in ('buy-reverted','buy-never-mined'):continue
        if not p['updated_at'] or not p['t_sent'] or not p['exit_at']:
            missing_samples.append(dict(id=p['id'],reason='missing_durable_clock'));continue
        verified=read(prepared/'verified'/f"{p['id']}.json")
        logs=verified.get('logs',verified.get('request',{}).get('logs',[]))
        own=[l for l in logs if l['transactionHash'].lower()==(p['buy_hash'] or '').lower()]
        times={integer(verified['headers'][l['blockNumber']]['timestamp'])*1000 if 'headers' in verified else l['at'] for l in own}
        if len(times)!=1:
            missing_samples.append(dict(id=p['id'],reason='missing_unique_inclusion_block'));continue
        block_at=next(iter(times));adopted=p['t_confirmed'] or first_marks.get(p['id'])
        bounds=inclusion_interval(p['t_sent'],block_at,adopted)
        if bounds is None:
            missing_samples.append(dict(id=p['id'],reason='inconsistent_inclusion_and_adoption_clocks'));continue
        samples.append(dict(id=p['id'],completedAt=p['exit_at'],availableAt=p['updated_at'],sentAt=p['t_sent'],
                            blockAt=block_at,adoptedAt=adopted,adoptionSource='confirmed' if p['t_confirmed'] else 'first_mark_upper_bound',**bounds))
    write(root/'calibration-evidence.json',dict(samples=samples,unavailable=missing_samples))
    old_requests=[s['request'] for b in bundles for s in b['scenarios']]
    old_expected=[s['result'] for b in bundles for s in b['scenarios']]
    progress('baseline_parity',0,len(old_requests));old_actual=execute_batch('predict',requests=old_requests)
    mismatches=[i for i,(a,b) in enumerate(zip(old_actual,old_expected)) if a!=b]
    write(root/'baseline-parity.json',dict(checks=len(old_requests),mismatches=mismatches))
    if mismatches:raise ValueError('historical default behavior changed')
    variants={};fit_proofs=[];unavailable=[]
    for i,(row,bundle) in enumerate(zip(rows,bundles)):
        prior=prior_samples(samples,row['entryAt'])
        fit_proofs.append(dict(id=row['id'],fitThrough=row['entryAt']-21600000,ids=[s['id'] for s in prior],n=len(prior)))
        if len(prior)<20:unavailable.append(dict(id=row['id'],reason='fewer_than_20_inclusion_samples'))
        for bound in ('lower','midpoint','upper'):
            for scenario in bundle['scenarios']:
                name=bound+':'+scenario['id'];variants.setdefault(name,[])
                if len(prior)<20:
                    variants[name].append(None);continue
                percentile=int(scenario['id'].split('-')[0][1:])/100
                values=sorted(s[bound] for s in prior);delay=values[int((len(values)-1)*percentile)]
                q=copy.deepcopy(scenario['request']);q['timing']['buyInclusionMs']=delay
                q['timing']['label']='inclusion-v1:'+name
                variants[name].append(q)
    write(root/'fit-proofs.json',dict(rows=fit_proofs,unavailable=unavailable))
    # Freeze every candidate and its input hashes before computing corrected outcomes.
    frozen={name:[{'id':rows[i]['id'],'delayMs':q['timing']['buyInclusionMs'],'inputSha256':__import__('hashlib').sha256(json.dumps(q,sort_keys=True).encode()).hexdigest()} if q else None for i,q in enumerate(qq)] for name,qq in variants.items()}
    write(root/'candidates.json',frozen)
    source_names=['src/strategy/counterfactual.ts','src/strategy/execution-model.ts','research/core/inclusion_study.py']
    sources={name:sha(BOT/name) for name in source_names};write(root/'source-hashes.json',sources)
    results={}
    for n,(name,requests) in enumerate(variants.items()):
        progress('corrected_predictions',n,len(variants))
        predicted=iter(execute_batch('predict',requests=[q for q in requests if q]))
        results[name]=[next(predicted) if q else dict(status='unavailable',reason='missing_inclusion_calibration',pnlWei=None,exitAt=None) for q in requests]
    end=manifest['through'];groups={
        'all':list(range(len(rows))),
        'development_sep8_9':[i for i,r in enumerate(rows) if r['entryAt']<1788998400000],
        'evaluation_sep10_on':[i for i,r in enumerate(rows) if r['entryAt']>=1788998400000],
        'final_six_hours':[i for i,r in enumerate(rows) if r['entryAt']>=end-21600000]}
    for i,row in enumerate(rows):groups.setdefault('day:'+dt.datetime.fromtimestamp(row['entryAt']/1000,dt.timezone.utc).date().isoformat(),[]).append(i)
    scorecards={}
    for group,indices in groups.items():
        scorecards[group]={}
        for name,predictions in results.items():
            k=next(k for k,s in enumerate(bundles[0]['scenarios']) if s['id']==name.split(':')[1])
            common=[i for i in indices if predictions[i].get('pnlWei') is not None and predictions[i].get('exitAt') is not None and bundles[i]['scenarios'][k]['result'].get('pnlWei') is not None]
            selected=[rows[i] for i in common]
            scorecards[group][name]=dict(expected=len(indices),common=len(common),
                missingReasons=dict(collections.Counter(predictions[i]['reason'] for i in indices if i not in common)),
                baseline=matched_score(selected,[bundles[i]['scenarios'][k]['result'] for i in common]),
                corrected=matched_score(selected,[predictions[i] for i in common]))
    summary=dict(modelHash=identity['modelHash'],baselineHash=manifest['modelHash'],attempts=len(rows),actualPopulation=1190,calibrationSamples=len(samples),missingCalibration=len(unavailable),
        inclusionIntervals={b:describe(s[b] for s in samples) for b in ('lower','midpoint','upper')},scorecards=scorecards,
        diagnosticOnly=True,liveChanges=False,thresholdFitting=False)
    write(root/'results.json',results);write(root/'scorecards.json',summary)
    for name,expected in sources.items():
        if sha(BOT/name)!=expected:raise ValueError('source changed during experiment')
    if execute_batch('identity')!=identity:raise ValueError('engine changed during experiment')
    for name in source_names:
        target=root/'objects'/name;target.parent.mkdir(parents=True,exist_ok=True);__import__('shutil').copy2(BOT/name,target)
    progress('scoring_complete',len(variants),len(variants));db.close()
    return summary


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);args=parser.parse_args()
    result=run(args.root);print(json.dumps({k:v for k,v in result.items() if k!='scorecards'}))
