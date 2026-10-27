"""Readable fidelity scorecards with actual cash kept separate from modeled cash."""
import argparse
import collections
import datetime as dt
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

from .expanded_sample import read, write
from .unified_fidelity import sha


COLORS = ['#93c5fd','#2563eb','#86efac','#15803d','#fdba74','#c2410c']


def eth(value): return int(value)/1e18
def money(value): return f'{eth(value):+.6f}'
def date(at): return dt.datetime.fromtimestamp(at/1000,dt.timezone.utc)
def ratio(n,d): return f'{100*n/d:.1f}%' if d else 'unavailable'


def curve(rows):
    ordered=sorted(rows,key=lambda r:(r['at'],r['id']))
    times, cash, drawdown=[],[],[]
    total=peak=0
    for row in ordered:
        total+=int(row['pnl']);peak=max(peak,total)
        times.append(date(row['at']));cash.append(total/1e18);drawdown.append((total-peak)/1e18)
    return times,cash,drawdown


def report(root,audit):
    root,audit=Path(root),Path(audit)
    result=read(audit/'fidelity.json'); extra=read(audit/'expanded-scorecards.json')
    rows,bundles=read(audit/'rows.json'),read(audit/'scenario-bundles.json')
    manifest=read(audit/'run-manifest.json'); proofs=read(Path(manifest['inputs']['expanded_proofs']['path']))
    inventory=read(root/'inventory.json'); scenarios=result['cohorts']['all_matched_diagnostic']['scenarios']
    common=[i for i in range(len(rows)) if all(s['result'].get('pnlWei') is not None and s['result'].get('exitAt') is not None for s in bundles[i]['scenarios'])]
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'white'})
    fig,axs=plt.subplots(3,1,figsize=(13,11),sharex=True,gridspec_kw={'height_ratios':[1,1.4,1]})
    x,y,dd=curve(result['actualRows']);axs[0].step(x,y,where='post',color='#111827',label=f"Actual wallet cash: {result['actualAttempts']} attempts")
    axs[0].set_title('Frozen September actual cash, full captured population',loc='left',weight='bold')
    axs[0].set_ylabel('Net ETH');axs[0].legend(loc='best')
    actual=[dict(id=rows[i]['id'],at=rows[i]['exitAt'],pnl=rows[i]['actualWei']) for i in common]
    x,y,dd=curve(actual)
    axs[1].step(x,y,where='post',color='#111827',lw=2.4,label=f'Actual, same {len(common)} attempts')
    axs[2].step(x,dd,where='post',color='#111827',lw=2.4)
    for k,(name,color) in enumerate(zip(scenarios,COLORS)):
        predicted=[dict(id=rows[i]['id'],at=bundles[i]['scenarios'][k]['result']['exitAt'],pnl=bundles[i]['scenarios'][k]['result']['pnlWei']) for i in common]
        x,y,dd=curve(predicted)
        axs[1].step(x,y,where='post',color=color,lw=1.2,label=name)
        axs[2].step(x,dd,where='post',color=color,lw=1.2)
    axs[1].set_title(f'Same-attempt comparison: {len(common)} resolved under all six stresses',loc='left',weight='bold')
    axs[1].set_ylabel('Net ETH');axs[1].legend(ncol=3,loc='best',fontsize=9)
    axs[2].set_ylabel('Closed-cash drawdown, ETH');axs[2].set_xlabel('UTC, September 2026')
    axs[2].xaxis.set_major_formatter(mdates.DateFormatter('%b %d',tz=dt.timezone.utc))
    for ax in axs: ax.axhline(0,color='#9ca3af',lw=.6);ax.grid(alpha=.15)
    fig.suptitle('Expanded simulation fidelity: diagnostic only',fontsize=17,weight='bold')
    fig.text(.08,.012,'Timing and same-second order stresses are scenarios, not confidence bounds. Missing attempts are excluded only from matched panels.',fontsize=9)
    fig.tight_layout(rect=(0,.03,1,.96));fig.savefig(audit/'expanded-cash.png',dpi=155);plt.close(fig)
    days=sorted(k for k in extra['groups'] if k.startswith('day:'))
    fig,axs=plt.subplots(2,1,figsize=(13,8),sharex=True)
    for k,(scenario,color) in enumerate(zip(scenarios,COLORS)):
        daily=[extra['groups'][day]['scenarios'][scenario] for day in days]
        axs[0].plot(range(len(days)),[eth(s['predicted']['net_wei'])-eth(s['actual']['net_wei']) for s in daily],marker='o',color=color,label=scenario)
    axs[0].axhline(0,color='#111827',lw=1);axs[0].set_ylabel('Simulation minus actual, ETH')
    axs[0].set_title('Daily cash error: above zero means optimistic simulation',loc='left',weight='bold');axs[0].legend(ncol=3)
    byday=collections.Counter(date(r['entryAt']).strftime('%Y-%m-%d') for r in inventory['rows'])
    paired=[extra['groups'][day]['scenarios']['p50-after']['known'] for day in days]
    axs[1].bar(range(len(days)),[byday[d[4:]] for d in days],color='#d1d5db',label='All actual attempts that day')
    axs[1].bar(range(len(days)),paired,color='#2563eb',label='Matched in p50-after')
    axs[1].set_ylabel('Attempts');axs[1].legend();axs[1].set_xticks(range(len(days)),[d[4:] for d in days]);axs[1].set_xlabel('UTC entry day')
    for ax in axs:ax.grid(axis='y',alpha=.15)
    fig.tight_layout();fig.savefig(audit/'expanded-daily-errors.png',dpi=155);plt.close(fig)
    lines=[f'# Expanded actual-trade simulation audit', '',
        f"The expanded comparison remains diagnostic only. It covers {len(rows)} assembled attempts, compared with 51 previously. Only {proofs['modernCaptured']} have directly captured pre-execution quotes; the other {proofs['reconstructed']} use explicitly reconstructed historical inputs.", '',
        f"The frozen capture is {result['fromUtc']} through {result['throughUtc']} (16:30 London on September 13). It contains {result['actualAttempts']} actual attempts. Their net cash is {money(result['actualCash']['net_wei'])} ETH. Receipt cash reconciles for {result['receiptReconstruction']['exact']} attempts.", '',
        '## Matched cash and behavior', '',
        'Each row compares the same actual attempts with its predictions. Counts can differ when a scenario is unavailable. None of these results is a guard-policy comparison or a validated replacement recommendation.', '',
        '| Scenario | Matched | Actual net ETH | Simulated net ETH | Cash error ETH | Actual DD ETH | Simulated DD ETH | Simulated winners that actually lost |',
        '|---|---:|---:|---:|---:|---:|---:|---:|']
    for name,s in scenarios.items():
        lines.append(f"| {name} | {s['known']}/{s['expected']} | {money(s['actual']['net_wei'])} | {money(s['predicted']['net_wei'])} | {eth(s['predicted']['net_wei'])-eth(s['actual']['net_wei']):+.6f} | {eth(s['actual']['drawdown_wei']):.6f} | {eth(s['predicted']['drawdown_wei']):.6f} | {len(s['falseWinners'])} |")
    lines+=['','## Four reproduction ratios','','These compare simulated totals with actual totals on matched attempts. They are not guard retention KPIs. Values above 100% mean the simulator produced more of that quantity than reality.','',
        '| Scenario | Winning trades / actual | Losing trades / actual | Winning ETH / actual | Losing ETH / actual |','|---|---:|---:|---:|---:|']
    for name,s in scenarios.items():
        a,p=s['actual'],s['predicted']
        lines.append(f"| {name} | {ratio(p['winners'],a['winners'])} | {ratio(p['losers'],a['losers'])} | {ratio(int(p['profit_wei']),int(a['profit_wei']))} | {ratio(int(p['loss_wei']),int(a['loss_wei']))} |")
    lines+=['','![Cumulative cash and drawdown](expanded-cash.png)','','![Daily errors and coverage](expanded-daily-errors.png)','','## Evidence and exclusions','',
        f"- All {inventory['summary']['sourceJobs']} context-bearing source jobs were examined. {inventory['summary']['faults']['historical_strategy_context_missing']} of the full 1,190 attempts lack recorded strategy context.",
        f"- {len(proofs['missing'])} further historical attempts could not enter this comparison: {dict(collections.Counter(r['reason'] for r in proofs['missing']))}.",
        f"- Strict replay resolves {result['cohorts']['all_matched_diagnostic']['strict']['known']}/{len(rows)} assembled attempts. The rest require execution-order assumptions or have another explicit gap.",
        f"- Both integer endpoints of reconstructed quotes produced identical results in {extra['quoteEndpointChecks']} shared-engine checks. This tests the inversion of the archived 50% slippage rule; it does not prove that rule was effective for every historical submission.",
        '- The same TypeScript engine calculates each scenario. External orders are recalculated against simulated reserves; our wallet orders are excluded. External traders are assumed to keep their historical order quantities.',
        '- Historical entry quotes come from submitted minimums. Actual filled quantities, proceeds, realized P&L and failure labels never set predictions.',
        '- Gas components use separate medians of earlier receipts. Timing uses at least 20 earlier valid samples. Missing durable availability times are excluded, and the last six hours before each attempt cannot calibrate it.',
        '- This tightens historical calibration relative to the prior audit. It is a documented evidence change, not a fitted loss adjustment. Directly captured requests retain their pinned cost assumptions.',
        '- Observation delay and first-mark adoption remain modeled where exact arrivals are absent. Six before/after stresses are not bounds on every possible same-second execution state.',
        '- This is conditional on actual trade intents and their selected TP. It does not establish the realism of skipped opportunities, adaptive TP selection over the full opportunity population, capacity, or a whole hypothetical account.',
        '- September has already been inspected. No prospective validation or future-profit claim is made. No live settings changed.','','## Daily matched results (p50-after)','',
        '| UTC entry day | Matched | Actual ETH | Simulation ETH | False winners |','|---|---:|---:|---:|---:|']
    for day in days:
        s=extra['groups'][day]['scenarios']['p50-after']
        lines.append(f"| {day[4:]} | {s['known']}/{s['expected']} | {money(s['actual']['net_wei'])} | {money(s['predicted']['net_wei'])} | {len(s['falseWinners'])} |")
    discrepancies=[]
    for row,bundle in zip(rows,bundles):
        p=next(s['result'] for s in bundle['scenarios'] if s['id']=='p50-after')
        if p.get('pnlWei') is None or p.get('exitAt') is None: continue
        discrepancies.append((int(p['pnlWei'])-int(row['actualWei']),row,p))
    lines+=['','## Largest optimistic errors (p50-after)','','This scenario is shown consistently, not selected because it matches best. All six remain in the scorecards.','',
        '| Attempt | Actual ETH | Simulation ETH | Optimism ETH | Actual exit | Simulated exit | Exit time error, seconds |','|---|---:|---:|---:|---|---|---:|']
    for error,row,p in sorted(discrepancies,key=lambda x:x[0],reverse=True)[:10]:
        lines.append(f"| {row['id']} | {money(row['actualWei'])} | {money(p['pnlWei'])} | {error/1e18:+.6f} | {row['actualReason']} | {p['reason']} | {(p['exitAt']-row['exitAt'])/1000:+.3f} |")
    lines+=['','## Error distributions','','Every mean below includes median, standard deviation and count. Errors in return are percentage points of pinned stake.','',
        '| Scenario | Metric | Mean | Median | SD | n |','|---|---|---:|---:|---:|---:|']
    for name,s in scenarios.items():
        for metric in ('signedErrorPp','absoluteErrorPp','quantityErrorPct','costsErrorEth','exitTimingErrorMs'):
            d=s[metric]
            fmt=lambda v:'unavailable' if v is None else f'{v:.6g}'
            lines.append(f"| {name} | {metric} | {fmt(d['mean'])} | {fmt(d['median'])} | {fmt(d['sd'])} | {d['n']} |")
    lines+=['','Period and configuration-era details, all false-winner IDs and missing outcomes are in [expanded-scorecards.json](expanded-scorecards.json). The standard [fidelity report](report.md) retains the 24-hour eight-bin and seven-day seven-bin actual cash breakdowns and the unchanged pass/fail limits.','',
        'Reproduce after source verification, from `bot/`:','',
        '```sh',
        'python3 -m research.core.expanded_replay build --root data/research/20260913-expanded-sample-v1',
        'python3 -m research validate-replay --manifest data/research/20260913-expanded-sample-v1/built/manifest.json --out NEW_AUDIT_DIRECTORY',
        'python3 -m research.core.expanded_replay supplement --root data/research/20260913-expanded-sample-v1 --audit NEW_AUDIT_DIRECTORY',
        'python3 -m research.core.expanded_report --root data/research/20260913-expanded-sample-v1 --audit NEW_AUDIT_DIRECTORY',
        '```','',
        'The build directory must be new; preserve prior outputs when reproducing. Exit code 2 from validate-replay means the diagnostic report completed but the fidelity certificate failed.']
    (audit/'expanded-report.md').write_text('\n'.join(lines)+'\n')
    write(audit/'artifact-hashes.json',{str(p.relative_to(audit)):sha(p) for p in audit.rglob('*') if p.is_file() and p.name!='artifact-hashes.json'})
    return dict(report=str(audit/'expanded-report.md'),commonMatched=len(common),assembled=len(rows))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--audit',required=True);args=parser.parse_args()
    print(json.dumps(report(args.root,args.audit)))
