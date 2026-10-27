"""Aggregate frozen scorecards with training-only nominations and paired stress checks."""
import argparse
import gzip
import collections
import copy
import json
import itertools
import re
import tarfile
from pathlib import Path
from research.core.data import read_json, write_json

CUTOFFS = ['train3', 'train5', 'train7']
NEXT = dict(train3='eval4-5', train5='eval6-7', train7='eval8-9')
BASELINE = dict(n=10, m=5, off=-2, freshOn=1, fullOn=2, ageMs=10800000, mode='both')
PATTERN = re.compile(r'^(fixed|corrected)-memory(\d+)-(.+)-(\d+)\.json(?:\.gz)?$')

def policy_key(policy):
    return json.dumps({k:v for k,v in policy.items() if k!='id'}, sort_keys=True, separators=(',',':'))

def key_for(policy, lane, memory, exit_name):
    return json.dumps([policy_key(policy),lane,memory,exit_name],separators=(',',':'))

def metric(values):
    return dict(net=min(x['net'] for x in values),dd=max(x['dd'] for x in values),
                recoveryLoss=max(x['recoveryLoss'] for x in values),
                losingRecoveries=max(x['losingRecoveries'] for x in values),
                tradesMin=min(x['n'] for x in values),tradesMax=max(x['n'] for x in values))

def paired(values, baseline):
    b={x['id']:x for x in baseline}
    if set(b)!={x['id'] for x in values}:raise ValueError('Unmatched execution stresses')
    return dict(net=min(x['net']-b[x['id']]['net'] for x in values),
                dd=max(x['dd']-b[x['id']]['dd'] for x in values),
                recoveryLoss=max(x['recoveryLoss']-b[x['id']]['recoveryLoss'] for x in values),
                losingRecoveries=max(x['losingRecoveries']-b[x['id']]['losingRecoveries'] for x in values))

def improves(delta):
    return bool(delta) and delta['net']>1e-12 and all(delta[k]<=1e-12 for k in ['dd','recoveryLoss','losingRecoveries'])

def nominate(rows, cutoff, expected):
    # Evaluation outcomes never enter the nomination order or eligibility check.
    available=[r for r in rows if r['fitEligible'].get(cutoff,0)==expected and r['periods'].get(cutoff,{}).get('completeScenarios')==expected]
    order=lambda r:(-r['periods'][cutoff]['net'],r['periods'][cutoff]['dd'],r['periods'][cutoff]['recoveryLoss'],r['periods'][cutoff]['losingRecoveries'],r['key'])
    available.sort(key=order)
    admissible=[r for r in available if r['deltas'].get(cutoff,{}).get('completeScenarios')==expected and improves(r['deltas'][cutoff])]
    choice=admissible[0] if admissible else available[0] if available else None
    risk=sorted([r for r in available if r['deltas'].get(cutoff,{}).get('completeScenarios')==expected and r['deltas'][cutoff]['dd']< -1e-12],key=lambda r:(r['periods'][cutoff]['dd'],-r['periods'][cutoff]['net'],r['key']))
    return dict(eligible=len(available),trainingRiskGatePasses=len(admissible),choice=choice,
                lowerDrawdownAlternative=risk[0] if risk else None,ranked=available[:30])

def merge_metric(target, source):
    target['completeScenarios']=target.get('completeScenarios',0)+1
    for name,value in source.items():
        if name in ['net','tradesMin']:target[name]=min(target.get(name,value),value)
        else:target[name]=max(target.get(name,value),value)

def joint_clock_rows(rows):
    """Execution-clock assumptions are stresses, never selectable policies."""
    indexed={row['key']:row for row in rows};combined=[]
    def worst(left,right):
        if not left or not right:return {'completeScenarios':0}
        result={}
        for key in set(left)&set(right):
            combine=min if key in ['net','tradesMin','completeScenarios'] else max
            result[key]=combine(left[key],right[key])
        return result
    for row in rows:
        if row['lane']!='fixed':continue
        companion=indexed.get(key_for(row['policy'],'corrected',row['memory'],row['exit']))
        value=copy.deepcopy(row);value['selectionClocks']=['fixed','corrected']
        value['fitEligible']={cutoff:min(row['fitEligible'].get(cutoff,0),
            companion['fitEligible'].get(cutoff,0) if companion else 0) for cutoff in CUTOFFS}
        for field in ['periods','deltas']:
            value[field]={period:worst(metrics,companion[field].get(period) if companion else None)
                          for period,metrics in row[field].items()}
        combined.append(value)
    return combined

