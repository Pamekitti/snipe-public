"""Report frozen discrepancy and sell-clock experiments without selecting a fit."""
import argparse
import collections
import datetime as dt
from pathlib import Path

from .execution_discrepancies import REFERENCE, verify
from .expanded_sample import read, write
from .execution import describe
from .unified_fidelity import read_database, sha


def report(root, clocks):
    frozen=verify(root);verify(clocks);base=Path(frozen['base'])
    rows=read(base/'rows.json');qq=read(base/'requests.json')
    vv=read(base/f'results/{REFERENCE}.json')['results']
    excluded={r['id'] for r in read(base/'excluded.json')}
    db=read_database(frozen['database']);positions={p['id']:dict(p) for p in db.execute('SELECT * FROM positions')}
    marks=collections.defaultdict(list)
    for m in db.execute('SELECT * FROM trade_marks ORDER BY at'):marks[m['position_id']].append(dict(m))
    db.close()
    paired=[i for i,r in enumerate(rows) if r['id'] not in excluded]
    errors=[]
    for i in paired:
        r,p,q=rows[i],vv[i],positions[rows[i]['id']]
        a,s=int(r['actualWei']),int(p['pnlWei'])
        errors.append(dict(id=r['id'],entryAt=r['entryAt'],actualEth=a/1e18,simEth=s/1e18,
            errorEth=(s-a)/1e18,errorPp=100*(s-a)/int(r['sizeWei']),
            costErrorEth=(int(p['costsWei'])-int(r['actualCostsWei']))/1e18,
            falseWinner=a<0<s,actualAccepted=r['actualBuyAccepted'],simAccepted=int(p.get('tokens') or 0)>0,
            exactQuantity=str(r['actualTokens'])==p['tokens'],actualReason=r['actualReason'],simReason=p['reason'],
            markCount=len(marks[r['id']]),burnedGasWei=q['burned_gas_wei'],retryCount=None))
    errors.sort(key=lambda r:abs(r['errorEth']),reverse=True)
    write(root/'ranked-errors.json',errors)
    groups={}
    for name,values in [('All matched',errors),('False winners',[e for e in errors if e['falseWinner']])]:
        groups[name]=dict(n=len(values),absoluteCashErrorEth=sum(abs(e['errorEth']) for e in values),
            absoluteCostErrorEth=sum(abs(e['costErrorEth']) for e in values),
            acceptedMismatch=sum(e['actualAccepted']!=e['simAccepted'] for e in values),
            exactQuantity=sum(e['exactQuantity'] for e in values),
            exitReasonMismatch=sum(e['actualReason']!=e['simReason'] for e in values),
            missingBurnedGas=sum(e['burnedGasWei'] is None for e in values))
    write(root/'error-decomposition.json',groups)
    cases={}
    for id in [2347,2319,2418,2424,2476,2040,2045,2106]:
        i=next(i for i,r in enumerate(rows) if r['id']==id);p=positions[id];q=qq[i]
        nearby=[l for l in q['logs'] if p['exit_at']-3000<=l['at']<=p['exit_at']+1000]
        cases[str(id)]=dict(actual=rows[i],prediction=vv[i],marks=marks[id],nearbyLogs=nearby,
            recordedClose=p['exit_at'],buyHash=p['buy_hash'],sellHash=p['exit_hash'],
            intentEntryMark=p['entry_mark_wei'],contextRecorded=bool(p['context_json']),
            inferredRuntimeEntryMarks=[int(m['mark_wei'])/m['multiple'] for m in marks[id] if m['multiple']])
    write(root/'case-timelines.json',cases)
    cards=read(root/'scorecards.json');clockcards=read(clocks/'scorecards.json')
    coverage=read(clocks/'coverage.json');ids=set(coverage['commonIds']);ci=[i for i,r in enumerate(rows) if r['id'] in ids]
    cr=read(clocks/'results.json')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import numpy as np
    plt.rcParams.update({'font.size':11,'axes.spines.top':False,'axes.spines.right':False})
    def date(t):return dt.datetime.fromtimestamp(t/1000,dt.timezone.utc)
    def curve(indices,values):
        cash=sorted((values[i]['exitAt'],int(values[i]['pnlWei'])/1e18) for i in indices)
        x=[date(min(rows[i]['entryAt'] for i in indices))]+[date(t) for t,v in cash]
        y=np.array([0]+[v for t,v in cash]).cumsum()
        return x,y
    actual=[dict(exitAt=r['exitAt'],pnlWei=r['actualWei']) for r in rows]
    fig,axes=plt.subplots(3,1,figsize=(13,11),layout='constrained')
    for v,label,color,style in [(actual,'Actual cash','#222222','-'),(vv,'Fixed reference simulation','#cf7522','--')]:
        x,y=curve(paired,v);axes[0].step(x,y,where='post',label=label,color=color,linestyle=style)
    axes[0].set_title('Full history: 1,182 matched attempts; the model still has execution errors',loc='left')
    axes[0].set_ylabel('Cumulative ETH');axes[0].legend(loc='upper left')
    candidates=[('fixed-after','Fixed reference','#cf7522','--'),
                ('inclusion-midpoint-before','Sell inclusion midpoint: before order','#2865ad','-'),
                ('inclusion-midpoint-after','Sell inclusion midpoint: after order','#2865ad',':')]
    for j,ax in enumerate(axes[1:]):
        for values,label,color,style in [(actual,'Actual cash','#222222','-')]+[(cr[n],label,color,style) for n,label,color,style in candidates]:
            x,y=curve(ci,values)
            if j:y=y-np.maximum.accumulate(y)
            ax.step(x,y,where='post',label=label,color=color,linestyle=style,linewidth=1.6)
        ax.set_ylabel('Drawdown ETH' if j else 'Cumulative ETH')
    axes[1].set_title('Sell-clock test: same 280 Sep 8–13 attempts; both midpoint order stresses shown',loc='left')
    axes[1].legend(loc='lower left',fontsize=10)
    axes[2].set_title('Closed-cash drawdown, accumulated without accounting resets',loc='left')
    for ax in axes:
        ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %d',tz=dt.timezone.utc));ax.grid(axis='y',alpha=.2);ax.axhline(0,color='#aaa',lw=.6)
    axes[2].set_xlabel('UTC; frozen capture ends 13 September 2026, 15:30 UTC / 16:30 London')
    fig.suptitle('Clock correction is a research candidate, not a validated simulator upgrade',fontsize=15)
    fig.savefig(root/'execution-clock-comparison.png',dpi=150);plt.close(fig)
    fig,ax=plt.subplots(figsize=(12,4.5),layout='constrained');keys=['winners','losers','profit_wei','loss_wei']
    names=['fixed-after','inclusion-midpoint-before','inclusion-midpoint-after']
    for j,name in enumerate(names):
        vals=[clockcards['All supported'][name]['reproductionKpis'][k] for k in keys]
        bars=ax.bar(np.arange(4)+(j-1)*.24,vals,.24,label=name,color=['#cf7522','#2865ad','#74a6d1'][j],hatch=['','//','..'][j])
        ax.bar_label(bars,fmt='%.1f%%',fontsize=9)
    ax.axhline(100,color='#222',ls='--',label='Actual = 100%');ax.set_ylim(0,140)
    ax.set_xticks(range(4),['Winning trade count','Losing trade count','Winning money','Losing money'])
    ax.set_ylabel('Simulation / actual (%)');ax.legend(loc='upper center',ncols=2,fontsize=9)
    ax.set_title('Reproduction KPIs on the same 280 attempts; these are not guard-retention ratios')
    fig.savefig(root/'reproduction-kpis.png',dpi=150);plt.close(fig)
    # Selected case shows value available at decision versus money received at exit.
    case=cases['2476'];sent=positions[2476]['t_sent'];sim=case['prediction'];mm=case['marks']
    fig,ax=plt.subplots(figsize=(11,4),layout='constrained')
    ax.step([(m['at']-sent)/1000 for m in mm],[int(m['mark_wei'])/1e18 for m in mm],where='post',color='#222',label='Actual recorded exit quote')
    ax.step([(m['at']-sent)/1000 for m in sim['trace']],[int(m['markWei'])/1e18 for m in sim['trace']],where='post',color='#cf7522',ls='--',label='Simulated observed exit quote')
    ax.scatter([(case['recordedClose']-sent)/1000],[int(positions[2476]['proceeds_wei'])/1e18],color='#222',marker='x',s=80,label='Actual proceeds at recorded close')
    ax.scatter([(sim['exitAt']-sent)/1000],[int(sim['proceedsWei'])/1e18],color='#cf7522',marker='o',s=60,label='Simulated proceeds at modeled execution')
    ax.axhline(.02,color='#aaa',ls=':',label='Stake (before costs)');ax.set_xlabel('Seconds after send');ax.set_ylabel('Gross exit value ETH')
    ax.set_title('Trade 2476: the exit decision agrees, but selling after subsequent buys creates a false winner')
    ax.legend(fontsize=9,ncols=2);fig.savefig(root/'false-winner-2476.png',dpi=150);plt.close(fig)
    eth=lambda v:f'{int(v)/1e18:+.6f}'
    fmt=lambda v:'Unavailable' if v is None else f'{v:.3f}'
    lines=['# Execution discrepancy investigation','',
        'Sell inclusion deserves a separate clock from receipt completion. The new historical test reduces some false winners, but does not establish a validated replacement. Fill-adoption substitutions do not consistently improve accuracy. No simulator defaults or live controls changed.','',
        'The capture remains September 1 to September 13, 2026 at 15:30 UTC (16:30 London). It is not a refreshed live dataset. All 1,190 attempts remain inventoried. The full-history comparison has 1,182 receipt-matched attempts and eight unreconciled cash labels. No attempts were recorded September 1–3.','',
        '![Full history and focused comparison](execution-clock-comparison.png)','',
        '## What the execution records show','',
        '- Trade 2476: actual net -0.005545 ETH versus fixed-reference simulated +0.003280 ETH. Tokens and the dead-trade decision agree. The chain places our sell in block 59920727 before new external buys in blocks 59920728 and 59920731 within the same stamped second. The simulation sells later and benefits from those buys.',
        '- Its recorded close is 335 ms before the modeled sale, but that is not an exact execution-time difference: the recorded close includes confirmation wait. Using it as sell inclusion time mixes two clocks.',
        '- Trade 2040 shows the opposite direction: actual +0.008657 ETH versus simulated -0.013602 ETH, with exact token quantity and TP exit on both sides. A later external sell batch changes execution proceeds. Longer modeled delays are not uniformly conservative.',
        '- Trade 2347 has a 25% token-quantity mismatch and different observed entry marks. Trade 2418 has exact quantity but different exit decisions. The entry baseline recorded at intent is not always the runtime baseline after fill adoption. A fixed ETH offset cannot repair either behavior.',
        '- Trade 2106 really reverted its buy, while the reference predicts a profitable fill. Three of the 26 false winners involve disagreement on whether the buy succeeds. Copying the failed receipt into a prediction would conceal that error.',
        '', '![False-winner timeline](false-winner-2476.png)','',
        f"Across 26 false winners, absolute cash discrepancies sum to {groups['False winners']['absoluteCashErrorEth']:.6f} ETH. Absolute cost discrepancies sum to {groups['False winners']['absoluteCostErrorEth']:.6f} ETH, at most {100*groups['False winners']['absoluteCostErrorEth']/groups['False winners']['absoluteCashErrorEth']:.2f}% of that error magnitude. The principal and proceeds differences dominate this historical comparison.",'',
        'All matched burned_gas_wei fields are NULL. This means unknown retry-ledger coverage, not zero retries. Retry frequency cannot be calibrated honestly from that field. The first discrepancy inventory coalesced these NULL values to zero; ranked-errors.json now preserves NULL and explicitly leaves retryCount unavailable.','',
        '## Tests and coverage','',
        'The first experiment froze ten configurations: fixed timing, preceding median sell-close delay, preceding median adoption delay, both medians, and both 90th percentiles, each with before/after sell ordering. All other reference inputs stayed fixed. There are 281 supported attempts, all September 8 onward.','',
        'The second experiment froze eight configurations: fixed timing plus the preceding median of lower/midpoint/upper sell-inclusion bounds, each with before/after order. The midpoint was declared the central hypothesis before scoring. This has 280 supported attempts; one prior timing sample has inconsistent inclusion bounds, delaying warmup by one attempt. No result was discarded because it lost money.','',
        'The 909 and 910 unsupported attempts respectively remain in coverage.json. There is no compatible preceding-delay test before September 8. The earlier 36 fixed timing scenarios cover both profitable and losing periods, but cannot fill this calibration gap. No new prospective observations were scored.','',
        'Each prediction uses at least 20 of the last 100 valid samples whose completion and durable availability precede entry by six hours. Sell bounds use verified block stamps. First marks are labelled adoption upper bounds. The observed close remains an upper bound on inclusion. Observation delay stays at 600 ms because adoption delay does not measure feed latency. Actual current fills, cash and execution times never calibrate their own predictions.','',
        '## Sell-clock results, identical 280 attempts','',
        '| Setting | Real ETH | Sim ETH | Sim drawdown ETH | False winners | False losers | Absolute error mean / median / SD (pp stake), n |',
        '|---|---:|---:|---:|---:|---:|---|']
    for name,c in clockcards['All supported'].items():
        e=c['absoluteErrorPp'];lines.append(f"| {name} | {eth(c['actual']['net_wei'])} | {eth(c['predicted']['net_wei'])} | {eth(c['predicted']['drawdown_wei'])} | {len(c['falseWinners'])} | {len(c['falseLosers'])} | {fmt(e['mean'])} / {fmt(e['median'])} / {fmt(e['sd'])}, {e['n']} |")
    lines+=['','A near-perfect final net in one endpoint is not a reason to select it. Per-trade errors remain, and the sign of aggregate bias changes across periods.','',
        '| Period | Setting | n | Real ETH | Sim ETH | False winners | Absolute error mean / median / SD (pp stake) |',
        '|---|---|---:|---:|---:|---:|---|']
    for group in ['Sep8-9','Sep10-13','Final six hours']:
        for name in ['fixed-after','inclusion-midpoint-before','inclusion-midpoint-after']:
            c=clockcards[group][name];e=c['absoluteErrorPp']
            lines.append(f"| {group} | {name} | {e['n']} | {eth(c['actual']['net_wei'])} | {eth(c['predicted']['net_wei'])} | {len(c['falseWinners'])} | {fmt(e['mean'])} / {fmt(e['median'])} / {fmt(e['sd'])} |")
    lines+=['','## Adoption and recorded-close-delay results, identical 281 attempts','',
        '| Setting | Sim ETH | False winners | Absolute error mean / median / SD (pp stake), n |','|---|---:|---:|---|']
    for name,c in cards['All supported'].items():
        e=c['absoluteErrorPp'];lines.append(f"| {name} | {eth(c['predicted']['net_wei'])} | {len(c['falseWinners'])} | {fmt(e['mean'])} / {fmt(e['median'])} / {fmt(e['sd'])}, {e['n']} |")
    lines+=['','## Four reproduction KPIs','',
        '![Winning/losing counts and money](reproduction-kpis.png)','',
        'Here the denominator is actual cash on the identical 280 attempts. These ratios test simulation reproduction, not guard retention against an always-on account. Zero denominators are unavailable. Equal counts do not mean the same trades won.','',
        '| Setting | Win count / actual | Loss count / actual | Win money / actual | Loss money / actual |','|---|---:|---:|---:|---:|']
    for name in ['fixed-after','inclusion-midpoint-before','inclusion-midpoint-after']:
        k=clockcards['All supported'][name]['reproductionKpis'];lines.append('| '+name+' | '+' | '.join(f'{k[key]:.2f}%' if k[key] is not None else 'Unavailable' for key in keys)+' |')
    lines+=['','## Decision and unresolved work','',
        'Keep the sell-inclusion interval model as a frozen research candidate. Do not promote a particular order endpoint, add a universal loss offset, or claim the simulator is as accurate as possible. Even the improved candidates exceed the existing mean-absolute-error limit of 5 percentage points. Whole-account and live-shadow certification are not supplied by this attempt-level test.','',
        'The useful next evidence is separate sale submission, chain inclusion, receipt completion, fill adoption and feed-arrival clocks on new attempts, plus each failed-exit transaction and its gas. Existing collection should supply these through the shared model. Do not force trades for evidence. The profitable-period preceding-clock gap cannot be recovered by fitting to its final profit.','',
        'No new observations have occurred under a prediction lock for this candidate in this run. Prospective validation is pending. This report does not assert that the live indicator currently uses these settings.','',
        '## Verification and reproduction','',
        'Both frozen model/input checks passed. There are 1,122 exact baseline parity comparisons across the two experiments. Daily, trailing 24-hour (eight bins) and seven-day (seven bins) scorecards include mean, median, sample SD and count. Both experiments preserve the eight original unreconciled labels. No source model, costs default, guard or live control was changed.','',
        'From bot/, after preparation, frozen comparisons can be rerun with:','',
        '```sh','python3 -m research.core.execution_discrepancies run --root data/research/20260913-execution-discrepancies-v1',
        'python3 -m research.core.sell_clock_study run --root data/research/20260913-sell-clock-v1',
        'python3 -m research.core.execution_discrepancy_report --root data/research/20260913-execution-discrepancies-v1 --clocks data/research/20260913-sell-clock-v1','```','',
        '[Ranked errors](ranked-errors.json), [case records](case-timelines.json), [initial scorecards](scorecards.json), [sell-clock scorecards](../20260913-sell-clock-v1/scorecards.json), [sell-clock coverage](../20260913-sell-clock-v1/coverage.json).']
    (root/'report.md').write_text('\n'.join(lines)+'\n')
    # Independent totals and scorecard cross-checks.
    for result in [cards,clockcards]:
        for cc in result.values():
            for c in cc.values():
                for side in ['actual','predicted']:
                    x=c[side];assert int(x['net_wei'])==int(x['profit_wei'])-int(x['loss_wei'])
                assert c['expected']==c['known'] and c['missing']==0
        for name,c in result['All supported'].items():
            assert sum(int(result[f'Sep{d:02}'][name]['actual']['net_wei']) for d in range(1,14))==int(c['actual']['net_wei'])
            assert sum(int(result[f'Sep{d:02}'][name]['predicted']['net_wei']) for d in range(1,14))==int(c['predicted']['net_wei'])
    write(root/'report-checks.json',dict(dailyTotalsAgree=True,profitMinusLossEqualsNet=True,
        identicalScenarioDenominators=True,reportSourceHash=sha(__file__),prospectiveObservations=0,
        baselineParityChecks=read(root/'verification.json')['baselineParityChecks']+read(clocks/'verification.json')['baselineParityChecks']))
    return dict(report=str(root/'report.md'),charts=3,matchedFullHistory=len(paired),clockComparison=len(ci))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--clocks',required=True);a=p.parse_args()
    print(report(Path(a.root).resolve(),Path(a.clocks).resolve()))
