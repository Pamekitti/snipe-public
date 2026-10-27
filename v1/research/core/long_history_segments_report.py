"""Comparative evidence on every common, complete history interval."""
from collections import defaultdict
from pathlib import Path
import datetime as dt
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from .data import read_json,write_json,DAY,HOUR,digest
from .long_history import OUT,summary
from .guard_visual import close_cash
from .fidelity import cash_metrics
from .execution import describe

def eth(v):return int(v)/1e18
def when(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).strftime('%d %b %H:%M')
def moments(m):return ' / '.join(str(m[k]) if k=='n' else 'NA' if m[k] is None else f'{m[k]:+.5f}' for k in ('mean','median','sd','n'))

def render():
    index=read_json(OUT/'segments-index.json')
    grouped=defaultdict(dict)
    checks=0
    for p in sorted((OUT/'segments').glob('*.json')):
        g=read_json(p);checks+=1
        for name,r in g['runs'].items():
            s=g['scores'][name]
            assert int(s['net_wei'])==int(s['profit_wei'])-int(s['loss_wei'])
            assert sum(x['pnl'] for x in close_cash(r) if x['id'] not in r['open_ids'])==int(s['net_wei'])
        grouped[(g['signal'],g['intervention'],g['variant'])][g['segment']]=g
    aggregates={}
    for key,groups in grouped.items():
        byname={}
        for name in next(iter(groups.values()))['runs']:
            ss=[g['scores'][name] for g in groups.values()]
            cash=[dict(row,id=f'{i}/{row["id"]}') for i,g in sorted(groups.items()) for row in close_cash(g['runs'][name]) if row['id'] not in g['runs'][name]['open_ids']]
            cm=cash_metrics(cash)
            # The concatenated drawdown is a diagnostic across separate accounts.
            # Report worst individual-account drawdown as the interpretable risk metric.
            cm['concatenated_cash_drawdown_wei']=cm.pop('drawdown_wei')
            cm['worst_interval_drawdown_wei']=str(max(int(s['drawdown_wei']) for s in ss))
            cm['complete_intervals']=sum(s['complete'] for s in ss)
            cm['interval_n']=len(ss)
            cm['recovery_loss_eth']=sum(g['runs'][name]['recovery_losses']['loss_eth'] for g in groups.values())
            cm['losing_recoveries']=sum(g['runs'][name]['recovery_losses']['losing_n'] for g in groups.values())
            cm['profitable_baseline_interval_cash_wei']=str(sum(int(g['scores'][name]['net_wei']) for g in groups.values() if int(g['scores']['market_plus2']['net_wei'])>0))
            cm['losing_baseline_interval_cash_wei']=str(sum(int(g['scores'][name]['net_wei']) for g in groups.values() if int(g['scores']['market_plus2']['net_wei'])<0))
            cm['interval_net_eth']=describe(eth(s['net_wei']) for s in ss)
            byname[name]=cm
        ref=byname['continuous'];base=byname['market_plus2']
        for name,cm in byname.items():
            cm['profit_capture_pct']=100*int(cm['profit_wei'])/int(ref['profit_wei']) if int(ref['profit_wei']) else None
            cm['loss_avoided_pct']=100*(1-int(cm['loss_wei'])/int(ref['loss_wei'])) if int(ref['loss_wei']) else None
            cm['winning_trade_capture_pct']=100*cm['winners']/ref['winners'] if ref['winners'] else None
            cm['losing_trade_avoidance_pct']=100*(1-cm['losers']/ref['losers']) if ref['losers'] else None
            cm['extra_vs_current_eth']=eth(cm['net_wei'])-eth(base['net_wei'])
            cm['value_vs_always_on_eth']=eth(cm['net_wei'])-eth(ref['net_wei'])
            cm['no_worse_worst_interval_dd']=int(cm['worst_interval_drawdown_wei'])<=int(base['worst_interval_drawdown_wei'])
            cm['preserves_profitable_intervals']=int(cm['profitable_baseline_interval_cash_wei'])>=int(base['profitable_baseline_interval_cash_wei'])
        aggregates['/'.join(key)]=byname
    primary='reconstructed_early/recorded_controls/adaptive'
    table=aggregates[primary]
    names=list(table)
    candidates=[n for n in names if n not in ('market_plus2','market_off','continuous')]
    robustness={}
    for n in candidates:
        rr=[group[n] for group in aggregates.values()]
        robustness[n]=dict(extra_eth=[r['extra_vs_current_eth'] for r in rr],
            improves_net_scenarios=sum(r['extra_vs_current_eth']>0 for r in rr),
            preserves_profit_scenarios=sum(r['preserves_profitable_intervals'] for r in rr),
            no_worse_dd_scenarios=sum(r['no_worse_worst_interval_dd'] for r in rr),scenario_n=len(rr),
            all_complete=all(r['complete_intervals']==r['interval_n'] for r in rr))
    ranked=sorted(candidates,key=lambda n:int(table[n]['net_wei']),reverse=True)
    lowrisk=[n for n in ranked if table[n]['no_worse_worst_interval_dd'] and table[n]['extra_vs_current_eth']>0]
    robust=[n for n in lowrisk if robustness[n]['improves_net_scenarios']==robustness[n]['scenario_n']
        and robustness[n]['no_worse_dd_scenarios']==robustness[n]['scenario_n']
        and robustness[n]['preserves_profit_scenarios']==robustness[n]['scenario_n'] and robustness[n]['all_complete']]
    chosen=robust[0] if robust else lowrisk[0] if lowrisk else ranked[0]
    selected=list(dict.fromkeys(['market_plus2','market_plus1','recent_profit','staged','staged_budget',chosen]))
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,
        'axes.titleweight':'bold','figure.facecolor':'#f8fafc','axes.facecolor':'white','savefig.dpi':160})
    fig,axes=plt.subplots(1,2,figsize=(14,8),gridspec_kw={'width_ratios':[1.4,1]})
    fig.subplots_adjust(left=.18,right=.95,top=.79,bottom=.17,wspace=.38)
    for ax,key,title in [(axes[0],'net_wei','Conditional sum of tested-interval cash (ETH)'),(axes[1],'worst_interval_drawdown_wei','Largest drawdown within one interval (ETH)')]:
        vals=[eth(table[n][key]) for n in selected]
        ax.barh(range(len(selected)),vals,color=['#c76026' if n=='market_plus2' else '#1677a8' for n in selected])
        ax.axvline(0,color='#687582',linewidth=.8);ax.grid(axis='x',alpha=.15);ax.set_axisbelow(True)
        ax.set_yticks(range(len(selected)),selected if ax==axes[0] else ['']*len(selected));ax.invert_yaxis();ax.set_title(title,fontsize=11)
        span=max(max(vals)-min(vals),max(abs(v) for v in vals),.01)
        ax.set_xlim(min(0,min(vals))-span*.08,max(0,max(vals))+span*.28)
        for i,v in enumerate(vals):ax.text(v+span*.025,i,f'{v:+.4f}' if key=='net_wei' else f'{v:.4f}',va='center',fontsize=11)
    fig.suptitle('Which guards capture profit while limiting losses across the longer history?',x=.06,y=.96,ha='left',fontsize=17,fontweight='bold')
    fig.text(.06,.90,f'{when(index["start"])} to {when(index["end"])} UTC | {len(index["intervals"])} common coverage intervals | 1,200 ms modeled sell delay',fontsize=11)
    fig.text(.06,.085,'Each interval starts a separate flat account. This sum is a comparison score, not the earnings of one continuously running wallet.',fontsize=10)
    fig.text(.06,.045,'Earlier missing fixed-target readings are reconstructed. Historical screen decisions and recorded controls are retained. No live settings changed.',fontsize=10)
    fig.savefig(OUT/'longer-profit-risk.png');plt.close(fig)

    gg=grouped[('reconstructed_early','recorded_controls','adaptive')]
    arr=np.array([[eth(gg[i]['scores'][n]['net_wei'])-eth(gg[i]['scores']['market_plus2']['net_wei']) for i in sorted(gg)] for n in names])
    fig,ax=plt.subplots(figsize=(15,10));fig.subplots_adjust(left=.18,right=.96,top=.85,bottom=.18)
    limit=max(.01,np.max(abs(arr)));im=ax.imshow(arr,cmap='RdBu',vmin=-limit,vmax=limit,aspect='auto')
    for (i,j),v in np.ndenumerate(arr):ax.text(j,i,f'{v:+.3f}',ha='center',va='center',fontsize=8,color='white' if abs(v)>.60*limit else '#172b42')
    ax.set_yticks(range(len(names)),names)
    ax.set_xticks(range(len(gg)),[f'{when(gg[i]["start"])}\nto\n{when(gg[i]["end"])}' for i in sorted(gg)],fontsize=8)
    fig.suptitle('The same rule must face the profitable and losing intervals',x=.05,y=.96,ha='left',fontsize=19,fontweight='bold')
    fig.text(.05,.91,'Cells show extra simulated ETH versus the current guard. Interval lengths differ; all candidates use identical boundaries.',fontsize=11)
    fig.text(.05,.075,'Coverage boundaries surround ten unresolved graduated-market cases. Those cases remain unavailable in the strict account results.',fontsize=10)
    fig.text(.05,.035,'These are separate account tests. Cumulative losses inside each test never reset when a drawdown recovery occurs.',fontsize=10)
    fig.colorbar(im,ax=ax,shrink=.45,pad=.015,label='Extra ETH vs current guard')
    fig.savefig(OUT/'longer-periods.png');plt.close(fig)

    fig,ax=plt.subplots(figsize=(13,8));fig.subplots_adjust(left=.2,right=.96,top=.84,bottom=.14)
    for i,n in enumerate(ranked):
        vals=robustness[n]['extra_eth']
        ax.plot([min(vals),max(vals)],[i,i],color='#1677a8',linewidth=3)
        ax.scatter([table[n]['extra_vs_current_eth']],[i],color='#c76026',s=35,zorder=3)
    ax.axvline(0,color='#172b42',linewidth=1);ax.set_yticks(range(len(ranked)),ranked);ax.invert_yaxis();ax.grid(axis='x',alpha=.15)
    ax.set_xlabel('Extra conditional tested-interval ETH versus the current guard')
    fig.suptitle('Does the advantage survive different simulation assumptions?',x=.06,y=.96,ha='left',fontsize=18,fontweight='bold')
    fig.text(.06,.90,'Lines show the range across 12 scenarios. Orange dots mark reconstructed readings, recorded controls and 1,200 ms exits.',fontsize=10)
    fig.text(.06,.06,'Scenarios combine recorded/reconstructed readings, automatic/recorded interventions, and 600/1,200/2,000 ms sell delays.',fontsize=10)
    fig.text(.06,.025,'These are sensitivity ranges, not confidence intervals or guarantees about future returns.',fontsize=10)
    fig.savefig(OUT/'longer-robustness.png');plt.close(fig)

    lines=['# Longer comparative evidence','',
        f'**Strongest central candidate with no worse worst-interval drawdown: {chosen}.**',
        f'Candidates satisfying all three comparative conditions across all 12 scenarios: {", ".join(robust) or "none"}.',
        '', 'This study compares guard ideas. Exact real-world replication is not required to interpret relative results, but assumptions and missing outcomes remain visible.',
        '', '## Coverage and what the total means','',
        f'The requested model period is {when(index["start"])}–{when(index["end"])} UTC, approximately 23 days. There are {index["modeled_qualifying_launches"]} qualifying historically screened launches.',
        f'All 6,965 prepared launches have paths, parameters and timestamps. Ten tokens have an unresolved graduated-market exit in at least one size/delay case.',
        f'The comparative tables use {len(index["intervals"])} common complete intervals. The total omitted admission time is {index["omitted_admission_ms"]/60000:.1f} minutes, including identical three-minute closing tails.',
        'Each interval starts a separate hypothetical flat account. Summing these intervals is a conditional comparison score. It is not one continuous wallet backtest and may benefit from renewed risk budgets at interval starts.',
        'The separate strict inception study preserves the original unknowns and stops accounts when they would admit one. It also tests operation without human restarts.',
        'The requested earlier July 28–August 17 records are unavailable. Actual historical settings differ from the fixed current entry/exit configuration used for comparison.',
        '', '## Profit capture and loss avoidance','',
        '| Policy | Net ETH across tested intervals | Worst interval DD ETH | Profit captured | Loss avoided | Extra vs current ETH |',
        '|---|---:|---:|---:|---:|---:|']
    for n in names:
        s=table[n]
        lines.append(f'| {n} | {eth(s["net_wei"]):+.6f} | {eth(s["worst_interval_drawdown_wei"]):.6f} | {s["profit_capture_pct"]:.1f}% | {s["loss_avoided_pct"]:.1f}% | {s["extra_vs_current_eth"]:+.6f} |')
    lines+=['','Profit and loss ratios use the always-on account over the same intervals. Staged sizes reduce both exposure and capture; their ratios do not isolate selection skill.',
        '', '![Profit and risk](longer-profit-risk.png)','', '![Intervals](longer-periods.png)','', '![Sensitivity](longer-robustness.png)',
        '', '## Robustness counts','', '| Policy | Higher net | No worse worst-interval DD | Preserves profitable intervals | Scenarios |','|---|---:|---:|---:|---:|']
    for n in ranked:
        s=robustness[n];lines.append(f'| {n} | {s["improves_net_scenarios"]} | {s["no_worse_dd_scenarios"]} | {s["preserves_profit_scenarios"]} | {s["scenario_n"]} |')
    lines+=['','Profitable intervals are labeled after the fact using the current guard’s result in that scenario. Those labels never control simulated entries.',
        '', '## Per-attempt cash statistics','', '| Policy | Mean / median / sample SD / n, ETH |','|---|---|']
    for n in names:lines.append(f'| {n} | {moments(table[n]["cash_eth"])} |')
    lines+=['','## Controls against bias','',
        '- All 14 indicator candidates and five controls were frozen before the longer candidate cash results. No new thresholds were selected from these results.',
        '- All candidates use the same historical screen decisions, entry and exit configuration, delays, costs and coverage intervals.',
        '- The previous profitable periods are included. The report shows every candidate, losing interval and unfavorable sensitivity.',
        '- Costs use preceding completed attempts only. The last six hours do not provide calibration costs. Signals arrive after outcome and publication.',
        '- Unknown executions remain unknown in the strict study. Complete-interval tests are explicitly conditional on their coverage and reset assumptions.',
        '- Historical strategy selection cannot be made unbiased retroactively. These candidates were originally motivated by already-inspected losses.',
        '- Interval and scenario counts are not independent statistical trials. New observations are needed to test the selected rule without prior inspection.',
        '', 'The [CFA Institute backtesting guidance](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation) discusses chronological testing and the limitations of historical distributions.',
        'The [backtest-overfitting paper](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) explains why repeated historical searches can overstate performance.',
        '', 'No settings, stake, stop, deployment or account reset changed. This result supports comparative research, not a guaranteed return.']
    (OUT/'comparative-report.md').write_text('\n'.join(lines)+'\n')
    write_json(OUT/'comparative-scorecards.json',dict(primary=primary,central_choice=chosen,robust_choices=robust,aggregates=aggregates,robustness=robustness))
    write_json(OUT/'segment-verification.json',dict(groups_checked=checks,integer_cash_checks=True,
        all_complete=all(s['complete_intervals']==s['interval_n'] for g in aggregates.values() for s in g.values()),
        source_hashes_match=all(digest(Path(p))==h for p,h in index['source_hashes'].items()),visual_review_pending=True))
    print('Comparative central candidate',chosen,'robust candidates',robust,flush=True)

if __name__=='__main__':render()
