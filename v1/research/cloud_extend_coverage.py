"""Extend verified curve history for late detections without altering frozen inputs."""
import bisect,json,math,time,collections
from pathlib import Path
from research.core.data import Cache,bounded_logs,read_json,write_json,digest
ROOT=Path('/work/results');OUT=ROOT/'coverage-extension';OUT.mkdir(exist_ok=True)
d=read_json(ROOT/'acquisition/dataset.json');coverage=read_json(ROOT/'acquisition/coverage.json');facts={f['token'].lower():f for f in d['launches']};END=coverage['through']
headers=sorted((h['timestamp'],int(b,16)) for b,h in d['blocks'].items() if h.get('hash'))
times=[t for t,b in headers];tasks=[]
for token,reasons in coverage['missing'].items():
 f=facts[token];at=max(f.get('detected_at') or 0,f['launched_at']*1000+2000)
 if at+150000>END:continue
 ix=bisect.bisect_left(times,math.ceil((at+150000)/1000))
 if ix>=len(headers):continue
 old=d['path_coverage'].get(token,{})
 lo=old['to']+1 if old.get('all_topics') and old.get('from',10**20)<=f['block'] else f['block']
 tasks.append((token,f,at,lo,headers[ix][1]))
write_json(OUT/'plan.json',{'sourceHash':digest(ROOT/'acquisition/dataset.json'),'count':len(tasks),'through':END,'reason':'Historical detection occurred after the original launch-anchored path horizon'})
with Cache('/work/inputs/cache.snapshot.sqlite',True) as cache:
 for i,(token,f,at,lo,hi) in enumerate(tasks):
  path=OUT/(token+'.json')
  if path.exists():continue
  logs=bounded_logs(cache,{'address':f['curve'],'fromBlock':hex(lo),'toBlock':hex(hi)})
  if logs is None:write_json(OUT/(token+'.failure.json'),{'reason':'logs_unavailable','lo':lo,'hi':hi});continue
  ids=sorted({l['blockNumber'] for l in logs}|{hex(hi)},key=lambda b:int(b,16));blocks={};faults=[]
  missing=[b for b in ids if not d['blocks'].get(b,{}).get('hash')]
  for j in range(0,len(missing),100):
   for b,h in zip(missing[j:j+100],cache.many([('research_getTimestampHeader',[b,False]) for b in missing[j:j+100]])):
    if h and h.get('hash') and int(h['number'],16)==int(b,16):blocks[b]={'timestamp':int(h['timestamp'],16),'hash':h['hash']}
  for b in ids:
   if b in d['blocks'] and d['blocks'][b].get('hash'):blocks[b]=d['blocks'][b]
  for l in logs:
   h=blocks.get(l['blockNumber'])
   if not h or h['hash'].lower()!=l.get('blockHash','').lower() or l.get('removed') or l.get('transactionIndex') is None:faults.append('log_header_or_order')
  endpoint=blocks.get(hex(hi))
  if not endpoint or endpoint['timestamp']*1000<at+150000:faults.append('endpoint')
  write_json(path,{'token':token,'from':lo,'through':hi,'logs':logs,'blocks':blocks,'faults':sorted(set(faults)),'complete':not faults})
  write_json(OUT/'status.json',{'stage':'extending_late_detection_paths','completed':i+1,'total':len(tasks),'heartbeat':int(time.time()*1000)})
  print('coverage extension',i+1,len(tasks),len(logs),faults,flush=True)
write_json(OUT/'complete.json',{'at':int(time.time()*1000),'tasks':len(tasks),'complete':True})
