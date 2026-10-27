"""Create a new frozen dataset revision after verifying late-entry path extensions."""
import json,os,time,collections,shutil
from pathlib import Path
from research.core.data import read_json,write_json,write_artifact,digest,Worker
ROOT=Path('/work/results');EXT=ROOT/'coverage-extension';OLD=ROOT/'pre-extension'
if not (EXT/'complete.json').exists():raise RuntimeError('Coverage extension is not complete')
if OLD.exists():raise RuntimeError('A revision already exists; inspect before retrying')
d=read_json(ROOT/'acquisition/dataset.json');oldmanifest=read_json(ROOT/'acquisition/manifest.json');coverage=read_json(ROOT/'acquisition/coverage.json');facts={f['token'].lower():f for f in d['launches']}
if digest(ROOT/'acquisition/dataset.json')!=read_json(EXT/'plan.json')['sourceHash']:raise ValueError('Extension source changed')
with Worker() as worker:topics={v for k,v in worker.call(op='metadata')['topics'].items() if k!='TokenLaunched'}
proofs={};patched=[]
for p in sorted(EXT.glob('0x*.json')):
 if p.name.endswith('.failure.json'):continue
 x=read_json(p)
 if not x['complete']:continue
 token=x['token'];f=facts[token];prior=d['path_coverage'].get(token,{})
 if x['from']>f['block'] and (not prior.get('all_topics') or prior['from']>f['block'] or x['from']!=prior['to']+1):raise ValueError('Gap between original and extended coverage')
 values={}
 for l in d['paths'].get(token,[])+x['logs']:
  if not l.get('topics') or l['topics'][0] not in topics:continue
  key=(l['transactionHash'].lower(),int(l['logIndex'],16))
  if key in values and any(values[key].get(k)!=l.get(k) for k in ['address','topics','data','blockHash','blockNumber','transactionIndex']):raise ValueError('Conflicting log '+str(key))
  values[key]=l
 for b,h in x['blocks'].items():
  previous=d['blocks'].get(b)
  if previous and previous.get('hash') and previous!=h:raise ValueError('Conflicting header '+b)
  d['blocks'][b]=h
 d['paths'][token]=sorted(values.values(),key=lambda l:(int(l['blockNumber'],16),int(l['transactionIndex'],16),int(l['logIndex'],16)))
 d['path_coverage'][token]={'from':min(prior.get('from',f['block']),f['block']),'to':x['through'],'all_topics':True}
 proofs[p.name]=digest(p);patched.append(token)
def faults(t,f):
 issue=[];c=d['path_coverage'].get(t,{})
 if not d['params'].get(t):issue.append('parameters')
 if not c.get('all_topics') or c.get('from',10**20)>f['block']:issue.append('full_launch_prefix')
 at=max(f.get('detected_at') or 0,f['launched_at']*1000+2000);h=d['blocks'].get(hex(c.get('to',0)))
 if not h or not h.get('hash') or h['timestamp']*1000<at+150000:issue.append('end_header')
 for l in d['paths'].get(t,[]):
  h=d['blocks'].get(l['blockNumber'])
  if not h or not h.get('hash') or h['hash'].lower()!=l.get('blockHash','').lower() or l.get('removed') or l.get('transactionIndex') is None:issue.append('log_timestamp_or_order');break
 return issue
missing={t:v for t,f in facts.items() if (v:=faults(t,f))}
OLD.mkdir()
for name in ['acquisition','jobs','matrices','input-manifest.json','run-freeze.json','build-inputs.log']:
 p=ROOT/name
 if p.exists():p.rename(OLD/name)
new=ROOT/'acquisition';new.mkdir()
for name in ['snapshot.json.gz','capture-state.json']:
 if (OLD/'acquisition'/name).exists():os.link(OLD/'acquisition'/name,new/name)
write_artifact(new/'dataset.json',d)
coverage.update(missing=missing,complete=len(facts)-len(missing),breakdown=dict(collections.Counter(r for v in missing.values() for r in v)),revision=2)
write_json(new/'coverage.json',coverage)
manifest={**oldmanifest,'datasetHash':digest(new/'dataset.json'),'sourceComplete':not missing,'revision':2,'previousManifestHash':digest(OLD/'acquisition/manifest.json'),'extensionHashes':proofs,'extensionScriptHash':digest(Path(__file__))}
write_json(new/'manifest.json',manifest)
write_json(ROOT/'coverage-revision.json',{'at':int(time.time()*1000),'revision':2,'extendedTokens':len(patched),'sourceMissingBefore':149,'sourceMissingAfter':len(missing),'priorRoot':'pre-extension','reason':'Preserve recorded late entry timing by extending paths beyond the original launch+180-second horizon','modelChanged':False,'thresholdsChanged':False})
print(json.dumps({'extended':len(patched),'remaining':len(missing),'revision':2}),flush=True)
