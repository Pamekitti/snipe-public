"""Read the latest grid's durable counters without ranking unfinished work."""
import argparse,json,re
from pathlib import Path

def status(root=None):
 if root is None:
  latest=Path('data/research/latest-grid')
  root=latest if latest.exists() else Path('data/research/20260912-grid')
 root=Path(root)
 read=lambda p:json.loads(p.read_text()) if p.exists() else None
 run=read(root/'run.json')
 report=read(root/'report-status.json')
 output=dict(root=str(root.resolve()),capture=run.get('capture') if run else None,
             guard_configurations=run.get('core_count') if run else None,
             snapshot_complete=(root/'snapshot.json.gz').exists(),merged_dataset=(root/'dataset.json').exists(),
             pipeline=read(root/'status.json') or read(root/'pipeline-status.json'),
             superseded=read(root/'superseded.json'),
             selection_locked=(root/'locked-selection.json').exists(),
             report_generated=(root/'report.html').exists(),
             report_complete=bool(report and report.get('complete')),
             note='Counters report work completed. Selection and report generation do not establish validation or live approval.')
 pipeline=output['pipeline'] or {}
 if pipeline.get('estimate_scope')=='unavailable':pipeline['estimated_remaining_seconds']=None
 source=read(root/'acquisition-source.json')
 acquisition_root=Path(source['root']) if source else root
 log=acquisition_root/'acquire/run.log'
 if log.exists():
  with log.open('rb') as f:
   f.seek(max(0,log.stat().st_size-16000));tail=f.read().decode(errors='replace')
  progress=re.findall(r'(paths \d+/\d+|fallback timestamp headers \d+/\d+|coverage headers \d+ / \d+)',tail)
  output['acquisition_progress']=progress[-1] if progress else None
 print(json.dumps(output,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root');status(p.parse_args().root)
