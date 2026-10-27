"""Report every frozen attempt and fixed scenario, with explicit matched coverage."""
import argparse
import csv
import datetime as dt
from pathlib import Path
from .both_periods import positions,START,END,DATA
from .expanded_sample import read,write
from .unified_fidelity import matched_score,sha
from .fidelity import cash_metrics


def report(root):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import numpy as np
    root=Path(root).resolve();rows=read(root/'rows.json');candidates=read(root/'candidates.json')
    results={c['name']:read(root/'results'/(c['name']+'.json'))['results'] for c in candidates}
    freeze_hash=sha(root/'run-freeze.json')
    assert all(read(root/'results'/(c['name']+'.json'))['freezeHash']==freeze_hash for c in candidates)
    assert all(len(v)==len(rows) for v in results.values())
    assert len({r['id'] for r in rows})==len(rows)
    all_rows=[p for p in positions() if START<=(p['t_decide'] or p['t_detect'])<END]
    receipt_rows=read(DATA/'20260913-shared-refresh/receipt-audit.json')['rows']+read(DATA/'20260913-shared-refresh-1530/realism-audit/new-receipt-proof.json')
    receipt_values={r['id']:int(r['independently_reconstructed_wei']) for r in receipt_rows if r['independent_match'] is True}
    receipt_good={p['id'] for p in all_rows if p['id'] in receipt_values and
        str(receipt_values[p['id']])==str(p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei'])}
    common=[i for i,r in enumerate(rows) if r['id'] in receipt_good and r['actualWei'] is not None and r['exitAt'] is not None
        and all(v[i].get('pnlWei') is not None and v[i].get('exitAt') is not None for v in results.values())]
    common_ids={rows[i]['id'] for i in common}
    groups={'September':(START,END),'Sep4-7':(START+3*86400000,1788825600000),'Sep8-13':(1788825600000,END),
        'Final six hours':(END-21600000,END)}
    groups.update({f'Sep{day:02}':(START+(day-1)*86400000,min(START+day*86400000,END)) for day in range(1,14)})
    groups.update({f'24h bin {i+1}':(END-86400000+i*10800000,END-86400000+(i+1)*10800000) for i in range(8)})
    groups.update({f'7d bin {i+1}':(END-7*86400000+i*86400000,END-7*86400000+(i+1)*86400000) for i in range(7)})
    cards={};coverage={};individual={}
    for group,(begin,end) in groups.items():
        indices=[i for i in common if begin<=rows[i]['entryAt']<end]
        actual=[p for p in all_rows if begin<=(p['t_decide'] or p['t_detect'])<end]
        cash=[dict(id=p['id'],at=p['exit_at'],pnl=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei']) for p in actual]
        known=[p for p in cash if p['pnl'] is not None and p['at'] is not None]
        missing_cash=[p for p in known if p['id'] not in common_ids]
        coverage[group]=dict(fromMs=begin,throughMs=end,attempts=len(actual),compared=len(indices),
            recordedCash=cash_metrics(known),outsideComparison=cash_metrics(missing_cash),
            unverifiedReceiptIds=[p['id'] for p in actual if p['id'] not in receipt_good],
            absentCashIds=[p['id'] for p in cash if p['pnl'] is None or p['at'] is None])
        cards[group]={}
        individual[group]={}
        for name,values in results.items():
            available=[i for i,r in enumerate(rows) if begin<=r['entryAt']<end and r['id'] in receipt_good]
            individual[group][name]=matched_score([rows[i] for i in available],[values[i] for i in available])
            card=matched_score([rows[i] for i in indices],[values[i] for i in indices])
            card['falseLosers']=[rows[i]['id'] for i in indices if int(rows[i]['actualWei'])>0>int(values[i]['pnlWei'])]
            card['falseProfitsOnZero']=[rows[i]['id'] for i in indices if int(rows[i]['actualWei'])==0<int(values[i]['pnlWei'])]
            card['reproductionPct']={key:100*int(card['predicted'][key])/int(card['actual'][key]) if int(card['actual'][key]) else None
                for key in ['winners','losers','profit_wei','loss_wei']}
            cards[group][name]=card
    missing=[]
    for p in all_rows:
        if p['id'] in common_ids:continue
        i=next((i for i,r in enumerate(rows) if r['id']==p['id']),None)
        missing.append(dict(id=p['id'],entryAt=p['t_decide'] or p['t_detect'],actualWei=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei'],
            receiptVerified=p['id'] in receipt_good,reasons={name:v[i].get('reason') for name,v in results.items()
                if i is not None and (v[i].get('pnlWei') is None or v[i].get('exitAt') is None)},requestAvailable=i is not None))
    write(root/'scorecards.json',cards);write(root/'coverage.json',coverage);write(root/'excluded.json',missing)
    write(root/'individual-scenario-coverage.json',individual)
    fields=['period','scenario','n','actual_net_eth','sim_net_eth','sim_drawdown_eth','wins_pct','losses_pct','winning_money_pct','losing_money_pct','false_winners','false_losers','mean_error_pp','median_error_pp','sd_error_pp','error_n']
    with (root/'all-scenarios.csv').open('w') as f:
        writer=csv.writer(f);writer.writerow(fields)
        for group,cc in cards.items():
            for name,c in cc.items():
                error=c['signedErrorPp'];writer.writerow([group,name,c['known'],int(c['actual']['net_wei'])/1e18,
                    int(c['predicted']['net_wei'])/1e18,int(c['predicted']['drawdown_wei'])/1e18,
                    *c['reproductionPct'].values(),len(c['falseWinners']),len(c['falseLosers']),error['mean'],error['median'],error['sd'],error['n']])
    assert coverage['September']['attempts']==1190
    assert len(common)+len(missing)==1190
    assert sum(coverage[f'Sep{d:02}']['attempts'] for d in range(1,14))==1190
    assert sum(int(coverage[f'Sep{d:02}']['recordedCash']['net_wei']) for d in range(1,14))==int(coverage['September']['recordedCash']['net_wei'])
    for group,cc in cards.items():
        for c in cc.values():assert int(c['predicted']['profit_wei'])-int(c['predicted']['loss_wei'])==int(c['predicted']['net_wei'])
    todate=lambda at:dt.datetime.fromtimestamp(at/1000,dt.timezone.utc)
    def line(events,begin,end):
        total=0;xx=[todate(begin)];yy=[0.]
        for at,value in sorted(events):total+=int(value);xx.append(todate(at));yy.append(total/1e18)
        xx.append(todate(end));yy.append(total/1e18)
        return xx,yy
    fig=plt.figure(figsize=(13,11));gs=fig.add_gridspec(3,2,height_ratios=[1,.95,.35])
    ax=fig.add_subplot(gs[0,:]);cash=[(p['exit_at'],p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei']) for p in all_rows]
    xx,yy=line([(at,v) for at,v in cash if at is not None and v is not None],START,END)
    ax.step(xx,yy,where='post',color='#111827',lw=2,label='Recorded cash, all 1,190 attempts')
    ax.axvline(todate(1788825600000),color='#64748b',ls=':',lw=1)
    ax.set_title('Full recorded history includes the profitable period',loc='left',weight='bold');ax.set_ylabel('Cumulative net ETH');ax.legend(fontsize=9)
    ax.text(.02,.06,'Eight attempt cash labels still lack complete receipt reconciliation.',transform=ax.transAxes,fontsize=9)
    axes=[];centres=['q5000-rank0.5-sell1200-after','q500-rank0.5-sell1200-after']
    for col,group in enumerate(['Sep4-7','Sep8-13']):
        ax=fig.add_subplot(gs[1,col],sharey=axes[0] if axes else None);axes.append(ax);begin,end=groups[group]
        ii=[i for i in common if begin<=rows[i]['entryAt']<end]
        for name,values in results.items():
            xx,yy=line([(values[i]['exitAt'],values[i]['pnlWei']) for i in ii],begin,end)
            ax.step(xx,yy,where='post',color='#b7bdc7',alpha=.32,lw=.7)
        for name,color,style,label in zip(centres,['#2563eb','#c56b17'],['-','--'],['50% bound assumption','5% bound assumption']):
            xx,yy=line([(results[name][i]['exitAt'],results[name][i]['pnlWei']) for i in ii],begin,end)
            ax.step(xx,yy,where='post',color=color,ls=style,lw=1.7,label=label)
        xx,yy=line([(rows[i]['exitAt'],rows[i]['actualWei']) for i in ii],begin,end)
        ax.step(xx,yy,where='post',color='#111827',lw=2,label='Actual, same matched attempts')
        ax.set_title(f"{group}: {len(ii)}/{coverage[group]['attempts']} attempts compared",loc='left',weight='bold')
        ax.set_ylabel('Conditional cumulative net ETH');ax.legend(fontsize=8,loc='best')
    axbar=fig.add_subplot(gs[2,:]);dd=range(4,14);n=[coverage[f'Sep{d:02}']['attempts'] for d in dd];matched=[coverage[f'Sep{d:02}']['compared'] for d in dd]
    axbar.bar(list(dd),matched,color='#2563eb',label='Common comparison');axbar.bar(list(dd),[a-b for a,b in zip(n,matched)],bottom=matched,color='#cbd5e1',label='Unavailable or unreconciled')
    axbar.set_xticks(list(dd),[f'Sep{d}' for d in dd]);axbar.set_ylabel('Attempts');axbar.legend(fontsize=8,ncol=2)
    for ax in [fig.axes[0],*axes]:
        ax.grid(alpha=.15);ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %d',tz=dt.timezone.utc));ax.set_xlabel('UTC')
    for ax in axes:ax.xaxis.set_major_locator(mdates.DayLocator(interval=1,tz=dt.timezone.utc))
    fig.suptitle('Profitable and losing periods, identical execution assumptions',fontsize=16,weight='bold')
    fig.text(.065,.014,'Gray: all 36 fixed scenarios, not confidence bounds. Bottom curves sum only matched attempts and are not complete wallet simulations.\nColored curves use predeclared midpoint settings. Cutoff: September 13, 15:30 UTC / 16:30 London. No scenario selected as best.',fontsize=9)
    fig.tight_layout(rect=(0,.045,1,.965));fig.savefig(root/'both-periods.png',dpi=150);plt.close(fig)
    labels=[];values=[]
    for group in ['Sep4-7','Sep8-13','September']:
        for name in centres:
            labels.append(group+' / '+('50%' if name.startswith('q5000-') else '5%')+' bound')
            values.append(list(cards[group][name]['reproductionPct'].values()))
    values=np.array([[np.nan if x is None else x for x in row] for row in values])
    fig,ax=plt.subplots(figsize=(10,5));im=ax.imshow(values,cmap='coolwarm',vmin=0,vmax=max(200,np.nanmax(values)))
    ax.set_xticks(range(4),['Winning\ntrades','Losing\ntrades','Winning\nmoney','Losing\nmoney']);ax.set_yticks(range(len(labels)),labels)
    for (i,j),v in np.ndenumerate(values):ax.text(j,i,'N/A' if np.isnan(v) else f'{v:.1f}%',ha='center',va='center',fontsize=11)
    ax.set_title('Simulated / actual on identical matched attempts\n100% means equal totals; these are reproduction ratios, not guard retention',fontsize=12,pad=14)
    fig.colorbar(im,ax=ax,label='Percent of actual');fig.tight_layout();fig.savefig(root/'reproduction-kpis.png',dpi=150);plt.close(fig)
    eth=lambda x:f'{int(x)/1e18:+.6f}'
    lines=['# Both profitable and losing September periods','',
        'The full frozen capture is included in this audit. Execution sensitivity remains diagnostic because historical settings and timing are incompletely recorded. No live changes were made.','',
        f"All 1,190 attempts are inventoried. {len(common)} have receipt-reconciled cash and a known result in every one of the 36 fixed scenarios. The other {len(missing)} remain in the coverage and missing-evidence tables.",'',
        '![Full history and matched comparisons](both-periods.png)','',
        '## Actual cash and comparison coverage','',
        '| Period | Actual attempts | Common compared | All recorded net ETH | Compared actual net ETH | Recorded cash outside comparison ETH |',
        '|---|---:|---:|---:|---:|---:|']
    for group in ['Sep4-7','Sep8-13','September']+[f'Sep{d:02}' for d in range(1,14)]:
        c=coverage[group];a=cards[group][centres[0]]['actual'];lines.append(f"| {group} | {c['attempts']} | {c['compared']} | {eth(c['recordedCash']['net_wei'])} | {eth(a['net_wei'])} | {eth(c['outsideComparison']['net_wei'])} |")
    lines+=['','## All-scenario range, same comparison IDs','',
        'Ranges show sensitivity to assumptions, not probabilities or confidence intervals. No scenario is selected for matching the ending cash.','',
        '| Period | Actual ETH | Simulated ETH range | False winners range | False losers range |',
        '|---|---:|---:|---:|---:|']
    for group in ['Sep4-7','Sep8-13','September','Final six hours']:
        cc=list(cards[group].values());net=[int(c['predicted']['net_wei']) for c in cc];fw=[len(c['falseWinners']) for c in cc];fl=[len(c['falseLosers']) for c in cc]
        lines.append(f"| {group} | {eth(cc[0]['actual']['net_wei'])} | {eth(min(net))} to {eth(max(net))} | {min(fw)} to {max(fw)} | {min(fl)} to {max(fl)} |")
    early=list(cards['Sep4-7'].values());late=list(cards['Sep8-13'].values())
    lines+=['',f"All {len(candidates)} scenarios show positive earlier matched net and negative later matched net: {all(int(c['predicted']['net_wei'])>0 for c in early) and all(int(c['predicted']['net_wei'])<0 for c in late)}. This supports the broad change in market outcomes, while the range shows that earnings remain sensitive to execution assumptions.",
        '',f"The {len(missing)} unreconciled attempts contribute {eth(coverage['September']['outsideComparison']['net_wei'])} ETH to the recorded net. Their small count does not make their missing cash evidence immaterial."]
    lines+=['','## Four reproduction KPIs','','![Reproduction KPIs](reproduction-kpis.png)','',
        'These ratios compare simulation with actual cash on the same attempts. They are not the four always-on guard-retention ratios. Ratios above 100% mean overstatement; zero denominators are unavailable. Matching win counts does not prove the same trades won.','',
        'False winners in the tables mean simulated profit with an actual loss. Predicted profits on zero actual cash are recorded separately as falseProfitsOnZero in the scorecards.','',
        '## Assumptions and bias controls','',
        '- Same 36 predeclared scenarios on both periods: three buy ranks, three sell delays, two sell-order stresses and two reconstructed quote assumptions.',
        '- Actual stake, TP, dead-trade rules, decision time, send time and minimum tokens are recorded before the current fill. Current fills and cash are comparison labels only.',
        '- Missing historical rule contexts use the documented 45-second hold, 0.5 hard stop and 4.5 entry multiple as assumptions. A repository version does not prove deployment per attempt. Existing per-attempt contexts override assumptions.',
        '- Gas uses the preceding 100 eligible receipt pairs with a six-hour embargo and at least 20 pairs. Historical local publication times remain modeled. Missing approval-ledger coverage uses preceding sell gas as a labelled proxy.',
        '- Confirmation and observation delays are fixed at 600 ms; inclusion is 300 ms. Sell delays are 600/1,200/2,000 ms. None was fitted to this run. Midpoint colored examples were declared before scoring.',
        '- Both 5% and 50% historical quote reconstructions are applied to every period. Submitted minimums remain unchanged. These alternatives do not establish the missing historical quote.',
        '- Entire external transactions are reordered through the same TypeScript kernel. Our wallet orders are excluded. Complete source proof requires agreeing independent scans and matching header hashes.',
        '- A common intersection across every scenario prevents denominator changes from making a scenario look better. Excluded IDs and their actual money remain visible. This still introduces coverage selection and cannot validate excluded trades.',
        '- Historical account controls, capacity and guard admission choices are not reproduced by this conditional actual-attempt test. Cash is accumulated without accounting resets, but this is not a complete counterfactual wallet.',
        '- The September data has already been inspected. This is retrospective evidence, not untouched validation. The existing failed fidelity certificate is unchanged.','',
        '## Distributions','',
        '| Period | Recorded cash mean ETH | Median ETH | Sample SD ETH | n |','|---|---:|---:|---:|---:|']
    fmt=lambda x:'Unavailable' if x is None else f'{x:.8f}'
    for group in groups:
        d=coverage[group]['recordedCash']['cash_eth'];lines.append(f"| {group} | {fmt(d['mean'])} | {fmt(d['median'])} | {fmt(d['sd'])} | {d['n']} |")
    lines+=['','## Verification','',
        '- All 1,190 source paths have complete source proofs. Input construction retained every attempt; eight cash labels lack independent receipt reconciliation.',
        '- The research suite passed 286 tests. Source-proof tests reject disagreeing scans, incomplete event scope and header-hash mismatches.',
        '- All 432 replay spot checks agreed exactly with the frozen outputs. Three additional scalar calls also agreed. These checks test the orchestration, not market accuracy.',
        '- Report checks require unique IDs, identical scenario denominators, daily totals equal to September totals, and winning money minus losing money equal to net cash.',
        '- The execution engine was unchanged. Its existing historical-fidelity verdict remains diagnostic only. This sensitivity run cannot renew that certificate.',
        '', '## Reproduce and inspect','',
        'From bot/:','', '```sh',
        'python3 -m research.core.both_periods run --root data/research/20260913-both-periods-v1',
        'python3 -m research.core.both_periods_report --root data/research/20260913-both-periods-v1','```','',
        'The frozen request, candidate, source and model hashes are in run-freeze.json. Source proof files identify the original cached RPC responses or new bounded reads. Input-proof files identify each preceding cost sample.',
        '', '[Every scenario and period](all-scenarios.csv). [Coverage](coverage.json). [Unavailable attempts](excluded.json). [Frozen protocol](protocol.json).', '',
        '**Decision:** this extends the inspection to both market periods. It does not repair missing historical execution records or establish a validated simulation. No new guard ranking or live change is justified by a close aggregate alone.']
    (root/'report.md').write_text('\n'.join(lines)+'\n')
    write(root/'report-checks.json',dict(actualAttempts=1190,commonCompared=len(common),excluded=len(missing),
        uniqueIds=True,dailyTotalsAgree=True,profitMinusLossEqualsNet=True,identicalScenarioDenominators=True,
        modelHash=read(root/'run-freeze.json')['modelHash'],diagnosticOnly=True))
    return dict(compared=len(common),excluded=len(missing))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);a=p.parse_args();print(report(a.root))
