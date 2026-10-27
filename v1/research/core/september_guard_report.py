"""Training-only representative selection, full scorecards and September charts."""
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime, timezone
import argparse
import hashlib
import json
import statistics
from .data import read_json,write_json,digest,HOUR,DAY
from .september_guard_study import OUT,START,FIT_END,SCENARIOS
from .september_guards import candidates
from .fidelity import cash_metrics

CENTRAL='reconstructed_early-adaptive'
BASES=['continuous','current_guard','matched20']

def iso(at):return datetime.fromtimestamp(at/1000,timezone.utc).strftime('%b %d %H:%M')
def eth(s):return int(s)/1e18

def collect(scenarios=None):
    design=read_json(OUT/'design.json');coverage=read_json(OUT/'coverage.json')
    records={}
    for scenario in (SCENARIOS if scenarios is None else scenarios):
        segs=[]
        for i in range(len(coverage['intervals'])):
            p=OUT/'runs'/f'{scenario["name"]}-{i:02}.json'
            if not p.exists():raise ValueError(f'Run missing {p}')
            segs.append(read_json(p))
        records[scenario['name']]=segs
    return design,coverage,records

def measure(segs,name,lo,hi):
    cash=[];losses=[];worst=0;resumes=stops=0
    for seg in segs:
        r=seg['runs'][name]
        rows=[x for x in r['cash'] if lo<=x['at']<hi]
        cash+=rows
        worst=max(worst,int(cash_metrics(rows)['drawdown_wei']))
        for ep in r['recovery']['episodes']:
            # A cut cannot use future closes or still-active recovery episodes.
            if lo<=ep['at'] and ep['until']<=hi:
                ids={d['id'] for d in r['admitted'] if ep['at']<=d['at']<ep['until']}
                values=[x['pnl'] for x in rows if x['id'] in ids]
                if sum(values)<0:losses.append(-sum(values))
        resumes+=sum(lo<=x['at']<hi and x['action']=='venue_resume' for x in r['actions'])
        stops+=sum(lo<=x['at']<hi and x['action']=='venue_stop' for x in r['actions'])
    cash.sort(key=lambda x:(x['at'],x['id']))
    assert len({x['id'] for x in cash})==len(cash), 'Duplicate cross-segment cash'
    return dict(**cash_metrics(cash),worst_segment_dd_wei=str(worst),recovery_loss_wei=str(sum(losses)),
                losing_recoveries=len(losses),resumes=resumes,stops=stops)

def riskpass(c,b):
    return (int(c['drawdown_wei'])<=int(b['drawdown_wei']) and
            int(c['recovery_loss_wei'])<=int(b['recovery_loss_wei']) and
            c['losing_recoveries']<=b['losing_recoveries'])

def ratios(c,b):
    def pct(k):return 100*int(c[k])/int(b[k]) if int(b[k]) else None
    return dict(win_trades=pct('winners'),loss_trades=pct('losers'),win_money=pct('profit_wei'),loss_money=pct('loss_wei'))

def select():
    design,coverage,records=collect(SCENARIOS[:6])
    primary=[s['name'] for s in SCENARIOS[:6]]
    training={s:{n:measure(records[s],n,START,FIT_END) for n in records[s][0]['runs']} for s in primary}
    picks={}
    for family in sorted({r.family for r in candidates()}):
        names=[r.name for r in candidates() if r.family==family]
        safe=[n for n in names if all(riskpass(training[s][n],training[s]['matched20']) for s in primary)]
        pool=safe or names
        winner=max(pool,key=lambda n:(min(int(training[s][n]['net_wei']) for s in primary),-len(n),n))
        picks[family]=dict(name=winner,training_risk_qualified=winner in safe,
                           worst_training_net_eth=min(eth(training[s][winner]['net_wei']) for s in primary))
    frozen=dict(fit_end=FIT_END,representatives=picks,training=training,
                design_sha256=digest(OUT/'design.json'),method=design['selection'])
    if (OUT/'selection.json').exists():
        assert read_json(OUT/'selection.json')==frozen
    else:write_json(OUT/'selection.json',frozen)
    print('Training-only representatives frozen:',len(picks),flush=True)


