"""Replay locked candidates on the available recorded-clock account prefix."""
import argparse,json,os,subprocess,collections
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as md
from research.core.data import read_json,write_json
from research.bounded_details import BASELINE,stamp,summarize

def render(root,engine):
    root=Path(root);remote=root/'results/optimized-v2';engine=Path(engine).resolve();report=root/'report'
    ranking=read_json(remote/'report/fixed-clock-diagnostic-ranking.json')['nominations']['train7']
    requests=[('10/5 baseline',BASELINE,20,'hold-45')]
    for label,item in [('Training risk pick',ranking['choice']),('Training profit leader',ranking['ranked'][0] if ranking['ranked'] else None)]:
        if item:requests.append((label,item['policy'],item['memory'],item['exit']))
    env={**os.environ,'ENV_FILE':'/dev/null','MODE':'observe','LIVE':'0','DASH':'0','DOTENV_CONFIG_QUIET':'true'}
    def execute(obj):
        result=subprocess.run(['node','--import','tsx','scripts/execution-worker.ts'],input=json.dumps(obj),text=True,capture_output=True,check=True,cwd=engine,env=env)
        return json.loads(result.stdout)['result']
    assert execute({'op':'identity'})['modelHash']==read_json(remote/'run-freeze.json')['modelHash']
    scenarios=['pool-d0-h0-pub0','pool-d5000-h2500-pub180000'];all_rows=[]
    fig,axes=plt.subplots(2,2,figsize=(14,8),layout='constrained')
    for column,scenario in enumerate(scenarios):
        folder=remote/'scenarios'/scenario;runs=[]
        for index,(label,policy,memory,exit_name) in enumerate(requests):
            inp=read_json(folder/'accounts'/f'corrected-memory{memory}-{exit_name}.json.gz');inp['policy']=policy
            result=execute({'op':'scenario-accounts','input':inp});meta={o['id']:o for o in inp['opportunities']};cutoff=inp['through'];unknown=[]
            for account in result['continuous']:
                for identity in account['metrics']['unavailable']:
                    unknown.append(identity);cutoff=min(cutoff,meta[identity]['at'] if identity in meta else inp['start'])
            for account in result['accounts']:
                for identity in account['selected']['unavailable']+account['reference']['unavailable']:
                    unknown.append(identity);cutoff=min(cutoff,meta[identity]['at'] if identity in meta else inp['start'])
            runs.append((label,result,inp['start'],cutoff,unknown))
            write_json(report/f'corrected-{column}-{index}-lines.json',result)
        start=max(x[2] for x in runs);through=min(x[3] for x in runs)
        for index,(label,result,_,_,unknown) in enumerate(runs):
            central=next(a for a in result['accounts'] if a['id']=='p50-after');cash=central['selected']['cash'];reference=central['reference']['cash']
            selected=summarize(cash,through);ref=summarize(reference,through)
            stress=[]
            for account in result['accounts']:
                metrics=summarize(account['selected']['cash'],through);episodes=collections.defaultdict(int)
                # All account metrics are clipped to the same independently known prefix.
                stress.append({'id':account['id'],**metrics})
            all_rows.append({'scenario':scenario,'label':label,'from':start,'through':through,'unavailableIds':sorted(set(unknown)),'selected':selected,'reference':ref,'winRetained':selected['profitEth']/ref['profitEth'] if ref['profitEth'] else None,'lossRetained':selected['lossEth']/ref['lossEth'] if ref['lossEth'] else None,'stresses':stress})
            def plot(points,name,color):
                net=peak=0;times=[stamp(start)];values=[0];dd=[0]
                for c in points:
                    if not start<=c['at']<through:continue
                    net+=int(c['pnlWei'])/1e18;peak=max(peak,net);times.append(stamp(c['at']));values.append(net);dd.append(peak-net)
                times.append(stamp(through));values.append(values[-1]);dd.append(dd[-1])
                axes[0,column].step(times,values,where='post',label=name,color=color);axes[1,column].step(times,dd,where='post',color=color)
            plot(cash,label,['#3574aa','#2b8f70','#8856a7'][index])
            if index==0:plot(reference,'Market guard disabled, 45s','#c77c30')
        for ax in axes[:,column]:ax.grid(alpha=.2);ax.set_xlim(stamp(start),stamp(through));ax.xaxis.set_major_formatter(md.DateFormatter('%d %b'))
        axes[0,column].set_title('Base pool / no publication delay' if column==0 else 'Pool +5s / proceeds -25% / publication +180s');axes[0,column].legend(fontsize=8)
        axes[1,column].set_xlabel('UTC, recorded-clock support only')
    axes[0,0].set_ylabel('Cumulative simulated ETH');axes[1,0].set_ylabel('Cumulative drawdown ETH')
    fig.suptitle('Locked training candidates on later recorded timing, diagnostic only\nKnown flat start on 8 Sep; comparable prefix ends before unresolved evidence')
    fig.savefig(report/'recorded-clock-lines.png',dpi=160);plt.close(fig)
    write_json(report/'recorded-clock-prefix.json',{'diagnosticOnly':True,'selection':'Candidates locked using fixed-clock training. This chart does not refit using later results. Accounts start flat at the first supported recorded-clock launch.','rows':all_rows});return all_rows

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--engine-root',required=True);a=p.parse_args();render(a.root,a.engine_root)
