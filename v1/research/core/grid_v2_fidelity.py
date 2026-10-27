"""Current-capture independent intent diagnostics; failures never become a certificate."""
import argparse,bisect,statistics,json
from pathlib import Path
from .data import read_json,write_json,digest,Worker,HOUR
from .evaluation import entry,context
from .execution import booked,receipt_gas,path_request,describe
from .fidelity import cash_metrics,cash_contrast
from .grid_v2_run import verify

def run(root):
 root=Path(root);m=verify(root);raw=read_json(root/'snapshot.json.gz');d=read_json(root/'dataset.json')
 positions=sorted([p for p in raw['bot_positions'] if p.get('live') and p.get('closed') and m['start']<=entry(p)<m['capture']],key=entry)
 prior=[]
 for p in raw['bot_positions']:
  if not p.get('live') or not p.get('closed') or not p.get('exit_at') or p['exit_at']>=m['reserved_start']:continue
  gas=int(p.get('proceeds_wei') or 0)-int(p['spend_wei'])-booked(p);buy=receipt_gas(d['receipts'].get(p.get('buy_hash')))
  if gas>=buy>0:prior.append(dict(at=p['exit_at'],gas=gas,buy=buy,open=max(0,(context(p).get('at') or entry(p))-entry(p))))
 prior.sort(key=lambda x:x['at']);times=[p['at'] for p in prior];rows=[]
 with Worker() as worker:
  for p in positions:
   previous=prior[:bisect.bisect_left(times,entry(p))][-100:]
   row=dict(id=p['id'],token=p['token'],entry=entry(p),actual_at=p['exit_at'],actual_wei=str(booked(p)),size=p['spend_wei'])
   if len(previous)<20:row['unavailable']='fewer_than_20_preceding_cost_samples';rows.append(row);continue
   median=lambda k:round(statistics.median(x[k] for x in previous))
   req,missing=path_request(d,p,median('gas'),lag=1200,poll=50)
   if missing:row['unavailable']=missing;rows.append(row);continue
   # Predicted costs and modeled open delay use preceding outcomes only. Actual fill
   # block and own filled token amount are deliberately absent from this prediction.
   req.pop('entryBlock',None);req.update(buyGasWei=str(median('buy')),buyAt=p.get('t_sent') or entry(p),openedAt=entry(p)+median('open'))
   result=worker.call(**req)
   row.update(result=result,calibration_latest=previous[-1]['at'])
   if result.get('status') in ('closed','buy_reverted'):
    row.update(predicted_wei=str(result['pnlWei']),predicted_at=result['exitAt'],error_pp=100*(int(result['pnlWei'])-booked(p))/int(p['spend_wei']))
   elif result.get('status')=='entry_price_rejected':row.update(predicted_wei='0',predicted_at=entry(p),error_pp=-100*booked(p)/int(p['spend_wei']))
   else:row['unavailable']=result.get('status','unknown')
   rows.append(row)
 def score(lo,hi):
  group=[r for r in rows if lo<=r['entry']<hi];known=[r for r in group if 'predicted_wei' in r]
  actual=[dict(id=r['id'],at=r['actual_at'],pnl=r['actual_wei']) for r in known]
  pred=[dict(id=r['id'],at=r['predicted_at'],pnl=r['predicted_wei']) for r in known]
  errors=[r['error_pp'] for r in known]
  return dict(n=len(group),known=len(known),missing=len(group)-len(known),signed_error_pp=describe(errors),absolute_error_pp=describe(abs(x) for x in errors),sign_agreement=sum((int(r['actual_wei'])>0)-(int(r['actual_wei'])<0)==(int(r['predicted_wei'])>0)-(int(r['predicted_wei'])<0) for r in known)/len(known) if known else None,contrast=cash_contrast(actual,pred,min((int(r['size']) for r in known),default=1)))
 limits=read_json(Path('research/BACKTEST_LIMITS_V1.json'))
 groups={label:score(lo,hi) for label,lo,hi in [('all',m['start'],m['capture']),('fit',m['start'],m['reserved_start']),('reserved',m['reserved_start'],m['capture']),('today',m['capture']//(24*HOUR)*(24*HOUR),m['capture'])]}
 checks=[]
 for label,g in groups.items():
  if label not in ('fit','reserved'):continue
  checks.extend([dict(name=label+'_sample',passed=g['known']>=limits['min_fit_attempts' if label=='fit' else 'min_reserved_attempts']),dict(name=label+'_coverage',passed=g['missing']==0),dict(name=label+'_sign',passed=g['sign_agreement'] is not None and g['sign_agreement']>=limits['min_sign_agreement'])])
  for field,stat,limit,absolute in [('signed_error_pp','mean','max_absolute_bias_pp',True),('absolute_error_pp','mean','max_mean_absolute_error_pp',False),('absolute_error_pp','median','max_median_absolute_error_pp',False),('absolute_error_pp','p95','max_p95_absolute_error_pp',False)]:
   v=g[field][stat];checks.append(dict(name=label+'_'+limit,passed=v is not None and (abs(v) if absolute else v)<=limits[limit]))
 checks.extend([dict(name='whole_account_historical_era_fidelity',passed=False,reason='Current-policy counterfactual accounts do not reproduce all historical policy eras'),dict(name='receipt_wallet_residual_proof',passed=False,reason='Independent full wallet reconciliation not established by this diagnostic')])
 out=dict(status='diagnostic_only',historical_fidelity_passed=False,checks=checks,periods=groups,rows=rows,run_sha256=digest(root/'run.json'),dataset_sha256=digest(root/'dataset.json'),limits_sha256=digest(Path('research/BACKTEST_LIMITS_V1.json')))
 write_json(root/'cash-fidelity/fidelity.json',out)
 (root/'cash-fidelity/report.md').write_text('# Current-capture cash fidelity\n\nDiagnostic only. Independent intent results and every failed check are in fidelity.json. This is not a whole-account certificate.\n\n'+ '\n'.join('- '+c['name']+': '+('PASS' if c['passed'] else 'FAIL') for c in checks)+'\n')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);run(p.parse_args().root)