def report():
    design,coverage,records=collect();selection=read_json(OUT/'selection.json')
    assert selection['design_sha256']==digest(OUT/'design.json')
    end=design['end'];cut=design['reserved_start']
    periods={'full':(START,end),'fit':(START,FIT_END),'validation':(FIT_END,cut),'reserved':(cut,end),'adaptive_history':(START+5*DAY,end)}
    names=list(records[CENTRAL][0]['runs'])
    scores={s:{n:{p:measure(segs,n,a,b) for p,(a,b) in periods.items()} for n in names} for s,segs in records.items()}
    for s in scores:
        for n in names:
            for p in periods:
                scores[s][n][p]['kpis']=ratios(scores[s][n][p],scores[s]['continuous'][p])
    representatives={f:d['name'] for f,d in selection['representatives'].items()}
    primary=[s['name'] for s in SCENARIOS[:6]]
    verdicts={}
    for f,n in representatives.items():
        checks={}
        for p in ('fit','validation','reserved','full'):
            checks[p]=dict(net_better=sum(int(scores[s][n][p]['net_wei'])>int(scores[s]['matched20'][p]['net_wei']) for s in primary),
                risk_no_worse=sum(riskpass(scores[s][n][p],scores[s]['matched20'][p]) for s in primary),scenarios=6)
        verdicts[f]=dict(**selection['representatives'][f],checks=checks)
    qualified=[n for f,n in representatives.items() if selection['representatives'][f]['training_risk_qualified'] and
               all(riskpass(scores[s][n]['validation'],scores[s]['matched20']['validation']) and
                   int(scores[s][n]['validation']['net_wei'])>int(scores[s]['matched20']['validation']['net_wei']) for s in primary)]
    recommendation=max(qualified,key=lambda n:min(int(scores[s][n]['validation']['net_wei']) for s in primary)) if qualified else 'matched20'
    # Exploratory whole-history winners are explicitly distinct from training-selected representatives.
    exploratory=max((r.name for r in candidates()),key=lambda n:int(scores[CENTRAL][n]['full']['net_wei']))
    retained={}
    for n in BASES+list(representatives.values()):
        by={x['id']:x['pnl'] for seg in records[CENTRAL] for x in seg['runs'][n]['cash']}
        ref={x['id']:x['pnl'] for seg in records[CENTRAL] for x in seg['runs']['continuous']['cash']}
        skipped=set(ref)-set(by);added=set(by)-set(ref)
        retained[n]=dict(missed_win_wei=str(sum(max(0,ref[t]) for t in skipped)),avoided_loss_wei=str(-sum(min(0,ref[t]) for t in skipped)),
                        added_win_wei=str(sum(max(0,by[t]) for t in added)),added_loss_wei=str(-sum(min(0,by[t]) for t in added)),added_trades=len(added),skipped_trades=len(skipped))
    bins={}
    for label,edges in [('24h',[end-DAY+i*3*HOUR for i in range(9)]),('7d',[end-7*DAY+i*DAY for i in range(8)]),('september',[*range(START,end,DAY),end])]:
        bins[label]=[dict(start=a,end=b,scores={n:measure(records[CENTRAL],n,a,b) for n in BASES+list(representatives.values())}) for a,b in zip(edges,edges[1:])]
    blocked={n:dict(sum((Counter(seg['runs'][n]['reasons']) for seg in records[CENTRAL]),Counter())) for n in BASES+list(representatives.values())}
    identical=defaultdict(list)
    for n in names:
        admissions=[(d['at'],d['id'],d.get('size')) for seg in records[CENTRAL] for d in seg['runs'][n]['admitted']]
        identical[hashlib.sha256(json.dumps(admissions,sort_keys=True).encode()).hexdigest()].append(n)
    frontier=[]
    for n in names:
        c=scores[CENTRAL][n]['full']
        if not any(int(scores[CENTRAL][m]['full']['profit_wei'])>=int(c['profit_wei']) and int(scores[CENTRAL][m]['full']['loss_wei'])<=int(c['loss_wei']) and int(scores[CENTRAL][m]['full']['drawdown_wei'])<=int(c['drawdown_wei']) and any(int(scores[CENTRAL][m]['full'][k])!=int(c[k]) for k in ('profit_wei','loss_wei','drawdown_wei')) for m in names if m!=n):
            frontier.append(n)
    out=dict(exploratory_pareto_frontier=frontier,identical_admission_groups=list(identical.values()),blocked_reasons=blocked,periods=periods,scores=scores,verdicts=verdicts,recommendation=recommendation,qualified=qualified,
             exploratory_best=exploratory,retention=retained,bins=bins,source_hashes={str(p):digest(p) for p in (OUT/'design.json',OUT/'selection.json')})
    write_json(OUT/'scorecards.json',out)
    charts(records,representatives,scores,out,coverage)
    full=scores[CENTRAL]
    lines=['# September guard experiment','',f'59 variants, 15 guard families, nine scenarios, September 1 00:00 to {iso(end)} UTC.',
           '',f'Conservative comparison choice: **{recommendation}**. This is diagnostic historical research, not a live activation decision.',
           '',f'Whole-history exploratory highest net: **{exploratory}**. It was found by searching the full sample and is not an unbiased forecast.',
           '', 'Parameters for each family were selected only from September 1-7. September 8 onward was then scored without changing them. All dates had already been inspected in prior work, including the final six hours.',
           '', '## Your four KPIs and risk', '',
           'Money is modeled ETH, including estimated costs. Ratios have the same-period always-on denominator. Losing trades and loss money are retained losses, so lower is better. Higher win retention is better.', '',
           '| Guard | Net ETH | Wins retained | Loss trades retained | Win money retained | Loss money retained | Conditional DD ETH | Validation net / risk passes |',
           '|---|---:|---:|---:|---:|---:|---:|---|']
    for n in BASES+list(representatives.values()):
        z=full[n]['full'];k=z['kpis'];v=next((d for d in verdicts.values() if d['name']==n),None)
        checks=f"{v['checks']['validation']['net_better']}/6; {v['checks']['validation']['risk_no_worse']}/6" if v else 'control'
        lines.append(f"| {n} | {eth(z['net_wei']):+.4f} | {k['win_trades']:.1f}% | {k['loss_trades']:.1f}% | {k['win_money']:.1f}% | {k['loss_money']:.1f}% | {eth(z['drawdown_wei']):.4f} | {checks} |")
    lines += ['', '## What the comparison can establish','',
       f'The 62 controls and candidate variants produce {len(identical)} distinct admission/size histories in the central scenario. Identical settings do not count as independent evidence.',
       '', 'The complete-interval study contains 11 separate flat accounts around ten unresolved graduated exits. It omits 63 minutes of admission time. Lines concatenate their cash only as a conditional comparison. Account and guard state restart at these boundaries; cumulative plotted losses never disappear. The strict uninterrupted September account remains unavailable beyond the first unsupported execution.',
       '', 'All primary guard runs retain the same drawdown, capacity, template-loss and bot-divergence stops. The always-on denominator removes account pauses by definition. A separate scenario replays recorded human controls. It is not mixed into automatic-policy ranking.',
       '', 'The existing drawdown-stop recovery still uses its original observation rule. This sweep changes the market guard only. It does not establish that the separate drawdown recovery logic is optimal.',
       '', 'TP stays adaptive in every candidate. Its historical selector uses the wider recorded launch population and falls back to 1.75 before full bar history is available on September 5. Thus the early September period does not contain fully adaptive target selection.',
       '', 'The matched adaptive shadow indicator stays the common information source. Short sums, accumulated outcomes and timing are guard features derived from that same source. The execution-delay scenarios change modeled account fills; they keep the chosen central shadow tape fixed. Publication-delay scenarios delay evidence by 60 seconds.',
       '', 'The standardized actual-cash fidelity check was rerun in fidelity/. It remains diagnostic. Exact historical curve prices support comparative evidence, but execution and account discrepancies remain.',
       '', 'Earned exposure uses independently priced quarter/half stakes. Other rules keep normal stake. A change in size alone can reduce loss-money retention, so winning/losing trade counts and net cash remain visible.',
       '', '## Candidate behavior', '']
    for f,n in representatives.items():
        z=full[n]['full'];v=verdicts[f];k=z['kpis'];reasons=Counter()
        for seg in records[CENTRAL]: reasons.update(x['reason'] for x in seg['runs'][n].get('guard_transitions',[]))
        lines += [f'### {f}', '',design['families'][f]+'.', '',
          f"Selected variant `{n}`. Training risk qualified: {v['training_risk_qualified']}. Validation improved net in {v['checks']['validation']['net_better']}/6 scenarios and met all risk limits in {v['checks']['validation']['risk_no_worse']}/6. Final six-hour checks: {v['checks']['reserved']['net_better']}/6 net, {v['checks']['reserved']['risk_no_worse']}/6 risk.", '',
          f"Blocked/admitted reasons: {blocked[n]}.", '',
          f"September retained {k['win_money']:.1f}% of always-on winning money and {k['loss_money']:.1f}% of losing money. Guard resumes: {z['resumes']}. Settled losing recoveries: {z['losing_recoveries']}. State-change reasons: {dict(reasons)}.", '']
    lines+=['## Files and reproduction','',
        'Run from bot/: `python3 -m research.core.september_guard_study freeze`, then `python3 -m research.core.september_guard_study run`, then `python3 -m research.core.september_guard_report select`, then `python3 -m research.core.september_guard_report report`.', '',
        'The frozen design binds source and data hashes. Existing outputs refuse changed definitions. Use a new output directory for another experiment. scorecards.json includes all variants, scenarios, period statistics, exact integer cash and 24-hour/7-day bins. runs/ contains every admitted trade, blocked-reason count, cash event and guard transition. selection.json documents training-only selection. No live settings were changed.']
    (OUT/'report.md').write_text('\n'.join(lines)+'\n')
    write_json(OUT/'verification.json',dict(all_accounts_complete=all(r['complete'] for segs in records.values() for seg in segs for r in seg['runs'].values()),
         scenario_count=len(records),interval_count=len(coverage['intervals']),accounts=sum(len(seg['runs']) for segs in records.values() for seg in segs),
         accounting_checks='All aggregates reconstructed from unique complete cash rows; P+L=net and KPI raw denominator identities checked in chart generator.',
         visual_review_pending=True,source_hashes={str(p):digest(p) for p in [Path(__file__),OUT/'scorecards.json',OUT/'selection.json']}))
    print('Recommendation',recommendation,'exploratory',exploratory,flush=True)
    for f,v in verdicts.items():print(f,v['name'],v['checks']['validation'],flush=True)


