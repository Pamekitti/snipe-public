"""Pin candidate exit choices and prepare matched account-model inputs."""
import argparse,json,sqlite3
from pathlib import Path
from .data import read_json,write_json,digest,HOUR
from .grid_exits import exits
from .grid_selector import HoldSelector,HOLDS,TARGETS
from .grid_model_store import unpack_results
from .long_history import eligible
from .evaluation import context,entry

def build(root):
 root=Path(root);raw=read_json(root/'snapshot.json.gz')
 db=sqlite3.connect('file:'+str(root/'exit-models.sqlite')+'?mode=ro',uri=True)
 models={t:json.loads(v) for t,v in db.execute("select token,json_remove(value,'$.results','$.result_pool','$.result_refs') from models")}
 expected=db.execute('select value from meta where key=?',('expected_tokens',)).fetchone()
 if expected is None or len(models)!=int(expected[0]):raise ValueError('exit-model generation is incomplete')
 facts={f['token'].lower():f for f in raw['bot_launches']}
 current=max((p for p in raw['bot_positions'] if context(p).get('entryStrategy')),key=entry)
 spec=context(current)['entryStrategy']
 publication={r['token'].lower():r['at'] for r in raw['gate_obs'] if not r.get('error')}
 observations=[]
 for t,z in models.items():
  if t not in publication:continue
  f=facts[t]
  published=max(publication[t],z['entry']+z['send_delay_ms']+z['open_delay_ms']+90000+14000)+1
  observations.append(dict(token=t,entry=z['entry'],block=f['block'],published=published,size=z['size'],results=z['selector_results']))
 policies=read_json(root/'candidate-exits.json')['policies'] if (root/'candidate-exits.json').exists() else list(exits())
 choices={p['name']:{t:p['name'] for t in models} for p in policies}
 for joint in (False,True):
  keys=([f'joint_{h}_{tp}' for h in HOLDS for tp in TARGETS] if joint else [f'fixed_{h}' for h in HOLDS])
  # Prefer the current hold/TP on a tie; remaining keys are ordered by shorter hold.
  fallback='joint_45_1.75' if joint else 'fixed_45'
  for window in (20,40,60):
   name=f'{"joint" if joint else "market"}_window_{window}'
   selector=HoldSelector(observations,keys,window,fallback)
   choices[name]={t:selector.select(z['entry'],f"joint_45_{z['tp']:g}" if joint else None)[0] for t,z in models.items()}
 unknown=set();names=[]
 cap={p['name']:p.get('capMs',p.get('maxHoldMs')) for p in policies}
 # Stream sixteen exit accounts at once. Loading every token's full expanded
 # result matrix into Python would multiply memory by hundreds of exit variants.
 all_names=list(choices)
 (root/'accounts').mkdir(parents=True,exist_ok=True)
 for offset in range(0,len(all_names),16):
  batch=all_names[offset:offset+16];files={};counts={n:0 for n in batch}
  try:
   for name in batch:
    files[name]=(root/'accounts'/f'{name}.json.tmp').open('w');files[name].write('{"tokens":{')
   for t,js in db.execute('select token,value from models'):
    z=unpack_results(json.loads(js))
    if not facts[t].get('passed') or not eligible(facts[t],spec):continue
    for name in batch:
     choice=choices[name][t]
     results={label:z['results'][f'{choice}:{lag}'] for label,lag in [('adaptive',1200),('fast_sell',600),('slow_sell',2000)]}
     if any(r['status'] not in ('closed','buy_reverted','entry_price_rejected') for r in results.values()):unknown.add(z['entry'])
     hold=cap.get(choice,int(choice.split('_')[1])*1000 if choice.startswith('joint_') else 45000)
     tp=float(choice.split('_')[2]) if choice.startswith('joint_') else z['tp']
     value={k:v for k,v in z.items() if k not in ('selector_results','results')}
     value.update(results=results,sized_results={},collection_hold_ms=hold,tp=tp,selected_exit=choice)
     if choice!='fixed_45':value['request_sha256']=None
     f=files[name]
     if counts[name]:f.write(',')
     f.write(json.dumps(t)+':');json.dump(value,f,separators=(',',':'));counts[name]+=1
   for name,f in files.items():
    f.write('},"exit_policy":'+json.dumps(name)+',"source":"exit-models.sqlite","selector_assumption":"Common completed broad cohort; pinned choices"}')
    f.close();(root/'accounts'/f'{name}.json.tmp').replace(root/'accounts'/f'{name}.json');names.append(name)
  finally:
   for f in files.values():f.close()
  print('Account exit candidates',len(names),'/',len(all_names),flush=True)
 db.close()
 write_json(root/'accounts/coverage.json',dict(unknown=sorted(unknown),meaning='Union of unavailable eligible executions across all exit policies and sell-delay scenarios'))
 write_json(root/'accounts/index.json',dict(names=names,models_sha256=digest(root/'exit-models.sqlite'),files={n:digest(root/'accounts'/f'{n}.json') for n in names}))
 print('Account exit candidates',len(names),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',default='data/research/20260912-grid');build(p.parse_args().root)
