"""Read-only summaries and charts for the frozen long-history comparison."""
from pathlib import Path
import datetime as dt
import json
from collections import Counter
import math
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

from .data import DAY,HOUR,read_json,write_json,digest
from .guard_visual import close_cash
from .long_history import OUT,ROOT,summary
from .indicators import candidates
from .execution import describe

BLUE,ORANGE,INK='#1677a8','#c76026','#172b42'
def date(x):return dt.datetime.fromtimestamp(x/1000,dt.timezone.utc)
def eth(x):return int(x)/1e18
def pct(x,y):return 100*x/y if y else None
def number(x):return 'unavailable' if x is None else f'{x:.1f}%'
def moment(m):
    return ' / '.join('unavailable' if m[k] is None else str(m[k]) if k=='n' else f'{m[k]:+.6f}' for k in ('mean','median','sd','n'))

def check_group(g):
    for name,r in g['runs'].items():
        s=g['scores'][name]['full']
        assert int(s['net_wei'])==int(s['profit_wei'])-int(s['loss_wei'])
        assert sum(x['pnl'] for x in close_cash(r) if x['id'] not in r['open_ids'])==int(s['net_wei'])
        d=g['comparisons'][name]
        # Floating display values originate from exact integer attribution.
        assert abs(d['net_change_eth']-(d['extra_profit_eth']+d['extra_loss_eth']-d['profit_missed_eth']+d['losses_avoided_eth']+d['changed_shared_cash_eth']))<1e-9

