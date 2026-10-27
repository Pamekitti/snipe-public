"""Compare a repaired shared execution model on the full frozen actual-attempt sample."""
import argparse
import datetime as dt
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from research.core.data import read_json, write_json, digest
from research.core.unified_fidelity import matched_score
from research.core.fidelity import execution_windows, grade


def run(root, source, manifest_path, audit_path, prior_grade_path):
    root, source, audit_path = Path(root), Path(source), Path(audit_path)
    manifest=read_json(manifest_path)
    start,end=manifest['start'],manifest['through']
    rows=read_json(source/'rows.json')
    predictions=read_json(audit_path/'predictions.json')
    audit=read_json(audit_path/'audit.json')
    pool_scenario=audit.get('poolScenario')
    assert len(rows)==len(predictions)==audit['attempts']
    cash=matched_score(rows,predictions)
    stamp=lambda at:dt.datetime.fromtimestamp(at/1000,dt.timezone.utc)
    iso=lambda at:stamp(at).isoformat()
    pairs=[(r,p) for r,p in zip(rows,predictions) if p['pnlWei'] is not None]
    missing=[{'id':r['id'],'actualWei':r['actualWei'],'reason':p['reason']} for r,p in zip(rows,predictions) if p['pnlWei'] is None]
    fig,axes=plt.subplots(2,1,figsize=(12,7),sharex=True)
    for label,color,events in [
        ('Actual cash, matched attempts','#1864ab',[(r['exitAt'],int(r['actualWei'])) for r,_ in pairs]),
        ('Simulation including pool scenario' if pool_scenario else 'Revised simulation, matched attempts','#d9480f',[(p['exitAt'],int(p['pnlWei'])) for _,p in pairs])]:
        total=peak=0
        times,net,dd=[stamp(start)],[0],[0]
        for at,value in sorted(events):
            total+=value;peak=max(peak,total)
            times.append(stamp(at));net.append(total/1e18);dd.append((peak-total)/1e18)
        times.append(stamp(end));net.append(net[-1]);dd.append(dd[-1])
        axes[0].step(times,net,where='post',label=label,color=color,lw=1.6)
        axes[1].step(times,dd,where='post',color=color,lw=1.6)
    axes[0].set_title(f'{len(pairs):,} matched actual attempts: '+('diagnostic pool scenario' if pool_scenario else 'corrected execution replay'),loc='left')
    first_entry=min(r['entryAt'] for r in rows)
    for ax in axes:ax.axvspan(stamp(start),stamp(first_entry),color='#888888',alpha=.07)
    axes[0].text(stamp(start+(first_entry-start)/2),.02,'No actual-attempt samples',ha='center',va='bottom',fontsize=9,color='#666666')
    axes[0].set_ylabel('Cumulative net ETH');axes[1].set_ylabel('Drawdown ETH')
    axes[0].legend(frameon=False,loc='upper left')
    for ax in axes:
        ax.grid(alpha=.2);ax.spines[['top','right']].set_visible(False)
    axes[1].set_xlim(stamp(start),stamp(end));axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%d %b',tz=dt.timezone.utc))
    axes[1].set_xlabel('UTC. Frozen capture ends '+iso(end))
    fig.text(.09,.02,f'Diagnostic only. {len(missing)} unavailable predictions excluded from both lines. '
        f'{len(cash["falseWinners"])} simulated winners actually lost.\n'+
        ('One pool exit uses stated timing and external funding assumptions. No guard ranking.' if pool_scenario else 'These are matched trade predictions, not a validated historical account or guard comparison.'),fontsize=9)
    fig.tight_layout(rect=(0,.07,1,1));fig.savefig(root/'cash-comparison.png',dpi=160);plt.close(fig)
    grouped={}
    for name,lo,hi,count in [('daily',start,end,int((end-start)//86400000)+1),('trailing24h',end-86400000,end,8),('trailing7d',end-7*86400000,end,7)]:
        step=86400000 if name=='daily' else (hi-lo)/count
        grouped[name]=[]
        for i in range(count):
            left,right=lo+i*step,min(hi,lo+(i+1)*step)
            indices=[j for j,r in enumerate(rows) if left<=r['entryAt']<right]
            grouped[name].append(dict(start=left,through=right,metrics=matched_score([rows[j] for j in indices],[predictions[j] for j in indices])))
    graded=[dict(id=r['id'],entry=r['entryAt'],size=int(r['sizeWei']),actual_wei=r['actualWei'],actual_at=r['exitAt'],
        predicted_wei=p['pnlWei'],predicted_at=p['exitAt'],status=p['status']) for r,p in zip(rows,predictions)]
    windows=execution_windows(graded,start,end,min(r['size'] for r in graded if r['size']>0))
    prior=read_json(prior_grade_path);limits_path=Path(__file__).with_name('BACKTEST_LIMITS_V1.json');limits=read_json(limits_path)
    verdict=grade(windows,prior['account'],prior['evidence'],limits)
    write_json(root/'standard-fidelity-grade.json',dict(verdict=verdict,execution=windows,account=prior['account'],evidence=prior['evidence'],
        limitsHash=digest(limits_path),priorUnresolvedEvidenceHash=digest(prior_grade_path),modelHash=audit['modelHash'],diagnosticOnly=True,
        scope='Execution errors recomputed. Prior account/source checks are retained as unresolved, not recertified.'))
    write_json(root/'cash-error-profile.json',dict(captureStart=start,captureThrough=end,actualSampleFirstEntry=min(r['entryAt'] for r in rows),
        actualSampleLastEntry=max(r['entryAt'] for r in rows),metrics=cash,missing=missing,bins=grouped,modelHash=audit['modelHash'],
        actualInputHashes=audit['inputHashes'],manifestHash=digest(manifest_path),poolScenario=pool_scenario,guardRetention={'winningMoney':None,'losingMoney':None},
        guardRetentionReason='No complete matching always-on and guarded account comparisons. Trade fidelity ratios are not guard retention KPIs.'))
    a,p=cash['actual'],cash['predicted'];err=cash['absoluteErrorPp']
    text=f'''# Execution repair: cash fidelity remains diagnostic

The shared execution model has two corrections. Neither establishes a supported guard replacement.

- External curve buys can carry their original submitted budget and slippage limit, verified against a successful transaction trace and receipt. A capped fill's recorded spend can be smaller than its submitted budget.
- When our historical order is removed before the modeled entry, subsequent external fills are recalculated. Their recorded token outputs cannot be reused against the changed reserves.

The frozen opportunity capture covers {iso(start)} through {iso(end)}. It was not refreshed beyond that boundary. The {len(rows):,} actual-attempt inputs span {iso(min(r['entryAt'] for r in rows))} through {iso(max(r['entryAt'] for r in rows))} by entry time.

## Cash comparison

| Same {len(pairs):,} matched attempts | Actual | Revised simulation |
| --- | ---: | ---: |
| Net ETH | {int(a['net_wei'])/1e18:.6f} | {int(p['net_wei'])/1e18:.6f} |
| Winning ETH | {int(a['profit_wei'])/1e18:.6f} | {int(p['profit_wei'])/1e18:.6f} |
| Losing ETH | {int(a['loss_wei'])/1e18:.6f} | {int(p['loss_wei'])/1e18:.6f} |
| Cumulative drawdown ETH | {int(a['drawdown_wei'])/1e18:.6f} | {int(p['drawdown_wei'])/1e18:.6f} |

![Actual versus revised simulation](cash-comparison.png)

There are {len(cash['falseWinners'])} simulated winners that actually lost. Absolute return error in percentage points of stake has mean {err['mean']:.3f}, median {err['median']:.3f}, standard deviation {err['sd']:.3f}, and n={err['n']}. These remain retrospective checks on inspected data.

Unavailable predictions: {len(missing)}. Their actual outcomes are listed in `cash-error-profile.json` and omitted from both matched lines. Full actual cash across all recorded attempts is {sum(int(r['actualWei']) for r in rows)/1e18:+.6f} ETH. No accounting reset erases a loss.

{len(audit['resolvedReferenceChanges'])} previously resolved outputs differ from the frozen earlier model. The audit deliberately fails its unchanged-output assertion. These are declared model changes, not parity passes against the old predictions. The standard fidelity report has {sum(not c['passed'] for c in verdict['checks'])} failed or unavailable checks out of {len(verdict['checks'])}; its limits were not relaxed.

## What remains incomplete

Local contract forks independently exercise the curve-to-pool route. Their pool preparation timing is modeled at one second per transaction. Complete candidate-specific external pool order replay and chain fee validation remain required before accepting these as scored outcomes. The local fork results are explicitly `rankingEligible: false` and are not injected into predicted cash.

The historical publication gap also remains. Earlier backfilled outcomes have late recorded publication times. A separately labeled modeled-publication scenario is available, but it is not recovered historical timing.

Winning-money and losing-money retention remain unavailable because the matching always-on and guarded accounts are incomplete. No new candidate ranking is claimed. The next grid depends on complete pool execution evidence and a frozen model revision. No live build, trading control, setting or accounting period changed.

`cash-error-profile.json` contains September daily bins, trailing 24 hours in eight bins, and seven days in seven bins. All descriptive means retain median, standard deviation and count. The reference cash and unresolved whole-account checks remain separate.
'''
    (root/'report.md').write_text(text)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for name in ['root','source','manifest','audit','prior-grade']:
        parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    run(args.root,args.source,args.manifest,args.audit,args.prior_grade)
