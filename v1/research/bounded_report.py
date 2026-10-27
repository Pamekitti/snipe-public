"""Summarize bounded grid artifacts without treating missing cash as avoided loss."""
import argparse,collections,datetime as dt,json,math,statistics
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as md
from research.core.data import read_json,write_json,digest
from research.bounded_io import active_results

def describe(values):
    a=list(values)
    return {'mean':statistics.mean(a) if a else None,'median':statistics.median(a) if a else None,'sd':statistics.stdev(a) if len(a)>1 else None,'n':len(a)}

def render(root):
    root=Path(root);report=root/'report';report.mkdir(exist_ok=True)
    m=read_json(root/'input-manifest.json');start,end=m['start'],m['through']
    stamp=lambda t:dt.datetime.fromtimestamp(t/1000,dt.timezone.utc)
    scenarios=[]
    for path in sorted((root/'actual-scenarios').glob('*/cash-error-profile.json')):
        p=read_json(path);scenarios.append({'id':path.parent.name,**p['metrics']})
    write_json(report/'actual-scenario-summary.json',scenarios)
    source=root.parent/'20260914-execution-repair-v1/source/reproduction-inputs/fidelity/rows.json'
    rows=read_json(source)
    paths=[root/'actual-scenarios'/name/'predictions.json' for name in ['pool-d0-h0','pool-d5000-h2500']]
    fig,axes=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained')
    curves=[('Actual cash','#26364a',[(r['exitAt'],int(r['actualWei'])) for r in rows if r['actualWei'] is not None])]
    for name,color,path in zip(['Simulation: base pool quote','Simulation: +5s and 25% lower pool proceeds'],['#3574aa','#c77c30'],paths):
        values=read_json(path);curves.append((name,color,[(p['exitAt'],int(p['pnlWei'])) for p in values if p['pnlWei'] is not None]))
    for name,color,cash in curves:
        total=peak=0;times=[stamp(start)];net=[0];dd=[0]
        for at,value in sorted(cash):
            total+=value;peak=max(peak,total);times.append(stamp(at));net.append(total/1e18);dd.append((peak-total)/1e18)
        times.append(stamp(end));net.append(net[-1]);dd.append(dd[-1])
        axes[0].step(times,net,where='post',color=color,label=name);axes[1].step(times,dd,where='post',color=color)
    for ax in axes:
        ax.axvspan(stamp(start),stamp(min(r['entryAt'] for r in rows)),color='grey',alpha=.07)
        ax.grid(alpha=.2);ax.spines[['top','right']].set_visible(False);ax.set_xlim(stamp(start),stamp(end))
    axes[0].legend(loc='upper left');axes[0].set_ylabel('Cumulative net ETH');axes[1].set_ylabel('Drawdown ETH');axes[1].xaxis.set_major_formatter(md.DateFormatter('%d %b',tz=dt.timezone.utc))
    axes[0].set_title('1,190 actual attempts: diagnostic execution comparison')
    axes[1].set_xlabel('UTC. Shaded dates have no actual-attempt samples. Pool assumptions affect one of these attempts.')
    fig.savefig(report/'actual-simulation-lines.png',dpi=160);plt.close(fig)
    remote=active_results(root/'results');progress=read_json(remote/'bounded-status.json') if (remote/'bounded-status.json').exists() else {'stage':'running_or_awaiting_download'}
    completed=read_json(remote/'scenario-summary.json').get('completed',[]) if (remote/'scenario-summary.json').exists() else []
    rank_path=remote/'report/cross-scenario-ranking.json'
    ranking=read_json(rank_path) if rank_path.exists() else None
    rank_counts={row['scenario']:row for row in ranking['counts']} if ranking else {}
    counters=[];leaders=[]
    for scenario in completed:
        folder=remote/'scenarios'/scenario['scenario'];summary=scenario['summary'];available=0;best=None
        # The verified aggregate already contains complete counts. Avoid rereading
        # hundreds of thousands of scorecards merely to count the same rows.
        for file in ([] if ranking else sorted((folder/'scores').glob('*/fixed-memory20-*.json*'))):
            if '.json.' in file.name and not file.name.endswith('.json.gz'):continue
            if file.parent.name=='coverage-preflight':continue
            data=read_json(file)
            for r in data.get('results',[]):
                if all(s['complete'] for s in r['periods']['train7']):
                    available+=1
                    objective=(min(s['net'] for s in r['periods']['train7']),-max(s['dd'] for s in r['periods']['train7']),-max(s['recoveryLoss'] for s in r['periods']['train7']),-max(s['losingRecoveries'] for s in r['periods']['train7']))
                    if best is None or objective>best[0]:best=(objective,r,file.name)
        authoritative_count=rank_counts.get(scenario['scenario'],{}).get('completeTrainingByClock',{}).get('fixed',{}).get('train7')
        counters.append({'scenario':scenario['scenario'],'comparisons':summary['comparisons'],'completeTraining':authoritative_count,'loadedSliceCompleteTraining':available,'stages':summary['stages']})
        if best:leaders.append({'scenario':scenario['scenario'],'objective':best[0],'result':best[1],'source':best[2]})
    write_json(report/'search-counts.json',counters);write_json(report/'training-leaders.json',leaders)
    scope_path=remote/'comparison-scope.json'
    scope=read_json(scope_path) if scope_path.exists() else None
    expected=len(scope['scenarios']) if scope else 27
    full=len(completed)==expected and (not scope or {s['scenario'] for s in completed}==set(scope['scenarios']))
    decision={'status':'diagnostic_only','validatedReplacement':False,'robustReplacement':None,'scenariosCompleted':len(completed),'scenariosExpected':expected,'originalScenariosExpected':27,'comparisonScope':scope,'reason':'No complete training candidates' if full and not leaders else 'Grid incomplete' if not full else 'Cross-scenario and neighboring-setting assessment required','liveChanges':False}
    if ranking:
        nomination=ranking['nominations']['train7']
        decision['trainingNominee']=nomination['choice']
        decision['evaluation']=nomination['evaluation']
        if full:
            decision['reason']='Cash fidelity failed; no validated replacement' if nomination['choice'] else 'No candidate has complete required training evidence across both clocks and all sensitivities'
    write_json(report/'decision.json',decision)
    a=scenarios[0]['actual'];n=len(rows)
    lines=['# Bounded September guard experiment','',f"**{decision['reason']}.** No validated replacement is claimed.",'',f"Capture: {stamp(start).isoformat()} to {stamp(end).isoformat()}. AWS stage: {progress['stage']}.",'',f"Actual cash across {n:,} attempts: {int(a['net_wei'])/1e18:+.6f} ETH. Cumulative drawdown: {int(a['drawdown_wei'])/1e18:.6f} ETH.",'','![Actual versus simulation](actual-simulation-lines.png)','','## Actual-trade comparison','','| Pool scenario | Matched | Simulated net ETH | Drawdown ETH | False winners | Mean absolute error, stake pp | Median | SD | n |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for r in scenarios:
        e=r['absoluteErrorPp'];lines.append(f"| {r['id']} | {r['known']} | {int(r['predicted']['net_wei'])/1e18:+.6f} | {int(r['predicted']['drawdown_wei'])/1e18:.6f} | {len(r['falseWinners'])} | {e['mean']:.3f} | {e['median']:.3f} | {e['sd']:.3f} | {e['n']} |")
    error_path=report/'error-periods.json'
    if error_path.exists():
        errors=read_json(error_path)
        lines+=['','## Profitable and losing periods','','| Actual-attempt entry period | Attempts | Actual net ETH | Simulated net ETH | False winners | Mean absolute error, stake pp | Median | SD | n |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for name,r in errors.items():
            e=r['absoluteErrorPp'];lines.append(f"| {name} | {r['known']} | {int(r['actual']['net_wei'])/1e18:+.6f} | {int(r['predicted']['net_wei'])/1e18:+.6f} | {len(r['falseWinners'])} | {e['mean']:.3f} | {e['median']:.3f} | {e['sd']:.3f} | {e['n']} |")
    lines+=['','Only one actual attempt needs the pool approximation. Its sensitivity does not validate all hypothetical pool exits. The historical-account audit remains diagnostic because initial state, controls and source coverage are incomplete.','','## Grid coverage','',f'{len(completed)} of {expected} required pool/publication scenarios completed. The original plan contained 27 scenarios. The core catalog contains 6,960 guards and ten exit policies. Each comparison includes six execution stresses. Wider-stage counts are recorded separately.']
    if scope:lines+=['',scope['reason'],'','Required scenarios: '+', '.join(scope['scenarios'])+'.']
    lines+=['','| Scenario | Account comparisons | Complete fixed-clock training candidates |','| --- | ---: | ---: |']
    for c in counters:
        count='Unavailable' if c['completeTraining'] is None else f"{c['completeTraining']:,}"
        lines.append(f"| {c['scenario']} | {c['comparisons']:,} | {count} |")
    if ranking:
        lines+=['','## Training selection and later assessment','',
            ranking['selection'], '',
            'All rankings remain diagnostic. The table uses the worst result across the tested execution stresses, pool sensitivities and both timing models. It does not rank settings using later profit.', '',
            '| Training cutoff | Eligible settings | Training risk gate passed | Selected policy | Next-period stresses passed | Supported neighbors |',
            '| --- | ---: | ---: | --- | --- | --- |']
        for cutoff,entry in ranking['nominations'].items():
            choice=entry['choice'];assessment=entry['evaluation'];next_period=dict(train3='eval4-5',train5='eval6-7',train7='eval8-9')[cutoff]
            neighbors=assessment.get('neighbors',{})
            lines.append(f"| {cutoff} | {entry['eligible']:,} | {entry['trainingRiskGatePasses']:,} | {choice['policy']['id'] if choice else 'Unavailable'} | {assessment.get(next_period,{}).get('passesEveryStress','Unavailable')} | {neighbors.get('improving',0)}/{neighbors.get('tested',0)} |")
        lines+=['','### Settings ranked using September 1–7 only','',
            '| Policy | N / M | Brake | Fresh / full recovery | Mode | Age, min | Exit | TP memory | Worst net ETH | Worst drawdown ETH |',
            '| --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: |']
        ranked=ranking['nominations']['train7']['ranked'][:10]
        for row in ranked:
            p=row['policy'];v=row['periods']['train7']
            lines.append(f"| {p['id']} | {p['n']} / {p['m']} | {p['off']} | {p['freshOn']} / {p['fullOn']} | {p['mode']} | {p['ageMs']/60000:g} | {row['exit']} | {row['memory']} | {v['net']:+.6f} | {v['dd']:.6f} |")
        if not ranked:lines+=['',f'No complete cross-scenario ranking is available. Partial scenarios are not substituted for the required {expected}.']
        alternatives=ranking['nominations']['train7'].get('lowerDrawdownAlternative')
        if alternatives:
            p=alternatives['policy'];v=alternatives['periods']['train7']
            lines+=['',f"Lower-drawdown training alternative: `{p['id']}`, exit `{alternatives['exit']}`, TP memory {alternatives['memory']}. Worst training net {v['net']:+.6f} ETH; worst training drawdown {v['dd']:.6f} ETH. This is a profit/risk alternative, not a validated recommendation."]
        lines+=['','Exact policies, including additional-family parameters and all paired stress differences, are in the archived `optimized-v2/report/cross-scenario-ranking.json`.']
    diagnostic_path=remote/'report/fixed-clock-diagnostic-ranking.json'
    if diagnostic_path.exists():
        diagnostic=read_json(diagnostic_path)
        decision['diagnosticTrainingNominee']=diagnostic['nominations']['train7']['choice']
        decision['diagnosticEvaluation']=diagnostic['nominations']['train7']['evaluation']
        decision['reason']='No supported replacement: the training pick fails later stress checks, and cash fidelity remains diagnostic'
        lines[2]=f"**{decision['reason']}.** No live change is recommended from this experiment."
        lines+=['','## Fixed-timing grid findings, diagnostic only','',diagnostic['selection'],'',
            'The joint-clock qualification above remains failed. The empirical timing account begins after the fitting cutoffs. This separate table uses the complete fixed-timing training history; it does not fill the missing early observations.', '',
            '| Training cutoff | Eligible settings | Training risk gate passed | Exploratory candidate |',
            '| --- | ---: | ---: | --- |']
        for cutoff,entry in diagnostic['nominations'].items():
            choice=entry['choice'];lines.append(f"| {cutoff} | {entry['eligible']:,} | {entry['trainingRiskGatePasses']:,} | {choice['policy']['id'] if choice else 'Unavailable'} |")
        lines+=['','| Fixed-clock training rank | N / M | Brake | Fresh / full | Mode | Age min | Exit | TP memory | Worst net ETH | Worst drawdown ETH |',
            '| --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: |']
        for i,row in enumerate(diagnostic['nominations']['train7']['ranked'][:10],1):
            p=row['policy'];v=row['periods']['train7']
            lines.append(f"| {i} | {p['n']} / {p['m']} | {p['off']} | {p['freshOn']} / {p['fullOn']} | {p['mode']} | {p['ageMs']/60000:g} | {row['exit']} | {row['memory']} | {v['net']:+.6f} | {v['dd']:.6f} |")
        chosen=diagnostic['nominations']['train7']['choice']
        if chosen:lines+=['','Exact exploratory candidate:', '', '```json',json.dumps({'policy':chosen['policy'],'exit':chosen['exit'],'tpMemory':chosen['memory']},indent=2),'```']
        risk=diagnostic['nominations']['train7'].get('lowerDrawdownAlternative')
        if risk:
            value=risk['periods']['train7']
            lines+=['',f"The lowest-drawdown training alternative made {value['tradesMin']}–{value['tradesMax']} trades across the required stresses. Its worst training net was {value['net']:+.6f} ETH. Zero trades and zero drawdown do not demonstrate profit capture."]
        clock_path=remote/'report/supported-clock-assessment.json'
        if clock_path.exists():
            clock=read_json(clock_path)
            lines+=['','### Later recorded-timing assessment','',clock['selection'], '',
                '| Pool/publication scenario | Evidence begins UTC | Missing earlier launches |',
                '| --- | --- | ---: |']
            for name,value in clock['coverage'].items():lines.append(f"| {name} | {stamp(value['from']).isoformat()} | {value['unavailablePrefixLaunches']:,} |")
            lines+=['','These accounts assume a known flat account when recorded-timing evidence begins. They cannot reproduce the missing earlier account path.','','| Training cutoff | Scenario | Assessment period | Complete | Worst net difference ETH | Worst drawdown difference ETH | All profit/risk conditions pass |','| --- | --- | --- | --- | ---: | ---: | --- |']
            for cutoff,scenarios_by_name in clock['assessments'].items():
                for name,periods in scenarios_by_name.items():
                    for period,value in periods.items():
                        delta=value['pairedDifference']
                        net=f"{delta['net']:+.6f}" if delta else 'Unavailable';dd=f"{delta['dd']:+.6f}" if delta else 'Unavailable'
                        lines.append(f"| {cutoff} | {name} | {period} | {value['complete']} | {net} | {dd} | {value['improvesEveryStress']} |")
    prefix_path=report/'recorded-clock-prefix.json'
    if prefix_path.exists():
        prefix=read_json(prefix_path)
        lines+=['','## Recorded timing on the common supported prefix','',prefix['selection'], '',
            'Whole calendar-period checks remain unavailable when their start predates this clock or their end exceeds complete evidence. The table below explicitly clips to the same supported interval for all three plotted policies. A pool-quote mismatch stops the comparison at September 13, 01:12:12 UTC. It excludes the final six hours and is not a validation of that reserved period.', '',
            '| Scenario | Policy | From UTC | Through UTC | Trades | Net ETH | Drawdown ETH | Win retained | Loss retained |',
            '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |']
        for row in prefix['rows']:
            v=row['selected'];win='Unavailable' if row['winRetained'] is None else f"{row['winRetained']*100:.1f}%";loss='Unavailable' if row['lossRetained'] is None else f"{row['lossRetained']*100:.1f}%"
            lines.append(f"| {row['scenario']} | {row['label']} | {stamp(row['from']).isoformat()} | {stamp(row['through']).isoformat()} | {v['n']} | {v['netEth']:+.6f} | {v['drawdownEth']:.6f} | {win} | {loss} |")
        lines+=['','![Recorded timing comparison](recorded-clock-lines.png)']
    retention_path=report/'money-retention.json'
    if retention_path.exists():
        def percent(value):return 'Unavailable' if value is None else f'{100*value:.1f}%'
        lines+=['','## Two money-retention KPIs','',
            'These are the central 1,200 ms, after-order replays in the base pool/publication scenario. They use the same complete comparable prefix for both accounts. Full-capture retention remains unavailable when the tail is unresolved. They are separate from the worst-stress ranking above.', '',
            'Retention can exceed 100% because each account has independent capacity, template history and stops. The guarded account is not necessarily a subset of the always-on account.', '',
            '| Account | Complete prefix through UTC | Win retained | Loss retained | Win retained, fixed 45s reference | Loss retained, fixed 45s reference |',
            '| --- | --- | ---: | ---: | ---: | ---: |']
        for row in read_json(retention_path):
            lines.append(f"| {row['label']} | {stamp(row['comparableThrough']).isoformat()} | {percent(row['prefixWinRetained'])} | {percent(row['prefixLossRetained'])} | {percent(row['prefixWinRetainedFixed45'])} | {percent(row['prefixLossRetainedFixed45'])} |")
        lines+=['','| Account, same complete prefix | Net ETH | Drawdown ETH | Losing recoveries | Recovery loss ETH | Profit missed ETH | Losses avoided ETH |',
                '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
        for row in read_json(retention_path):
            v=row['knownPrefixSelected']
            lines.append(f"| {row['label']} | {v['netEth']:+.6f} | {v['drawdownEth']:.6f} | {row['prefixLosingRecoveries']} | {row['prefixRecoveryLossEth']:.6f} | {row['prefixProfitMissedEth']:.6f} | {row['prefixLossesAvoidedEth']:.6f} |")
    for filename,title in [('guard-lines.png','Guard cumulative return and drawdown'),('retention.png','Winning and losing money retained'),('opportunity-reference.png','Unrestricted opportunities, separate from executable accounts'),('intraday-indicator.png','Last capture day: indicator, decisions and trades'),('parameter-heatmaps.png','Controlled parameter comparisons'),('rolling-cohort-errors.png','Retrospective errors on identical actual-attempt windows')]:
        if (report/filename).exists():lines+=['',f'### {title}','',f'![{title}]({filename})']
    if (report/'rolling-cohort-errors.png').exists():
        lines+=['','The rolling-cohort chart uses eventual outcomes ordered by actual entry time. It is not a causal indicator reconstruction. Its overlapping windows are not independent samples and did not fit new thresholds.']
    controls_path=report/'account-control-audit.json'
    if controls_path.exists():
        lines+=['','## Account stops and flat chart sections','',
            'The market-guard-disabled account retains drawdown protection and recorded controls. Its flat sections do not mean the market had no opportunities. The independent shadow observer continues to collect outcomes while trading accounts are stopped.', '',
            '| Account | Largest interval between completed trades, hours | From UTC | Through UTC | Entry attempts blocked by account pause within that interval |',
            '| --- | ---: | --- | --- | ---: |']
        for row in read_json(controls_path):
            lines.append(f"| {row['account']} | {row['largestCashGapHours']:.1f} | {row['fromUtc']} | {row['throughUtc']} | {row['reasonsDuringGap'].get('account_pause',0)} |")
    bins_path=report/'period-bins.json'
    if bins_path.exists():
        def number(value):return 'Unavailable' if value is None else f'{value:+.6f}'
        lines+=['','## Daily and trailing-period results','',
                'All amounts are ETH. Trailing windows end at the frozen capture boundary, not the date this report was rendered. Unavailable periods retain their known rows and are flagged incomplete.', '',
                '| Window | From UTC | Through UTC | Series | Net | Mean | Median | SD | n | Complete |',
                '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |']
        for period in read_json(bins_path):
            for label,v in period['series'].items():
                lines.append(f"| {period['window']} | {period['fromUtc']} | {period['throughUtc']} | {label} | {number(v['netEth'])} | {number(v['mean'])} | {number(v['median'])} | {number(v['sd'])} | {v['n']} | {v['complete']} |")
    lines+=['','Win retained and loss retained compare winning and losing ETH with matching always-on accounts. Incomplete references and zero denominators are unavailable. A guard that never receives usable shadow evidence is not demonstrated loss avoidance.','','The final six hours were excluded from fitting. All inspected data is retrospective. Full details of delays, costs, publication assumptions, capacity and missing executions are in ../protocol.md. No live changes were made.']
    lines+=['','## Verification and reproduction','',
        'Frozen numerical verification passed 935 bot tests, 8,056 historical baseline guard parity checks, both TypeScript checks and the research suite. The final research suite ran 323 tests with one laptop-only fixture skipped on AWS; it passed locally. Laptop curve validation passed 60 curves, 99,080 integer core calculations and 409 tax calculations. Exact numerical parity does not certify predicted earnings.', '',
        'The refreshed capture contains 25,272 opportunity jobs and 1,190 actual attempts. Eight execution requests remain unavailable at the tail. The later recorded-clock account contains one pool-quote mismatch and one source/preceding-clock gap; those outcomes were not replaced by actual proceeds. The paper-account comparison clips before their earliest affected admission.', '',
        'Final plotted account replays are checked against their archived scalar scorecards in `final-frozen-replay-parity.json`. All 60,993 archived files were downloaded and individually hash verified before remote artifacts were removed. See `../download-verification.json`, `../cleanup.json` and `../cleanup-independent-verification.json`.', '',
        'Run these commands from `bot/` after restoring the verified archive. Use the isolated frozen engine so unrelated workspace changes cannot alter the replay:', '',
        '```sh',
        'python3 -m research.bounded_rank --root data/research/20260914-bounded-grid-v1/results/optimized-v2 --fixed-clock-diagnostic',
        'python3 -m research.bounded_supported_clock --root data/research/20260914-bounded-grid-v1/results/optimized-v2',
        'PATH="/path/to/snipe" python3 -m research.bounded_details --root data/research/20260914-bounded-grid-v1 --engine-root data/research/20260914-bounded-grid-v1/frozen-render-engine --fixed-clock-diagnostic',
        'PATH="/path/to/snipe" python3 -m research.bounded_corrected_lines --root data/research/20260914-bounded-grid-v1 --engine-root data/research/20260914-bounded-grid-v1/frozen-render-engine',
        'python3 -m research.bounded_report --root data/research/20260914-bounded-grid-v1',
        '```']
    write_json(report/'decision.json',decision)
    (report/'report.md').write_text('\n'.join(lines)+'\n')
    return decision
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);a=p.parse_args();print(json.dumps(render(a.root)))
