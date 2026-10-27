"""Complete the frozen September capture using the shared bounded cache client."""
import argparse, collections, json, time
from pathlib import Path
from .data import capture, read_json, write_json, write_artifact, digest, prepare, Cache, HOUR
START=1788220800000
END=1789313400000

def run(inputs, root):
 inputs,root=Path(inputs),Path(root);root.mkdir(parents=True,exist_ok=True)
 def status(stage,**kw):
  write_json(root/'acquisition-status.json',dict(stage=stage,heartbeat=int(time.time()*1000),**kw));print(stage,kw,flush=True)
 status('loading_frozen_inputs')
 state=read_json(inputs/'state.json');state['at']=END;write_json(root/'capture-state.json',state)
 if not (root/'snapshot.json.gz').exists():capture(inputs/'bot.db',inputs/'gate.db',root/'capture-state.json',root/'snapshot.json.gz')
 raw=read_json(root/'snapshot.json.gz');prior=read_json(inputs/'prior-dataset.json')
 actual={p['token'].lower() for p in raw['bot_positions'] if p.get('live') and START<=(p.get('t_decide') or p.get('t_detect') or 0)<END}
 wanted={f['token'].lower():f for f in raw['bot_launches'] if f.get('curve') and f.get('block') and START-7*HOUR<=(f.get('launched_at') or 0)*1000<END and (f.get('passed') or f['token'].lower() in actual)}
 def faults(d,t,f):
  issue=[];c=d.get('path_coverage',{}).get(t,{})
  if not d.get('params',{}).get(t):issue.append('parameters')
  if not c.get('all_topics') or c.get('from',10**15)>f['block']:issue.append('full_launch_prefix')
  header=d['blocks'].get(hex(c.get('to',0)))
  at=max(f.get('detected_at') or 0,(f.get('launched_at') or 0)*1000+2000)
  if not header or not header.get('hash') or header['timestamp']*1000<at+150000:issue.append('end_header')
  for l in d.get('paths',{}).get(t,[]):
   h=d['blocks'].get(l['blockNumber'])
   if not h or not h.get('hash') or h['hash'].lower()!=str(l.get('blockHash')).lower() or l.get('removed') or l.get('transactionIndex') is None:
    issue.append('log_timestamp_or_order');break
  return issue
 known={t for t,f in wanted.items() if not faults(prior,t,f)}
 missing={t:f for t,f in wanted.items() if t not in known}
 status('fetching_missing_coverage',total=len(wanted),reused=len(known),missing=len(missing))
 subset={**raw,'bot_launches':list(missing.values()),'bot_positions':[]}
 if not (root/'missing-snapshot.json').exists():write_artifact(root/'missing-snapshot.json',subset)
 if not (root/'missing/manifest.json').exists():
  prepare(root/'missing-snapshot.json',root/'missing',inputs/'cache.snapshot.sqlite',fetch=True,days=15,scope='opportunities',immutable_latest=True,population='screened',since_ms=START)
 patch=read_json(root/'missing/dataset.json');merged=dict(prior)
 for key in ('paths','params','path_coverage','blocks','receipts','parameter_sources'):
  merged.setdefault(key,{})
  for k,v in patch.get(key,{}).items():
   prev=merged[key].get(k)
   if prev and v and key=='params' and prev!=v:raise ValueError('parameter conflict '+k)
   if prev and v and key=='blocks' and (prev['timestamp']!=v['timestamp'] or prev.get('hash') and v.get('hash') and prev['hash']!=v['hash']):raise ValueError('header conflict '+k)
   if v is not None:merged[key][k]=v
 # Coverage endpoints are checked independently even when their blocks have no logs.
 ids=sorted({hex(c['to']) for t,c in merged['path_coverage'].items() if t in wanted}-set(merged['blocks']))
 with Cache(inputs/'cache.snapshot.sqlite',True) as cache:
  for i in range(0,len(ids),100):
   batch=ids[i:i+100]
   for b,h in zip(batch,cache.many([('eth_getBlockByNumber',[b,False]) for b in batch])):
    if h and h.get('hash') and int(h['number'],16)==int(b,16):merged['blocks'][b]={'timestamp':int(h['timestamp'],16),'hash':h['hash']}
   status('coverage_headers',completed=min(i+100,len(ids)),total=len(ids))
 merged.update(source=str(root/'snapshot.json.gz'),snapshot_at=END,launches=list(wanted.values()),positions=raw['bot_positions'],observations=raw['gate_obs'],population='screened')
 unavailable={t:faults(merged,t,f) for t,f in wanted.items() if faults(merged,t,f)}
 write_artifact(root/'dataset.json',merged)
 write_json(root/'coverage.json',dict(start=START,through=END,total=len(wanted),complete=len(wanted)-len(unavailable),missing=unavailable,breakdown=dict(collections.Counter(x for xs in unavailable.values() for x in xs)),actualAttempts=len([p for p in raw['bot_positions'] if p.get('live') and START<=(p.get('t_decide') or p.get('t_detect') or 0)<END]),actualTokens=len(actual),actualSourceComplete=len((actual & wanted.keys())-unavailable.keys()),pathCoverageOnly=True,minimumCoverageMs=150000))
 write_json(root/'manifest.json',dict(start=START,through=END,datasetHash=digest(root/'dataset.json'),snapshotHash=digest(root/'snapshot.json.gz'),sourceHashes={p.name:digest(p) for p in [inputs/'prior-dataset.json',inputs/'bot.db',inputs/'gate.db',inputs/'state.json']},sourceComplete=not unavailable,diagnosticOnly=True))
 status('acquisition_complete',total=len(wanted),complete=len(wanted)-len(unavailable),unavailable=len(unavailable))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--inputs',required=True);p.add_argument('--root',required=True);a=p.parse_args();run(a.inputs,a.root)
