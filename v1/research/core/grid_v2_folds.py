"""Expanding fit/evaluate cycles, with independent candidate selection in each fold."""
import argparse,subprocess,sys
from pathlib import Path
from .data import write_json,read_json,digest
from .grid_v2_run import verify,selection

def reuse_identical_training(root,out,m,fold):
 # The September 7 fold has exactly the main fit cutoff. Its evaluation remains
 # independent, but recalculating all fit accounts would duplicate the same work.
 if fold['fit_end']!=m['fit_end']:return False
 parent=read_json(root/'locked-selection.json')
 if parent['run_sha256']!=digest(root/'run.json'):raise ValueError('Parent selection identity mismatch')
 for phase in ('core','families','exits','cross','pairs','pair_cross','refine','expand'):
  target=out/phase
  if not target.exists():target.symlink_to((root/phase).resolve(),target_is_directory=True)
 # Reselect from verified training score files. No evaluation rows are consumed.
 selection(out,['cross','pair_cross','refine','expand'],'locked-selection.json')
 current=read_json(out/'locked-selection.json')
 if current['candidates']!=parent['candidates']:raise ValueError('Identical-cutoff selection differs')
 write_json(out/'training-reuse.json',dict(source=str(root.resolve()),fit_end=m['fit_end'],
     source_run_sha256=digest(root/'run.json'),source_selection_sha256=digest(root/'locked-selection.json'),
     selection_recomputed=True,evaluation_reused=False))
 return True

def run(root):
 root=Path(root);m=verify(root);index=[]
 for i,fold in enumerate(m['folds']):
  out=root/'folds'/str(i);out.mkdir(parents=True,exist_ok=True)
  for name in ('snapshot.json.gz','accounts','candidate-exits.json','timings','coverage.json'):
   target=out/name
   if not target.exists():target.symlink_to((root/name).resolve(),target_is_directory=name in ('accounts','timings'))
  fm={**m,**fold,'parent_run_sha256':digest(root/'run.json')}
  if (out/'run.json').exists() and read_json(out/'run.json')!=fm:raise ValueError('Fold manifest mismatch')
  write_json(out/'run.json',fm)
  if not reuse_identical_training(root,out,m,fold):
   for phase in ('core','families','exits','cross','pairs','pair_cross','refine','expand'):
    subprocess.run([sys.executable,'-m','research.core.grid_v2_run','--root',str(out),'--action',phase],check=True)
  subprocess.run([sys.executable,'-m','research.core.grid_v2_validate','--root',str(out)],check=True)
  index.append(dict(root=str(out),**fold,selection_sha256=digest(out/'locked-selection.json')))
 write_json(root/'folds/completed.json',dict(folds=index))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);run(p.parse_args().root)