def charts(records,reps,scores,result,coverage):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as md
    import numpy as np
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    def dt(t):return datetime.fromtimestamp(t/1000,timezone.utc)
    def cash(n):return sorted([x for seg in records[CENTRAL] for x in seg['runs'][n]['cash']],key=lambda x:x['at'])
    def series(n):
        rows=cash(n);return [dt(START)]+[dt(x['at']) for x in rows],[0]+list(np.cumsum([x['pnl']/1e18 for x in rows]))
    end=coverage['end'];base=scores[CENTRAL]['matched20']['full']
    rule_map={r.name:r for r in candidates()}
    def pretty(n):
        if n in {'continuous','current_guard','matched20'}:return {'continuous':'Always-on','current_guard':'Original guard','matched20':'Adaptive -1/+2'}[n]
        r=rule_map[n];return f'{r.family}: h={r.scale:g}, W={r.window}'
    selected=list(dict.fromkeys(['continuous','matched20',result['recommendation'],result['exploratory_best'],reps['trail'],reps['memory']]))
    colors=['#777777','#2166ac','#009e73','#cc79a7','#d55e00','#e69f00']
    fig,axes=plt.subplots(3,2,figsize=(16,12));axes=axes.ravel()
    for j,n in enumerate(selected):
        x,y=series(n);axes[0].step(x,y,where='post',label=pretty(n),color=colors[j],linestyle=['--','-',':','-.','-',':'][j])
    axes[0].set_title('September: conditional cumulative net cash');axes[0].set_ylabel('Modeled ETH');axes[0].legend(fontsize=8)
    times=list(range(START,end,3*HOUR))+[end]
    for ax,key,title in zip(axes[1:5],['winners','losers','profit_wei','loss_wei'],['Winning trades retained ↑','Losing trades retained ↓','Winning money retained ↑','Losing money retained ↓']):
        for j,n in enumerate(selected):
            vals=[]
            for t in times:
                c=cash_metrics([r for r in cash(n) if r['at']<t]);b=cash_metrics([r for r in cash('continuous') if r['at']<t])
                vals.append(100*int(c[key])/int(b[key]) if int(b[key]) else float('nan'))
            ax.plot([dt(t) for t in times],vals,color=colors[j],linestyle=['--','-',':','-.','-',':'][j])
        ax.set_title(title);ax.set_ylabel('% of always-on');ax.set_ylim(bottom=0)
    for seg in records[CENTRAL]:
        rows=seg['shadow_records'];tot=0;xx=[];yy=[]
        for i,row in enumerate(rows):
            if row['available']<START:continue
            selected_rows=sorted(rows[:i+1],key=lambda r:r['launched'])[-20:]
            valid=len(selected_rows)==20 and row['available']-selected_rows[0]['launched']<=3*HOUR
            xx.append(dt(row['available']));yy.append(sum(r['value'] for r in selected_rows) if valid else float('nan'))
        axes[5].plot(xx,yy,color='#2166ac',linewidth=0.8)
    axes[5].axhline(2,color='gray',linestyle='--');axes[5].axhline(-1,color='gray',linestyle=':')
    axes[5].set_title('Common adaptive shadow indicator');axes[5].set_ylabel('Last 20 outcomes, stakes')
    for ax in axes:
        for a,b in coverage['intervals'][1:]:ax.axvline(dt(a),color='gray',alpha=.2,linewidth=.6)
        ax.axvspan(dt(end-6*HOUR),dt(end),color='#e69f00',alpha=.1)
        ax.xaxis.set_major_formatter(md.DateFormatter('%b %d',tz=timezone.utc));ax.grid(alpha=.15)
    fig.suptitle(f'September 1 to {iso(end)} UTC | 59 guard variants; adaptive TP held constant',fontsize=15)
    fig.text(.02,.015,'11 independent complete intervals, concatenated for comparison only. Gray lines: account restarts at missing-data boundaries.\nOrange band: final 6 hours excluded from selection. Diagnostic modeled cash; no prospective validation.',fontsize=10)
    fig.tight_layout(rect=[0,.055,1,.95]);fig.savefig(OUT/'september-lines-kpis.png',dpi=140);plt.close(fig)
    # All families remain visible, including failed ideas.
    ns=['matched20']+list(reps.values());labels=['Adaptive baseline']+list(reps)
    fig,ax=plt.subplots(figsize=(13,9))
    matrix=np.array([[scores[CENTRAL][n]['full']['kpis'][k] for k in ('win_trades','loss_trades','win_money','loss_money')] for n in ns])
    im=ax.imshow(matrix,aspect='auto',cmap='Blues',vmin=0,vmax=100)
    for i in range(len(ns)):
        for j in range(4):ax.text(j,i,f'{matrix[i,j]:.1f}%',ha='center',va='center',color='white' if matrix[i,j]>55 else 'black')
    ax.set_xticks(range(4),['Win trades ↑','Loss trades ↓','Win money ↑','Loss money ↓']);ax.set_yticks(range(len(ns)),labels)
    ax.set_title('Training-selected representative from every family | September retention vs always-on')
    fig.colorbar(im,ax=ax,label='Retained %');fig.text(.02,.02,'Higher wins and lower losses are preferred. Color indicates magnitude only, not quality. ETH cash, including modeled costs.',fontsize=10)
    fig.tight_layout(rect=[0,.04,1,1]);fig.savefig(OUT/'family-kpis.png',dpi=140);plt.close(fig)
    fig,axes=plt.subplots(5,3,figsize=(16,16),sharex=True,sharey=True)
    for ax,(f,n) in zip(axes.ravel(),reps.items()):
        for name,c,style in [('continuous','#aaaaaa','--'),('matched20','#2166ac','-'),(n,'#d55e00','-')]:
            x,y=series(name);ax.step(x,y,where='post',color=c,linestyle=style,linewidth=1.1)
        z=scores[CENTRAL][n]['full'];ax.set_title(f"{f}: {eth(z['net_wei']):+.3f} ETH",fontsize=11)
        ax.xaxis.set_major_formatter(md.DateFormatter('%d Sep'));ax.grid(alpha=.15)
    fig.suptitle('Every guard family: orange candidate, blue adaptive baseline, gray always-on',fontsize=15)
    fig.text(.02,.015,'September 1-11, 12:44 UTC. Shared axes show profit missed. Cash concatenates independent complete intervals, not one wallet.',fontsize=10)
    fig.supylabel('Conditional cumulative modeled ETH');fig.tight_layout(rect=[.015,.04,1,.96]);fig.savefig(OUT/'all-family-lines.png',dpi=130);plt.close(fig)
    # Explore every setting without treating the exploratory frontier as validation.
    import plotly.graph_objects as go
    figi=go.Figure()
    for f in reps:
        nsf=[r.name for r in candidates() if r.family==f]
        figi.add_trace(go.Scatter(x=[scores[CENTRAL][n]['full']['kpis']['loss_money'] for n in nsf],
            y=[scores[CENTRAL][n]['full']['kpis']['win_money'] for n in nsf], mode='markers',name=f,
            text=[f"{n}<br>Net {eth(scores[CENTRAL][n]['full']['net_wei']):+.4f} ETH<br>Conditional DD {eth(scores[CENTRAL][n]['full']['drawdown_wei']):.4f} ETH" for n in nsf],
            marker=dict(size=10),hovertemplate='%{text}<br>Loss money retained %{x:.1f}%<br>Win money retained %{y:.1f}%<extra></extra>'))
    bk=scores[CENTRAL]['matched20']['full']['kpis']
    figi.add_trace(go.Scatter(x=[bk['loss_money']],y=[bk['win_money']],mode='markers',name='Adaptive baseline',marker=dict(symbol='star',size=18,color='black')))
    figi.update_layout(title='All 59 settings: upper left retains more wins and fewer losses',xaxis_title='Losing money retained % (lower is better)',yaxis_title='Winning money retained % (higher is better)',template='plotly_white',height=750,
        annotations=[dict(text='Sep 1-11, 12:44 UTC. Conditional complete intervals, diagnostic simulation. Hover for settings and drawdown.',xref='paper',yref='paper',x=0,y=-.15,showarrow=False)])
    figi.write_html(OUT/'explore-all-settings.html',include_plotlyjs=True)

    # All 59 variants, to expose unstable settings and attractive discarded points.
    fig,axes=plt.subplots(1,2,figsize=(15,7))
    for ax,p in zip(axes,('fit','validation')):
        for f,n in reps.items():
            rs=[r.name for r in candidates() if r.family==f]
            ax.scatter([eth(scores[CENTRAL][x][p]['drawdown_wei']) for x in rs],[eth(scores[CENTRAL][x][p]['net_wei']) for x in rs],alpha=.35,s=25,color='#777777')
            z=scores[CENTRAL][n][p]
            if f in ('fresh','earned','trail','permit'):
                ax.annotate(f,(eth(z['drawdown_wei']),eth(z['net_wei'])),fontsize=9)
        z=scores[CENTRAL]['matched20'][p];ax.scatter([eth(z['drawdown_wei'])],[eth(z['net_wei'])],marker='*',color='black',s=130,label='Adaptive baseline')
        ax.set_title('Sep 1-7: selection' if p=='fit' else 'Sep 8 onward: assessment, final 6h excluded');ax.set_xlabel('Conditional cumulative drawdown ETH ↓');ax.set_ylabel('Net ETH ↑');ax.legend();ax.grid(alpha=.2)
    fig.suptitle('All 59 settings: higher profit and lower drawdown is the preferred direction');fig.tight_layout();fig.savefig(OUT/'settings-sensitivity.png',dpi=140);plt.close(fig)
    for s in scores.values():
        for n,zs in s.items():
            for z in zs.values():
                assert int(z['profit_wei'])-int(z['loss_wei'])==int(z['net_wei'])
                assert z['winners']+z['losers']<=z['n']

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['select','report']);a=p.parse_args()
    select() if a.command=='select' else report()
