"""Apply unchanged fidelity limits to the independently replayed frozen attempts."""
import json,hashlib
from pathlib import Path
from research.core.fidelity import grade,execution_windows,cash_contrast
from research.core.execution import describe
from research.core.unified_fidelity import matched_score
ROOT=Path('/work/results');INPUTS=Path('/work/inputs/fidelity');START=1788220800000;END=1789313400000
read=lambda p:json.loads(p.read_text())
proof=read(ROOT/'verification/cash-fidelity.json')
if not proof['calculationParity']:raise ValueError('Independent integer parity is required')
rows=read(INPUTS/'rows.json');predictions=read(INPUTS/'reference.json')['results']
if len(rows)!=len(predictions):raise ValueError('Attempt count mismatch')
graded=[dict(id=r['id'],entry=r['entryAt'],size=int(r['sizeWei']),actual_wei=r['actualWei'],actual_at=r['exitAt'],predicted_wei=p['pnlWei'],predicted_at=p['exitAt'],status=p['status']) for r,p in zip(rows,predictions)]
stake=min(r['size'] for r in graded if r['size']>0)
windows=execution_windows(graded,START,END,stake)
# Historical entry selection and initial wallet state are not reconstructed by an intent replay.
account={name:dict(complete=False,entry_precision=None,entry_recall=None,cash={key:None for key in ['gross_profit_relative_error','gross_loss_relative_error','net_error_stakes','drawdown_error_stakes','maximum_equity_gap_stakes']}) for name in ['current','fit','reserved6h']}
evidence=dict(receipt_accounting_complete=False,arithmetic_exact=None,historical_source_matches=False,calibration_is_causal=None,input_hashes_valid=None,account_engine_reproduces_saved_run=False,wallet_residual_wei=None,exit_reason_agreement=None,exit_time_error_ms=describe([]),exit_time_expected=len(rows),actual_failures=sum(not r['actualBuyAccepted'] for r in rows),failures_matched=sum(not r['actualBuyAccepted'] and p['pnlWei'] is not None and int(p.get('tokens') or 0)==0 for r,p in zip(rows,predictions)))
limits=read(Path('research/BACKTEST_LIMITS_V1.json'));verdict=grade(windows,account,evidence,limits)
sha=lambda p:hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
result=dict(verdict=verdict,execution=windows,account=account,evidence=evidence,referenceStakeWei=str(stake),limits=limits,hashes={str(p):sha(p) for p in [INPUTS/'rows.json',INPUTS/'reference.json',Path('research/BACKTEST_LIMITS_V1.json'),ROOT/'verification/cash-fidelity.json']},scope='Grading of the frozen intent reference after independent AWS replay; not a whole-account fidelity certificate',diagnosticOnly=True)
cohorts={}
for name,lo,hi in [('before_sep8',START,1788825600000),('sep8_onward',1788825600000,END)]:
 pairs=[(r,p) for r,p in zip(rows,predictions) if lo<=r['entryAt']<hi]
 cohorts[name]=matched_score([r for r,p in pairs],[p for r,p in pairs])
false_winners=[{'id':r['id'],'entryAt':r['entryAt'],'sizeWei':r['sizeWei'],'actualWei':r['actualWei'],'predictedWei':p['pnlWei']} for r,p in zip(rows,predictions) if p['pnlWei'] is not None and int(r['actualWei'])<0<int(p['pnlWei'])]
result.update(cohorts=cohorts,falseWinners=false_winners,falseWinnerActualEth=sum(int(r['actualWei']) for r in false_winners)/1e18,falseWinnerPredictedEth=sum(int(r['predictedWei']) for r in false_winners)/1e18)
(ROOT/'verification/standard-fidelity-grade.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'status':verdict['status'],'checks':len(verdict['checks']),'failed':sum(not c['passed'] for c in verdict['checks'])}))
