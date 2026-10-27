"""Compare every batched exit with scalar replay before using the accelerator."""
import argparse,gzip,json,time
from pathlib import Path
from .data import Worker,write_json,digest
from .grid_exits import exits,variant

def run(root=Path('data/research/20260912-grid')):
 cases=json.loads(gzip.decompress(Path('test/fixtures/replay-before-extraction.json.gz').read_bytes()))['cases']
 root=Path(root);count=0;started=time.monotonic()
 extra=json.loads((root/'candidate-exits.json').read_text())['policies'] if (root/'candidate-exits.json').exists() else []
 with Worker(Path('research/core/grid_worker.ts')) as w:
  for i,c in enumerate(cases):
   req=c['request'];vs=[variant(p,req['rules']) for p in exits()]
   if extra:vs += [variant(p,req['rules']) for p in extra]
   vs += [dict(takeProfit=tp,sellDelayMs=lag) for tp in (1.25,1.36,1.5,1.75,2,2.5,3) for lag in (600,1200,2000)]
   batch=w.call(op='replay_many',request=req,variants=vs)
   for v,actual in zip(vs,batch):
    expected=w.call(**{**req,**v})
    if actual!=expected:raise AssertionError(dict(case=i,variant=v,actual=actual,expected=expected))
    count+=1
   if i%20==0:print('batch parity',i+1,'/',len(cases),flush=True)
 write_json(root/'batch-parity.json',dict(exact_cases=len(cases)*69,expanded_exact_cases=count,exit_catalog_sha256=digest(root/'candidate-exits.json') if extra else None,seconds=time.monotonic()-started,hashes={str(p):digest(p) for p in [Path('research/core/grid_batch_replay.ts'),Path('research/core/grid_replay.ts'),Path('research/core/grid_worker.ts')]}))
 print('Exact batched exit comparisons',count,flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',default='data/research/20260912-grid');run(p.parse_args().root)
