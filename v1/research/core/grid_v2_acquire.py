"""Merge verified prior evidence with a fresh immutable September capture."""
import argparse,os,time,re
from pathlib import Path
from .data import read_json,write_json,write_artifact,digest,prepare,Cache,HOUR
from .grid_v2_run import verify

def run(root):
 root=Path(root);m=verify(root)
 if m.get('acquisition_source'):
  source=Path(m['acquisition_source']['root'])
  print('Waiting for frozen acquisition',source,flush=True)
  while not (source/'manifest.json').exists():
   status=read_json(source/'status.json') if (source/'status.json').exists() else {}
   if status.get('state')=='failed':raise RuntimeError('Frozen acquisition failed: '+str(status.get('error')))
   progress=os.environ.get('RESEARCH_PROGRESS_PATH')
   if progress:
    value=dict(at=int(time.time()*1000),unit='waiting for immutable acquisition',source_status=status)
    log=source/'acquire/run.log'
    if log.exists():
     with log.open('rb') as stream:
      stream.seek(max(0,log.stat().st_size-16000));tail=stream.read().decode(errors='replace')
     counters=re.findall(r'(paths|fallback timestamp headers|coverage headers) (\d+)\s*/\s*(\d+)',tail)
     if counters:
      unit,done,total=counters[-1]
      value.update(completed=int(done),total=int(total),unit=unit+' only; later acquisition stages excluded',elapsed=status.get('elapsed_seconds',0),failures=(status.get('progress') or {}).get('failures',0))
    write_json(Path(progress),value)
   time.sleep(5)
  acquisition=read_json(source/'manifest.json')
  if acquisition['snapshot_sha256']!=m['snapshot_sha256'] or digest(source/'dataset.json')!=acquisition['dataset_sha256']:raise ValueError('Acquisition input identity mismatch')
  target=root/'dataset.json'
  if not target.exists():target.symlink_to((source/'dataset.json').resolve())
  write_json(root/'manifest.json',dict(acquisition,run_sha256=digest(root/'run.json'),acquisition_manifest=str(source/'manifest.json'),acquisition_manifest_sha256=digest(source/'manifest.json')))
  print('Reusing immutable acquisition with identical snapshot',flush=True)
  return
 raw=read_json(root/'snapshot.json.gz')
 sources=[Path(m['prior_dataset']),Path(m['prior_tail'])]
 datasets=[read_json(p) for p in sources]
 facts={f['token'].lower():f for f in raw['bot_launches']}
 def reusable(d,t,logs):
  c=d['path_coverage'].get(t,{})
  header=d['blocks'].get(hex(c.get('to',0)))
  f=facts.get(t,{})
  at=max(f.get('detected_at') or 0,(f.get('launched_at') or 0)*1000+2000)
  return d['params'].get(t) and c.get('all_topics') and header and header['timestamp']*1000>=at+150000 and all(l['blockNumber'] in d['blocks'] for l in logs)
 known={t for d in datasets for t,logs in d['paths'].items() if reusable(d,t,logs)}
 start=m['start']-7*HOUR
 wanted={f['token'].lower():f for f in raw['bot_launches'] if f.get('curve') and f.get('block') and start<=(f.get('launched_at') or 0)*1000<m['capture'] and (f.get('passed') or f['token'].lower() in known)}
 subset=root/'missing-snapshot.json'
 value={**raw,'bot_launches':[f for t,f in wanted.items() if t not in known]}
 if not subset.exists():write_json(subset,value)
 if not (root/'missing/manifest.json').exists():
  if (root/'missing/dataset.json').exists():raise ValueError('Partial preparation needs explicit recovery, not blind reuse')
  prepare(subset,root/'missing',Path('data/research/cache.sqlite'),fetch=True,days=(m['capture']-start)/86400000+1,scope='opportunities',immutable_latest=True,population='screened',since_ms=start)
 sources.append(root/'missing/dataset.json');datasets.append(read_json(sources[-1]))
 d=dict(datasets[-1]);conflicts=[]
 for k in ('paths','params','path_coverage','blocks','receipts','parameter_sources'):
  d[k]={}
  for source in datasets:
   for t,v in source[k].items():
    prev=d[k].get(t)
    if prev and v and k=='params' and prev!=v:conflicts.append((k,t))
    if prev and v and k=='blocks' and prev.get('timestamp')!=v.get('timestamp'):conflicts.append((k,t))
    if prev and v and k=='blocks' and prev.get('hash') and v.get('hash') and prev['hash']!=v['hash']:conflicts.append((k,t))
    if v is not None:d[k][t]=v
 if conflicts:raise ValueError('Immutable evidence conflict: '+str(conflicts[:5]))
 d.update(source=str((root/'snapshot.json.gz').resolve()),snapshot_at=m['capture'],launches=list(wanted.values()),population='screened',positions=[p for p in raw['bot_positions'] if p.get('live') and (p.get('exit_at') or m['capture'])>=m['start']],observations=raw['gate_obs'])
 ids=sorted({hex(c['to']) for t,c in d['path_coverage'].items() if t in wanted}-set(d['blocks']))
 with Cache('data/research/cache.sqlite',True) as cache:
  for i in range(0,len(ids),100):
   batch=ids[i:i+100]
   for block,r in zip(batch,cache.many([('eth_getBlockByNumber',[b,False]) for b in batch])):
    if r and int(r['number'],16)==int(block,16):d['blocks'][block]=dict(hash=r['hash'],timestamp=int(r['timestamp'],16))
   print('coverage headers',min(i+100,len(ids)),'/',len(ids),flush=True)
 verify(root)
 write_artifact(root/'dataset.json',d)
 write_json(root/'manifest.json',dict(run_sha256=digest(root/'run.json'),dataset_sha256=digest(root/'dataset.json'),snapshot_sha256=digest(root/'snapshot.json.gz'),launches=len(wanted),missing_historical=len(value['bot_launches']),sources={str(p):digest(p) for p in sources},coverage_complete=False))
 print('Dataset merged; per-execution coverage remains to be evaluated',flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);run(p.parse_args().root)
