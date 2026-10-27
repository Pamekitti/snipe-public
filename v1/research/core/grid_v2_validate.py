"""Evaluate locked expanded guards without feeding evaluation scores into selection."""
import argparse,subprocess,sys,time
from pathlib import Path
from dataclasses import asdict
from .data import read_json,write_json,digest
from .grid_v2_guard import Rule
from .grid_v2_run import verify,rules_file,account_path,coverage_path
from .grid_jobs import SCENARIOS,complete
from .grid_scorecards import collect

def run(root):
 root=Path(root);m=verify(root);sel=root/'locked-selection.json';frozen=read_json(sel)
 grouped={'fixed_45':{Rule().name:Rule()}}
 for x in frozen['candidates'].values():
  r=Rule(**x['rule']);grouped.setdefault(x['exit'],{})[r.name]=r
 scenarios=[dict(mode=a,variant=b,delay=0,controls=False) for a,b in SCENARIOS]
 scenarios.extend([dict(mode='recorded',variant='adaptive',delay=60000,controls=False),dict(mode='recorded',variant='adaptive',delay=0,controls=True)])
 index=[]
 for name,rules in grouped.items():
  rp=rules_file(root/'validation'/(name+'-rules.json'),list(rules.values()))
  for s in scenarios:
   for scope in ('conditional','strict_prefix'):
    label=f"{s['mode']}--{s['variant']}--delay{s['delay']}--controls{int(s['controls'])}"
    out=root/'validation'/f'{name}--{label}--{scope}'
    args=['--snapshot',str(root/'snapshot.json.gz'),'--models',str(account_path(root,s['mode'],name)),'--shadow-models',str(account_path(root,'recorded',name)),'--out',str(out),'--rules',str(rp),'--coverage',str(coverage_path(root)),'--engine','expanded','--start',str(m['start']),'--end',str(m.get('eval_end',m['capture'])),'--scenario-mode',s['mode'],'--variant',s['variant'],'--publication-delay',str(s['delay']),'--scope',scope]
    if s['controls']:args.append('--recorded-controls')
    index.append(dict(exit=name,scenario=label,scope=scope,output=str(out),args=args))
 identity=dict(selection_sha256=digest(sel),run_sha256=digest(root/'run.json'),jobs=index,coverage_sha256=digest(coverage_path(root)),models={str(account_path(root,mode,n)):digest(account_path(root,mode,n)) for mode in ('recorded','reconstructed_early') for n in grouped})
 jp=root/'validation/jobs.json'
 if jp.exists() and read_json(jp)!=identity:raise ValueError('Validation checkpoint mismatch')
 write_json(jp,identity);started=time.time()
 for i,job in enumerate(index):
  if (root/'pause.request').exists():raise RuntimeError('Research paused')
  out=Path(job['output']);stamp=out/'completed.json'
  if stamp.exists():
   if not complete(out) or read_json(stamp)['design_sha256']!=digest(out/'design.json'):raise ValueError('Invalid validation checkpoint')
  else:
   subprocess.run([sys.executable,'-m','research.core.grid_final_sweep',*job['args']],check=True)
   if not complete(out):raise ValueError('Incomplete validation')
   write_json(stamp,dict(design_sha256=digest(out/'design.json')))
  for label,lo,hi in [('full',m['start'],m.get('eval_end',m['capture'])),('evaluation',m['fit_end'],m.get('eval_end',m['reserved_start'])),('reserved',m['reserved_start'],m['capture'])]:
   if hi<=lo:continue
   write_json(out/(label+'-scorecards.json'),collect(out,lo,hi))
  write_json(root/'validation/progress.json',dict(at=int(time.time()*1000),completed=i+1,total=len(index),elapsed=time.time()-started))
 write_json(root/'validation/completed.json',dict(plan_sha256=digest(jp)))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);run(p.parse_args().root)
