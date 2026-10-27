"""Assess locked fixed-clock nominees on the supported recorded-clock periods."""
import argparse,json,re
from pathlib import Path
from research.core.data import read_json,write_json
from research.bounded_rank import BASELINE,CUTOFFS,NEXT,PATTERN,policy_key,metric,paired,improves

def assess(root):
    root=Path(root);ranking=read_json(root/'report/fixed-clock-diagnostic-ranking.json')
    nominees={k:v['choice'] for k,v in ranking['nominations'].items() if v['choice']}
    if ranking['nominations']['train7']['ranked']:
        nominees['train7-profit']=ranking['nominations']['train7']['ranked'][0]
    required={(policy_key(BASELINE),20,'hold-45')}
    required.update((policy_key(v['policy']),v['memory'],v['exit']) for v in nominees.values())
    scenarios=read_json(root/'comparison-scope.json')['scenarios'];found={};coverage={}
    for scenario in scenarios:
        folder=root/'scenarios'/scenario;local={}
        manifest=read_json(folder/'account-manifest.json')
        covered=[x for x in manifest['inputs'] if x['lane']=='corrected']
        coverage[scenario]={'from':min(x['start'] for x in covered),'unavailablePrefixLaunches':max(x['unavailablePrefixLaunches'] for x in covered),'initialAccountAssumption':covered[0]['initialAccountAssumption']}
        for path in sorted((folder/'scores').glob('*/*.json*')):
            match=PATTERN.match(path.name)
            if not match or match[1]!='corrected' or path.parent.name=='coverage-preflight':continue
            _,memory,exit_name,_=match.groups();memory=int(memory)
            targets={k for k in required if k[1:]==(memory,exit_name) and k not in local}
            if not targets:continue
            for row in read_json(path)['results']:
                key=(policy_key(row['policy']),memory,exit_name)
                if key in targets:local[key]=row['periods']
            if required<=local.keys():break
        found[scenario]=local
    results={}
    for cutoff,nominee in nominees.items():
        key=(policy_key(nominee['policy']),nominee['memory'],nominee['exit']);results[cutoff]={}
        for scenario,rows in found.items():
            candidate=rows.get(key);baseline=rows.get((policy_key(BASELINE),20,'hold-45'));periods={}
            for period in [NEXT[cutoff.removesuffix('-profit')],'later','reserved6h']:
                values=candidate.get(period,[]) if candidate else [];reference=baseline.get(period,[]) if baseline else []
                complete=bool(values and reference) and all(v['complete'] for v in values+reference)
                periods[period]={'complete':complete,'candidate':metric(values) if complete else None,'baseline':metric(reference) if complete else None,'pairedDifference':paired(values,reference) if complete else None,'improvesEveryStress':improves(paired(values,reference)) if complete else None}
            results[cutoff][scenario]=periods
    result={'diagnosticOnly':True,'validatedReplacement':False,'selection':'Nominees locked using fixed-clock training only. Recorded-clock outcomes are assessed afterward without selecting a replacement from later returns.','coverage':coverage,'assessments':results}
    write_json(root/'report/supported-clock-assessment.json',result);return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);a=p.parse_args();assess(a.root)
