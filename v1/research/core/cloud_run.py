"""Durable orchestration for the frozen shared-model grid on temporary compute."""
import argparse,concurrent.futures,hashlib,json,os,subprocess,time,traceback,sys
from pathlib import Path
from .data import read_json,write_json,digest
from .search_preflight import assess
os.environ.setdefault('DOTENV_CONFIG_QUIET','true')

def policy_batches(policies,stage):
 groups={}
 for p in policies:
  key=tuple(p.get(k) for k in ['n','m','ageMs','halfLifeMs','positiveCap'])
  groups.setdefault(key,[]).append(p)
 # Keep the completed core layout stable. Wider searches often contain only
 # one policy per window, so combine adjacent groups to reuse account setup.
 if stage in ['core','coverage-preflight']:return list(groups.values())
 batches=[];pending=[]
 for group in groups.values():
  if pending and len(pending)+len(group)>256:batches.append(pending);pending=[]
  pending.extend(group)
 if pending:batches.append(pending)
 return batches

def run(root,workers=16,execution_only=False):
 root=Path(root);root.mkdir(exist_ok=True,parents=True);began=time.time()
 def status(stage,**kw):write_json(root/'status.json',dict(stage=stage,heartbeat=int(time.time()*1000),elapsedSeconds=time.time()-began,**kw))
 def command(args,log):
  with open(log,'w') as f:subprocess.run(args,stdout=f,stderr=subprocess.STDOUT,check=True)
 def parallel(jobs,stage):
  nonlocal workers
  total=len(jobs);started=time.time();done=0;executed=0;reused=0
  def work(job):
   args,path,key=job;identity=hashlib.sha256(json.dumps({'args':args,'inputKey':key,'freeze':digest(root/'run-freeze.json')}).encode()).hexdigest();proof=Path(str(path)+'.checkpoint.json')
   if path.exists() and proof.exists() and read_json(proof)=={'jobHash':identity,'outputHash':digest(path)}:return False
   command(args,str(path)+'.log');write_json(proof,{'jobHash':identity,'outputHash':digest(path)})
   return True
  pilot_path=Path(m['sharedPilotPath']) if m.get('sharedPilotPath') else None
  band_workers=m.get('scoringPilotWorkers',[8,16,24])
  if not band_workers or any(not isinstance(n,int) or isinstance(n,bool) or not 1<=n<=128 for n in band_workers):raise ValueError('invalid scoring pilot workers')
  freeze=read_json(root/'run-freeze.json')
  pilot_id=hashlib.sha256(json.dumps({'model':freeze['modelHash'],'sources':freeze['sources'],'chunks':[c['sha256'] for c in m['chunks']],'workers':band_workers,'cpuCount':os.cpu_count()},sort_keys=True).encode()).hexdigest()
  saved_pilot=read_json(pilot_path) if pilot_path and pilot_path.exists() else None
  if saved_pilot and saved_pilot.get('identity')==pilot_id and saved_pilot.get('complete'):
   workers=saved_pilot['chosenWorkers']
  else:saved_pilot=None
  stage_workers=32 if stage=='execution_matrix' else workers
  ramp=stage=='core' and saved_pilot is None;ordered=sorted(jobs,key=lambda j:hashlib.sha256(json.dumps(j[0]).encode()).hexdigest()) if ramp else jobs
  bands=[{'workers':n,'completedCandidates':0,'seconds':0} for n in band_workers];queue=iter(ordered);exhausted=False;last=time.time()
  status(stage,completed=0,total=total,workers=band_workers[0] if ramp else stage_workers,pilotReused=saved_pilot is not None)
  with concurrent.futures.ThreadPoolExecutor(max_workers=max(band_workers) if ramp else stage_workers) as pool:
   pending={}
   while pending or not exhausted:
    elapsed=time.time()-started;band=min(len(bands)-1,int(elapsed//(900/len(bands))))
    limit=bands[band]['workers'] if ramp and elapsed<900 else max(bands,key=lambda b:b['completedCandidates']/max(1,b['seconds']))['workers'] if ramp else stage_workers
    while len(pending)<limit and not exhausted:
     try:j=next(queue);pending[pool.submit(work,j)]=j
     except StopIteration:exhausted=True
    if not pending:break
    ready,_=concurrent.futures.wait(pending,timeout=20,return_when=concurrent.futures.FIRST_COMPLETED)
    now=time.time()
    if ramp and elapsed<900:bands[band]['seconds']+=now-last
    last=now
    for f in ready:
     computed=f.result();job=pending.pop(f);done+=1
     if computed:executed+=1
     else:reused+=1
     if ramp and elapsed<900 and computed:bands[band]['completedCandidates']+=len(read_json(job[1])['results'])
    elapsed=time.time()-started
    if ramp:
     finished=elapsed>=900 or done==total
     chosen=max(bands,key=lambda b:b['completedCandidates']/max(1,b['seconds']))['workers']
     pilot={'identity':pilot_id,'bands':bands,'elapsedSeconds':min(elapsed,900),'chosenWorkers':chosen if finished else limit,'complete':finished,'endedEarlyBecauseCoreComplete':done==total and elapsed<900,'method':'disjoint core jobs ordered by content hash; completed new comparisons per measured second; cached checkpoints excluded'}
     write_json(root/'parallelism-pilot.json',pilot)
     if finished and sum(b['completedCandidates'] for b in bands)>0:
      workers=chosen
      if pilot_path:write_json(pilot_path,pilot)
    status(stage,completed=done,total=total,workers=limit,newlyExecuted=executed,reused=reused,estimateRemainingSeconds=(total-done)*elapsed/executed if executed else None)
 def score(policies,stage,inputs):
  folder=root/'scores'/stage;folder.mkdir(parents=True,exist_ok=True)
  jobs=[]
  for i,group in enumerate(policy_batches(policies,stage)):
   pp=folder/f'policies-{i}.json';write_json(pp,group)
   for inp in inputs:
    path=folder/(Path(inp['path']).stem+f'-{i}.json')
    jobs.append((['node','--import','tsx','research/core/cloud_score.ts',inp['path'],str(pp),str(path),str(root/'input-manifest.json')],path,inp['sha256']+digest(pp)))
  parallel(jobs,stage)
  values=[]
  for _,path,_ in jobs:
   info=next(i for i in inputs if path.name.startswith(Path(i['path']).stem+'-'))
   values.extend({**r,'lane':info['lane'],'exit':info['exit'],'memory':info['memory']} for r in read_json(path)['results'])
  write_json(folder/'index.json',{'candidates':len(policies),'comparisons':len(values),'files':[str(p) for _,p,_ in jobs]})
  return values
 try:
  status('waiting_for_acquisition')
  while not (root/'input-manifest.json').exists() and not (root/'acquisition/manifest.json').exists():
   status('waiting_for_acquisition')
   if subprocess.run(['systemctl','is-failed','--quiet','compute-acquisition-v2.service']).returncode==0:raise RuntimeError('acquisition service failed; see acquisition log')
   time.sleep(15)
  status('freezing_execution_inputs')
  if not (root/'input-manifest.json').exists():command([sys.executable,'-u','-m','research.core.cloud_inputs','--inputs','/work/inputs','--root',str(root)],root/'build-inputs.log')
  m=read_json(root/'input-manifest.json');folder=root/'matrices';folder.mkdir(exist_ok=True)
  identity=subprocess.check_output(['node','--import','tsx','scripts/execution-worker.ts'],input=b'{"op":"identity"}\n',env={**os.environ,'ENV_FILE':'/dev/null','MODE':'observe','LIVE':'0','DASH':'0'}).decode();model=json.loads(identity)['result']['modelHash']
  source={str(p):digest(p) for base in ['src','research/core','scripts'] for p in Path(base).rglob('*') if p.suffix in ['.ts','.py']}
  freeze={'modelHash':model,'sources':source,'inputManifestHash':digest(root/'input-manifest.json'),'exitDescriptorsHash':digest(Path('research/core/cloud-exits.json')),'diagnosticOnly':True}
  if (root/'run-freeze.json').exists() and read_json(root/'run-freeze.json')!=freeze:raise ValueError('frozen model or inputs changed')
  write_json(root/'run-freeze.json',freeze)
  jobs=[]
  for c in m['chunks']:
   path=folder/Path(c['path']).name
   if digest(c['path'])!=c['sha256']:raise ValueError('execution chunk changed')
   jobs.append((['node','--import','tsx','research/core/cloud_execution.ts',c['path'],str(path)],path,c['sha256']))
  if not m.get('preparedMatrices'):
   parallel(jobs,'execution_matrix')
  else:
   for name,expected in m['preparedMatrices'].items():
    if digest(folder/name)!=expected:raise ValueError('prepared matrix changed')
  if execution_only:
   status('execution_matrix_complete');return
  status('causal_account_inputs')
  if not (root/'account-manifest.json').exists():
   builder='research.core.parallel_accounts' if m.get('parallelAccountWorkers') else 'research.core.cloud_accounts'
   args=[sys.executable,'-u','-m',builder,'--root',str(root)]
   if m.get('parallelAccountWorkers'):args+=['--workers',str(m['parallelAccountWorkers'])]
   command(args,root/'build-accounts.log')
  catalog=json.loads(subprocess.check_output(['node','--import','tsx','--input-type=module','-e',"import {candidates,FAMILIES} from './research/core/cloud_catalog.ts';console.log(JSON.stringify({policies:candidates(),families:FAMILIES}))"]).decode())
  write_json(root/'candidate-freeze.json',catalog)
  account_manifest=read_json(root/'account-manifest.json')
  if account_manifest.get('inputManifestHash')!=digest(root/'input-manifest.json'):raise ValueError('Account inputs belong to another manifest')
  inputs=account_manifest['inputs']
  if any(digest(i['path'])!=i['sha256'] for i in inputs):raise ValueError('Account payload changed')
  coreinputs=[i for i in inputs if i['memory']==20 and not i.get('refinementOnly')]
  baseline=next(p for p in catalog['policies'] if p['n']==10 and p['m']==5 and p['off']==-2 and p['freshOn']==1 and p['fullOn']==2 and p['ageMs']==10800000 and p['mode']=='both')
  preflight=score([baseline],'coverage-preflight',coreinputs)
  coverage_check=assess(preflight);write_json(root/'search-preflight.json',coverage_check)
  if not coverage_check['ready'] and not m.get('boundedResearch'):
   status('blocked_before_grid',**coverage_check)
   return
  # The representative pilot runs real, disjoint windows and retains its outputs.
  # Core starts with a measured 15-minute concurrency pilot; its jobs are retained.
  results=score(catalog['policies'],'core',coreinputs)
  def frontier(values,cutoff):
   valid=[r for r in values if all(s['complete'] for s in r['periods'][cutoff])]
   def metrics(r):
    s=r['periods'][cutoff];return (min(v['net'] for v in s),-max(v['dd'] for v in s),-max(v['recoveryLoss'] for v in s),-max(v['losingRecoveries'] for v in s))
   # Collapse identical objective vectors before dominance checks, retaining every tie.
   groups={}
   for r in valid:groups.setdefault(metrics(r),[]).append(r)
   objective_front=[]
   for v in sorted(groups,reverse=True):
    if any(all(a>=b for a,b in zip(f,v)) for f in objective_front):continue
    objective_front=[f for f in objective_front if not all(a>=b for a,b in zip(v,f))];objective_front.append(v)
   front=[r for v in objective_front for r in groups[v]]
   seeds=[];seen=set();rankings=[sorted(front,key=lambda r:(-metrics(r)[k],r['policy']['id'],r['exit'])) for k in range(4)];cursor=[0]*4
   while len(seeds)<12 and any(cursor[k]<len(rankings[k]) for k in range(4)):
    for k in range(4):
     while cursor[k]<len(rankings[k]):
      r=rankings[k][cursor[k]];cursor[k]+=1;p=r['policy'];key=json.dumps({a:b for a,b in p.items() if a!='id'},sort_keys=True)
      if key not in seen:seen.add(key);seeds.append(p);break
     if len(seeds)==12:break
   return front,seeds
  allstages=[];core_results=list(results)
  for cutoff in ['train3','train5','train7']:
   front,seeds=frontier(core_results,cutoff);write_json(root/f'frontier-{cutoff}.json',{'frontier':front,'seeds':seeds})
   if not seeds:
    allstages.append({'cutoff':cutoff,'state':'blocked','reason':'No complete training account; unavailable evidence cannot select wider-search seeds'});continue
   family=[]
   for j,seed in enumerate(seeds):
    family.append(seed)
    for key,vals in catalog['families'].items():
     for val in vals:family.append({**seed,key:val,'id':f'{cutoff}-seed{j}-{key}-{val}'})
   singles=score(family,cutoff+'-families',coreinputs);results.extend(singles);cutoff_results=core_results+singles
   pairs=[]
   for j,seed in enumerate(seeds):
    best=[]
    for key in catalog['families']:
     eligible=[r for r in singles if r['policy']['id'].startswith(f'{cutoff}-seed{j}-{key}-') and all(s['complete'] for s in r['periods'][cutoff])]
     if eligible:
      winner=max(eligible,key=lambda r:(min(s['net'] for s in r['periods'][cutoff]),-max(s['dd'] for s in r['periods'][cutoff]),-max(s['recoveryLoss'] for s in r['periods'][cutoff]),-max(s['losingRecoveries'] for s in r['periods'][cutoff])))
      best.append((key,winner['policy'][key]))
    for a,(ka,va) in enumerate(best):
     for kb,vb in best[a+1:]:pairs.append({**seed,ka:va,kb:vb,'id':f'{cutoff}-pair{j}-{ka}-{kb}'})
   if pairs:
    pair_results=score(pairs,cutoff+'-pairs',coreinputs);results.extend(pair_results);cutoff_results.extend(pair_results)
   front,seeds2=frontier(cutoff_results,cutoff)
   results.extend(score(seeds2,cutoff+'-tp-memory',[i for i in inputs if i['memory']!=20 and not i.get('refinementOnly')]))
   neighbors=[];timer_policies=list(seeds2)
   for j,p in enumerate(seeds2):
    edits=[]
    for key,step,lo,hi in [('n',1,5,60),('m',1,2,20),('off',.25,-3,1),('freshOn',.25,.25,3),('fullOn',.25,.5,4),('ageMs',900000,900000,14400000)]:
     for sign in [-1,1]:
      val=p[key]+sign*step
      if lo<=val<=hi:edits.append((key,val))
    changes=[dict([e]) for e in edits]+[dict([a,b]) for n,a in enumerate(edits) for b in edits[n+1:] if a[0]!=b[0]]
    for k,change in enumerate(changes):
     q={**p,**change,'id':f'{cutoff}-neighbor{j}-{k}'}
     if q['m']<q['n']:
      neighbors.append(q)
      if len(change)==1:timer_policies.append(q)
   results.extend(score(neighbors,cutoff+'-neighbors',coreinputs))
   results.extend(score(timer_policies,cutoff+'-timer-singles',[i for i in inputs if i.get('refinementOnly') and i.get('timerChanges')==1]))
   results.extend(score(seeds2,cutoff+'-timer-pairs',[i for i in inputs if i.get('refinementOnly') and i.get('timerChanges')==2]))
   allstages.append({'cutoff':cutoff,'state':'complete','familyCandidates':len(family),'pairCandidates':len(pairs),'neighborCandidates':len(neighbors)})
  write_json(root/'comparison-summary.json',{'comparisons':len(results),'stages':allstages,'diagnosticOnly':True,'complete':all(s['state']=='complete' for s in allstages)})
  write_json(root/'all-scorecards.json',results)
  status('scoring_complete',comparisons=len(results),stages=allstages)
 except BaseException as e:
  status('failed',error=str(e),traceback=traceback.format_exc());raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--workers',type=int,default=16);p.add_argument('--execution-only',action='store_true');a=p.parse_args();run(a.root,a.workers,a.execution_only)
