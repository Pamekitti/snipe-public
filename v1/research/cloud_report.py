"""Render the frozen cloud experiment without promoting diagnostic cash predictions."""
import os
os.environ.setdefault('DOTENV_CONFIG_QUIET','true')
import argparse,datetime as dt,json,sqlite3,statistics,subprocess,collections
from pathlib import Path
from cloud_report_supplement import supplement
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as md

def run(root,inputs):
 root,inputs=Path(root),Path(inputs);report=root/'report';report.mkdir(exist_ok=True)
 read=lambda p:json.loads(Path(p).read_text())
 status=read(root/'status.json') if (root/'status.json').exists() else {}
 scores=read(root/'all-scorecards.json') if (root/'all-scorecards.json').exists() else []
 coverage=read(root/'acquisition/coverage.json') if (root/'acquisition/coverage.json').exists() else {}
 summary=read(root/'comparison-summary.json') if (root/'comparison-summary.json').exists() else {}
 utc=lambda t:dt.datetime.fromtimestamp(t/1000,dt.timezone.utc)
 manifest=read(root/'input-manifest.json') if (root/'input-manifest.json').exists() else {}
 start,end=manifest.get('start',1788220800000),manifest.get('through',1789313400000)
 db=sqlite3.connect(f'file:{inputs}/bot.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
 actual=[dict(r) for r in db.execute('SELECT id,exit_at,onchain_pnl_wei,COALESCE(onchain_pnl_wei,pnl_wei) cash FROM positions WHERE live=1 AND closed=1 AND exit_at>=? AND exit_at<? ORDER BY exit_at,id',(start,end))];db.close()
 cash_proof={'completedRecords':len(actual),'receiptReconciled':sum(r['onchain_pnl_wei'] is not None for r in actual),'bookOnly':sum(r['onchain_pnl_wei'] is None and r['cash'] is not None for r in actual),'cashUnavailable':sum(r['cash'] is None for r in actual)}
 if (inputs/'fidelity/requests.json').exists():cash_proof['intentEvidence']=dict(collections.Counter(r.get('provenance',{}).get('kind','unavailable') for r in read(inputs/'fidelity/requests.json')))
 (report/'cash-source-coverage.json').write_text(json.dumps(cash_proof,indent=2))
 cash=0;real=[(start,0)]
 for r in actual:
  if r['cash'] is not None:cash+=int(r['cash'])/1e18;real.append((r['exit_at'],cash))
 def line(ax,rows,label,color):
  ax.step([utc(t) for t,_ in rows],[v for _,v in rows],label=label,color=color,lw=1.4,where='post',linestyle='--' if 'simulation' in label.lower() or 'off' in label.lower() else '-')
 def style(ax,ylabel):
  ax.set_xlim(utc(start),utc(end));ax.set_ylabel(ylabel);ax.grid(alpha=.2);ax.xaxis.set_major_formatter(md.DateFormatter('%d Sep',tz=dt.timezone.utc));ax.legend(loc='best',fontsize=9)
 fig,axs=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained');line(axs[0],real,'Actual booked cash','#26364a');peak=0;dd=[]
 for t,c in real:peak=max(peak,c);dd.append((t,peak-c))
 line(axs[1],dd,'Actual cumulative drawdown','#ba3f46');style(axs[0],'Net ETH');style(axs[1],'Drawdown ETH');fig.suptitle('September actual cash, shown separately from simulation');fig.savefig(report/'actual-cash.png',dpi=160);plt.close(fig)
 ranked=[]
 for r in scores:
  s=r['periods']['train7']
  if all(v['complete'] for v in s):ranked.append(r)
 ranked.sort(key=lambda r:(-min(s['net'] for s in r['periods']['train7']),max(s['dd'] for s in r['periods']['train7']),r['policy']['id']))
 # Preserve every scorecard; this list is a training ordering, never a live recommendation.
 (report/'ranked-training.json').write_text(json.dumps(ranked[:100],indent=2))
 if scores:
  points=[r for r in scores if r['lane']=='fixed' and r['exit']=='hold-45' and r['memory']==20]
  import numpy as np
  families=['freshBrake','minNewOutcomes','cooldownMs','halfLifeMs','positiveCap','participation']
  plain=[r for r in points if not any(k in r['policy'] for k in families) and r['policy']['mode']=='both']
  panels=[('Main vs fresh window','n','m',{'off':-2,'freshOn':1,'fullOn':2,'ageMs':10800000}),('Brake vs fresh recovery','off','freshOn',{'n':10,'m':5,'fullOn':2,'ageMs':10800000}),('Evidence age vs full recovery','ageMs','fullOn',{'n':10,'m':5,'off':-2,'freshOn':1})]
  fig,axs=plt.subplots(1,3,figsize=(16,5),layout='constrained')
  matrices=[]
  for title,x,y,held in panels:
   rows=[r for r in plain if all(r['policy'][k]==v for k,v in held.items())]
   xs=sorted({r['policy'][x] for r in rows});ys=sorted({r['policy'][y] for r in rows});grid=np.full((len(ys),len(xs)),np.nan)
   for r in rows:
    if all(s['complete'] for s in r['periods']['train7']):grid[ys.index(r['policy'][y]),xs.index(r['policy'][x])]=min(s['net'] for s in r['periods']['train7'])
   matrices.append((title,x,y,xs,ys,grid))
  known=[abs(v) for *_,grid in matrices for v in grid.flatten() if np.isfinite(v)];bound=max(known or [1]) or 1
  for ax,(title,x,y,xs,ys,grid) in zip(axs,matrices):
   if xs and ys:
    im=ax.imshow(grid,origin='lower',aspect='auto',cmap='RdBu',vmin=-bound,vmax=bound)
    ax.set_xticks(range(len(xs)),[f'{v/60000:g}' if x=='ageMs' else str(v) for v in xs]);ax.set_yticks(range(len(ys)),[str(v) for v in ys])
    for j in range(len(ys)):
     for i in range(len(xs)):ax.text(i,j,f'{grid[j,i]:.2f}' if np.isfinite(grid[j,i]) else 'NA',ha='center',va='center',fontsize=7)
   else:ax.text(.5,.5,'No matching complete candidates',ha='center',va='center',transform=ax.transAxes)
   ax.set_title(title);ax.set_xlabel('Age (minutes)' if x=='ageMs' else x);ax.set_ylabel(y)
  if known:fig.colorbar(im,ax=list(axs),label='Worst-scenario training net ETH')
  fig.suptitle('Controlled parameter slices, 45-second exit; other settings held at 10/5 baseline')
  fig.savefig(report/'parameter-grid.png',dpi=160);plt.close(fig)
 # Detailed cumulative lines use the actual shared account reducer, not aggregated scorecards.
 chosen=[]
 accounts=read(root/'account-manifest.json')['inputs'] if (root/'account-manifest.json').exists() else []
 base=next((i for i in accounts if i['lane']=='fixed' and i['memory']==20 and i['exit']=='hold-45'),None)
 if base:chosen.append(('10/5 baseline',base,{'id':'conservative-10-5','n':10,'m':5,'off':-2,'freshOn':1,'fullOn':2,'ageMs':10800000,'mode':'both'}))
 if ranked:
  top=ranked[0];item=next(i for i in accounts if i['lane']==top['lane'] and i['memory']==top['memory'] and i['exit']==top['exit']);chosen.append(('Training leader (diagnostic)',item,top['policy']))
 risk_candidates=[r for r in ranked if sum(s['n'] for s in r['periods']['train7'])>0 and min(s['net'] for s in r['periods']['train7'])>=0]
 if risk_candidates:
  risk=min(risk_candidates,key=lambda r:(max(s['dd'] for s in r['periods']['train7']),-min(s['net'] for s in r['periods']['train7']),r['policy']['id']))
  if not ranked or (risk['policy'],risk['exit'],risk['lane'],risk['memory'])!=(ranked[0]['policy'],ranked[0]['exit'],ranked[0]['lane'],ranked[0]['memory']):
   item=next(i for i in accounts if i['lane']==risk['lane'] and i['memory']==risk['memory'] and i['exit']==risk['exit']);chosen.append(('Training risk alternative (diagnostic)',item,risk['policy']))
 baseline_score=next((r for r in scores if r['lane']=='fixed' and r['exit']=='hold-45' and r['memory']==20 and all(r['policy'].get(k)==v for k,v in {'n':10,'m':5,'off':-2,'freshOn':1,'fullOn':2,'ageMs':10800000,'mode':'both'}.items()) and not any(k in r['policy'] for k in ['freshBrake','minNewOutcomes','cooldownMs','halfLifeMs','positiveCap','participation'])),None)
 decision={'status':'diagnostic_only','validatedReplacement':False,'trainingChoice':ranked[0]['policy'] if ranked else None,'assessments':{},'reason':'No complete training candidate' if not ranked else 'Cash fidelity failed; assess the training choice without searching the reserved period for replacements'}
 if ranked and baseline_score:
  for period in ['later','reserved6h','all']:
   a,b=ranked[0]['periods'][period],baseline_score['periods'][period];complete=all(s['complete'] for s in a+b)
   decision['assessments'][period]={'complete':complete,'higherNetInEveryScenario':complete and all(x['net']>y['net'] for x,y in zip(a,b)),'noWorseDrawdown':complete and all(x['dd']<=y['dd'] for x,y in zip(a,b)),'noWorseRecoveryLoss':complete and all(x['recoveryLoss']<=y['recoveryLoss'] for x,y in zip(a,b)),'noMoreLosingRecoveries':complete and all(x['losingRecoveries']<=y['losingRecoveries'] for x,y in zip(a,b))}
 (report/'decision.json').write_text(json.dumps(decision,indent=2))
 runs=[];account_audits=[]
 for label,info,policy in chosen:
  obj=read(info['path']);obj['policy']=policy
  response=subprocess.run(['node','--import','tsx','scripts/execution-worker.ts'],input=json.dumps({'op':'scenario-accounts','input':obj}),text=True,capture_output=True,check=True)
  result=json.loads(response.stdout)['result'];runs.append((label,result));
  metadata={o['id']:o for o in obj['opportunities']}
  faults=[]
  for scenario in result['continuous']:
   ids=scenario['metrics']['unavailable']
   for identity in ids:
    o=metadata.get(identity)
    faults.append({'scenario':scenario['id'],'id':identity,'at':o['at'] if o else None,'availableAt':o['availableAt'] if o else None,'reasons':o['bundle']['unavailable'] if o else 'account gap'})
  account_audits.append({'label':label,'guardReasons':dict(collections.Counter(r['reason'] for r in result['readings'])),'openChecks':sum(r['state']=='open' for r in result['readings']),'totalChecks':len(result['readings']),'shadowUnknowns':faults,'publicationMoreThanThreeHoursAfterEntry':sum(o['availableAt']-o['at']>10800000 for o in obj['opportunities']),'opportunities':len(obj['opportunities'])})
  (report/(['baseline-lines.json','leader-lines.json','risk-lines.json'][len(runs)-1])).write_text(json.dumps(result))
 (report/'account-evidence-audit.json').write_text(json.dumps(account_audits,indent=2))
 if runs:
  fig,axs=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained')
  retained=[]
  for k,(label,result) in enumerate(runs):
   a=result['accounts'][3];points=[(start,0)]+[(c['t'],int(c['cashWei'])/1e18) for c in a['policy']['cash']];
   if not a['policy']['cash']:points.append((end,0))
   line(axs[0],points,label+(' (incomplete)' if not a['selected']['complete'] else ''),['#3574aa','#2b8f70','#8064a2'][k]);peak=0;dd=[]
   for t,c in points:peak=max(peak,c);dd.append((t,peak-c))
   line(axs[1],dd,label,['#3574aa','#2b8f70','#8064a2'][k]);retained.append({'label':label,'winningMoneyRetained':a['retention']['winningMoneyRetained'],'losingMoneyRetained':a['retention']['losingMoneyRetained'],'complete':a['selected']['complete'] and a['reference']['complete'] and all(c['metrics']['complete'] for c in result['continuous'])})
   if k==0:
    reference_points=[(start,0)]+[(c['t'],int(c['cashWei'])/1e18) for c in a['marketOff']['cash']]
    line(axs[0],reference_points,'Market guard off'+(' (incomplete)' if not a['reference']['complete'] else ''),'#bd8841')
    refpeak=0;refdd=[]
    for t,c in reference_points:refpeak=max(refpeak,c);refdd.append((t,refpeak-c))
    line(axs[1],refdd,'Market guard off'+(' (incomplete)' if not a['reference']['complete'] else ''),'#bd8841')
    if not a['selected']['cash']:axs[0].text(.5,.92,'Baseline admits no trades because usable shadow history never warms up.',ha='center',transform=axs[0].transAxes,fontsize=10)
    if not a['reference']['complete']:
     for ax in axs:ax.axvline(utc(reference_points[-1][0]),color='#bd8841',ls=':',alpha=.7)
     axs[1].text(.5,.92,'Reference ends at unresolved execution. The remaining period is unavailable.',ha='center',transform=axs[1].transAxes,fontsize=10)
  style(axs[0],'Simulated net ETH');style(axs[1],'Cumulative drawdown ETH');fig.suptitle('Diagnostic simulation, median sell delay and after-order scenario');fig.savefig(report/'simulation-lines.png',dpi=160);plt.close(fig)
  fig,ax=plt.subplots(figsize=(10,4),layout='constrained')
  for i,r in enumerate(retained):
   for j,key in enumerate(['winningMoneyRetained','losingMoneyRetained']):
    v=r[key] if r['complete'] else None
    if v is None:ax.text(i*3+j,50,'Unavailable',ha='center',va='center',fontsize=11)
    else:ax.bar(i*3+j,v*100,color=['#3574aa','#c77c30'][j],hatch=['','//'][j],label=['Winning money','Losing money'][j] if i==0 else None)
  from matplotlib.patches import Patch
  ax.legend(handles=[Patch(facecolor='#3574aa',label='Winning money'),Patch(facecolor='#c77c30',hatch='//',label='Losing money')]);ax.set_ylim(0,max([100]+[100*r[k]*1.1 for r in retained if r['complete'] for k in ['winningMoneyRetained','losingMoneyRetained'] if r[k] is not None]));ax.set_xticks([i*3+.5 for i in range(len(retained))],[r['label'] for r in retained]);ax.set_xlim(-.6,(len(retained)-1)*3+1.6);ax.set_ylabel('Money retained (%)');ax.set_title('Winning money (solid) and losing money (hatched), matching-exit reference');fig.savefig(report/'retention.png',dpi=160);plt.close(fig)
  fixed=runs[0][1]['accounts'][3]['reference']
  for r,(_,result) in zip(retained,runs):
   selected=result['accounts'][3]['selected']
   for title,key in [('fixedWinningMoneyRetained','profitWei'),('fixedLosingMoneyRetained','lossWei')]:
    denominator=int(fixed[key]);r[title]=int(selected[key])/denominator if denominator and selected['complete'] and fixed['complete'] else None
   matching=result['accounts'][3]['reference']
   r['profitMissedEth']=(int(matching['profitWei'])-int(selected['profitWei']))/1e18 if selected['complete'] and matching['complete'] else None
   r['lossesAvoidedEth']=(int(matching['lossWei'])-int(selected['lossWei']))/1e18 if selected['complete'] and matching['complete'] else None
  (report/'retention.json').write_text(json.dumps(retained,indent=2))
  baseline=runs[0][1];today=end//86400000*86400000
  readings=[r for r in baseline['readings'] if today<=r['at']<end]
  fig,axs=plt.subplots(2,1,figsize=(13,7),sharex=True,layout='constrained')
  for key,label,color in [('sumRange','Main 10 raw outcomes, may be stale','#3574aa'),('recentSumRange','Fresh 5 raw outcomes, may be stale','#aa6b24')]:
   axs[0].plot([utc(r['at']) for r in readings],[r[key][0] if r[key] and all(s['n']>=10 if key=='sumRange' else s['recentN']>=5 for s in r['scenarios']) else float('nan') for r in readings],label=label,color=color,lw=1)
  axs[0].axhline(-2,color='#ba3f46',ls='--',lw=.8,label='Main brake < -2');axs[0].axhline(2,color='#3574aa',ls=':',lw=.8,label='Main recovery > +2');axs[0].axhline(1,color='#aa6b24',ls=':',lw=.8,label='Fresh recovery > +1')
  a=baseline['accounts'][3];intraday=[c for c in a['selected']['cash'] if today<=c['at']<end]
  if intraday:axs[1].scatter([utc(c['at']) for c in intraday],[int(c['pnlWei'])/1e18 for c in intraday],facecolors='none',edgecolors='#3574aa',s=30,label='Modeled trade closure')
  actual_today=[r for r in actual if today<=r['exit_at']<end and r['cash'] is not None]
  axs[1].scatter([utc(r['exit_at']) for r in actual_today],[int(r['cash'])/1e18 for r in actual_today],c=['#2b8f70' if int(r['cash'])>0 else '#ba3f46' for r in actual_today],marker='x',s=25,label='Actual booked trade closure')
  if readings and all(r['state']=='shut' for r in readings):
   axs[0].text(.5,.92,'No entry-authorizing evidence. Visible raw sums remain stale or incomplete.',ha='center',transform=axs[0].transAxes,fontsize=9)
   axs[1].text(.5,.92,'No simulated entries. Crosses show actual trades at their historical stakes.',ha='center',transform=axs[1].transAxes,fontsize=9)
  last='shut'
  for r in readings:
   if r['state']!=last:
    for ax in axs:ax.axvline(utc(r['at']),color='#2b8f70' if r['state']=='open' else '#ba3f46',alpha=.25,lw=.7)
   last=r['state']
  style(axs[0],'Stakes');style(axs[1],'Trade net ETH')
  for ax in axs:
   ax.set_xlim(utc(today),utc(end));ax.xaxis.set_major_formatter(md.DateFormatter('%H:%M',tz=dt.timezone.utc))
  fig.suptitle('September 13 UTC: replayed shadow evidence and actual trade outcomes');fig.savefig(report/'intraday-indicator.png',dpi=160);plt.close(fig)
  opportunities=a['unrestricted'];net=0;unrestricted=[]
  for c in sorted(opportunities,key=lambda c:(c['at'],c['id'])):net+=int(c['pnlWei'])/1e18;unrestricted.append((c['at'],net))
  fig,ax=plt.subplots(figsize=(13,4),layout='constrained');line(ax,unrestricted,'Known unrestricted opportunities, excludes unavailable outcomes','#7f689e');style(ax,'Sum of opportunity net ETH');ax.set_title('Opportunity reference only: no account capacity or bankroll, not executable wallet cash');fig.savefig(report/'unrestricted-opportunities.png',dpi=160);plt.close(fig)
  def stats(values):return {'n':len(values),'netEth':sum(values),'mean':statistics.mean(values) if values else None,'median':statistics.median(values) if values else None,'sd':statistics.stdev(values) if len(values)>1 else None}
  bins=[]
  cash_series={'actual':[(r['exit_at'],int(r['cash'])/1e18) for r in actual if r['cash'] is not None]}
  for label,result in runs:cash_series[label]=[(c['at'],int(c['pnlWei'])/1e18) for c in result['accounts'][3]['selected']['cash']]
  complete_series={'actual':all(r['cash'] is not None for r in actual)}
  complete_series.update({label:result['accounts'][3]['selected']['complete'] and result['accounts'][3]['reference']['complete'] and all(c['metrics']['complete'] for c in result['continuous']) for label,result in runs})
  for window,hours,count in [('24h',24,8),('7d',168,7),('September daily',None,13)]:
   lower=end-hours*3600000 if hours else start;step=hours*3600000/count if hours else 86400000
   for b in range(count):
    lo=lower+b*step;hi=min(end,lo+step)
    bins.append({'window':window,'fromUtc':utc(lo).isoformat(),'throughUtc':utc(hi).isoformat(),'series':{name:{'complete':complete_series[name],'knownOutcomesOnly':not complete_series[name],**stats([v for t,v in values if lo<=t<hi])} for name,values in cash_series.items()}})
  (report/'period-bins.json').write_text(json.dumps(bins,indent=2))
 if (inputs/'fidelity/rows.json').exists() and (root/'verification/cash-fidelity.json').exists():
  proof=read(root/'verification/cash-fidelity.json')
  if proof.get('calculationParity'):
   labels=read(inputs/'fidelity/rows.json');prediction=read(inputs/'fidelity/reference.json')['results'];pairs=[(a,p) for a,p in zip(labels,prediction) if p['pnlWei'] is not None and a['actualWei'] is not None]
   realLine=[];modelLine=[];rnet=pnet=0
   for a,p in sorted(pairs,key=lambda ap:ap[0]['exitAt']):
    rnet+=int(a['actualWei'])/1e18;realLine.append((a['exitAt'],rnet))
   for a,p in sorted(pairs,key=lambda ap:ap[1]['exitAt']):
    pnet+=int(p['pnlWei'])/1e18;modelLine.append((p['exitAt'],pnet))
   fig,ax=plt.subplots(figsize=(13,4.5),layout='constrained');line(ax,realLine,'Actual, same matched attempts','#26364a');line(ax,modelLine,'Shared simulation, frozen 1,200 ms after-order scenario','#3574aa');style(ax,'Cumulative net ETH');ax.set_title(f'Actual-attempt fidelity: {len(pairs):,} matched, {len(labels)-len(pairs):,} unavailable; historical stakes');fig.savefig(report/'actual-versus-simulation.png',dpi=160);plt.close(fig)
 daily=[]
 for day in range(13):
  vals=[int(r['cash'])/1e18 for r in actual if r['cash'] is not None and start+day*86400000<=r['exit_at']<min(end,start+(day+1)*86400000)]
  daily.append({'utcDay':utc(start+day*86400000).date().isoformat(),'netEth':sum(vals),'n':len(vals),'mean':statistics.mean(vals) if vals else None,'median':statistics.median(vals) if vals else None,'sd':statistics.stdev(vals) if len(vals)>1 else None})
 (report/'actual-daily.json').write_text(json.dumps(daily,indent=2))
 lines=['# September cloud guard experiment','',f'Frozen period: {utc(start).isoformat()} through {utc(end).isoformat()}.','',f'Stage: {status.get("stage","unavailable")}. Completed scorecards: {len(scores):,}.', '', '**Diagnostic only. Cash fidelity has not passed. No live replacement is validated.**','',f'Actual booked cash: {cash:+.6f} ETH across {len(actual):,} completed records. This is separate from hypothetical current-configuration results.','',f'Launch coverage: {coverage.get("complete","unavailable")} complete source paths of {coverage.get("total","unavailable")}. Source coverage does not imply successful executable outcomes.','',f'Complete training rankings: {len(ranked):,}.', '', 'Missing executions remain unavailable and stop the affected account. A flat line after missing evidence is not an estimate of avoided losses. Historical publication timing is modeled. The corrected sell clock lacks earlier-period causal coverage. All inspected September data remains retrospective.','', '## Charts','']
 if scores and not ranked:
  lines[2:2]=['**No tested replacement is supported.** The completed core comparisons lack complete training evidence. The wider stages cannot select eligible training candidates. Policy profitability remains unresolved.','', 'The fixed-clock lane encounters missing compatible graduated-pool execution. The corrected-clock lane has no supported September 1 training start. Historical publication delays also prevent compatible shadow warmup. These limitations are recorded rather than filled with assumed profits or zero-valued trades.','']
 for name in ['actual-cash','actual-versus-simulation','simulation-lines','retention','parameter-grid','intraday-indicator','unrestricted-opportunities']:
  if (report/(name+'.png')).exists():lines+=['!['+name+']('+name+'.png)','']
 if runs:
  lines+=['## Money retention','', '| Candidate | Win retained, matching exit | Loss retained, matching exit | Win retained, fixed 45s | Loss retained, fixed 45s |', '| --- | ---: | ---: | ---: | ---: |']
  percent=lambda v:'Unavailable' if v is None else f'{100*v:.1f}%'
  for r in retained:
   vals=[r.get(k) if r['complete'] else None for k in ['winningMoneyRetained','losingMoneyRetained','fixedWinningMoneyRetained','fixedLosingMoneyRetained']]
   lines.append('| '+r['label']+' | '+' | '.join(percent(v) for v in vals)+' |')
  lines+=['', 'Profit missed and losses avoided are in retention.json. They compare executable accounts, so changed capacity can produce retention above 100% or negative missed profit.', '']
 if ranked:
  lines+=['## Training profit and risk ranking','', 'Training ordering only. Later and reserved periods were not used in this ordering. All cash predictions remain diagnostic.', '', '| Candidate | Clock / exit | N / M / mode | Brake / fresh / full | Age min | Training worst net ETH | Worst drawdown ETH | Later worst net ETH | Final 6h worst net ETH |', '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |']
  def periodvalue(row,key,metric,func):
   v=row['periods'][key]
   return f'{func(s[metric] for s in v):+.6f}' if all(s['complete'] for s in v) else 'Unavailable'
  for r in ranked[:15]:
   p=r['policy'];lines.append(f"| {p['id']} | {r['lane']} / {r['exit']} | {p['n']} / {p['m']} / {p['mode']} | {p['off']} / {p['freshOn']} / {p['fullOn']} | {p['ageMs']/60000:g} | {periodvalue(r,'train7','net',min)} | {periodvalue(r,'train7','dd',max)} | {periodvalue(r,'later','net',min)} | {periodvalue(r,'reserved6h','net',min)} |")
  lines.append('')
 if (root/'verification/standard-fidelity-grade.json').exists():
  grade=read(root/'verification/standard-fidelity-grade.json');checks=grade['verdict']['checks'];failed=[c for c in checks if not c['passed']]
  observed=read(root/'verification/cash-fidelity.json')['actualCash']
  lines+=['## Actual-attempt prediction errors','',f"Matched attempts: {observed['known']:,}; unavailable: {observed['missing']}. Profit/loss sign agreement: {100*observed['signAgreement']:.1f}%. False winners: {len(observed['falseWinners'])}.",'',f"The false winners earned {grade.get('falseWinnerPredictedEth',0):+.6f} ETH in simulation and {grade.get('falseWinnerActualEth',0):+.6f} ETH in actual cash. An overall pessimistic result does not prevent optimistic errors on individual trades.",'', '| Period | Matched / missing | False winners | Sign agreement | Mean absolute error, stake pp | Median | SD | n |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
  for name,c in grade.get('cohorts',{}).items():
   e=c['absoluteErrorPp'];lines.append(f"| {name} | {c['known']} / {c['missing']} | {len(c['falseWinners'])} | {100*c['signAgreement']:.1f}% | {e['mean']:.2f} | {e['median']:.2f} | {e['sd']:.2f} | {e['n']} |")
  lines.append('')
  lines+=['## Fidelity limits','',f'{len(failed)} of {len(checks)} unchanged fidelity checks failed or lacked required evidence. See verification/standard-fidelity-grade.json for every result. The intent replay does not establish whole-account fidelity.','']
 lines+=['## Account evidence blockers','', 'The baseline chart must not be interpreted as successful loss avoidance when no compatible shadow window was available. Missing pool execution and late recorded publication can prevent a historical account comparison. See account-evidence-audit.json for exact tokens, dates, reasons and publication counts.','']
 lines+=['## Cash and intent evidence','', '```json',json.dumps(cash_proof,indent=2),'```','', 'Book-only cash is retained in the actual booked line but is not receipt-reconciled. Reconstructed intent is not a captured pre-execution observation. The request provenance label prospective describes capture timing only; these inspected comparisons are retrospective and do not constitute new prospective validation.','']
 lines+=['## Training-choice assessment','', '```json',json.dumps(decision,indent=2),'```','']
 lines+=['## Remaining stages','', '```json',json.dumps(summary.get('stages',status),indent=2),'```','', 'The account reducer retains recorded non-market stop samples and explicit accounting resets. Missing control transitions and drawdown-recovery behavior require an independent account-fidelity verdict. Zero denominators and incomplete references are unavailable.']
 lines += ['', *supplement(root,scores,accounts)]
 (report/'findings.md').write_text('\n'.join(lines))
 print(json.dumps({'report':str(report),'scorecards':len(scores),'rankableTraining':len(ranked),'actualNetEth':cash}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--inputs',required=True);a=p.parse_args();run(a.root,a.inputs)
