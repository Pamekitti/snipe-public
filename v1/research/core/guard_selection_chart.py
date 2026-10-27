"""Final guard selection: cash lines and four always-on KPI ratios, offline only."""
from dataclasses import asdict
from pathlib import Path
import bisect
import datetime as dt
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from .data import read_json,write_json,digest,DAY,HOUR
from .long_history import OUT,ROOT
from .guard_visual import close_cash
from .fidelity import cash_metrics
from .indicators import candidates

DEST=OUT/'final-selection'
NAMES=['continuous','market_plus2','fixed_shadow20','matched20']
LABELS={'continuous':'Always on','market_plus2':'Current guard','fixed_shadow20':'SELECTED: same launches, fixed target','matched20':'Same launches, adaptive target'}
COLORS={'continuous':'#788592','market_plus2':'#c76026','fixed_shadow20':'#6551a4','matched20':'#1677a8'}
STYLES={'continuous':(0,(5,3)),'market_plus2':(0,(2,1)),'fixed_shadow20':'-','matched20':(0,(5,2,1,2))}
METRICS=[('winners','Winning trades captured ↑'),('losers','Losing trades retained ↓'),('profit_wei','Winning money captured ↑'),('loss_wei','Losing money retained ↓')]

def date(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc)
def eth(v):return int(v)/1e18
def completed(run):
    assert run['complete'] and not run['open_ids'] and not run['unresolved']
    return close_cash(run)

def ledger(rows,times):
    """Accumulate whole settled attempts; unknown denominators remain unavailable."""
    assert len({r['id'] for r in rows})==len(rows)
    rows=sorted(rows,key=lambda r:(r['at'],str(r['id'])))
    j=0;acc=dict(net_wei=0,winners=0,losers=0,profit_wei=0,loss_wei=0)
    out={k:[] for k in acc}
    for t in times:
        while j<len(rows) and rows[j]['at']<=t:
            v=int(rows[j]['pnl']);acc['net_wei']+=v
            acc['winners']+=v>0;acc['losers']+=v<0
            acc['profit_wei']+=max(v,0);acc['loss_wei']+=max(-v,0);j+=1
        for k in out:out[k].append(acc[k])
    return out

def chart(label,rows,start,end,intervals=None,*,title=None,subtitle=None,footer=None,names=None,labels=None,colors=None,styles=None,destination=None):
    names=names or NAMES;labels=labels or LABELS;colors=colors or COLORS;styles=styles or STYLES
    destination=destination or DEST
    times=sorted({start,end,*[r['at'] for rr in rows.values() for r in rr]})
    series={n:ledger(rr,times) for n,rr in rows.items()}
    totals={n:cash_metrics(rr) for n,rr in rows.items()}
    ratios={}
    for n in names:
        for key in series[n]:assert series[n][key][-1]==int(totals[n][key])
        ratios[n]={k:100*int(totals[n][k])/int(totals['continuous'][k]) if int(totals['continuous'][k]) else None for k,title in METRICS}
    fig=plt.figure(figsize=(15,12));grid=fig.add_gridspec(3,2,height_ratios=[1.45,1,1])
    axes=[fig.add_subplot(grid[0,:])]+[fig.add_subplot(grid[r,c]) for r in [1,2] for c in [0,1]]
    fig.subplots_adjust(left=.08,right=.96,top=.84,bottom=.12,hspace=.44,wspace=.20)
    xs=[date(t) for t in times]
    for n in names:
        axes[0].step(xs,np.array(series[n]['net_wei'])/1e18,where='post',label=labels[n],color=colors[n],ls=styles[n],lw=2.3 if n=='fixed_shadow20' else 1.6)
    axes[0].set_ylabel('Cumulative comparison cash (ETH)' if intervals else 'Cumulative simulated cash (ETH)')
    axes[0].axhline(0,color='#a7b1ba',lw=.7)
    axes[0].legend(loc='lower left',bbox_to_anchor=(0,1.05),ncol=2,frameon=False,fontsize=10)
    axes[0].set_title('Net cash, including costs',loc='left',fontsize=12,fontweight='bold',pad=3)
    for ax,(key,title) in zip(axes[1:],METRICS):
        den=np.array(series['continuous'][key],dtype=float)
        for n in names:
            num=np.array(series[n][key],dtype=float);yy=np.full(len(den),np.nan)
            np.divide(num*100,den,out=yy,where=den!=0)
            ax.step(xs,yy,where='post',color=colors[n],ls=styles[n],lw=2 if n=='fixed_shadow20' else 1.4)
        ax.set_title(title,loc='left',fontsize=12,fontweight='bold')
        ax.set_ylabel('% of same-period always-on')
        ax.set_ylim(bottom=0,top=max(110,ax.get_ylim()[1]))
    for ax in axes:
        ax.set_xlim(date(start),date(end));ax.grid(axis='y',alpha=.14);ax.set_axisbelow(True)
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%d %b' if intervals else '%d %b\n%H:%M',tz=dt.timezone.utc))
        if intervals:
            for a,b in intervals[1:]:ax.axvline(date(a),color='#bec6ce',alpha=.50,lw=.55)
    title=title or ('23-day comparison: the selected guard keeps profits while reducing losses' if intervals else 'Continuous 48-hour comparison: cash and your four KPIs')
    fig.suptitle(title,x=.06,y=.97,ha='left',fontsize=18,fontweight='bold')
    fig.text(.06,.934,subtitle or f'{date(start):%d %b %Y %H:%M} to {date(end):%d %b %Y %H:%M} UTC | automatic operation | 1,200 ms sell delay',fontsize=11)
    if footer:
        fig.text(.06,.080,footer,fontsize=10)
    elif intervals:
        fig.text(.06,.080,'Vertical lines start separate test accounts. Cumulative values sum 11 complete intervals; they are not one continuous wallet.',fontsize=10)
        fig.text(.06,.052,'Same coverage for every guard. Ten unresolved executions remain excluded; 63 minutes of admission time are omitted.',fontsize=10)
    else:
        fig.text(.06,.080,'One account per rule, initialized once. All account losses and stop state carry across the full 48 hours.',fontsize=10)
        fig.text(.06,.052,'This recent test supports the decision; the longer comparison determines the selection.',fontsize=10)
    fig.text(.06,.024,'KPIs use cumulative settled attempts. Failed-buy gas counts as a loss. Winning/loss money uses net ETH; denominator is always-on.',fontsize=10)
    fig.savefig(destination/f'{label}.png');plt.close(fig)
    return dict(start=start,end=end,totals=totals,ratios=ratios,
        series=dict(times=times,values=series),intervals=intervals)

