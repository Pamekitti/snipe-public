"""Plot selected shared-account replays, preserving unavailable account prefixes."""
import argparse
import collections
import datetime as dt
import json
import os
import statistics
import subprocess
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as md
from research.core.data import read_json, write_json
from research.bounded_io import active_results

BASELINE = dict(id='conservative-10-5', n=10, m=5, off=-2, freshOn=1,
                fullOn=2, ageMs=10800000, mode='both')
UTC = dt.timezone.utc
def stamp(at):
    return dt.datetime.fromtimestamp(at / 1000, UTC)

def stats(values):
    return dict(netEth=sum(values), mean=statistics.mean(values) if values else None,
                median=statistics.median(values) if values else None,
                sd=statistics.stdev(values) if len(values) > 1 else None, n=len(values))

def summarize(cash, before):
    values=[int(c['pnlWei']) for c in cash if c['at'] < before]
    net=peak=drawdown=0
    for value in values:
        net+=value;peak=max(peak,net);drawdown=max(drawdown,peak-net)
    return dict(netEth=net/1e18, drawdownEth=drawdown/1e18,
                profitEth=sum(max(0,v) for v in values)/1e18,
                lossEth=sum(max(0,-v) for v in values)/1e18, n=len(values))

def render(root, scenario='pool-d0-h0-pub0', engine_root=None, fixed_clock_diagnostic=False):
    root=Path(root);remote=active_results(root/'results');folder=remote/'scenarios'/scenario;report=root/'report'
    report.mkdir(exist_ok=True)
    worker_env={**os.environ,'ENV_FILE':'/dev/null','MODE':'observe','LIVE':'0','DASH':'0','DOTENV_CONFIG_QUIET':'true'}
    engine_root=Path(engine_root).resolve() if engine_root else Path.cwd()
    identity=subprocess.run(['node','--import','tsx','scripts/execution-worker.ts'],input='{"op":"identity"}\n',text=True,capture_output=True,check=True,env=worker_env,cwd=engine_root)
    expected=read_json(remote/'run-freeze.json')['modelHash']
    if json.loads(identity.stdout)['result']['modelHash']!=expected:
        raise ValueError('Local shared model differs from the frozen AWS model')
    manifest=read_json(root/'input-manifest.json');start,end=manifest['start'],manifest['through']
    inventory=read_json(folder/'account-manifest.json')['inputs']
    requests=[('10/5 baseline','fixed',20,'hold-45',BASELINE)]
    ranking_path=remote/'report'/('fixed-clock-diagnostic-ranking.json' if fixed_clock_diagnostic else 'cross-scenario-ranking.json')
    ranking=read_json(ranking_path) if ranking_path.exists() else None
    choice=ranking['nominations']['train7']['choice'] if ranking else None
    if choice:
        comparable=lambda policy:{k:v for k,v in policy.items() if k!='id'}
        if (comparable(choice['policy']),choice['memory'],choice['exit'])!=(comparable(BASELINE),20,'hold-45'):
            requests.append(('Training risk pick' if fixed_clock_diagnostic else 'Training nominee (diagnostic)','fixed',choice['memory'],choice['exit'],choice['policy']))
    if fixed_clock_diagnostic and ranking and ranking['nominations']['train7']['ranked']:
        profit=ranking['nominations']['train7']['ranked'][0]
        if not any((comparable(p),memory,exit_name)==(comparable(profit['policy']),profit['memory'],profit['exit']) for _,_,memory,exit_name,p in requests):
            requests.append(('Training profit leader','fixed',profit['memory'],profit['exit'],profit['policy']))
    leaders=read_json(report/'training-leaders.json') if (report/'training-leaders.json').exists() else []
    for item in leaders if not ranking else []:
        if item['scenario']==scenario:
            result=item['result'];source=item['source']
            # The score file stem includes the exit descriptor before its final group index.
            exit_name=source.removeprefix('fixed-memory20-').rsplit('-',1)[0]
            if (result['policy'],exit_name)!=(BASELINE,'hold-45'):
                requests.append(('Single-scenario leader (diagnostic)','fixed',20,exit_name,result['policy']))
            break
    runs=[];audits=[];metadata_maps=[]
    for label,lane,memory,exit_name,policy in requests:
        info=next(i for i in inventory if (i['lane'],i['memory'],i['exit'])==(lane,memory,exit_name))
        source=folder/'accounts'/Path(info['path']).name
        if not source.exists():source=Path(str(source)+'.gz')
        inp=read_json(source);inp['policy']=policy
        completed=subprocess.run(['node','--import','tsx','scripts/execution-worker.ts'],
            input=json.dumps({'op':'scenario-accounts','input':inp}),text=True,capture_output=True,
            env=worker_env,check=True,cwd=engine_root)
        result=json.loads(completed.stdout)['result']
        meta={o['id']:o for o in inp['opportunities']}
        metadata_maps.append(meta)
        controls={c['id']+':'+c.get('reason',''):c['at'] for c in inp['controls']}
        central=next(a for a in result['accounts'] if a['id']=='p50-after')
        faults=[]
        for account in result['continuous']:
            for identity in account['metrics']['unavailable']:
                o=meta.get(identity)
                faults.append(dict(scenario=account['id'],id=identity,at=o['at'] if o else controls.get(identity,start),
                                   publication=o['availableAt'] if o else None,
                                   reasons=o['bundle']['unavailable'] if o else 'control_or_initial_state_gap'))
        unknown=central['selected']['unavailable']+central['reference']['unavailable']
        cutoff=min([end]+[f['at'] for f in faults]+[meta[i]['at'] if i in meta else controls.get(i,start) for i in unknown])
        complete=cutoff==end and all(a['metrics']['complete'] for a in result['continuous']) and central['selected']['complete'] and central['reference']['complete']
        audit=dict(label=label,policy=policy,exit=exit_name,complete=complete,comparableThrough=cutoff,
                   guardReasons=dict(collections.Counter(r['reason'] for r in result['readings'])),
                   openChecks=sum(r['state']=='open' for r in result['readings']),
                   shadowUnavailable=faults, selectedUnavailable=central['selected']['unavailable'],
                   referenceUnavailable=central['reference']['unavailable'])
        name='baseline' if not runs else 'training-leader' if len(runs)==1 else 'training-profit-leader'
        write_json(report/(name+'-account-lines.json'),result)
        audits.append(audit);runs.append((label,result,central,audit))
    common_through=min(a['comparableThrough'] for a in audits)
    for item in audits:
        item['individuallyComparableThrough']=item['comparableThrough']
        item['comparableThrough']=common_through
        item['complete']=item['complete'] and common_through==end
    write_json(report/'account-coverage.json',audits)
    control_audit=[]
    for label,key in [('10/5 baseline','policy'),('Market guard disabled','marketOff')]:
        account=runs[0][2][key];cash=account['cash']
        if len(cash)<2:continue
        duration,lower,upper=max((cash[i+1]['t']-point['t'],point['t'],cash[i+1]['t']) for i,point in enumerate(cash[:-1]))
        control_audit.append(dict(account=label,largestCashGapHours=duration/3600000,
            fromUtc=stamp(lower).isoformat(),throughUtc=stamp(upper).isoformat(),
            reasonsDuringGap=dict(collections.Counter(d['reason'] for d in account['decisions'] if lower<d['at']<upper))))
    write_json(report/'account-control-audit.json',control_audit)
    fig,axes=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained')
    def plot(cash,label,color,cutoff):
        net=peak=0;times=[stamp(start)];totals=[0];drawdowns=[0]
        for c in cash:
            if c['at']>=cutoff:continue
            net+=int(c['pnlWei']);peak=max(peak,net)
            times.append(stamp(c['at']));totals.append(net/1e18);drawdowns.append((peak-net)/1e18)
        times.append(stamp(cutoff));totals.append(totals[-1]);drawdowns.append(drawdowns[-1])
        axes[0].step(times,totals,where='post',label=label,color=color)
        axes[1].step(times,drawdowns,where='post',color=color)
    for i,(label,result,a,audit) in enumerate(runs):
        plot(a['selected']['cash'],label,['#3574aa','#2b8f70','#8856a7'][i],audit['comparableThrough'])
        if i==0:plot(a['reference']['cash'],'Market guard disabled','#c77c30',audit['comparableThrough'])
    earliest=min(a['comparableThrough'] for a in audits)
    for ax in axes:
        ax.grid(alpha=.2);ax.spines[['top','right']].set_visible(False);ax.set_xlim(stamp(start),stamp(end))
        if earliest<end:ax.axvspan(stamp(earliest),stamp(end),color='grey',alpha=.13)
    axes[0].legend();axes[0].set_ylabel('Cumulative simulated ETH');axes[1].set_ylabel('Drawdown from cumulative cash peak, ETH')
    axes[1].xaxis.set_major_formatter(md.DateFormatter('%d %b',tz=UTC))
    axes[0].set_title('Guard comparison: '+scenario+', 1,200 ms sell delay, after-order')
    for ax in axes:ax.axvline(stamp(start+7*86400000),color='#555555',ls='--',lw=.8)
    axes[1].set_xlabel('UTC. Dashed line ends 1–7 Sep fitting. Grey is unavailable; later data is retrospective assessment.')
    fig.savefig(report/'guard-lines.png',dpi=160);plt.close(fig)
    # This opportunity reference has no executable account constraints.
    base_account=runs[0][2];base_meta=metadata_maps[0]
    unrestricted_through=min([common_through]+[base_meta[i]['at'] if i in base_meta else start for i in base_account['unrestrictedUnavailable']])
    unrestricted=sorted(base_account['unrestricted'],key=lambda c:c['at'])
    reference_audit=dict(comparableThrough=unrestricted_through,
        unavailable=base_account['unrestrictedUnavailable'],
        unrestricted=summarize(unrestricted,unrestricted_through),
        executableMarketOff=summarize(base_account['reference']['cash'],unrestricted_through),
        definition='Static launch filters only. Ignores account capacity, template-loss history and stops. Not an executable account.')
    write_json(report/'unrestricted-reference.json',reference_audit)
    fig,axes=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained')
    plot(unrestricted,'Unrestricted opportunities, not an account','#777777',unrestricted_through)
    plot(base_account['reference']['cash'],'Executable market-guard-disabled reference','#c77c30',unrestricted_through)
    for ax in axes:
        ax.grid(alpha=.2);ax.spines[['top','right']].set_visible(False);ax.set_xlim(stamp(start),stamp(end))
        if unrestricted_through<end:ax.axvspan(stamp(unrestricted_through),stamp(end),color='grey',alpha=.13)
    axes[0].legend();axes[0].set_ylabel('Cumulative hypothetical ETH');axes[1].set_ylabel('Drawdown from cumulative cash peak, ETH')
    axes[1].xaxis.set_major_formatter(md.DateFormatter('%d %b',tz=UTC))
    axes[0].set_title('Separate opportunity reference: static filters, no capacity, template history or account stops')
    axes[1].set_xlabel('Base pool/publication scenario, fixed clock, 1,200 ms after-order sell. Grey is unavailable.')
    fig.savefig(report/'opportunity-reference.png',dpi=160);plt.close(fig)
    retained=[];fixed=runs[0][2]['reference']
    for (label,result,a,audit),meta in zip(runs,metadata_maps):
        record=dict(label=label,complete=audit['complete'],comparableThrough=audit['comparableThrough'],
                    netEth=int(a['selected']['netWei'])/1e18,drawdownEth=int(a['selected']['drawdownWei'])/1e18,
                    losingRecoveries=a['losingRecoveries'],recoveryLossEth=int(a['recoveryLossWei'])/1e18)
        for name,key in [('win','profitWei'),('loss','lossWei')]:
            denominator=int(a['reference'][key]);fixed_denominator=int(fixed[key])
            record[name+'Retained']=int(a['selected'][key])/denominator if audit['complete'] and denominator else None
            record[name+'RetainedFixed45']=int(a['selected'][key])/fixed_denominator if audit['complete'] and audits[0]['complete'] and fixed_denominator else None
        record['profitMissedEth']=(int(a['reference']['profitWei'])-int(a['selected']['profitWei']))/1e18 if audit['complete'] else None
        record['lossesAvoidedEth']=(int(a['reference']['lossWei'])-int(a['selected']['lossWei']))/1e18 if audit['complete'] else None
        record['knownPrefixSelected']=summarize(a['selected']['cash'],audit['comparableThrough'])
        record['knownPrefixReference']=summarize(a['reference']['cash'],audit['comparableThrough'])
        selected,reference=record['knownPrefixSelected'],record['knownPrefixReference']
        fixed_prefix=summarize(fixed['cash'],audit['comparableThrough'])
        for name,key in [('win','profitEth'),('loss','lossEth')]:
            record['prefix'+name.title()+'Retained']=selected[key]/reference[key] if reference[key] else None
            record['prefix'+name.title()+'RetainedFixed45']=selected[key]/fixed_prefix[key] if fixed_prefix[key] else None
        record['prefixProfitMissedEth']=reference['profitEth']-selected['profitEth']
        record['prefixLossesAvoidedEth']=reference['lossEth']-selected['lossEth']
        episodes=collections.defaultdict(int)
        for cash in a['selected']['cash']:
            if cash['at']>=audit['comparableThrough']:continue
            entry=meta[cash['id']]['at']
            recovery=next((r for r in reversed(a['recoveries']) if r['at']<=entry),None)
            if recovery:episodes[recovery['at']]+=int(cash['pnlWei'])
        record['prefixLosingRecoveries']=sum(v<0 for v in episodes.values())
        record['prefixRecoveryLossEth']=sum(max(0,-v) for v in episodes.values())/1e18
        retained.append(record)
    write_json(report/'money-retention.json',retained)
    fig,ax=plt.subplots(figsize=(10,4),layout='constrained')
    for i,row in enumerate(retained):
        for j,(key,color) in enumerate([('prefixWinRetained','#3574aa'),('prefixLossRetained','#c77c30')]):
            if row[key] is None:ax.text(3*i+j,40,'Unavailable',rotation=90,ha='center',va='center')
            else:
                bars=ax.bar(3*i+j,100*row[key],color=color,label=['Win retained','Loss retained'][j] if i==0 else None)
                ax.bar_label(bars,labels=[f'{100*row[key]:.1f}%'],padding=3)
    ax.set_xticks([3*i+.5 for i in range(len(retained))],[r['label']+'\nThrough '+stamp(r['comparableThrough']).strftime('%d %b %H:%M UTC') for r in retained]);ax.set_xlim(-.6,3*len(retained)-1.4)
    ax.set_ylim(0,max([100]+[row[k]*110 for row in retained for k in ['prefixWinRetained','prefixLossRetained'] if row[k] is not None]))
    ax.set_ylabel('Money retained (%)');ax.set_title('Comparable-prefix KPIs, matching-exit always-on reference')
    if any(row['prefixWinRetained'] is not None for row in retained):ax.legend()
    fig.savefig(report/'retention.png',dpi=160);plt.close(fig)
    actual=read_json(root.parent/'20260914-execution-repair-v1/source/reproduction-inputs/fidelity/rows.json')
    actual_from=min(r['entryAt'] for r in actual)
    series={'Actual cash':[(r['exitAt'],int(r['actualWei'])/1e18) for r in actual if r['actualWei'] is not None]}
    for label,result,a,audit in runs:series[label]=[(c['at'],int(c['pnlWei'])/1e18) for c in a['selected']['cash'] if c['at']<audit['comparableThrough']]
    bins=[]
    for name,lower,step,count in [('24h',end-86400000,10800000,8),('7d',end-7*86400000,86400000,7),('September daily',start,86400000,(end-start+86399999)//86400000)]:
        for i in range(count):
            lo=lower+i*step;hi=min(end,lo+step)
            bins.append(dict(window=name,fromUtc=stamp(lo).isoformat(),throughUtc=stamp(hi).isoformat(),
                             series={key:{**stats([v for t,v in cash if lo<=t<hi]),'complete':lo>=actual_from if key=='Actual cash' else hi<=next(a['comparableThrough'] for a in audits if a['label']==key)} for key,cash in series.items()}))
    write_json(report/'period-bins.json',bins)
    today=end//86400000*86400000
    baseline=runs[0][1];account=runs[0][2]
    readings=[r for r in baseline['readings'] if today<=r['at']<end]
    fig,axes=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained')
    for key,label,color in [('sumRange','Main 10-outcome sum','#3574aa'),('recentSumRange','Fresh 5-outcome sum','#c77c30')]:
        values=[r[key][0] if r.get(key) and all(s['n']>=10 if key=='sumRange' else s['recentN']>=5 for s in r['scenarios']) else float('nan') for r in readings]
        axes[0].plot([stamp(r['at']) for r in readings],values,label=label,color=color,lw=1)
    for value,label,color in [(-2,'Main pause below -2','#ba3f46'),(2,'Main recovery above +2','#3574aa'),(1,'Fresh recovery above +1','#c77c30')]:
        axes[0].axhline(value,color=color,ls=':',lw=.8,label=label)
    last='shut'
    for reading in readings:
        if reading['state']!=last:
            for ax in axes:ax.axvline(stamp(reading['at']),color='#2b8f70' if reading['state']=='open' else '#ba3f46',alpha=.3,lw=.8)
        last=reading['state']
    known=[c for c in account['selected']['cash'] if today<=c['at']<end]
    if known:axes[1].scatter([stamp(c['at']) for c in known],[int(c['pnlWei'])/1e18 for c in known],facecolors='none',edgecolors='#3574aa',label='Simulated closures')
    real=[r for r in actual if r['actualWei'] is not None and today<=r['exitAt']<end]
    axes[1].scatter([stamp(r['exitAt']) for r in real],[int(r['actualWei'])/1e18 for r in real],marker='x',c=['#2b8f70' if int(r['actualWei'])>0 else '#ba3f46' for r in real],label='Actual closures, historical stakes')
    for ax in axes:
        ax.grid(alpha=.2);ax.set_xlim(stamp(today),stamp(end));ax.legend(fontsize=8)
    axes[0].set_ylabel('Shadow return, stakes');axes[1].set_ylabel('Trade net ETH')
    axes[1].xaxis.set_major_formatter(md.DateFormatter('%H:%M',tz=UTC))
    axes[0].set_title('Last capture day: raw indicator lower bounds across six execution stresses')
    axes[1].set_xlabel('UTC. Raw sums do not authorize entries when evidence is stale or unavailable.')
    fig.savefig(report/'intraday-indicator.png',dpi=160);plt.close(fig)
    import numpy as np
    points=[]
    for path in sorted((folder/'scores'/'core').glob('fixed-memory20-hold-45-*.json*')):
        if '.json.' in path.name and not path.name.endswith('.json.gz'):continue
        points.extend(read_json(path)['results'])
    slices=[('Windows','n','m',dict(off=-2,freshOn=1,fullOn=2,ageMs=10800000)),
            ('Pause and fresh recovery','off','freshOn',dict(n=10,m=5,fullOn=2,ageMs=10800000)),
            ('Freshness and main recovery','ageMs','fullOn',dict(n=10,m=5,off=-2,freshOn=1))]
    fig,axes=plt.subplots(1,3,figsize=(15,5),layout='constrained');panels=[]
    for title,x,y,held in slices:
        chosen=[r for r in points if r['policy']['mode']=='both' and all(r['policy'][k]==v for k,v in held.items())]
        xs=sorted({r['policy'][x] for r in chosen});ys=sorted({r['policy'][y] for r in chosen})
        values=np.full((len(ys),len(xs)),np.nan)
        tested=np.zeros((len(ys),len(xs)),dtype=bool)
        for r in chosen:
            tested[ys.index(r['policy'][y]),xs.index(r['policy'][x])]=True
            scores=r['periods']['train7']
            if all(s['complete'] for s in scores):values[ys.index(r['policy'][y]),xs.index(r['policy'][x])]=min(s['net'] for s in scores)
        panels.append((title,x,y,xs,ys,values,tested))
    bound=max([abs(v) for *_,values,tested in panels for v in values.flat if np.isfinite(v)]+[.001])
    for ax,(title,x,y,xs,ys,values,tested) in zip(axes,panels):
        if xs and ys:
            im=ax.imshow(values,origin='lower',aspect='auto',cmap='RdBu',vmin=-bound,vmax=bound)
            ax.set_xticks(range(len(xs)),[str(v//60000) if x=='ageMs' else str(v) for v in xs]);ax.set_yticks(range(len(ys)),[str(v) for v in ys])
            for j in range(len(ys)):
                for i in range(len(xs)):
                    value=values[j,i]
                    text=f'{value:.3f}' if np.isfinite(value) else 'NA' if tested[j,i] else 'Not\ntested'
                    ax.text(i,j,text,ha='center',va='center',fontsize=7,color='white' if np.isfinite(value) and abs(value)>.6*bound else 'black')
        else:ax.text(.5,.5,'No completed slice',ha='center',va='center',transform=ax.transAxes)
        labels={'n':'Main window N','m':'Fresh window M','off':'Pause threshold B','freshOn':'Fresh recovery R','fullOn':'Main recovery H','ageMs':'Age, minutes'}
        ax.set_title(title);ax.set_xlabel(labels[x]);ax.set_ylabel(labels[y])
    if any(xs and ys for _,_,_,xs,ys,_,_ in panels):fig.colorbar(im,ax=list(axes),label='Worst-stress training net ETH')
    fig.suptitle('Base pool/publication scenario, fixed clock, 45s exit; worst of six execution stresses. NA is unavailable.')
    fig.savefig(report/'parameter-heatmaps.png',dpi=160);plt.close(fig)
    return dict(scenario=scenario,replays=len(runs),complete=all(a['complete'] for a in audits))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--scenario',default='pool-d0-h0-pub0')
    parser.add_argument('--engine-root',help='Isolated copy of the frozen engine; its model hash must match the run')
    parser.add_argument('--fixed-clock-diagnostic',action='store_true')
    args=parser.parse_args();print(json.dumps(render(args.root,args.scenario,args.engine_root,args.fixed_clock_diagnostic)))
