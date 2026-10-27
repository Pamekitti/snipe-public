"""Reprice exit grid from frozen paths, using causal TP and cost inputs."""
import argparse,bisect,json,sqlite3,statistics,hashlib
from pathlib import Path
from .data import read_json,Worker,HOUR,digest
from .execution import path_request,booked,receipt_gas
from .evaluation import context,entry
from .long_history import selector_rows
from .grid_exits import exits,variant
from .grid_selector import TARGETS,HOLDS
from .grid_model_store import pack_results


def modeled_entry(f, actual_entries, mode):
 earliest=f['launched_at']*1000+2000
 if mode=='reconstructed_early':return earliest
 if mode!='recorded':raise ValueError('Unknown entry timing mode')
 return max(earliest,actual_entries.get(f['token'].lower(),f.get('detected_at') or earliest))

def run(root, limit=None, entry_mode='recorded'):
 root=Path(root);raw=read_json(root/'snapshot.json.gz');d=read_json(root/'dataset.json')
 proof=read_json(root/'batch-parity.json')
 if proof['exact_cases']!=9936 or any(digest(Path(p))!=h for p,h in proof['hashes'].items()):raise ValueError('batch replay requires current exact parity proof')
 if (root/'candidate-exits.json').exists() and proof.get('exit_catalog_sha256')!=digest(root/'candidate-exits.json'):raise ValueError('Expanded exits require current scalar parity proof')
 latest=max((p for p in raw['bot_positions'] if context(p).get('entryStrategy')),key=entry)
 ctx=context(latest);size=round(raw['state']['risk']['tradeSizeEth']*1e18)
 end=raw['snapshot_at'];cut=end-6*HOUR
 actual_entries={}
 for p in sorted(raw['bot_positions'],key=entry):
  if p.get('live') and (p.get('cohort') or 'main')=='main' and entry(p):actual_entries.setdefault(p['token'].lower(),entry(p))
 priors=[]
 for p in raw['bot_positions']:
  if not(p['live'] and p.get('buy_ok') and p.get('closed') and p.get('exit_at') and p['exit_at']<cut and p.get('onchain_pnl_wei') is not None):continue
  gas=int(p.get('proceeds_wei') or 0)-int(p['spend_wei'])-booked(p)
  buy=receipt_gas(d['receipts'].get(p.get('buy_hash')))
  send=p['t_sent']-entry(p) if p.get('t_sent') else None
  opened=(context(p).get('at') or p.get('t_confirmed') or entry(p))-entry(p)
  if gas>=buy>0 and send is not None and send>=0 and opened>=0:priors.append(dict(at=p['exit_at'],gas=gas,buy=buy,send=send,opened=opened))
 priors.sort(key=lambda r:r['at']);clocks=[p['at'] for p in priors]
 native=selector_rows(raw);pubs=[o['available'] for o in native]
 db=sqlite3.connect(root/'exit-models.sqlite')
 db.execute('create table if not exists meta(key text primary key,value text)')
 db.execute('create table if not exists models(token text primary key,value text)')
 identity=json.dumps({'entry_mode':entry_mode,'sources':{str(p):digest(p) for p in ([root/'dataset.json',root/'snapshot.json.gz',Path(__file__),Path(__file__).with_name('grid_replay.ts'),Path(__file__).with_name('grid_exits.py'),Path(__file__).with_name('grid_batch_replay.ts'),Path(__file__).with_name('grid_worker.ts'),Path(__file__).with_name('grid_selector.py'),Path(__file__).with_name('grid_model_store.py')]+([root/'candidate-exits.json'] if (root/'candidate-exits.json').exists() else []))}},sort_keys=True)
 old=db.execute('select value from meta where key=?',('identity',)).fetchone()
 if old and old[0]!=identity:raise ValueError('model checkpoint source mismatch')
 db.execute('insert or ignore into meta values (?,?)',('identity',identity));db.commit()
 policies=(read_json(root/'candidate-exits.json')['policies'] if (root/'candidate-exits.json').exists() else list(exits()))+[dict(name=f'joint_{h}_{tp}',kind='fixed',maxHoldMs=h*1000,takeProfit=tp) for h in HOLDS for tp in TARGETS];done={t for t, in db.execute('select token from models')}
 facts=sorted(d['launches'],key=lambda f:modeled_entry(f,actual_entries,entry_mode))
 db.execute('insert or replace into meta values (?,?)',('expected_tokens',str(len({f['token'].lower() for f in facts}))));db.commit()
 added=0
 with Worker() as selector,Worker(Path('research/core/grid_worker.ts')) as worker:
  for f in facts:
   t=f['token'].lower();at=modeled_entry(f,actual_entries,entry_mode)
   if t in done:continue
   prior=priors[:bisect.bisect_left(clocks,at)][-100:]
   timing={k:round(statistics.median(x[k] for x in prior)) if prior else 0 for k in ('gas','buy','send','opened')}
   recent=sorted(native[:bisect.bisect_left(pubs,at)],key=lambda o:-o['block'])[:20]
   tp=selector.call(op='adaptive',rows=[o['bars'] for o in recent],window=20,bars=[1.25,1.36,1.5,1.75,2,2.5,3],fallback=1.75)['multiple']
   fake=dict(token=t,curve=f['curve'],t_decide=at,spend_wei=str(size),take_profit=tp,context_json=ctx)
   req,missing=path_request(d,fake,timing['gas'],lag=1200,poll=50)
   if len(prior)<20:missing='fewer_than_20_preceding_cost_observations'
   if not missing:
    req.update(buyGasWei=str(timing['buy']),buyAt=at+timing['send'],openedAt=at+timing['opened'])
    coverage=d['path_coverage'][t];header=d['blocks'].get(hex(coverage['to']))
    # A recorded last event does not establish coverage through the exit horizon.
    if not header or header['timestamp']*1000<at+(120000 if (root/'candidate-exits.json').exists() else 90000)+timing['opened']+2000:missing='coverage_end_timestamp_unavailable'
   results={}
   for lag in (600,1200,2000):
    if missing:rr=[dict(status=missing) for _ in policies]
    else:rr=worker.call(op='replay_many',request=req,variants=[dict(variant(p,req['rules']),sellDelayMs=lag, takeProfit=p.get('takeProfit',tp)) for p in policies])
    for p,r in zip(policies,rr):results[f"{p['name']}:{lag}"]={k:v for k,v in r.items() if k!='trace'}
   if missing:native_result=dict(status=missing)
   else:
    native_result=worker.call(**dict(req,entryAt=f['launched_at']*1000+2000,buyAt=f['launched_at']*1000+2000,openedAt=f['launched_at']*1000+2000,maxEntryMultiple=None,gasWei='0',buyGasWei='0',pollMs=1200,takeProfit=1.75,sizeWei=str(10**16),sellDelayMs=600))
   selector_policies=[p for p in policies if p['name'].startswith('joint_') or p['name'] in ('fixed_20','fixed_30','fixed_45','fixed_60','fixed_90')]
   if missing:observer_results=[dict(status=missing) for _ in selector_policies]
   else:
    observer_results=worker.call(op='replay_many',request=dict(req,maxEntryMultiple=None),variants=[dict(variant(p,req['rules']),takeProfit=p.get('takeProfit',tp),sellDelayMs=1200) for p in selector_policies])
   selector_results={p['name']:{k:v for k,v in result.items() if k!='trace'} for p,result in zip(selector_policies,observer_results)}
   value=dict(entry_mode=entry_mode,request_sha256=hashlib.sha256(json.dumps(req,sort_keys=True).encode()).hexdigest() if req else None,token=t,entry=at,size=size,tp=tp,results=results,native_result=native_result,selector_results=selector_results,template=f"{f.get('creator_tax_bps')}:{f.get('dev_buy_wei')}:{f.get('exemptions')}",creator_tax_bps=f.get('creator_tax_bps'),exemptions=f.get('exemptions'),gas_wei=str(timing['gas']),buy_gas_wei=str(timing['buy']),send_delay_ms=timing['send'],open_delay_ms=timing['opened'],calibration_latest=prior[-1]['at'] if prior else None,gas_n=len(prior))
   stored=pack_results(value) if (root/'candidate-exits.json').exists() else value
   db.execute('insert into models values (?,?)',(t,json.dumps(stored,separators=(',',':'))));done.add(t)
   added+=1
   if len(done)%50==0:db.commit();print('exit models',len(done),'/',len(facts),flush=True)
   if limit is not None and added>=limit:break
 db.commit();db.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',default='data/research/20260912-grid');p.add_argument('--limit',type=int);p.add_argument('--entry-mode',choices=['recorded','reconstructed_early'],default='recorded');args=p.parse_args();run(args.root,args.limit,args.entry_mode)
