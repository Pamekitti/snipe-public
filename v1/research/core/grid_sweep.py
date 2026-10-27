"""Resumable full-account guard grid. Historical seed runs are labeled explicitly."""
import argparse,json,sqlite3,time
from pathlib import Path
from dataclasses import asdict,replace
from .data import read_json,write_json,digest,HOUR
from .long_history import observations_for
from .indicator_study import configured_policy,trades_for,make_tapes
from .indicators import SignalTape
from .grid_guard import GridGuard,GridRule,grid
from .account import simulate
from .guard_visual import close_cash
from .fidelity import cash_metrics
from .evaluation import recovery_losses

START=1788220800000

def run(args):
 out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
 raw=read_json(Path(args.snapshot));models=read_json(Path(args.models))
 end=min(raw['snapshot_at'],args.end or raw['snapshot_at'])
 passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
 models={**models,'tokens':{t:z for t,z in models['tokens'].items() if t in passed}}
 base=configured_policy(raw)
 always=replace(base,name='market_disabled',market_enabled=False)
 shadow_policy=replace(base,name='shadow',market_enabled=False,account_pauses_enabled=False,touch_enabled=False)
 obs=observations_for(raw,models,True)
 trades=trades_for(models,args.variant)
 unknown=sorted({t['entry'] for t in trades if t.get('unsupported') and START<=t['entry']<end})
 intervals=[];cursor=START
 for at in unknown:
  if at-cursor>360000:intervals.append((cursor,at))
  cursor=max(cursor,at+180000)
 if end-cursor>360000:intervals.append((cursor,end))
 ident=dict(snapshot=digest(Path(args.snapshot)),models=digest(Path(args.models)),end=end,variant=args.variant,scope='conditional intervals; historical seed, not final selection' if args.seed else 'conditional intervals',rules=[asdict(r) for r in grid()],source={p.name:digest(p) for p in [Path(__file__),Path(__file__).with_name('grid_guard.py'),Path(__file__).with_name('account.py')]})
 path=out/'design.json'
 if path.exists() and read_json(path)!=ident:raise ValueError('checkpoint identity mismatch')
 write_json(path,ident);write_json(out/'coverage.json',dict(intervals=intervals,unknown=unknown,start=START,end=end))
 db=sqlite3.connect(out/'scores.sqlite');db.execute('create table if not exists scores(segment integer,name text,rule text,value text,primary key(segment,name))')
 rules=[GridRule(),*list(grid())];rules=list({r.name:r for r in rules}.values())
 for segment,(a,b) in enumerate(intervals):
  warm=a-7*HOUR if segment==0 else a
  selected=[t for t in trades if a<=t['entry']<b-180000]
  shadow=simulate(obs,[t for t in trades if warm<=t['entry']<b-180000],shadow_policy,warm,b)
  if not shadow['complete']:raise ValueError('shadow interval incomplete')
  tapes,missing=make_tapes(raw,models,shadow,obs)
  records=[]
  for r in tapes['matched'].records:
   z=models['tokens'][r['token']]
   complete=z['entry']+z.get('send_delay_ms',0)+z.get('open_delay_ms',0)+45000+14000
   records.append(dict(r,available=((max(r['available']-1,complete)+999)//1000)*1000+1))
  tape=SignalTape(records)
  reference=simulate(obs,selected,always,a,b)
  write_json(out/f'reference-{segment}.json',dict(cash=close_cash(reference),complete=reference['complete'],records=records,missing=missing))
  done={name for name, in db.execute('select name from scores where segment=?',(segment,))}
  before=time.monotonic()
  for i,rule in enumerate(rules):
   if rule.name in done:continue
   guard=GridGuard(tape,rule,base.size_wei,a,[t['entry'] for t in selected])
   result=simulate(obs,selected,base,a,b,guard=guard)
   cash=close_cash(result)
   value=dict(complete=result['complete'],metrics=cash_metrics(cash),recovery=recovery_losses(result,b),cash=cash,transitions=guard.transitions)
   db.execute('insert into scores values (?,?,?,?)',(segment,rule.name,json.dumps(asdict(rule)),json.dumps(value)))
   if i%100==0:db.commit();print('segment',segment,'/',len(intervals),'guards',i+1,'/',len(rules),'elapsed',round(time.monotonic()-before),flush=True)
  db.commit()
 db.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--snapshot',required=True);p.add_argument('--models',required=True);p.add_argument('--out',required=True);p.add_argument('--variant',default='adaptive');p.add_argument('--end',type=int);p.add_argument('--seed',action='store_true');run(p.parse_args())
