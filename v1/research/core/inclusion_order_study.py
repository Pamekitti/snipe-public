"""A predeclared empirical insertion-rank test, using the same execution kernel."""
import copy
import json
from pathlib import Path
from .inclusion_study import prior_samples
from .expanded_sample import read,write,integer
from .shared_execution import execute_batch
from .unified_fidelity import read_database,matched_score,sha


def rank_before_order(logs,own_hash,wallet,block_at):
    order=lambda l:(integer(l['blockNumber']),integer(l.get('transactionIndex',l.get('order',{}).get('transaction',0))))
    own=[l for l in logs if l['transactionHash'].lower()==own_hash.lower()]
    if not own:return None
    key=order(own[0]);address=wallet.lower().replace('0x','')
    bucket={order(l) for l in logs if l['at']==block_at and l['transactionHash'].lower()!=own_hash.lower() and not any(t[-40:].lower()==address for t in l['topics'][1:3])}
    if not bucket:return None
    return sum(order_key<key for order_key in bucket)/len(bucket)


def run(root):
    root=Path(root).resolve();protocol=read(root/'protocol.json');base=Path(protocol['baselineRoot']);rows=read(base/'rows.json');bundles=read(base/'scenario-bundles.json')
    manifest=read(base/'run-manifest.json');db=read_database(manifest['inputs']['bot']['path']);positions={p['id']:dict(p) for p in db.execute('select * from positions where live=1')}
    wallet=bundles[0]['scenarios'][0]['request']['wallet'];samples=[];missing=[]
    for sample in read(root/'calibration-evidence.json')['samples']:
        v=read(base.parent/'verified'/f"{sample['id']}.json")
        logs=v.get('logs',v.get('request',{}).get('logs',[]))
        logs=[dict(l,at=integer(v['headers'][l['blockNumber']]['timestamp'])*1000 if 'headers' in v else l['at']) for l in logs]
        rank=rank_before_order(logs,positions[sample['id']]['buy_hash'],wallet,sample['blockAt'])
        if rank is None:missing.append(sample['id']);continue
        samples.append(dict(sample,rank=rank))
    fit=[];variants={};candidate_inputs={}
    for row,bundle in zip(rows,bundles):
        prior=prior_samples(samples,row['entryAt']);fit.append(dict(id=row['id'],ids=[s['id'] for s in prior],n=len(prior),fitThrough=row['entryAt']-21600000))
        for s in bundle['scenarios']:
            name=s['id'];variants.setdefault(name,[]);candidate_inputs.setdefault(name,[])
            if len(prior)<20:variants[name].append(None);candidate_inputs[name].append(None);continue
            quantile=int(name.split('-')[0][1:])/100;index=int((len(prior)-1)*quantile)
            rank=sorted(p['rank'] for p in prior)[index];delay=sorted(p['midpoint'] for p in prior)[index]
            q=copy.deepcopy(s['request']);q['timing'].update(buyInclusionMs=delay,buyOrderFraction=rank,label='empirical-insertion-v1:'+name)
            variants[name].append(q);candidate_inputs[name].append(dict(id=row['id'],inclusionMs=delay,orderFraction=rank))
    out=root/'order-atomic';out.mkdir(exist_ok=False)
    write(out/'calibration.json',dict(samples=samples,missingBucketIds=missing,fit=fit));write(out/'candidates.json',candidate_inputs)
    identity=execute_batch('identity');write(out/'model.json',identity)
    write(out/'source-hashes.json',{n:sha(Path(__file__).resolve().parents[2]/n) for n in ['src/strategy/counterfactual.ts','src/strategy/execution-model.ts','research/core/inclusion_order_study.py']})
    old_requests=[s['request'] for b in bundles for s in b['scenarios']];expected=[s['result'] for b in bundles for s in b['scenarios']]
    actual=execute_batch('predict',requests=old_requests)
    mismatches=[i for i,(a,b) in enumerate(zip(actual,expected)) if a!=b];write(out/'baseline-parity.json',dict(checks=len(expected),mismatches=mismatches))
    if mismatches:raise ValueError('baseline parity failed')
    results={}
    for name,requests in variants.items():
        predicted=iter(execute_batch('predict',requests=[q for q in requests if q]))
        results[name]=[next(predicted) if q else dict(status='unavailable',reason='missing_rank_calibration',pnlWei=None,exitAt=None) for q in requests]
    groups={'all':list(range(len(rows))),'development_sep8_9':[i for i,r in enumerate(rows) if r['entryAt']<1788998400000],
            'evaluation_sep10_on':[i for i,r in enumerate(rows) if r['entryAt']>=1788998400000],
            'final_six_hours':[i for i,r in enumerate(rows) if r['entryAt']>=manifest['through']-21600000]}
    cards={}
    for group,indices in groups.items():
        cards[group]={}
        for k,(name,predicted) in enumerate(results.items()):
            common=[i for i in indices if predicted[i].get('pnlWei') is not None and predicted[i].get('exitAt') is not None and bundles[i]['scenarios'][k]['result'].get('pnlWei') is not None]
            cards[group][name]=dict(expected=len(indices),common=len(common),
                baseline=matched_score([rows[i] for i in common],[bundles[i]['scenarios'][k]['result'] for i in common]),
                corrected=matched_score([rows[i] for i in common],[predicted[i] for i in common]))
    write(out/'results.json',results);write(out/'scorecards.json',dict(modelHash=identity['modelHash'],calibrationSamples=len(samples),scorecards=cards,diagnosticOnly=True,liveChanges=False))
    if execute_batch('identity')!=identity:raise ValueError('model changed during evaluation')
    for name,expected in read(out/'source-hashes.json').items():
        p=Path(__file__).resolve().parents[2]/name
        if sha(p)!=expected:raise ValueError('source changed')
        target=out/'objects'/name;target.parent.mkdir(parents=True,exist_ok=True);__import__('shutil').copy2(p,target)
    db.close();return cards


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);args=parser.parse_args();run(args.root)
