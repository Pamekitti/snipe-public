"""Render completed locked-candidate comparisons with explicit evidence limitations."""
import argparse
import html
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from .data import read_json, write_json, digest, HOUR, DAY
from .grid_guard import GridRule
from .grid_jobs import FIT_END
from .grid_scorecards import collect
from .fidelity import cash_metrics
from .september_guard_report import ratios
from .execution import booked

CENTRAL='reconstructed_early--adaptive--delay0--controls0'


def chunks(path,name):
    intervals=read_json(path/'coverage.json')['intervals']
    with sqlite3.connect('file:'+str(path/'scores.sqlite')+'?mode=ro',uri=True) as db:
        result=[]
        for segment,value in db.execute('select segment,value from scores where name=? order by segment',(name,)):
            row=json.loads(value)
            value=json.loads(db.execute('select value from accounts where id=?',(row['account_id'],)).fetchone()[0])
            result.append(dict(value,start=intervals[segment][0],end=intervals[segment][1]))
        return result


def series(parts):
    x=[];cash=[];dd=[];total=peak=0
    for part in parts:
        if 'start' in part:
            x.append(datetime.fromtimestamp(part['start']/1000,timezone.utc));cash.append(total/1e18);dd.append((peak-total)/1e18)
        for row in part['cash']:
            total+=int(row['pnl']);peak=max(peak,total)
            x.append(datetime.fromtimestamp(row['at']/1000,timezone.utc));cash.append(total/1e18);dd.append((peak-total)/1e18)
        if 'end' in part:
            x.append(datetime.fromtimestamp(part['end']/1000,timezone.utc));cash.append(total/1e18);dd.append((peak-total)/1e18)
        x.append(None);cash.append(None);dd.append(None)
    return x,cash,dd


