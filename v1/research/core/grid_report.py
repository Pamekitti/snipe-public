"""Render a complete grid artifact; refuse rankings from partially processed grids."""
import argparse,json,sqlite3,html
from itertools import groupby
from pathlib import Path
from datetime import datetime,timezone
from .data import read_json,write_json
from .grid_guard import GridRule
from .fidelity import cash_metrics
from .september_guard_report import ratios

def run(root):
 import plotly.graph_objects as go
 from plotly.subplots import make_subplots
 root=Path(root);design=read_json(root/'design.json');coverage=read_json(root/'coverage.json')
 db=sqlite3.connect('file:'+str(root/'scores.sqlite')+'?mode=ro',uri=True)
 expected=len(design['rules']);segments=len(coverage['intervals'])
 counts=dict(db.execute('select segment,count(*) from scores group by segment'))
 if any(counts.get(i)!=expected for i in range(segments)):raise ValueError(f'Grid incomplete: {counts}; need {expected} per segment')
 def expand(value):
  row=json.loads(value)
  return json.loads(db.execute('select value from accounts where id=?',(row['account_id'],)).fetchone()[0]) if 'account_id' in row else row
 names=[r[0] for r in db.execute('select name from scores where segment=0')]
 refs=[read_json(root/f'reference-{i}.json') for i in range(segments)]
 refcash=sorted([x for ref in refs for x in ref['cash']],key=lambda r:(r['at'],r['id']))
 denom=cash_metrics(refcash);cards={}
 for name,group in groupby(db.execute('select name,value from scores order by name,segment'),key=lambda row:row[0]):
  chunks=[expand(v) for _,v in group]
  cash=sorted([x for r in chunks for x in r['cash']],key=lambda r:(r['at'],r['id']))
  metrics=cash_metrics(cash)
  cards[name]=dict(metrics=metrics,kpis=ratios(metrics,denom),complete=all(r['complete'] for r in chunks))
 write_json(root/'scorecards.json',dict(scope=design['scope'],denominator='Market guard removed; all other account stops retained',cards=cards))
 baseline=GridRule().name
 best=max(names,key=lambda n:int(cards[n]['metrics']['net_wei']))
 safest=min(names,key=lambda n:(int(cards[n]['metrics']['drawdown_wei']),-int(cards[n]['metrics']['net_wei'])))
 selected=list(dict.fromkeys([baseline,best,safest]))
 fig=make_subplots(rows=3,cols=1,subplot_titles=('Conditional cash by complete interval (not wallet earnings)','Conditional drawdown by interval','Four retained KPIs; lower losses retained is better'))
 for name in ['market_disabled',*selected]:
  chunks=refs if name=='market_disabled' else [expand(v) for v, in db.execute('select value from scores where name=? order by segment',(name,))]
  x=[];cash=[];dd=[]
  for chunk in chunks:
   total=peak=0
   for r in chunk['cash']:
    total+=r['pnl'];peak=max(peak,total)
    x.append(datetime.fromtimestamp(r['at']/1000,timezone.utc));cash.append(total/1e18);dd.append((peak-total)/1e18)
   x.append(None);cash.append(None);dd.append(None)
  label='Baseline' if name==baseline else 'Highest training net' if name==best else 'Lowest training DD' if name==safest else 'Market guard removed'
  fig.add_trace(go.Scatter(x=x,y=cash,name=label,connectgaps=False),row=1,col=1)
  fig.add_trace(go.Scatter(x=x,y=dd,name=label,showlegend=False,connectgaps=False),row=2,col=1)
  if name!='market_disabled':fig.add_trace(go.Bar(x=['Wins','Losses','Winning money','Losing money'],y=list(cards[name]['kpis'].values()),name=label,showlegend=False),row=3,col=1)
 fig.update_layout(height=1100,template='plotly_white',barmode='group',title='September grid: retrospective training comparison')
 fig.update_yaxes(title_text='ETH',row=1,col=1);fig.update_yaxes(title_text='ETH',row=2,col=1);fig.update_yaxes(title_text='Retained %',row=3,col=1)
 frontier=go.Figure(go.Scattergl(x=[int(cards[n]['metrics']['drawdown_wei'])/1e18 for n in names],y=[int(cards[n]['metrics']['net_wei'])/1e18 for n in names],mode='markers',text=names,marker=dict(size=4,opacity=.3)))
 frontier.update_layout(template='plotly_white',title='Training profit/drawdown tradeoffs, all guard configurations',xaxis_title='Conditional cumulative drawdown (ETH)',yaxis_title='Conditional net profit (ETH)')
 warning='Training results only. No prospective claim, no live recommendation. Intervals restart independently; graphs contain gaps. Exit and later-period studies must finish before selection.'
 body='<html><meta charset="utf-8"><title>September guard grid</title><body><h1>September guard grid</h1><p>'+html.escape(warning)+'</p>'+fig.to_html(full_html=False,include_plotlyjs=True)+frontier.to_html(full_html=False,include_plotlyjs=False)+'</body></html>'
 (root/'report.html').write_text(body)
 print(root/'report.html',flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);run(p.parse_args().root)
