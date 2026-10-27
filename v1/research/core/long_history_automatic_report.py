"""Show the automatic-operation comparison separately from recorded human controls."""
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from .data import read_json,write_json,DAY
from .long_history import OUT,ROOT,SOURCE,summary,observations_for
from .execution import describe
from .guard_visual import close_cash
from .indicator_study import make_tapes
from .indicators import candidates
import datetime as dt
import matplotlib.dates as mdates

def eth(x):return int(x)/1e18

def automatic_chart():
    index=read_json(OUT/'index.json');end=index['end'];start=end-2*DAY;a=end-DAY
    g=read_json(OUT/'groups'/f'recorded-{start}-automatic-adaptive.json')
    raw,models=read_json(SOURCE),read_json(ROOT/'models.json')
    obs=observations_for(raw,models,False)
    tapes,missing=make_tapes(raw,models,g['runs']['continuous'],obs)
    ts=list(range(a,end,60000));date=lambda t:dt.datetime.fromtimestamp(t/1000,dt.timezone.utc)
    fig,axes=plt.subplots(2,1,figsize=(14,9),sharex=True)
    fig.subplots_adjust(left=.10,right=.96,top=.80,bottom=.15,hspace=.22)
    ns=['continuous','market_plus2','fixed_shadow20','matched20']
    labels=['Always on','Current guard','Same launches, fixed-target signal','Same launches, adaptive signal']
    colors=['#687582','#c76026','#7b58a5','#1677a8']
    for n,label,c in zip(ns,labels,colors):
        assert g['runs'][n]['complete']
        rows=[r for r in close_cash(g['runs'][n]) if a<=r['at']<end and r['id'] not in g['runs'][n]['open_ids']]
        vals=np.cumsum([0]+[eth(r['pnl']) for r in rows]).tolist()
        axes[0].step([date(a)]+[date(r['at']) for r in rows]+[date(end)],vals+[vals[-1]],where='post',label=label,color=c,linewidth=2,ls='--' if n=='continuous' else '-')
    axes[0].legend(loc='upper left',bbox_to_anchor=(0,1.32),ncol=2,frameon=False,fontsize=10)
    axes[0].set_ylabel('24h simulated cash\nchange (ETH)')
    for name,label,c in [('native20_control','Original sensor','#c76026'),('fixed_shadow20','Matched launches, fixed target','#7b58a5'),('matched20','Matched launches, adaptive target','#1677a8')]:
        rule=next(r for r in candidates() if r.name==name)
        ss=[tapes[rule.source].estimate(t,rule) for t in ts]
        axes[1].plot([date(t) for t in ts],[20*s['value'] if s['fresh'] else np.nan for s in ss],label=label,color=c,alpha=.85,linewidth=1.25)
    for value in [-1,2]:axes[1].axhline(value,color='#75818e',ls='--',linewidth=1)
    axes[1].legend(loc='upper left',bbox_to_anchor=(0,1.12),ncol=3,fontsize=9,frameon=False)
    axes[1].set_ylabel('Indicator sum\n(normalized stakes)')
    for ax in axes:ax.axhline(0,color='#b0bac3',lw=.7);ax.grid(axis='y',alpha=.15)
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%d %b\n%H:%M',tz=dt.timezone.utc));axes[1].set_xlim(date(a),date(end))
    fig.suptitle('Same coins, different guards: the latest 24 hours',x=.065,y=.97,ha='left',fontsize=19,fontweight='bold')
    fig.text(.065,.92,'Automatic operation, without human restarts | account risk stops retained | 1,200 ms modeled sell delay',fontsize=11)
    fig.text(.065,.078,'These continuous accounts start on 9 Sep at 12:44 UTC. The chart rebases cash on 10 Sep; account state and losses carry forward.',fontsize=10)
    fig.text(.065,.044,'Indicator gaps mean unavailable or stale evidence. Dashed thresholds are −1 / +2. Scores describe past outcomes, not promised future profit.',fontsize=10)
    fig.text(.065,.012,'Actual historical coin paths, simulated fills and cash. Only the always-on reference disables account stops.',fontsize=10)
    fig.savefig(OUT/'automatic-cash-indicators-24h.png');plt.close(fig)

