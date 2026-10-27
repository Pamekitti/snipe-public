"""Require archived integer execution parity, then report actual-cash prediction errors."""
import argparse,collections,json,copy
from pathlib import Path
from research.core.expanded_sample import quote_interval
from research.core.shared_execution import ExecutionWorker
from research.core.unified_fidelity import matched_score

def run(inputs,out):
 inputs,out=Path(inputs),Path(out);out.mkdir(parents=True,exist_ok=True)
 read=lambda p:json.loads(Path(p).read_text())
 requests=read(inputs/'requests.json');rows=read(inputs/'rows.json');expected=read(inputs/'reference.json')['results'];values=[]
 with ExecutionWorker() as w:
  identity=w.call('identity')
  for offset in range(0,len(requests),40):
   batch=copy.deepcopy(requests[offset:offset+40])
   for q in batch:
    q['entryQuoteTokens']=str(quote_interval(q['minTokens'],5000)[0]);q['timing'].update(label='q5000-rank0.5-sell1200-after',buyOrderFraction=.5,sellMs=1200,sameTimeOrder='after')
   values.extend(w.call('predict',requests=batch))
 mismatches=[rows[i]['id'] for i,(a,b) in enumerate(zip(values,expected)) if a!=b]
 score=matched_score(rows,values)
 value={'modelHash':identity['modelHash'],'attempts':len(rows),'exactReferenceMismatches':mismatches,'calculationParity':len(values)==len(expected) and not mismatches,'actualCash':score,'diagnosticOnly':True,'certified':False}
 (out/'cash-fidelity.json').write_text(json.dumps(value,indent=2))
 print(json.dumps({'attempts':len(rows),'mismatches':len(mismatches),'diagnosticOnly':True}))
 if mismatches:raise ValueError('archived execution calculation parity failed')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--inputs',required=True);p.add_argument('--out',required=True);a=p.parse_args();run(a.inputs,a.out)
