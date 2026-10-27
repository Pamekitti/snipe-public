"""Runtime/parity pilot on frozen history; never a strategy selection artifact."""
from dataclasses import replace
from pathlib import Path
import time
from .data import read_json,write_json
from .long_history import ROOT,SOURCE,observations_for
from .indicator_study import configured_policy,trades_for
from .grid_guard import GridGuard,GridRule,grid
from .indicators import SignalTape
from .account import simulate
from .guard_visual import close_cash
from .fidelity import cash_metrics

def main():
 raw=read_json(SOURCE);models=read_json(ROOT/'models.json')
 base=configured_policy(raw)
 prior=read_json(Path('data/research/20260911-fresh-live/september/runs/reconstructed_early-adaptive-00.json'))
 tape=SignalTape(prior['shadow_records'])
 a,b=prior['start'],prior['end']
 obs=observations_for(raw,models,True)
 passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
 trades=[t for t in trades_for(models,'adaptive') if t['token'] in passed and a<=t['entry']<b-180000]
 rows=[]
 for rule in [GridRule(),*list(grid())[:20]]:
  guard=GridGuard(tape,rule,base.size_wei,a,[t['entry'] for t in trades])
  before=time.monotonic()
  run=simulate(obs,trades,base,a,b,guard=guard)
  rows.append(dict(rule=guard.definition(),seconds=time.monotonic()-before,complete=run['complete'],metrics=cash_metrics(close_cash(run))))
 write_json(Path('data/research/20260912-grid/pilot.json'),dict(purpose='runtime only, old input; not selection',rows=rows))
 print('pilot',len(rows),'seconds',sum(r['seconds'] for r in rows),flush=True)
if __name__=='__main__':main()
