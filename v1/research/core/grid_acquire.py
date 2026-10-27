"""Reuse immutable paths and acquire the remaining screened September population."""
from pathlib import Path
import argparse,json
from .data import read_json,write_json,write_artifact,digest,prepare,Cache,HOUR

def run(root):
 root=Path(root);raw=read_json(root/'snapshot.json.gz')
 old=read_json(Path('data/research/20260911-long-history-input/dataset.json'))
 tail=read_json(root/'tail/dataset.json')
 start=1788220800000-7*HOUR
 old_tokens={x['token'].lower() for x in old['launches']}
 wanted={f['token'].lower():f for f in raw['bot_launches'] if (f.get('launched_at') or 0)*1000>=start and (f.get('launched_at') or 0)*1000<raw['snapshot_at'] and f.get('curve') and f.get('block') and (f.get('passed') or f['token'].lower() in old_tokens)}
 known={t for source in (old,tail) for t,logs in source['paths'].items() if source['params'].get(t) and source['path_coverage'].get(t,{}).get('all_topics') and all(l['blockNumber'] in source['blocks'] for l in logs)}
 missing=[f for t,f in wanted.items() if t not in known]
 subset=root/'missing-snapshot.json'
 if not subset.exists():write_json(subset,{**raw,'bot_launches':missing})
 if not (root/'missing/dataset.json').exists():
  prepare(subset,root/'missing',Path('data/research/cache.sqlite'),fetch=True,days=12,scope='opportunities',immutable_latest=True,population='screened',since_ms=1788220800000)
 extra=read_json(root/'missing/dataset.json')
 d={**old,**{k:v for k,v in tail.items() if k not in ('paths','params','path_coverage','blocks','receipts','parameter_sources')}}
 conflicts=[]
 for k in ('paths','params','path_coverage','blocks','receipts','parameter_sources'):
  d[k]={}
  for source in (old,tail,extra):
   for t,v in source[k].items():
    prev=d[k].get(t)
    if prev and v and k=='params' and prev!=v:conflicts.append((k,t))
    if prev and v and k=='blocks' and any(prev.get(a)!=v.get(a) for a in ('hash','timestamp')):conflicts.append((k,t))
    if v is not None:d[k][t]=v
 if conflicts:raise ValueError(f'Conflicting immutable evidence: {conflicts[:5]}')
 d.update(source=str((root/'snapshot.json.gz').resolve()),snapshot_at=raw['snapshot_at'],launches=list(wanted.values()),population='screened',positions=[p for p in raw['bot_positions'] if p.get('live') and (p.get('exit_at') or raw['snapshot_at'])>=1788220800000],observations=raw['gate_obs'])
 # Verify a header at every source-range end; absence is unavailable coverage.
 ids=sorted({hex(c['to']) for t,c in d['path_coverage'].items() if t in wanted}-set(d['blocks']))
 with Cache('data/research/cache.sqlite',True) as cache:
  for i in range(0,len(ids),100):
   batch=ids[i:i+100]
   for block,r in zip(batch,cache.many([('eth_getBlockByNumber',[b,False]) for b in batch])):
    if r:d['blocks'][block]=dict(hash=r['hash'],timestamp=int(r['timestamp'],16))
   print('coverage headers',min(i+100,len(ids)),'/',len(ids),flush=True)
 if (root/'dataset.json').exists():raise ValueError('immutable dataset already exists')
 write_artifact(root/'dataset.json',d)
 write_json(root/'manifest.json',dict(dataset_sha256=digest(root/'dataset.json'),snapshot_sha256=digest(root/'snapshot.json.gz'),launches=len(wanted),missing_historical=len(missing),conflicts=conflicts,sources={str(p):digest(p) for p in [Path('data/research/20260911-long-history-input/dataset.json'),root/'tail/dataset.json',root/'missing/dataset.json']}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',default='data/research/20260912-grid');run(p.parse_args().root)
