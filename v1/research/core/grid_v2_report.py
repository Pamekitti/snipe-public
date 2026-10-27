"""Expanded-grid report, chronological evidence and explicit recommendation limits."""
import argparse,json,math,sqlite3,html
from pathlib import Path
from datetime import datetime,timezone
from .data import read_json,write_json,digest,DAY,HOUR
from .grid_v2_run import verify
from .grid_v2_guard import Rule,Guard
from .grid_scorecards import collect
from .grid_final_report import chunks
CENTRAL="recorded--adaptive--delay0--controls0"
from .fidelity import cash_metrics
from .september_guard_report import ratios

def run(root):
 import plotly.graph_objects as go
 from plotly.subplots import make_subplots
 from . import grid_final_report as report
 root=Path(root);m=verify(root)
 report.GridRule=Rule;report.FIT_END=m['fit_end'];report.CENTRAL=CENTRAL
 coarse=root/'core/fixed_45--recorded--adaptive'
 if coarse.exists():
  destination=root/'joint_coarse/fixed_45--reconstructed_early--adaptive/scorecards.json'
  write_json(destination,collect(coarse))
 report.run(root)
 comparison=read_json(root/'comparison.json');reports=list(comparison['reports'].values())
 baseline={ (x['job']['scenario'],x['job']['scope']):x for x in reports if x['job']['exit']=='fixed_45'}
 candidates={}
 for x in reports:
  key=(x['job']['scenario'],x['job']['scope']);base=baseline[key]
  for name,card in x['periods']['validation']['cards'].items():
   b=base['periods']['validation']['cards'][Rule().name]
   identity=x['job']['exit']+'::'+name
   complete=card['complete'] and b['complete']
   passes=complete and int(card['metrics']['net_wei'])>int(b['metrics']['net_wei']) and int(card['metrics']['drawdown_wei'])<=int(b['metrics']['drawdown_wei']) and int(card['recovery_loss_wei'])<=int(b['recovery_loss_wei']) and card['losing_recoveries']<=b['losing_recoveries']
   candidates.setdefault(identity,[]).append(dict(scenario=key,passes=passes,complete=complete,card=card,baseline=b))
 ranked=sorted(candidates,key=lambda k:(-sum(r['passes'] for r in candidates[k]),-min(int(r['card']['metrics']['net_wei']) for r in candidates[k])))
 # A conditional success cannot override missing strict continuous evidence.
 qualified=[k for k in ranked if len(candidates[k])==16 and all(r['passes'] for r in candidates[k])]
 folds=read_json(root/'folds/completed.json')
 fold_evidence=[]
 for f in folds['folds']:
  fr=Path(f['root']);jobs=read_json(fr/'validation/jobs.json')['jobs']
  fold_evidence.append(dict(**f,scorecards={str(Path(j['output'])/'evaluation-scorecards.json'):read_json(Path(j['output'])/'evaluation-scorecards.json') for j in jobs}))
 verdict=dict(status='diagnostic_only',recommendation='No supported live replacement established',
              evaluation_dominators=qualified,ranked_candidates=ranked,candidates=candidates,
              reason='Historical ranking is descriptive. Current-capture cash fidelity, fold stability, neighborhood stability and new observations are mandatory before a supported replacement claim.',
              folds=fold_evidence,live_changes=False)
 write_json(root/'decision.json',verdict)
 # Daily summaries and actual recorded indicator/guard timeline for the loss day.
 raw=read_json(root/'snapshot.json.gz');day=m['capture']//DAY*DAY
 central=[r for r in reports if r['job']['scenario']==CENTRAL and r['job']['scope']=='conditional']
 daily={}
 for x in central:
  path=Path(x['job']['output']);cov=x['periods']['all']['coverage']['intervals']
  reference=[z for i in range(len(cov)) for z in read_json(path/f'reference-{i}.json')['cash']]
  for name in x['periods']['all']['cards']:
   cash=[z for part in chunks(path,name) for z in part['cash']]
   daily[x['job']['exit']+'::'+name]=[dict(start=a,end=min(a+DAY,m['capture']),metrics=cash_metrics([z for z in cash if a<=z['at']<min(a+DAY,m['capture'])]),kpis=ratios(cash_metrics([z for z in cash if a<=z['at']<min(a+DAY,m['capture'])]),cash_metrics([z for z in reference if a<=z['at']<min(a+DAY,m['capture'])]))) for a in range(m['start'],m['capture'],DAY)]
 write_json(root/'daily.json',daily)
 decisions=[]
 for row in raw.get('bot_shadow_decisions',[]):
  if day<=row['at']<m['capture']:
   value=json.loads(row['reading']);decisions.append(dict(at=row['at'],**value))
 decisions.sort(key=lambda r:r['at'])
 fig=make_subplots(rows=3,cols=1,shared_xaxes=True,subplot_titles=('Recorded adaptive indicator today','Recorded market guard permission','Actual completed cash today'))
 dt=lambda t:datetime.fromtimestamp(t/1000,timezone.utc)
 for field,label in [('sum','Main window'),('recentSum','Fresh window')]:fig.add_trace(go.Scatter(x=[dt(r['at']) for r in decisions],y=[r.get(field) for r in decisions],name=label),row=1,col=1)
 fig.add_trace(go.Scatter(x=[dt(r['at']) for r in decisions],y=[int(r.get('state')=='open') for r in decisions],name='Market permission',line_shape='hv'),row=2,col=1)
 from .execution import booked
 cash=sorted([dict(at=p['exit_at'],pnl=booked(p),id=p['id']) for p in raw['bot_positions'] if p.get('live') and p.get('closed') and day<=(p.get('exit_at') or 0)<m['capture']],key=lambda r:r['at'])
 total=0;yy=[]
 for r in cash:total+=r['pnl'];yy.append(total/1e18)
 fig.add_trace(go.Scatter(x=[dt(r['at']) for r in cash],y=yy,name='Actual today ETH',line_shape='hv'),row=3,col=1)
 fig.update_layout(height=950,template='plotly_white',title='Today: recorded evidence, guard and actual cash (UTC)')
 fig.update_yaxes(title_text='Stakes',row=1,col=1);fig.update_yaxes(title_text='Open = 1',row=2,col=1);fig.update_yaxes(title_text='ETH',row=3,col=1)
 # Counts distinguish rule-by-stress evaluations from unique effective policies.
 counts=[];unique=set()
 for plan_path in sorted(root.rglob('jobs.json')):
  plan=read_json(plan_path)
  if 'jobs' not in plan:continue
  count=0
  for job in plan['jobs']:
   design_path=Path(job['output'])/'design.json'
   if not design_path.exists():continue
   design=read_json(design_path);count+=len(design['rules'])
   for rule in design['rules']:unique.add(job['exit']+'::'+Rule(**rule).name)
  counts.append(dict(stage=str(plan_path.parent.relative_to(root)),rule_stress_evaluations=count,jobs=len(plan['jobs'])))
 metadata=dict(start=m['start'],capture=m['capture'],fit_end=m['fit_end'],reserved_start=m['reserved_start'],unique_effective_policies=len(unique),stages=counts,scenarios=m['scenarios'],timing_assumptions=m.get('entry_timing_assumptions'),controls='Common recorded operator controls in every executable account; controls1 also overlays recorded non-market stops independently.',opportunity_reference='Static eligible opportunities without account stops, capacity or repeat-template restrictions; not an executable wallet.',retrospective=True,additional_family_search='Single families, pairwise frontier combinations and one neighbor refinement; not exhaustive over every family combination.')
 write_json(root/'experiment-summary.json',metadata)
 prospective=read_json(root/'prospective-observations/summary.json') if (root/'prospective-observations/summary.json').exists() else {'status':'unavailable','candidate_performance_assessed':False}
 fidelity=read_json(root/'cash-fidelity/fidelity.json') if (root/'cash-fidelity/fidelity.json').exists() else {'status':'unavailable'}
 table=[]
 for identity in ranked[:25]:
  rows=candidates[identity];example=next((r for r in rows if r['scenario']==(CENTRAL,'conditional')),rows[0]);card=example['card']
  kpis=list(card['kpis'].values())
  cells=[identity,str(sum(r['passes'] for r in rows))+'/'+str(len(rows)),f"{int(card['metrics']['net_wei'])/1e18:.6f}",f"{int(card['metrics']['drawdown_wei'])/1e18:.6f}",str(card['losing_recoveries']),*[f'{v:.1f}%' if v is not None else 'N/A' for v in kpis]]
  table.append('<tr>'+''.join('<td>'+html.escape(c)+'</td>' for c in cells)+'</tr>')
 headers=['Candidate','Improves baseline scenarios','Evaluation net ETH','Evaluation drawdown ETH','Losing recoveries','Wins retained','Losses retained','Winning money retained','Losing money retained']
 extra=fig.to_html(full_html=False,include_plotlyjs=False)
 extra+='<h2>Evaluation profit and risk ranking</h2><p>Top 25 by the number of scenario comparisons improving baseline, then worst net return. Displayed KPIs use recorded entry timing and complete intervals. This descriptive ranking does not change the training selection.</p><div style="overflow-x:auto"><table><tr>'+''.join('<th>'+h+'</th>' for h in headers)+'</tr>'+''.join(table)+'</table></div>'
 extra+='<h2>Coverage and verification</h2><p>'+html.escape(metadata['controls'])+'</p><p>'+html.escape(metadata['opportunity_reference'])+'</p><pre>'+html.escape(json.dumps(dict(experiment=metadata,fidelity_status=fidelity.get('status'),prospective=prospective),indent=2))+'</pre><p>All candidates and folds: decision.json. Daily KPIs: daily.json. Full cash-fidelity checks: cash-fidelity/fidelity.json. New candidate-account observations are not yet validated.</p>'
 page=root/'report.html';body=page.read_text();body=body.replace('</html>',extra+'</html>') if '</html>' in body else body+extra;page.write_text(body)
 from .grid_v2_lines import render
 render(root,m,ranked)
 write_json(root/'report-status.json',dict(report_sha256=digest(page),decision_sha256=digest(root/'decision.json'),visual_review='pending',fidelity='diagnostic_only',complete=False))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);run(p.parse_args().root)