def render():
    index=read_json(OUT/'index.json')
    end=index['end']
    files=sorted((OUT/'groups').glob('*.json'))
    central={}
    all_scores=[]
    checks=0
    shadow_names={r.name for r in candidates() if r.source in ('matched','fixed_matched')}
    for p in files:
        g=read_json(p);check_group(g);checks+=1
        for name,s in g['scores'].items():
            all_scores.append(dict(file=p.name,start=g['start'],signal=g['signal'],intervention=g['intervention'],variant=g['variant'],name=name,periods=s,
                indicator_complete=name not in shadow_names or index['signal_evidence'][f'{g["signal"]}/{g["start"]}']['shadow_complete'],
                min_funds=g['runs'][name]['minimum_starting_funds_wei'],recovery=g['runs'][name]['recovery_losses']))
        if g['signal']=='recorded' and g['intervention']=='recorded_controls' and g['variant']=='adaptive':
            central[g['start']]=g
    names=['continuous','market_off','market_plus2','market_plus1','stale_hold']+[r.name for r in candidates()]
    starts=sorted(central)
    complete_starts=[t for t,g in central.items() if all(r['complete'] for r in g['runs'].values())
                     and index['signal_evidence'][f'recorded/{t}']['shadow_complete']]
    chosen=min(complete_starts) if complete_starts else max(starts)
    g=central[chosen]
    reference=g['scores']['continuous']['full']
    base=g['scores']['market_plus2']['full']
    candidate_names=[n for n in names if n not in ('continuous','market_off','market_plus2')]
    ranked=sorted((n for n in candidate_names if g['scores'][n]['full']['complete']),key=lambda n:int(g['scores'][n]['full']['net_wei']),reverse=True)
    numerical=ranked[0] if ranked else None
    daily={}
    for n in names:
        rr=[]
        for a in range(chosen,end,DAY):
            b=min(a+DAY,end)
            s=summary(g['runs'][n],a,b);bs=summary(g['runs']['market_plus2'],a,b)
            rr.append(dict(start=a,end=b,net_eth=eth(s['net_wei']) if s['complete'] else None,
                extra_vs_current_eth=eth(s['net_wei'])-eth(bs['net_wei']) if s['complete'] and bs['complete'] else None))
        daily[n]=dict(rows=rr,extra_daily_eth=describe(x['extra_vs_current_eth'] for x in rr if x['extra_vs_current_eth'] is not None))
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.titlesize':13,'axes.titleweight':'bold',
        'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'#f8fafc','axes.facecolor':'white','savefig.dpi':160})
    fig,ax=plt.subplots(figsize=(15,10));fig.subplots_adjust(left=.19,right=.96,top=.85,bottom=.15)
    arr=np.full((len(names),len(starts)),np.nan)
    for j,t in enumerate(starts):
        gg=central[t];bb=gg['scores']['market_plus2']['full']
        for i,n in enumerate(names):
            s=gg['scores'][n]['full']
            source_complete=n not in shadow_names or index['signal_evidence'][f'recorded/{t}']['shadow_complete']
            if s['complete'] and bb['complete'] and source_complete:
                arr[i,j]=eth(s['net_wei'])-eth(bb['net_wei'])
    lim=max(.01,np.nanmax(np.abs(arr))) if np.isfinite(arr).any() else .01
    cm=plt.get_cmap('RdBu').copy();cm.set_bad('#dfe4e9')
    im=ax.imshow(arr,cmap=cm,vmin=-lim,vmax=lim,aspect='auto')
    for (i,j),v in np.ndenumerate(arr):
        ax.text(j,i,'?' if not np.isfinite(v) else f'{v:+.3f}',ha='center',va='center',fontsize=8,
            color='white' if np.isfinite(v) and abs(v)>.6*lim else INK)
    ax.set_yticks(range(len(names)),names)
    ax.set_xticks(range(len(starts)),[date(t).strftime('%d %b\n%H:%M') for t in starts])
    fig.suptitle('Does the guard improve results from different starting dates?',x=.05,y=.97,ha='left',fontsize=18,fontweight='bold')
    fig.text(.05,.92,'Each column is a separate account inception, ending 11 Sep at 12:44 UTC. Cells show ETH gained versus the current guard.',fontsize=11)
    fig.colorbar(im,ax=ax,shrink=.5,pad=.015,label='Extra ETH vs current guard')
    fig.text(.05,.065,'Recorded monitor availability and operator controls; modeled 1,200 ms sell delay. These overlapping scenarios are not independent trials.',fontsize=10)
    fig.text(.05,.035,'? = an execution, holding or required shadow signal is unresolved. Gray cells do not mean zero profit.',fontsize=10)
    fig.savefig(OUT/'inception-comparison.png');plt.close(fig)

    selected=list(dict.fromkeys(['continuous','market_plus2','market_plus1','recent_profit','staged','staged_budget']+([numerical] if numerical else [])))
    fig,axes=plt.subplots(2,1,figsize=(14,9),sharex=True,gridspec_kw={'height_ratios':[1.5,1]})
    fig.subplots_adjust(left=.085,right=.97,top=.82,bottom=.13,hspace=.22)
    colors=['#687582',ORANGE,'#8064a2',BLUE,'#26998a','#c89920','#d94b75']
    for n,c in zip(selected,colors):
        r=g['runs'][n];cash=close_cash(r)
        times=[date(chosen)];vals=[0];total=0;peak=0;dds=[0]
        stop=min((u['at'] for u in r['unresolved']),default=end)
        for row in cash:
            if row['at']>=stop or row['id'] in r['open_ids']:continue
            total+=row['pnl'];peak=max(peak,total)
            times.append(date(row['at']));vals.append(total/1e18);dds.append((total-peak)/1e18)
        times.append(date(stop));vals.append(vals[-1]);dds.append(dds[-1])
        axes[0].step(times,vals,where='post',label=n,color=c,linewidth=1.8,linestyle='--' if n=='continuous' else '-')
        axes[1].step(times,dds,where='post',color=c,linewidth=1.5,linestyle='--' if n=='continuous' else '-')
    for ax in axes:
        ax.axhline(0,color='#667788',linewidth=.7);ax.grid(axis='y',alpha=.15)
        if chosen<end-2*DAY:
            ax.axvspan(date(max(chosen,end-4*DAY)),date(end-2*DAY),color=BLUE,alpha=.07)
            ax.axvspan(date(end-2*DAY),date(end),color=ORANGE,alpha=.08)
    axes[0].set_ylabel('Cumulative simulated cash (ETH)');axes[1].set_ylabel('Drawdown from peak (ETH)')
    axes[0].legend(loc='upper left',bbox_to_anchor=(0,1.22),ncol=4,frameon=False,fontsize=10)
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%d %b\n%H:%M',tz=dt.timezone.utc))
    axes[1].set_xlim(date(chosen),date(end))
    fig.suptitle('Profit capture and loss control on the same historical opportunities',x=.075,y=.97,ha='left',fontsize=18,fontweight='bold')
    fig.text(.075,.92,f'Start: {date(chosen):%d %b %Y, %H:%M} UTC | longest listed inception with complete central accounts and shadow, if available',fontsize=10)
    fig.text(.075,.055,'Each account starts flat. Actual historical prices; current configuration; modeled fills and costs. Cumulative losses never reset.',fontsize=10)
    fig.text(.075,.025,'Recorded operator controls are retained. A flat line may reflect an account stop, a human stop, a market pause or a spent probe budget.',fontsize=10)
    fig.savefig(OUT/'candidate-cash.png');plt.close(fig)

    fig,ax=plt.subplots(figsize=(12,8));fig.subplots_adjust(left=.11,right=.96,top=.83,bottom=.14)
    ratio_rows=[]
    for n in names:
        s=g['scores'][n]['full']
        valid=s['complete'] and reference['complete']
        profit=pct(int(s['profit_wei']),int(reference['profit_wei'])) if valid else None
        loss=pct(int(s['loss_wei']),int(reference['loss_wei'])) if valid else None
        ratio_rows.append(dict(name=n,profit_capture_pct=profit,loss_retained_pct=loss,
            loss_avoided_pct=100-loss if loss is not None else None,
            value_added_eth=eth(s['net_wei'])-eth(reference['net_wei']) if valid else None,
            winner_capture_pct=pct(s['winners'],reference['winners']) if valid else None,
            losing_trade_avoidance_pct=100-pct(s['losers'],reference['losers']) if valid and reference['losers'] else None))
        if profit is not None and loss is not None:
            staged=n.startswith('staged')
            ax.scatter(loss,profit,s=90 if n in selected else 40,marker='D' if staged else 'o',color=BLUE if n in selected else '#9aa8b5',edgecolors='white')
            if n in selected:ax.annotate(n,(loss,profit),xytext=(5,6),textcoords='offset points',fontsize=10)
    maxv=max([105]+[max(r['profit_capture_pct'],r['loss_retained_pct'])+10 for r in ratio_rows if r['profit_capture_pct'] is not None and r['loss_retained_pct'] is not None])
    ax.plot([0,maxv],[0,maxv],linestyle='--',color='#aab3bd',label='Equal share of profits and losses')
    ax.set(xlim=(-3,maxv),ylim=(-3,maxv),xlabel='Always-on losses retained (%)  ← less is better',ylabel='Always-on winning profit captured (%)  → more is better')
    ax.grid(alpha=.15);ax.legend(loc='lower right',frameon=False)
    fig.suptitle('A useful guard keeps more of the profits than of the losses',x=.075,y=.97,ha='left',fontsize=18,fontweight='bold')
    fig.text(.075,.92,f'Same interval as the cash chart: {date(chosen):%d %b, %H:%M} to 11 Sep, 12:44 UTC',fontsize=11)
    fig.text(.075,.055,'Whole-account ratios, including changed admissions and fills. Diamonds use staged stakes; lower exposure also reduces both ratios.',fontsize=10)
    fig.text(.075,.025,'Above the diagonal means better proportional capture. It does not by itself establish positive net profit.',fontsize=10)
    fig.savefig(OUT/'capture-comparison.png');plt.close(fig)

    lines=['# Longer guard comparison','',
        'These are retrospective comparisons under common execution assumptions. No live configuration changed.','',
        f'Frozen capture ends {date(end):%Y-%m-%d %H:%M:%S} UTC. Actual history begins 17 August. The model comparison requests 23 days after calibration and shadow warmup.',
        'No source evidence exists here for the requested 28 July–17 August portion of a 45-day window.','',
        '## What was compared','',
        f'{len(files)} account groups, each containing 19 policies. Two observation histories, two intervention assumptions and three execution delays are separate scenarios.',
        'Recorded availability uses only stored per-target outcomes. Those outcomes begin on 5 September at 21:03 UTC. Earlier adaptive entries use the documented 1.75 fallback.',
        'The reconstructed alternative fills only missing fixed 1.75 observations using the curve model. It never invents missing adaptive-target histories.',
        'Recorded controls preserve external stop and restart records. Automatic scenarios retain account risk stops and assume no human interventions. Their initial state is hypothetical.',
        '', '## Longest complete central comparison','',
        f'The chart starts at {date(chosen):%Y-%m-%d %H:%M} UTC. Complete listed starting dates: {len(complete_starts)} of {len(starts)}.',
        f'Highest central simulated net among alternatives: **{numerical or "unavailable"}**. This is a numerical result, not proof of a stable advantage.',
        '', '| Policy | Attempts | Net ETH | Drawdown ETH | Profit captured | Loss avoided | Minimum starting ETH |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for r in ratio_rows:
        n=r['name'];s=g['scores'][n]['full']
        lines.append(f'| {n} | {s["n"]} | {eth(s["net_wei"]):+.6f}{" (prefix)" if not s["complete"] else ""} | {eth(s["drawdown_wei"]):.6f} | {number(r["profit_capture_pct"])} | {number(r["loss_avoided_pct"])} | {eth(g["runs"][n]["minimum_starting_funds_wei"]):.6f} |')
    lines+=['','Minimum starting funds are a modeled financing requirement, not the exposure cap or a funding recommendation.',
        '', '![Candidate cash](candidate-cash.png)','', '![Profit and loss capture](capture-comparison.png)','',
        '## Starting-date comparison','', '![Starting dates](inception-comparison.png)','',
        'Gray cells are unavailable. A simulator stopped at an unknown holding has not earned zero afterward. A matched signal cannot remain valid after its shadow path becomes unresolved.',
        'Starting-date scenarios overlap and must not be treated as independent wins or as permission to reset a losing account.',
        '', '## Per-attempt cash statistics','', '| Policy | Mean / median / sample SD / n (ETH) |','|---|---|']
    for n in names:lines.append(f'| {n} | {moment(g["scores"][n]["full"]["cash_eth"])} |')
    lines+=['','## Profitable and losing periods in the same account path','',
        'These periods retain the account state from the chart inception. No balances or probe budgets reset at their boundaries.','',
        '| Policy | Earlier profitable 48h ETH | Recent losing 48h ETH | Final 6h ETH |','|---|---:|---:|---:|']
    for n in names:
        cells=[]
        for period in ('profit48','loss48','reserved6h'):
            s=g['scores'][n].get(period)
            cells.append(f'{eth(s["net_wei"]):+.6f}' if s and s['complete'] else 'unavailable')
        lines.append('| '+n+' | '+' | '.join(cells)+' |')
    lines+=['','## Execution and intervention stress','',
        'These results share the chart inception. Changing the assumed delay does not change candidate definitions.','',
        '| Policy | Signal history | Intervention | Sell delay | Net ETH | Drawdown ETH | Complete |','|---|---|---|---|---:|---:|---|']
    for row in all_scores:
        if row['start']==chosen and row['name'] in selected:
            s=row['periods']['full']
            lines.append(f'| {row["name"]} | {row["signal"]} | {row["intervention"]} | {row["variant"]} | {eth(s["net_wei"]):+.6f} | {eth(s["drawdown_wei"]):.6f} | {s["complete"]} |')
    lines+=['','## Day-by-day advantage over the current guard','',
        'Statistics include all available daily bins from the chart inception, including days with no trades. The final bin may be partial.','',
        '| Policy | Mean / median / sample SD / n of daily extra ETH |','|---|---|']
    for n in names:lines.append(f'| {n} | {moment(daily[n]["extra_daily_eth"])} |')
    lines+=['','## Bias controls and remaining limits','',
        '- Candidate definitions and the comparison design were hashed before new candidate results. No threshold search followed the extension.',
        '- All candidates face the same opportunities and assumptions. Actual historical stakes remain separate from hypothetical current-size trades.',
        '- Costs use only preceding completed attempts, excluding the final six hours. Outcomes become signals only after exit and publication.',
        '- Unknown executions remain unknown. Comparative attribution stops at the earlier unknown on either side.',
        '- We show profitable and losing periods, all starting dates, delay stresses, and the possibility of no preferred replacement.',
        '- The candidates were originally inspired by already-inspected losses. Historical extension cannot remove that selection bias.',
        '- The formal existing replay validation passed 18 of 57 checks. It measures known imperfections, not a veto on comparative research.',
        '- Recorded market orders are fixed inputs. Feed timing, transaction ordering, retries and reactions to changed trades remain uncertain.',
        '- No previously inspected period is called prospective validation. No historical window guarantees the future market distribution.',
        '', 'The methodology follows the distinction between chronological backtests and uncertainty about future conditions described by [CFA Institute](https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation).',
        'Repeated strategy searches can inflate apparent performance, as discussed in [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).',
        '', 'Full scenario scorecards are in `scorecards.json`; per-account cash and decisions are in `groups/`. The original candidate design and interpretation amendment are retained in the input directory.']
    (OUT/'report.md').write_text('\n'.join(lines)+'\n')
    write_json(OUT/'scorecards.json',dict(chosen_start=chosen,numerical_winner=numerical,complete_starts=complete_starts,ratios=ratio_rows,scenarios=all_scores,daily=daily))
    write_json(OUT/'verification.json',dict(groups_checked=checks,integer_cash_checks=True,attribution_checks=True,
        source_hashes_match=all(digest(Path(p))==h for p,h in index['source_hashes'].items()),visual_review_pending=True))
    print('Report and charts',OUT,'central start',iso_date(chosen),'numerical',numerical,flush=True)

def iso_date(x):return date(x).isoformat()
if __name__=='__main__':render()