def run(root):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    root=Path(root);manifest=read_json(root/'validation/jobs.json');done=read_json(root/'validation/completed.json')
    if done['plan_sha256']!=digest(root/'validation/jobs.json'):raise ValueError('Validation manifest mismatch')
    raw=read_json(root/'snapshot.json.gz');end=raw['snapshot_at'];cut=end-6*HOUR
    jobs=manifest['jobs'];reports={}
    for job in jobs:
        path=Path(job['output'])
        periods={label:collect(path,lo,hi) for label,lo,hi in [('all',None,None),('validation',FIT_END,cut),('reserved6h',cut,end)]}
        reports[str(path)]=dict(job=job,periods=periods)
    # Exit changes have both their own always-on denominator and fixed-45s denominator.
    for report in reports.values():
        job=report['job']
        baseline=next(r for r in reports.values() if r['job']['exit']=='fixed_45' and r['job']['scenario']==job['scenario'] and r['job']['scope']==job['scope'])
        for period,score in report['periods'].items():
            fixed=baseline['periods'][period]['reference']
            path=Path(job['output']);segments=len(score['coverage']['intervals'])
            lo,hi=score['lo'],score['hi']
            unrestricted=[r for i in range(segments) for r in read_json(path/f'unrestricted-{i}.json')['cash'] if (lo is None or r['at']>=lo) and (hi is None or r['at']<hi)]
            opportunity=cash_metrics(unrestricted)
            score['unrestricted_reference']=opportunity
            for card in score['cards'].values():
                card['fixed_45_denominator_kpis']=ratios(card['metrics'],fixed)
                card['unrestricted_kpis']=ratios(card['metrics'],opportunity)
                card['profit_difference_from_own_reference_wei']=str(int(card['metrics']['profit_wei'])-int(score['reference']['profit_wei']))
                card['loss_avoided_vs_own_reference_wei']=str(int(score['reference']['loss_wei'])-int(card['metrics']['loss_wei']))
    write_json(root/'comparison.json',dict(capture=end,fit_end=FIT_END,reserve_start=cut,selection_sha256=manifest['selection_sha256'],reports=reports))
    central={r['job']['exit']:r for r in reports.values() if r['job']['scenario']==CENTRAL and r['job']['scope']=='conditional'}
    baseline_name=GridRule().name
    baseline=central['fixed_45']['periods']['all']['cards'].get(baseline_name)
    options=[(exit_name,name,card) for exit_name,report in central.items() for name,card in report['periods']['all']['cards'].items() if card['complete']]
    if not options or baseline is None:
        (root/'report.html').write_text('<h1>No complete comparable intervals</h1><p>The available evidence cannot rank these policies. See comparison.json for missing coverage.</p>')
        write_json(root/'research-completed.json',dict(status='unavailable',live_changes=False,visual_review='pending'))
        return
    high=max(options,key=lambda row:int(row[2]['metrics']['net_wei']))
    lower=min((r for r in options if r[2]['metrics']['n']>0),key=lambda row:(int(row[2]['metrics']['drawdown_wei']),-int(row[2]['metrics']['net_wei'])),default=high)
    picks=list(dict.fromkeys([('fixed_45',baseline_name),(high[0],high[1]),(lower[0],lower[1])]))
    labels={p:('Current baseline' if p==('fixed_45',baseline_name) else 'Highest central historical net' if p==(high[0],high[1]) else 'Lowest central historical drawdown') for p in picks}
    fig=make_subplots(rows=3,cols=1,subplot_titles=('Cash summed across independent complete intervals','Cumulative closed-cash drawdown across those intervals','Four KPIs against the same exit policy with market guard removed'))
    baseline_path=Path(central['fixed_45']['job']['output']);count=len(central['fixed_45']['periods']['all']['coverage']['intervals'])
    ranges=central['fixed_45']['periods']['all']['coverage']['intervals']
    refparts=[dict(read_json(baseline_path/f'reference-{i}.json'),start=ranges[i][0],end=ranges[i][1]) for i in range(count)]
    x,y,dd=series(refparts)
    fig.add_trace(go.Scatter(x=x,y=y,name='45s, market guard removed',connectgaps=False),row=1,col=1)
    fig.add_trace(go.Scatter(x=x,y=dd,name='45s, market guard removed',showlegend=False,connectgaps=False),row=2,col=1)
    bins={}
    for exit_name,name in picks:
        report=central[exit_name];path=Path(report['job']['output']);parts=chunks(path,name)
        x,y,dd=series(parts);label=labels[(exit_name,name)]
        fig.add_trace(go.Scatter(x=x,y=y,name=label,connectgaps=False),row=1,col=1)
        fig.add_trace(go.Scatter(x=x,y=dd,name=label,showlegend=False,connectgaps=False),row=2,col=1)
        card=report['periods']['all']['cards'][name]
        fig.add_trace(go.Bar(x=['Winning trades','Losing trades','Winning money','Losing money'],y=list(card['kpis'].values()),name=label,showlegend=False),row=3,col=1)
        cash=[r for p in parts for r in p['cash']]
        own=[r for i in range(len(report['periods']['all']['coverage']['intervals'])) for r in read_json(path/f'reference-{i}.json')['cash']]
        windows=[('24h',end-DAY,end,8),('7d',end-7*DAY,end,7)]
        bins[exit_name+'::'+name]={}
        for window,a,b,n in windows:
            rows=[]
            for i in range(n):
                lo=a+(b-a)*i//n;hi=a+(b-a)*(i+1)//n
                metrics=cash_metrics([r for r in cash if lo<=r['at']<hi]);denom=cash_metrics([r for r in own if lo<=r['at']<hi])
                rows.append(dict(start=lo,end=hi,metrics=metrics,kpis=ratios(metrics,denom)))
            bins[exit_name+'::'+name][window]=rows
    write_json(root/'bins.json',bins)
    fig.update_layout(height=1150,template='plotly_white',barmode='group',title='September guard and exit grid, diagnostic historical comparisons')
    fig.update_yaxes(title_text='ETH',row=1,col=1);fig.update_yaxes(title_text='ETH',row=2,col=1)
    percent_max=max([100,*[v for e,n in picks for v in central[e]['periods']['all']['cards'][n]['kpis'].values() if v is not None]])
    fig.update_yaxes(title_text='Retained %',range=[0,percent_max*1.05],row=3,col=1)
    risk=go.Figure(go.Scatter(x=[int(c['metrics']['drawdown_wei'])/1e18 for _,_,c in options],y=[int(c['metrics']['net_wei'])/1e18 for _,_,c in options],text=[e+' / '+n for e,n,_ in options],mode='markers'))
    risk.update_layout(template='plotly_white',title='Locked candidates: central historical profit and drawdown',xaxis_title='Conditional cumulative drawdown ETH',yaxis_title='Conditional net ETH')
    actual=[dict(id=p['id'],at=p['exit_at'],pnl=booked(p)) for p in raw['bot_positions'] if p.get('live') and p.get('closed') and p.get('exit_at') and 1788220800000<=p['exit_at']<end]
    actual.sort(key=lambda r:(r['at'],str(r['id'])))
    x,y,_=series([dict(cash=actual)]);wallet=go.Figure(go.Scatter(x=x,y=y,name='Actual booked cash'))
    wallet.update_layout(template='plotly_white',title='Actual September cash, historical stakes and policies (separate from simulation)',yaxis_title='ETH')
    write_json(root/'actual-cash.json',dict(metrics=cash_metrics(actual),cash=actual,meaning='COALESCE(onchain_pnl_wei,pnl_wei); historical stakes and policy eras, not the simulated constant-stake account'))
    rows=[]
    for exit_name,name in picks:
        report=central[exit_name]
        for period in ('all','validation','reserved6h'):
            card=report['periods'][period]['cards'][name];m=card['metrics'];k=card['kpis'];stats=m['cash_eth']
            average=' / '.join('N/A' if stats[key] is None else str(round(stats[key],6)) for key in ('mean','median','sd','n'))
            rows.append('<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in [labels[(exit_name,name)],exit_name,name,period,round(int(m['net_wei'])/1e18,6),round(int(m['drawdown_wei'])/1e18,6),*['N/A' if v is None else round(v,2) for v in k.values()],card['losing_recoveries'],average])+'</tr>')
    warning='Diagnostic only: cash fidelity has not passed. These are conditional intervals with independent account starts, not a continuous wallet forecast. Line gaps mark missing evidence. The final six hours were excluded from fitting. All inspected history remains retrospective. No live setting was changed.'
    body='<html><meta charset="utf-8"><title>September grid results</title><style>body{font:16px system-ui;margin:32px}td,th{padding:8px;border:1px solid #ddd}table{border-collapse:collapse;font-size:12px}</style><h1>September grid results</h1><p>'+html.escape(warning)+'</p><p>Displayed representatives illustrate historical profit/risk tradeoffs. They are not an automatic live recommendation. All locked candidates, eight execution/control scenarios, both coverage scopes and alternative KPI denominators are in comparison.json.</p>'
    body+=fig.to_html(full_html=False,include_plotlyjs=True)+risk.to_html(full_html=False,include_plotlyjs=False)+wallet.to_html(full_html=False,include_plotlyjs=False)
    coarse=root/'joint_coarse/fixed_45--reconstructed_early--adaptive/scorecards.json'
    if coarse.exists():
        grid=read_json(coarse)['cards']
        for xkey,ykey,title in [('n','m','Main and fresh windows'),('off','fresh_on','Pause and fresh recovery thresholds')]:
            fixed=dict(n=20,m=8,off=-1,fresh_on=1,full_on=2,age_min=180,mode='fresh',normalized=False)
            subset=[c for c in grid.values() if all(c['rule'][k]==v for k,v in fixed.items() if k not in (xkey,ykey))]
            xs=sorted({c['rule'][xkey] for c in subset});ys=sorted({c['rule'][ykey] for c in subset})
            lookup={(c['rule'][xkey],c['rule'][ykey]):c for c in subset}
            heat=make_subplots(rows=2,cols=2,subplot_titles=('Winning trades retained %','Losing trades retained %','Winning money retained %','Losing money retained %'))
            for i,key in enumerate(('win_trades','loss_trades','win_money','loss_money')):
                z=[[lookup[(x,y)]['kpis'][key] if (x,y) in lookup else None for x in xs] for y in ys]
                heat.add_trace(go.Heatmap(x=xs,y=ys,z=z,colorscale='Blues',showscale=False,hovertemplate=xkey+'=%{x}<br>'+ykey+'=%{y}<br>retained=%{z:.2f}%<extra></extra>'),row=i//2+1,col=i%2+1)
                heat.update_xaxes(title_text=xkey,row=i//2+1,col=i%2+1);heat.update_yaxes(title_text=ykey,row=i//2+1,col=i%2+1)
            heat.update_layout(height=750,template='plotly_white',title=title+' (training only, other guard parameters fixed at baseline)')
            body+=heat.to_html(full_html=False,include_plotlyjs=False)
    headings=['Representative','Exit','Guard','Period','Net ETH','DD ETH','Wins %','Losses %','Win money %','Loss money %','Losing recoveries','Per-trade ETH mean / median / sd / n']
    body+='<div style="overflow-x:auto"><table><tr>'+''.join('<th>'+h+'</th>' for h in headings)+'</tr>'+''.join(rows)+'</table></div><p>Lower loss retention is better. N/A means the denominator is zero or no sample exists. Retention can exceed 100% because guarding changes capacity and later admissions.</p></html>'
    (root/'report.html').write_text(body)
    write_json(root/'research-completed.json',dict(comparison_sha256=digest(root/'comparison.json'),report_sha256=digest(root/'report.html'),status='diagnostic_only',live_changes=False,visual_review='pending'))
    print(root/'report.html',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',default='data/research/20260912-grid');run(parser.parse_args().root)
