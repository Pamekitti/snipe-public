"""Read-only chronological checks and indicator charts for the frozen comparison."""
from collections import Counter
from dataclasses import replace
import datetime as dt
import bisect
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from .data import read_json,write_json,digest,DAY,HOUR
from .long_history import ROOT,OUT,SOURCE,observations_for,summary
from .indicator_study import make_tapes
from .indicators import candidates
from .guard_visual import close_cash
from .evaluation import rolling_at
from .execution import describe
from .fidelity import cash_metrics


def eth(x):return int(x)/1e18
def date(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc)
def cash(run,a,b):return [r for r in close_cash(run) if a<=r['at']<b and r['id'] not in run['open_ids']]
def moments(d):return ' / '.join(str(d[k]) if k=='n' else 'NA' if d[k] is None else f'{d[k]:+.6f}' for k in ('mean','median','sd','n'))


def run():
    index=read_json(OUT/'segments-index.json')
    raw,models=read_json(SOURCE),read_json(ROOT/'models.json')
    design=read_json(ROOT/'frozen-design.json')
    assert [r.__dict__ for r in candidates()]==design['candidates']
    assert all(z['gas_n']>=20 and z['calibration_latest']<min(z['entry'],index['end']-6*HOUR) for z in models['tokens'].values())
    assert digest(ROOT/'dataset.json')==read_json(ROOT/'manifest.json')['dataset_sha256']
    gs={}
    for p in (OUT/'segments').glob('*.json'):
        g=read_json(p);gs[(g['signal'],g['intervention'],g['variant'],g['segment'])]=g
        assert g['shadow_complete']
        assert all(s['complete'] for s in g['scores'].values())
        assert all(g['start']<=d['at']<g['last_entry'] for r in g['runs'].values() for d in r['decisions'] if d['reason'] is None)

    delayed={}
    for mode in ('recorded','reconstructed_early'):
        files=sorted((OUT/'segment-delay').glob(f'{mode}-*.json'))
        for rule in [r for r in candidates() if r.smooth]:
            rr=[read_json(p)[rule.name] for p in files]
            values=[dict(row,id=f'{i}/{row["id"]}') for i,r in enumerate(rr) for row in cash(r['run'],index['start'],index['end'])]
            s=cash_metrics(values)
            base=sum(int(gs[(mode,'recorded_controls','adaptive',i)]['scores']['market_plus2']['net_wei']) for i in range(len(files)))
            orig=sum(int(gs[(mode,'recorded_controls','adaptive',i)]['scores'][rule.name]['net_wei']) for i in range(len(files)))
            delayed[f'{mode}/{rule.name}']=dict(net_wei=s['net_wei'],extra_vs_current_eth=eth(s['net_wei'])-eth(base),
                change_vs_undelayed_eth=eth(s['net_wei'])-eth(orig),complete=all(r['score']['complete'] for r in rr),
                worst_interval_drawdown_wei=str(max(int(r['score']['drawdown_wei']) for r in rr)))

    # A ranking diagnostic observes whole policy accounts. It never pretends that
    # selecting tomorrow's account transfers that account's history into one wallet.
    forward=[]
    selection_names=['market_plus2','market_plus1','stale_hold']+[r.name for r in candidates()]
    for mode in ('recorded','reconstructed_early'):
        for i,(a,b) in enumerate(index['intervals']):
            g=gs[(mode,'recorded_controls','adaptive',i)]
            for t in range(a+7*DAY,b-DAY+1,DAY):
                training={n:cash_metrics(cash(g['runs'][n],t-7*DAY,t)) for n in selection_names}
                base=training['market_plus2']
                allowed=[n for n in selection_names if int(training[n]['drawdown_wei'])<=int(base['drawdown_wei'])]
                selected=max(allowed,key=lambda n:int(training[n]['net_wei']))
                test={n:cash_metrics(cash(g['runs'][n],t,t+DAY)) for n in [selected,'market_plus2']}
                forward.append(dict(mode=mode,segment=i,train_start=t-7*DAY,test_start=t,test_end=t+DAY,selected=selected,
                    training=training,test=test,extra_eth=eth(test[selected]['net_wei'])-eth(test['market_plus2']['net_wei'])))

    bins={}
    for count,width,label in [(8,3*HOUR,'24h'),(7,DAY,'7d')]:
        rows=[]
        for j in range(count):
            a=index['end']-(count-j)*width;b=a+width
            scores={}
            for n in gs[('reconstructed_early','recorded_controls','adaptive',0)]['runs']:
                values=[dict(r,id=f'{i}/{r["id"]}') for i in range(len(index['intervals'])) for r in cash(gs[('reconstructed_early','recorded_controls','adaptive',i)]['runs'][n],a,b)]
                scores[n]=cash_metrics(values)
            covered=sum(max(0,min(b,y-180000)-max(a,x)) for x,y in index['intervals'])
            rows.append(dict(start=a,end=b,admission_coverage=covered/(b-a),scores=scores))
        bins[label]=rows

    # Last 24 hours lie within one complete interval, so this chart preserves
    # account state throughout its display period without coverage resets.
    a,b=index['end']-DAY,index['end'];g=gs[('recorded','recorded_controls','adaptive',len(index['intervals'])-1)]
    assert g['start']<=a<b<=g['end']
    obs=observations_for(raw,models,False)
    tapes,missing=make_tapes(raw,models,g['runs']['continuous'],obs)
    recent=next(r for r in candidates() if r.name=='recent_profit')
    times=list(range(a,b,60000));native=[];matched=[];ages=[]
    for t in times:
        selected=rolling_at(obs,t,20)
        fresh=len(selected)==20 and t-selected[-1][0].launched<=3*HOUR
        native.append(sum(v for _,v in selected) if fresh else np.nan)
        s=tapes['matched'].estimate(t,recent)
        matched.append(s['value'] if s['fresh'] else np.nan)
        ages.append(max([(t-o.launched)/60000 for o,v in selected],default=np.nan))
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'#f8fafc','axes.facecolor':'white','savefig.dpi':150})
    fig,axes=plt.subplots(3,1,figsize=(14,10),sharex=True,gridspec_kw={'height_ratios':[1.5,1,1]})
    fig.subplots_adjust(left=.095,right=.96,top=.82,bottom=.13,hspace=.26)
    names=['continuous','market_plus2','stale_hold','recent_profit','staged']
    labels=['Always on','Current guard','Hold pause while stale','Recent profit signal','Staged entries']
    colors=['#687582','#c76026','#7b58a5','#1677a8','#26998a']
    for n,label,c in zip(names,labels,colors):
        rows=cash(g['runs'][n],a,b);vals=np.cumsum([0]+[eth(r['pnl']) for r in rows]).tolist()
        axes[0].step([date(a)]+[date(r['at']) for r in rows]+[date(b)],vals+[vals[-1]],where='post',label=label,color=c,linewidth=2,linestyle='--' if n=='continuous' else '-')
    axes[0].legend(loc='upper left',bbox_to_anchor=(0,1.30),ncol=3,frameon=False,fontsize=10)
    axes[0].set_ylabel('24h simulated cash\nchange (ETH)')
    axes[1].plot([date(t) for t in times],native,color='#c76026',linewidth=1.3)
    axes[1].axhline(2,color='#26998a',ls='--',label='Recovery +2');axes[1].axhline(-1,color='#ba3d3d',ls='--',label='Pause −1')
    axes[1].legend(loc='upper right',ncol=2,frameon=False,fontsize=9);axes[1].set_ylabel('Original indicator\n20-launch sum (stakes)')
    axes[2].plot([date(t) for t in times],matched,color='#1677a8',linewidth=1.3)
    axes[2].set_ylabel('Policy-matched recent\nreturn per stake')
    for ax in axes:ax.axhline(0,color='#9ba6b0',lw=.7);ax.grid(axis='y',alpha=.15)
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter('%d %b\n%H:%M',tz=dt.timezone.utc));axes[-1].set_xlim(date(a),date(b))
    fig.suptitle('When was trading profitable, and what did the indicators say?',x=.07,y=.97,ha='left',fontsize=18,fontweight='bold')
    fig.text(.07,.925,f'{date(a):%d %b %H:%M} to {date(b):%d %b %H:%M} UTC | same historical coins and current trading configuration',fontsize=11)
    fig.text(.07,.072,f'Account state carries from {date(g["start"]):%d %b %H:%M} UTC. Cash is rebased at the chart start; stops and losses are not reset.',fontsize=10)
    fig.text(.07,.040,'Indicator gaps mean stale or insufficient evidence. Outcomes enter the matched signal only after exit and publication.',fontsize=10)
    fig.text(.07,.012,'Simulated cash, not wallet earnings. Recorded operator controls and 1,200 ms modeled exits. Last three minutes admit no new trades.',fontsize=10)
    fig.savefig(OUT/'cash-and-indicators-24h.png');plt.close(fig)

    lines=['# Additional verification and chronological diagnostics','',
        'The original candidates and thresholds are unchanged. These checks do not select new settings.','',
        '## Delayed indicator publication','',
        'All figures sum the same separate coverage intervals. The seven smoothed rules receive their evidence 60 seconds later.','',
        '| Signal history / rule | Net ETH | Extra vs current ETH | Change vs usual publication ETH |','|---|---:|---:|---:|']
    for k,s in delayed.items():lines.append(f'| {k} | {eth(s["net_wei"]):+.6f} | {s["extra_vs_current_eth"]:+.6f} | {s["change_vs_undelayed_eth"]:+.6f} |')
    lines+=['','## Previous-week ranking, following-day results','',
        'At each eligible boundary, rank the 17 frozen guard choices by their preceding seven-day cash. Require training drawdown no worse than the current guard. Compare that chosen account on the next day.',
        'Only the first uninterrupted coverage interval provides seven training days followed by a full test day. Later intervals are too short. Candidate accounts retain their own history. This tests ranking persistence, not the earnings of a deployable switching portfolio.',
        'The earlier monitor lacks per-target observations, so these tests also carry the documented fixed-target fallback limitation.','',
        '| Signal history | Next day starts UTC | Selected using past data | Following-day extra ETH |','|---|---|---|---:|']
    for r in forward:lines.append(f'| {r["mode"]} | {date(r["test_start"]):%d %b %H:%M} | {r["selected"]} | {r["extra_eth"]:+.6f} |')
    lines+=['','| Signal history | Mean / median / sample SD / n, following-day extra ETH |','|---|---|']
    for mode in ('recorded','reconstructed_early'):lines.append(f'| {mode} | {moments(describe(r["extra_eth"] for r in forward if r["mode"]==mode))} |')
    lines+=['','## Latest 24 hours','', '![Cash and indicators](cash-and-indicators-24h.png)','',
        'Eight three-hour bins and seven daily bins for all candidates are saved in supplemental-scorecards.json. Daily bins spanning coverage boundaries remain conditional interval comparisons.',
        '', '## Causal and accounting checks','',
        f'- All {len(models["tokens"])} modeled launches use at least 20 preceding calibration attempts. Every calibration clock precedes both entry and the final-six-hour cutoff.',
        '- Dataset hash matches its acquisition manifest. Candidate definitions match the frozen design.',
        f'- All {len(gs)} coverage groups have complete shadow and candidate accounts. Every admitted entry lies inside its common admission interval.',
        '- Unknown graduated-market cases were excluded by the same coverage boundaries for all policies. Their opportunity value is still unavailable.',
        '- Return statistics include failed-buy costs. Means include median, sample standard deviation and count.']
    (OUT/'supplemental-report.md').write_text('\n'.join(lines)+'\n')
    write_json(OUT/'supplemental-scorecards.json',dict(delay=delayed,forward_ranking=forward,bins=bins,
        indicator_24h=dict(times=times,native=[None if np.isnan(v) else v for v in native],matched=[None if np.isnan(v) else v for v in matched],oldest_age_min=ages)))
    write_json(OUT/'supplemental-verification.json',dict(causal_calibration=True,calibration_models=len(models['tokens']),frozen_candidates=True,
        dataset_hash=True,complete_groups=len(gs),all_shadow_complete=True,common_entry_boundaries=True,visual_review_pending=True))
    print('Supplement verified',len(gs),'groups and',len(forward),'chronological ranking days',flush=True)

if __name__=='__main__':run()
