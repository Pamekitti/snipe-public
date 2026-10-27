"""Freeze causal execution jobs for the shared execution kernel."""
import argparse,collections,hashlib,json,math,sqlite3
from pathlib import Path
from .data import read_json,write_json,digest,Cache
from .both_periods import cost_model
from .cloud_acquire import START,END

def build(inputs,root):
 inputs,root=Path(inputs),Path(root);d=read_json(root/'acquisition/dataset.json');raw=read_json(root/'acquisition/snapshot.json.gz');coverage=read_json(root/'acquisition/coverage.json')
 state=raw['state'];policy=state['policy'];risk=state['risk'];positions=raw['bot_positions'];receipts={k.lower():v for k,v in d['receipts'].items()}
 if (inputs/'cost-receipts.json').exists():receipts.update(read_json(inputs/'cost-receipts.json'))
 hashes=sorted({str(p[k]).lower() for p in positions for k in ['buy_hash','exit_hash'] if p.get('closed') and p.get('buy_ok') and p.get(k) and (p.get('updated_at') or END)<END})
 missing=[h for h in hashes if not receipts.get(h)]
 with Cache(inputs/'cache.snapshot.sqlite',True) as cache:
  for i in range(0,len(missing),50):
   for h,r in zip(missing[i:i+50],cache.many([('eth_getTransactionReceipt',[h]) for h in missing[i:i+50]])):
    if r:receipts[h]=r
   print('preceding receipts',min(i+50,len(missing)),len(missing),flush=True)
 write_json(root/'cost-receipts.json',receipts)
 config={'entry':{'minCreatorTaxBps':policy['minCreatorTaxBps'],'minExemptionsToEnter':policy['minExemptionsToEnter'],'templateLossBlockMs':policy['templateLossBlockMs'],'tradeSizeEth':risk['tradeSizeEth']},'bankrollWei':str(round(risk['bankrollEth']*1e18)),'maxConcurrent':risk['maxConcurrent'],'maxDrawdownWei':str(round(risk['drawdownLimitEth']*1e18)),'entryHours':[]}
 configId=hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()
 gates={g['token'].lower():g for g in raw['gate_obs']};samples=read_json(inputs/'timing-evidence.json')['samples'];chunks=[];jobs=[];unavailable=[]
 folder=root/'jobs';folder.mkdir(exist_ok=True)
 def flush():
  if not jobs:return
  path=folder/f'{len(chunks):04}.json';write_json(path,jobs);chunks.append({'path':str(path),'sha256':digest(path),'n':len(jobs)});jobs.clear()
 for i,f in enumerate(sorted(d['launches'],key=lambda f:(max(f.get('detected_at') or 0,(f.get('launched_at') or 0)*1000+2000),f['token']))):
  token=f['token'].lower();at=max(f.get('detected_at') or 0,(f.get('launched_at') or 0)*1000+2000)
  if not START<=at<END:continue
  faults=list(coverage['missing'].get(token,[]));q=None
  if at+65000>END:faults.append('unresolved_capture_tail')
  cover=d['path_coverage'].get(token,{})
  end_header=d['blocks'].get(hex(cover.get('to',0)),{})
  end_at=min(at+180000,END,end_header.get('timestamp',0)*1000)
  if not faults:
   try:costs,proof=cost_model(positions,receipts,at)
   except ValueError as e:faults.append(str(e))
  if not faults:
   p=d['params'][token];logs=[]
   for l in d['paths'][token]:
    h=d['blocks'][l['blockNumber']];stamp=h['timestamp']*1000
    if stamp>end_at:continue
    logs.append({**l,'at':stamp,'observedAt':stamp+600,'observationSource':'modeled','timeResolutionMs':1000,'order':{'block':int(l['blockNumber'],16),'transaction':int(l['transactionIndex'],16),'log':int(l['logIndex'],16)}})
   prior=sorted([s for s in samples if s.get('completedAt') and s.get('availableAt') and s['completedAt']<at-21600000 and s['availableAt']<at-21600000],key=lambda s:s['completedAt'],reverse=True)[:100]
   bounds=None
   if len(prior)>=20:
    bounds=[sorted(s[k] for s in prior)[(len(prior)-1)//2] for k in ['lower','midpoint','upper']]
   costs['approvalDelayMs']=600
   q={'modelVersion':'execution-account-v3','evidenceVersion':'capture-v3','strategyVersion':'execution-account-v3','id':token,'token':token,'curve':f['curve'],'wallet':state['wallet'],'params':p,'sizeWei':str(round(risk['tradeSizeEth']*1e18)),'entryQuoteTokens':'1','minTokens':'1','maxEntryMultiple':policy['maxEntryPriceMultiple'],'takeProfit':1.75,'rules':{'maxHoldMs':45000,'hardStopMultiple':policy['hardStopMultiple'],'deadCoinAfterMs':policy['deadCoinAfterMs'],'deadCoinBelowMult':1.03},'entryAt':at,'openedAt':at+154,'endAt':end_at,'pollMs':50,'seed':{'state':{'trackedQuote':'0','trackedTokens':p['launchSupply'],'quoteFeeBalance':'0','creatorTaxBalance':'0','graduated':False},'order':{'block':f['block']-1,'transaction':0,'log':0},'at':int(p['launchedAt'])*1000,'observedAt':at},'logs':logs,'timing':{'kind':'scenario','label':'fixed-unfitted-reference','frozenAt':at,'fitThrough':at-21600000,'n':0,'sendMs':154,'confirmationMs':600,'sellMs':1200,'observationMs':600,'buyInclusionMs':300,'buyOrderFraction':.5,'sameTimeOrder':'after'},'costs':costs,'coverage':{'complete':True,'independentlyChecked':True,'from':int(p['launchedAt'])*1000,'through':end_at,'gaps':[]},'provenance':{'kind':'reconstruction','source':digest(root/'acquisition/manifest.json'),'capturedAt':END},'clockBounds':bounds,'costProof':proof,'clockN':len(prior)}
  if faults:unavailable.append({'token':token,'at':at,'reasons':faults})
  g=gates.get(token,{})
  jobs.append({'id':token,'token':token,'sequence':i,'at':at,'block':f['block'],'launched':f['launched_at']*1000,'creatorTaxBps':str(f.get('creator_tax_bps') or 0),'exemptions':f.get('exemptions'),'template':str(f.get('creator_tax_bps') or 0)+':'+str(f.get('dev_buy_wei') or 0)+':'+str(f.get('exemptions') if f.get('exemptions') is not None else ''),'configId':configId,'config':config,'sizeWei':str(round(risk['tradeSizeEth']*1e18)),'publicationFloor':max(g.get('at') or 0,at+1),'selectorPopulation':bool(g) and g.get('error') is None and g.get('bars') is not None,'bookEligible':bool(f.get('passed')),'request':q,'unavailable':faults})
  if len(jobs)>=200:flush();print('frozen jobs',i,flush=True)
 flush()
 controls=[];previous=None;previous_dd=None
 for s in sorted(raw['bot_guard_samples'],key=lambda s:s['at']):
  if s['at']>=END:continue
  halts=json.loads(s['halts']);halted=any(h != 'venue' for h in halts)
  current_dd='drawdown' in halts
  if previous_dd is True and not current_dd:
   controls.append({'kind':'control','id':'recorded-drawdown-clear:'+str(s['at']),'at':max(START,s['at']),'sequence':-3,'strategyVersion':'execution-account-v3','resetDrawdown':True})
  previous_dd=current_dd
  if halted!=previous:
   controls.append({'kind':'control','id':'recorded-stop:'+str(s['at']),'at':max(START,s['at']),'sequence':-2,'strategyVersion':'execution-account-v3','halted':halted});previous=halted
 # Explicitly retain only recorded accounting resets; never generate periodic ones.
 for h in raw['bot_health']:
  if START<=h['at']<END and h['component'] in ['epoch-reset','dd-lift'] and h.get('ok'):
   controls.append({'kind':'control','id':'recorded-reset:'+str(h['id']),'at':h['at'],'sequence':-2,'strategyVersion':'execution-account-v3','resetDrawdown':True})
 write_json(root/'input-manifest.json',{'start':START,'through':END,'config':config,'chunks':chunks,'controls':controls,'sourceManifestHash':digest(root/'acquisition/manifest.json'),'costReceiptsHash':digest(root/'cost-receipts.json'), 'clockEvidenceHash':digest(inputs/'timing-evidence.json'),'unavailable':unavailable,'missingBreakdown':dict(collections.Counter(r for u in unavailable for r in u['reasons'])),'initialAccountAssumption':'known flat hypothetical account at September 1; historical initial account is not reconstructed','controlLimit':'recorded-control stress: all non-market halt samples retained; observed drawdown-clear transitions reset epoch accounting only; independent candidate-dependent automatic drawdown recovery is not established by this run','diagnosticOnly':True})
 print('inputs complete',sum(c['n'] for c in chunks),'unavailable',len(unavailable),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--inputs',required=True);p.add_argument('--root',required=True);a=p.parse_args();build(a.inputs,a.root)