def render():
    d=read_json(OUT/'comparative-scorecards.json')
    groups={k:v for k,v in d['aggregates'].items() if '/automatic/' in k}
    primary=groups['reconstructed_early/automatic/adaptive']
    names=['continuous','market_plus2','stale_hold','fixed_shadow20','matched20','recent_profit','staged']
    labels=['Always on, all stops off','Current guard','Keep existing pause if stale','Same launches + fixed-target signal','Same launches + adaptive signal','Recent weighted profit','Staged entries']
    rows={}
    for n in primary:
        rr=[g[n] for g in groups.values()]
        rows[n]=dict(central=primary[n],higher_net=sum(r['extra_vs_current_eth']>0 for r in rr),
            no_worse_dd=sum(r['no_worse_worst_interval_dd'] for r in rr),
            no_worse_recovery_loss=sum(g[n]['recovery_loss_eth']<=g['market_plus2']['recovery_loss_eth'] for g in groups.values()),
            preserves_profitable_intervals=sum(r['preserves_profitable_intervals'] for r in rr),
            extra_min_eth=min(r['extra_vs_current_eth'] for r in rr),extra_max_eth=max(r['extra_vs_current_eth'] for r in rr),
            scenario_n=len(rr))
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,
        'figure.facecolor':'#f8fafc','axes.facecolor':'white','savefig.dpi':150})
    fig,axes=plt.subplots(1,2,figsize=(15,8),gridspec_kw={'width_ratios':[1.3,1]})
    fig.subplots_adjust(left=.29,right=.96,top=.82,bottom=.18,wspace=.35)
    for ax,key,title in [(axes[0],'net_wei','Sum across tested intervals (ETH)'),(axes[1],'worst_interval_drawdown_wei','Worst interval drawdown (ETH)')]:
        vals=[eth(primary[n][key]) for n in names]
        ax.barh(range(len(names)),vals,color=['#687582' if n=='continuous' else '#c76026' if n=='market_plus2' else '#1677a8' for n in names])
        ax.set_yticks(range(len(names)),labels if ax==axes[0] else ['']*len(names));ax.invert_yaxis();ax.grid(axis='x',alpha=.15);ax.set_axisbelow(True)
        ax.set_xlim(0,max(vals)*1.22);ax.set_title(title,fontsize=12)
        for i,v in enumerate(vals):ax.text(v+max(vals)*.025,i,f'{v:.4f}',va='center',fontsize=11)
    fig.suptitle('For automatic trading, matching the indicator population helps most',x=.045,y=.96,ha='left',fontsize=18,fontweight='bold')
    fig.text(.045,.905,'19 Aug to 11 Sep 2026 | current trading configuration | no human restarts | 1,200 ms modeled sell delay',fontsize=11)
    fig.text(.045,.10,'Each of 11 common coverage intervals starts a separate account. These sums are comparison scores, not one continuous wallet.',fontsize=10)
    fig.text(.045,.065,'The matched signals beat the current guard in all six automatic scenarios. Recorded human-control scenarios give a different ranking.',fontsize=10)
    fig.text(.045,.030,'Earlier missing fixed-target observations are reconstructed in this central case. All six automatic scenarios are reported separately.',fontsize=10)
    fig.savefig(OUT/'automatic-profit-risk.png');plt.close(fig)
    lines=['# Guard evidence for future automatic operation','',
        '**The strongest larger replacement in the automatic scenarios is fixed_shadow20.** The policy-matched adaptive version, matched20, is close behind. Both improve net cash, worst-interval drawdown and recovery losses in all six automatic scenarios.',
        'The smaller stale-data change is the most consistent improvement across both automatic and recorded human-control scenarios. None of the candidates satisfies every predeclared condition.',
        '', '## Automatic comparison','',
        'This view removes recorded human interventions while retaining every candidate’s account stop and drawdown recovery rules. Always-on removes those stops only as an opportunity benchmark.',
        'The underlying frozen study contains this view alongside the recorded-intervention view. Choosing the automatic view reflects the intended future operation; it does not erase the less favorable recorded-control results.',
        'All totals below sum 11 separately initialized accounts over common coverage intervals. They are not the earnings of one continuously running wallet.','',
        '| Policy | Tested-interval net ETH | Worst interval DD ETH | Winning profit captured | Loss avoided | Recovery losses ETH |','|---|---:|---:|---:|---:|---:|']
    for n,label in zip(names,labels):
        s=primary[n];lines.append(f'| {label} ({n}) | {eth(s["net_wei"]):+.6f} | {eth(s["worst_interval_drawdown_wei"]):.6f} | {s["profit_capture_pct"]:.1f}% | {s["loss_avoided_pct"]:.1f}% | {s["recovery_loss_eth"]:.6f} |')
    lines+=['','![Automatic profit and risk](automatic-profit-risk.png)','',
        '| Candidate | Higher net | No worse DD | No worse recovery losses | Preserves profitable intervals | Automatic scenarios | Extra ETH range |','|---|---:|---:|---:|---:|---:|---|']
    for n in names[2:]:
        s=rows[n];lines.append(f'| {n} | {s["higher_net"]} | {s["no_worse_dd"]} | {s["no_worse_recovery_loss"]} | {s["preserves_profitable_intervals"]} | {s["scenario_n"]} | {s["extra_min_eth"]:+.6f} to {s["extra_max_eth"]:+.6f} |')
    lines+=['','## Exact behavior of the leading replacement','',
        '1. Maintain a simulated always-on account using the current entry filters, adaptive exits, normal stake and exposure cap. Its admitted launch IDs define the indicator population.',
        '2. Score those launches with the same modeled entry timing, normal stake and costs, but a fixed 1.75x exit target for the indicator. The actual trading account keeps its adaptive exit selector.',
        '3. Wait until both the modeled result and its publication time are available. Use the latest 20 launch outcomes. Divide each net result by its stake.',
        '4. Require all 20 launches to be no more than three hours old. Insufficient or stale evidence blocks new entries.',
        '5. Pause below a mean of -0.05 stakes per launch. Resume above +0.10 on new evidence. With 20 launches, those are the existing -1/+2 total thresholds.',
        '6. Retain the existing account stops and drawdown-recovery rules. In these tests, the separate drawdown recovery still uses the original monitor.',
        '', '```text',
        'Same policy-admitted launch IDs',
        '        |',
        'Entry timing + stake + costs + fixed 1.75x scoring',
        '        |  result must already be available',
        'Latest 20, each no older than 3 hours',
        '        |',
        'stale / incomplete --------------------> PAUSE',
        'sum < -1 ------------------------------> PAUSE',
        'sum > +2 with new evidence ------------> ALLOW',
        'between thresholds --------------------> KEEP STATE',
        '        |',
        'Existing account stops still have final authority',
        '```','',
        'The matched20 alternative scores the same admitted population with its adaptive exits instead. It also passes the three risk/net comparisons in all six automatic scenarios. The fixed target is therefore not established as the original mistake.',
        '', '## Evidence that limits the recommendation','',
        '- Replaying recorded operator controls reverses the advantage of these larger replacements in most scenarios. Changes to guard timing can interact with those controls.',
        '- Neither larger replacement preserves the current guard’s profit in every profitable interval under every assumption. This remains a tradeoff, not a dominant policy.',
        '- The complete-interval sum renews the risk budget at each coverage boundary. Strict inception tests retain continuous account state and unknown holdings separately.',
        '- The daily previous-week ranking diagnostic chose the current guard on all seven eligible dates in each signal-history version. Thirteen of its fourteen chosen next-day accounts made no trades. It adds little evidence about future selection.',
        '- After identifying the two leaders, both received an additional 60-second publication-delay stress. Both still improved net cash, worst-interval drawdown and recovery losses in all six automatic scenarios. This check was added after comparison and is labeled separately.',
        '- Stale-hold improves the interval net in all 12 scenarios, but its central recorded-control gain comes from only four fewer completed attempts. It is a small operational improvement.',
        '- Before 5 September, missing adaptive-target observations force the documented 1.75x fallback. The historical record does not establish how a fully populated modern monitor would have behaved then.',
        '- Candidate design was inspired by already-inspected losses. Frozen definitions and chronological clocks reduce bias; they do not make the study unbiased or turn it into a future guarantee.',
        '', 'No live code, settings, stake or halt state changed. These findings name comparative candidates; they do not claim that the account is safe to restart.']
    write_json(OUT/'automatic-scorecards.json',dict(primary='reconstructed_early/automatic/adaptive',rows=rows))
    (OUT/'automatic-report.md').write_text('\n'.join(lines)+'\n')
    if (OUT/'index.json').exists():automatic_chart()
    print('Automatic comparison rendered',flush=True)

if __name__=='__main__':render()
