"""Resumable full-account guard grid. Historical seed runs are labeled explicitly."""
import argparse,json,sqlite3,time,hashlib
from pathlib import Path
from dataclasses import asdict,replace
from .data import read_json,write_json,digest,HOUR
from .long_history import observations_for,external_controls
from . import long_history
from .indicator_study import configured_policy,trades_for,make_tapes
from .indicators import SignalTape
from .grid_guard import GridGuard,GridRule,grid
from .account import simulate
from .guard_visual import close_cash
from .fidelity import cash_metrics
from .evaluation import recovery_losses
from .grid_clock import publications,recorded_publications
from .grid_controls import experiment_controls,interval_controls,opportunity_policy
from .grid_score_store import initialize as initialize_scores,insert as insert_score

START=1788220800000

def run(args):
 long_history.SOURCE=Path(args.snapshot)
 START=args.start
 RuleClass,GuardClass,rule_grid=GridRule,GridGuard,grid
 if getattr(args,"engine","legacy")=="expanded":
  from .grid_v2_guard import Rule,Guard,core
  RuleClass,GuardClass,rule_grid=Rule,Guard,core
 out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
 raw=read_json(Path(args.snapshot));models=read_json(Path(args.models))
 shadow_models=read_json(Path(args.shadow_models)) if getattr(args,'shadow_models',None) else models
 end=min(raw['snapshot_at'],args.end or raw['snapshot_at'])
 passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
 models={**models,'tokens':{t:z for t,z in models['tokens'].items() if t in passed}}
 shadow_models={**shadow_models,'tokens':{t:z for t,z in shadow_models['tokens'].items() if t in passed}}
 if getattr(args,'engine','legacy')=='expanded':
  if any(z.get('entry_mode') is not None and z['entry_mode']!=args.scenario_mode for z in models['tokens'].values()):raise ValueError('Entry timing label does not match repriced inputs')
  if getattr(args,'shadow_models',None) and any(z.get('entry_mode') is not None and z['entry_mode']!='recorded' for z in shadow_models['tokens'].values()):raise ValueError('Shadow account must retain independent recorded timing')
 base=configured_policy(raw)
 always=replace(base,name='market_disabled',market_enabled=False)
 shadow_policy=replace(base,name='shadow',market_enabled=False,account_pauses_enabled=False,touch_enabled=False)
 obs=observations_for(raw,shadow_models,args.scenario_mode=='reconstructed_early' and getattr(args,'engine','legacy')=='legacy')
 controls=experiment_controls(raw,args.recorded_controls) if getattr(args,'engine','legacy')=='expanded' else external_controls(raw) if args.recorded_controls else []
 trades=trades_for(models,args.variant)
 shadow_trades=trades_for(shadow_models,'adaptive')
 all_unknown=sorted({t['entry'] for t in trades if t.get('unsupported') and START-7*HOUR<=t['entry']<end})
 if args.coverage:all_unknown=[at for at in read_json(Path(args.coverage))['unknown'] if START-7*HOUR<=at<end]
 unknown=[at for at in all_unknown if at>=START]
 warm_boundary=max((at+180000 for at in all_unknown if at<START),default=START-7*HOUR)
 intervals=[];cursor=START
 if args.scope=='strict_prefix':
  boundary=min(unknown,default=end)
  if boundary>START and warm_boundary<=START:intervals.append((START,boundary))
 else:
  cursor=max(cursor,warm_boundary)
  for at in unknown:
   if at-cursor>360000:intervals.append((cursor,at))
   cursor=max(cursor,at+180000)
  if end-cursor>360000:intervals.append((cursor,end))
 rules=[RuleClass(),*([RuleClass(**r) for r in read_json(Path(args.rules))] if args.rules else list(rule_grid()))];rules=list({r.name:r for r in rules}.values())
 compact=getattr(args,'score_storage','auto')=='compact' or (getattr(args,'score_storage','auto')=='auto' and getattr(args,'engine','legacy')=='expanded')
 ident=dict(score_storage='compact' if compact else 'legacy',snapshot=digest(Path(args.snapshot)),models=digest(Path(args.models)),shadow_models=digest(Path(args.shadow_models)) if getattr(args,'shadow_models',None) else None,start=START,end=end,variant=args.variant,scope=args.scope,seed=args.seed,scenario_mode=args.scenario_mode,publication_delay=args.publication_delay,recorded_controls=args.recorded_controls,coverage=digest(Path(args.coverage)) if args.coverage else None,rules=[asdict(r) for r in rules],source={p.name:digest(p) for p in [Path(__file__),*[Path(__file__).with_name(n+'.py') for n in ('grid_guard','grid_v2_guard','grid_batch_guard','grid_score_store','grid_clock','grid_controls','account','long_history','indicator_study','indicators','evaluation','fidelity','guard_visual')]]})
 path=out/'design.json'
 if path.exists() and read_json(path)!=ident:raise ValueError('checkpoint identity mismatch')
 write_json(path,ident);write_json(out/'coverage.json',dict(intervals=intervals,unknown=unknown,start=START,end=end,shadow_initialization=max(START-7*HOUR,warm_boundary)))
 recorded=recorded_publications(raw) if getattr(args,'engine','legacy')=='expanded' else {}
 db=sqlite3.connect(out/'scores.sqlite');initialize_scores(db,rules,compact)
 for segment,(a,b) in enumerate(intervals):
  warm=max(a-7*HOUR,max((at+180000 for at in all_unknown if at<a),default=a-7*HOUR)) if segment==0 else a
  selected=[t for t in trades if a<=t['entry']<b-180000]
  shadow=simulate(obs,[t for t in shadow_trades if warm<=t['entry']<b-180000],shadow_policy,warm,b)
  if not shadow['complete']:raise ValueError('shadow interval incomplete')
  tapes,missing=make_tapes(raw,shadow_models,shadow,obs)
  records=publications(tapes['matched'].records,shadow_models['tokens'],args.publication_delay,recorded)
  tape=SignalTape(records)
  segment_controls=interval_controls(controls,a)
  reference=simulate(obs,selected,always,a,b,controls=segment_controls)
  unrestricted=simulate(obs,selected,opportunity_policy(base,len(selected)),a,b)
  write_json(out/f'unrestricted-{segment}.json',dict(cash=close_cash(unrestricted),complete=unrestricted['complete']))
  write_json(out/f'reference-{segment}.json',dict(cash=close_cash(reference),complete=reference['complete'],records=records,missing=missing))
  done={name for name, in db.execute('select name from scores where segment=?',(segment,))}
  account_cache={};derived_cache={}
  before=time.monotonic()
  ordinals={r.name:i for i,r in enumerate(rules)}
  pending=[r for r in rules if r.name not in done]
  entries=[t['entry'] for t in selected]
  def scalar_transitions():
   for rule in pending:
    guard=GuardClass(tape,rule,base.size_wei,a,entries,segment_controls)
    for at in sorted(x for x in guard.schedule if a<=x<b):guard.read(at)
    yield rule,guard.transitions
  if getattr(args,'engine','legacy')=='expanded':
   from .grid_batch_guard import grouped_transitions
   compiled=grouped_transitions(tape,pending,base.size_wei,a,b,entries,segment_controls)
  else:compiled=scalar_transitions()
  for completed,(rule,transitions) in enumerate(compiled,start=len(done)+1):
   i=ordinals[rule.name]
   fingerprint=(rule.age_min,tuple((r['at'],r['allow']) for r in transitions))
   value=account_cache.get(fingerprint)
   if value is None:
    guard=GuardClass(tape,rule,base.size_wei,a,[t['entry'] for t in selected],segment_controls)
    result=simulate(obs,selected,base,a,b,guard=guard,controls=segment_controls,derived_cache=derived_cache)
    cash=close_cash(result)
    value=dict(complete=result['complete'],metrics=cash_metrics(cash),recovery=recovery_losses(result,b),cash=cash)
    account_cache[fingerprint]=value
   account_id=hashlib.sha256(json.dumps((segment,fingerprint)).encode()).hexdigest()
   insert_score(db,segment,rule,i,account_id,value,compact)
   if completed%100==0 or completed==len(rules):db.commit();write_json(out/'progress.json',dict(at=int(time.time()*1000),segment=segment,segments=len(intervals),completed=completed,total=len(rules),elapsed=time.monotonic()-before));print('segment',segment,'/',len(intervals),'guards',completed,'/',len(rules),'elapsed',round(time.monotonic()-before),flush=True)
  db.commit()
 db.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--snapshot',required=True);p.add_argument('--models',required=True);p.add_argument('--out',required=True);p.add_argument('--variant',default='adaptive');p.add_argument('--end',type=int);p.add_argument('--seed',action='store_true');p.add_argument('--start',type=int,default=1788220800000);p.add_argument('--scenario-mode',choices=['reconstructed_early','recorded'],default='reconstructed_early');p.add_argument('--publication-delay',type=int,default=0);p.add_argument('--recorded-controls',action='store_true');p.add_argument('--score-storage',choices=['auto','legacy','compact'],default='auto');p.add_argument('--shadow-models');p.add_argument('--engine',choices=['legacy','expanded'],default='legacy');p.add_argument('--rules');p.add_argument('--coverage');p.add_argument('--scope',choices=['conditional','strict_prefix'],default='conditional');run(p.parse_args())