def score_files(root, archive=None, archive_prefix=None):
    if archive:
        with tarfile.open(archive,'r|gz') as bundle:
            for member in bundle:
                path=Path(member.name.removeprefix('./'))
                if archive_prefix:
                    try:path=path.relative_to(archive_prefix)
                    except ValueError:continue
                parts=path.parts
                if member.isfile() and len(parts)==5 and parts[0]=='scenarios' and parts[2]=='scores' and PATTERN.match(path.name):
                    stream=bundle.extractfile(member)
                    yield parts[1],path,json.load(gzip.GzipFile(fileobj=stream) if path.suffix=='.gz' else stream)
    else:
        for folder in sorted((root/'scenarios').glob('pool-*-pub*')):
            for path in sorted((folder/'scores').glob('*/*.json*')):
                if PATTERN.match(path.name):yield folder.name,path,read_json(path)

def aggregate(root, archive=None, archive_prefix=None, fixed_clock_diagnostic=False):
    root=Path(root);report=root/'report';report.mkdir(exist_ok=True)
    scope_path=root/'comparison-scope.json'
    scope=read_json(scope_path) if scope_path.exists() else None
    selected=set(scope['scenarios']) if scope else None
    if scope and (not selected or len(selected)!=len(scope['scenarios'])):
        raise ValueError('Comparison scope must contain distinct scenarios')
    completed_scope={name for name in selected or [] if (root/'scenarios'/name/'scenario-complete.json').is_file()}
    scope_complete=selected is None or completed_scope==selected
    global_rows={};counts=[];per_scenario_leaders=[]
    summaries=read_json(root/'scenario-summary.json')['completed'] if (root/'scenario-summary.json').exists() else []
    summaries={s['scenario']:s['summary'] for s in summaries}
    for scenario,files in itertools.groupby(score_files(root,archive,archive_prefix),key=lambda item:item[0]):
        if selected is not None and scenario not in selected:continue
        local={};stages=collections.Counter();distinct=collections.defaultdict(set)
        for _,path,data in files:
            match=PATTERN.match(path.name)
            if not match or path.parent.name=='coverage-preflight':continue
            lane,memory,exit_name,_=match.groups();memory=int(memory);stage=path.parent.name
            if fixed_clock_diagnostic and lane!='fixed':continue
            for row in data['results']:
                stages[stage]+=1;distinct[stage].add(policy_key(row['policy']))
                key=key_for(row['policy'],lane,memory,exit_name)
                fit=set(CUTOFFS) if stage=='core' else {c for c in CUTOFFS if stage.startswith(c+'-')}
                if key in local:
                    if local[key]['rawPeriods']!=row['periods']:raise ValueError('Different results for identical candidate inputs')
                    local[key]['fit'].update(fit)
                    continue
                local[key]=dict(key=key,policy=row['policy'],lane=lane,memory=memory,exit=exit_name,
                                rawPeriods=row['periods'],fit=fit)
        complete_training={lane:{cutoff:sum(row['lane']==lane and cutoff in row['fit'] and
            all(v['complete'] for v in row['rawPeriods'][cutoff]) for row in local.values()) for cutoff in CUTOFFS}
            for lane in ['fixed','corrected']}
        counts.append(dict(scenario=scenario,scorecards=sum(stages.values()),uniqueComparisons=len(local),completeTrainingByClock=complete_training,
                           stages={s:dict(scorecards=n,uniquePolicies=len(distinct[s])) for s,n in stages.items()},
                           pipelineSummary=summaries.get(scenario)))
        for key,row in local.items():
            g=global_rows.setdefault(key,{k:row[k] for k in ['key','policy','lane','memory','exit']})
            g.setdefault('seenScenarios',0);g['seenScenarios']+=1
            fit=g.setdefault('fitEligible',{});periods=g.setdefault('periods',{});deltas=g.setdefault('deltas',{})
            base=local.get(key_for(BASELINE,row['lane'],20,'hold-45'))
            for cutoff in row['fit']:fit[cutoff]=fit.get(cutoff,0)+1
            for period,values in row['rawPeriods'].items():
                if not values or not all(v['complete'] for v in values):continue
                merge_metric(periods.setdefault(period,{}),metric(values))
                if base and all(v['complete'] for v in base['rawPeriods'][period]):
                    merge_metric(deltas.setdefault(period,{}),paired(values,base['rawPeriods'][period]))
        for cutoff in CUTOFFS:
            eligible=[r for r in local.values() if cutoff in r['fit'] and all(v['complete'] for v in r['rawPeriods'][cutoff])]
            if eligible:
                leader=min(eligible,key=lambda r:(-metric(r['rawPeriods'][cutoff])['net'],metric(r['rawPeriods'][cutoff])['dd'],r['key']))
                per_scenario_leaders.append(dict(scenario=scenario,cutoff=cutoff,policy=leader['policy'],lane=leader['lane'],memory=leader['memory'],exit=leader['exit'],training=metric(leader['rawPeriods'][cutoff])))
        print(json.dumps({'scenario':scenario,'scorecards':sum(stages.values()),'uniqueComparisons':len(local)}),flush=True)
    rows=list(global_rows.values()) if fixed_clock_diagnostic else joint_clock_rows(list(global_rows.values()))
    expected=len(selected) if selected is not None else 27;nominations={}
    for cutoff in CUTOFFS:
        nomination=nominate(rows if scope_complete else [],cutoff,expected);choice=nomination['choice'];assessment={}
        if choice:
            for period in [NEXT[cutoff],'later','reserved6h']:
                delta=choice['deltas'].get(period,{})
                assessment[period]=dict(completeScenarios=delta.get('completeScenarios',0),expected=expected,
                    passesEveryStress=delta.get('completeScenarios')==expected and improves(delta),pairedWorstDifference=delta)
            # Neighbors differ in exactly one numeric policy coordinate and retain the same exit family.
            neighboring=[];numeric=['n','m','off','freshOn','fullOn','ageMs']
            for coordinate in numeric:
                held={k:v for k,v in choice['policy'].items() if k not in ['id',coordinate]}
                matches=[r for r in rows if (r['lane'],r['memory'],r['exit'])==(choice['lane'],choice['memory'],choice['exit']) and {k:v for k,v in r['policy'].items() if k not in ['id',coordinate]}==held and coordinate in r['policy']]
                current=choice['policy'].get(coordinate)
                if current is None:continue
                for sign in [-1,1]:
                    side=[r for r in matches if (r['policy'][coordinate]-current)*sign>0]
                    if side:
                        neighbor=min(side,key=lambda r:abs(r['policy'][coordinate]-current))
                        if neighbor['fitEligible'].get(cutoff)==expected:
                            delta=neighbor['deltas'].get(NEXT[cutoff],{})
                            neighboring.append(dict(policy=neighbor['policy'],coordinate=coordinate,
                                complete=delta.get('completeScenarios')==expected,improves=delta.get('completeScenarios')==expected and improves(delta)))
            assessment['neighbors']=dict(tested=len(neighboring),complete=sum(n['complete'] for n in neighboring),
                improving=sum(n['improves'] for n in neighboring),majoritySupported=bool(neighboring) and sum(n['improves'] for n in neighboring)>len(neighboring)/2,settings=neighboring)
            companion=global_rows.get(key_for(choice['policy'],'corrected',choice['memory'],choice['exit']))
            assessment['precedingClockCompanion']=dict(periods=companion['periods'],deltas=companion['deltas']) if companion else None
        nomination['evaluation']=assessment;nominations[cutoff]=nomination
    result=dict(diagnosticOnly=True,validatedReplacement=False,expectedScenarios=expected,
                originalExpectedScenarios=27,comparisonScope=scope,
                requiredScopeComplete=scope_complete,completedScopeScenarios=sorted(completed_scope),
                fixedClockDiagnostic=fixed_clock_diagnostic,
                scenarioDirectories=len(counts),counts=counts,perScenarioTrainingLeaders=per_scenario_leaders,
                nominations=nominations,uniqueCandidateComparisons=len(global_rows),jointClockCandidates=len(rows),
                selection='Training-only nomination uses the worse fixed/preceding-clock result across supported scenarios. '
                'Clock assumptions cannot win by being selected as a policy. Later and reserved outcomes are assessments, never replacement-selection inputs.')
    if fixed_clock_diagnostic:
        result['selection']='Exploratory fixed-clock training nomination across all five selected pool/publication scenarios. The preceding-clock lane has no September 1–7 coverage and cannot participate in fitting. Its later-period checks must be reported separately. This does not replace the failed joint-clock qualification or validate earnings.'
    write_json(report/('fixed-clock-diagnostic-ranking.json' if fixed_clock_diagnostic else 'cross-scenario-ranking.json'),result)
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--archive');parser.add_argument('--archive-prefix');parser.add_argument('--fixed-clock-diagnostic',action='store_true');args=parser.parse_args()
    result=aggregate(args.root,args.archive,args.archive_prefix,args.fixed_clock_diagnostic)
    print(json.dumps({'scenarios':result['scenarioDirectories'],'uniqueCandidates':result['uniqueCandidateComparisons'],
        'trainingEligible':{k:v['eligible'] for k,v in result['nominations'].items()}}))