def main():
    DEST.mkdir(exist_ok=True)
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,
        'figure.facecolor':'#f8fafc','axes.facecolor':'white','savefig.dpi':160})
    index=read_json(OUT/'segments-index.json');a,b=index['start'],index['end']
    groups=[read_json(OUT/'segments'/f'reconstructed_early-{i:02}-automatic-adaptive.json') for i in range(len(index['intervals']))]
    rows={n:[dict(r,id=f'{i}/{r["id"]}') for i,g in enumerate(groups) for r in completed(g['runs'][n])] for n in NAMES}
    longer=chart('full-history-lines-kpis',rows,a,b,index['intervals'])
    old=read_json(OUT/'automatic-scorecards.json')['rows']
    for n in NAMES:
        for key in ['net_wei','profit_wei','loss_wei','winners','losers']:
            assert int(longer['totals'][n][key])==int(old[n]['central'][key])
    g=read_json(OUT/'groups'/f'recorded-{b-2*DAY}-automatic-adaptive.json')
    recent=chart('continuous-48h-lines-kpis',{n:completed(g['runs'][n]) for n in NAMES},b-2*DAY,b)
    bins={}
    for count,width,label in [(8,3*HOUR,'24h'),(7,DAY,'7d')]:
        bins[label]=[]
        for i in range(count):
            lo=b-(count-i)*width;hi=lo+width
            source=rows if label=='7d' else {n:completed(g['runs'][n]) for n in NAMES}
            ss={n:cash_metrics([r for r in rr if lo<=r['at']<hi]) for n,rr in source.items()}
            rr={n:{k:100*int(ss[n][k])/int(ss['continuous'][k]) if int(ss['continuous'][k]) else None for k,title in METRICS} for n in NAMES}
            bins[label].append(dict(start=lo,end=hi,scores=ss,ratios=rr,comparison='Separate coverage intervals' if label=='7d' else 'Continuous account, state retained'))
    chosen=next(r for r in candidates() if r.name=='fixed_shadow20')
    decision=dict(selected_policy='fixed_shadow20',definition=asdict(chosen),status='selected_for_implementation_not_live',
        alternative='matched20 trades some net profit for less drawdown in the central longer case',
        basis='Highest automatic comparison net among candidates improving net, worst-interval drawdown and recovery loss in all six original automatic scenarios.',
        live_changes=False,frozen_capture_end=b,model_design_sha256=digest(ROOT/'frozen-design.json'),
        source_hashes={str(p):digest(p) for p in [OUT/'automatic-scorecards.json',OUT/'leader-delay-index.json',Path(__file__)]},
        limits=['Conditional separate-interval totals; full continuous 23-day path unavailable.',
            'Does not preserve every profitable interval or win under recorded human controls.',
            'Historical fidelity certificate remains diagnostic. No live configuration or account reset authorized by this selection.'])
    write_json(DEST/'decision.json',decision)
    write_json(DEST/'chart-data.json',dict(longer=longer,recent=recent,bins=bins))
    lines=['# Final selection: same-launch fixed-target indicator','',
        '**Select `fixed_shadow20` for implementation.** Keep the actual adaptive take-profit selector and current filters. The fixed 1.75x target scores only the indicator.',
        'Use the latest 20 available net outcomes from the policy-matched shadow account. Pause below a total of -1 stakes and resume above +2. Require all 20 launches to be within three hours. Preserve all other account stops.',
        '',f'The evidence is frozen at {date(b):%Y-%m-%d %H:%M:%S} UTC. No live settings changed.',
        '', '## Your four KPIs over the longer comparison','',
        'Always-on is the denominator over the same tested period. These are cumulative ratios, not the fraction of a guard’s own trades that win. Loss ratios are retained losses, so lower is better.',
        '', '| Policy | Wins / always-on wins | Losses / always-on losses | Win money / always-on win money | Loss money / always-on loss money |','|---|---:|---:|---:|---:|']
    for n in NAMES:
        r=longer['ratios'][n];s=longer['totals'][n];ref=longer['totals']['continuous']
        lines.append(f'| {LABELS[n]} | {s["winners"]}/{ref["winners"]} = {r["winners"]:.1f}% | {s["losers"]}/{ref["losers"]} = {r["losers"]:.1f}% | {r["profit_wei"]:.1f}% | {r["loss_wei"]:.1f}% |')
    s,base=longer['totals']['fixed_shadow20'],longer['totals']['market_plus2']
    lines+=['',f'The selected policy gives up {eth(int(base["profit_wei"])-int(s["profit_wei"])):.6f} ETH of winning money while reducing losing money by {eth(int(base["loss_wei"])-int(s["loss_wei"])):.6f} ETH. The difference adds {eth(int(s["net_wei"])-int(base["net_wei"])):.6f} ETH to the interval comparison score.',
        '', '![Full history lines and KPIs](full-history-lines-kpis.png)','',
        'These lines sum 11 separately initialized test intervals, with equal coverage exclusions. The sum is not a continuous-wallet simulation. The small multiples retain the cumulative denominator across intervals.',
        '', '## Independent continuous 48-hour view','', '![Continuous 48h lines and KPIs](continuous-48h-lines-kpis.png)','',
        '| Policy | Net ETH | Continuous drawdown ETH | Wins captured | Losses retained | Winning money captured | Losing money retained |','|---|---:|---:|---:|---:|---:|---:|']
    for n in NAMES:
        s=recent['totals'][n];r=recent['ratios'][n]
        lines.append(f'| {LABELS[n]} | {eth(s["net_wei"]):+.6f} | {eth(s["drawdown_wei"]):.6f} | {r["winners"]:.1f}% | {r["losers"]:.1f}% | {r["profit_wei"]:.1f}% | {r["loss_wei"]:.1f}% |')
    lines+=['','## Why this one','',
        '- It produces the highest central automatic net among the three candidates improving net, worst-interval drawdown and recovery loss across all six automatic scenarios.',
        '- Its advantage also survives an additional 60 seconds of indicator-publication delay in all six automatic scenarios.',
        '- The adaptive matched indicator has lower central drawdown. The fixed-target version captures more winning money and loses fewer recovery episodes in the central longer comparison.',
        '- The decision uses the whole tested history. The recent 48-hour chart is a consistency check, not a new selection window.',
        '- It does not win every profitable period and loses its advantage in most recorded human-control scenarios. Those results remain in the full comparison.',
        '- No live enablement follows from this file. The implementation and actual-cash fidelity gaps remain separate work.',
        '', '## Statistics and reproducibility','', '| Policy | Mean / median / sample SD / n, net ETH per settled attempt |','|---|---|']
    for n in NAMES:
        s=longer['totals'][n]['cash_eth'];lines.append(f'| {LABELS[n]} | {s["mean"]:+.6f} / {s["median"]:+.6f} / {s["sd"]:.6f} / {s["n"]} |')
    lines+=['','The numeric series and all four ratios are in chart-data.json. It also contains eight three-hour bins and seven daily bins. Every chart endpoint agrees with the saved comparison scorecard. A zero denominator stays unavailable. Cash amounts are in ETH and include costs. Failed buys are losing attempts.',
        '', 'Run from bot/: `python3 -m research.core.guard_selection_chart`. This command reads existing artifacts and writes this report; it performs no new strategy search.']
    (DEST/'decision.md').write_text('\n'.join(lines)+'\n')
    write_json(DEST/'verification.json',dict(raw_cash_matches_scorecard=True,chart_endpoints_match_cash=True,unique_attempt_ids=True,
        denominator='Same period, same scenario, always-on account',zero_denominator='unavailable',visual_review_pending=True))
    print('Selection charts and KPIs verified',DEST,flush=True)

if __name__=='__main__':main()
