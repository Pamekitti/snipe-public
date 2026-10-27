"""Frozen September guard sweep using the shared account and execution engines."""
from pathlib import Path
from dataclasses import replace, asdict
from collections import Counter
import argparse
from datetime import datetime, timezone
from .data import read_json, write_json, digest, HOUR, DAY
from .long_history import ROOT, SOURCE, observations_for, external_controls, required_funding
from .indicator_study import configured_policy, trades_for, make_tapes
from .indicators import IndicatorGuard, SignalRule
from .september_guards import CreativeGuard, candidates
from .account import simulate
from .guard_visual import close_cash
from .fidelity import cash_metrics
from .evaluation import recovery_losses

OUT=Path('data/research/20260911-september-guards-v2')
START=int(datetime(2026,9,1,tzinfo=timezone.utc).timestamp()*1000)
FIT_END=int(datetime(2026,9,8,tzinfo=timezone.utc).timestamp()*1000)
SCENARIOS=[dict(name=f'{m}-{v}', mode=m, variant=v, delay=0, controls=False)
           for m in ('reconstructed_early','recorded') for v in ('adaptive','fast_sell','slow_sell')]
SCENARIOS += [dict(name=f'{m}-publication60s', mode=m, variant='adaptive', delay=60000, controls=False)
              for m in ('reconstructed_early','recorded')]
SCENARIOS += [dict(name='reconstructed_early-recorded_controls',mode='reconstructed_early',variant='adaptive',delay=0,controls=True)]


def sources():
    paths=[ROOT/'models.json',SOURCE,Path(__file__),Path(__file__).with_name('september_guards.py'),
           Path(__file__).with_name('account.py'),Path(__file__).with_name('indicators.py'),
           Path(__file__).with_name('indicator_study.py'),Path(__file__).with_name('long_history.py')]
    return {str(p):digest(p) for p in paths}


def freeze():
    raw=read_json(SOURCE)
    design=dict(start=START,end=raw['snapshot_at'],fit_end=FIT_END,reserved_start=raw['snapshot_at']-6*HOUR,
        candidates=[dict(asdict(r),name=r.name) for r in candidates()],scenarios=SCENARIOS,
        source_hashes=sources(), selection='One representative per family: maximum minimum training net across six primary scenarios among variants no worse than matched20 on training cumulative conditional DD and recovery loss/count in every primary scenario. If none qualify, maximum minimum training net, flagged nonqualifying. Selection never reads Sep8 onward.',
        limitations=['All history already inspected; no prospective claim.',
        'September is a current-policy counterfactual, not historical wallet replication.',
        'Adaptive exit falls back to 1.75 before full bar availability on Sep5.',
        'Incomplete graduated executions force strict truncation. Complete intervals use independent account starts.',
        'Actual fidelity certificate previously passed 18/57 checks; comparative research remains diagnostic.',
        'Input cutoff Sep11 12:44 UTC, not live or refreshed to the present.'],
        accounting='Four retained KPIs use same-scenario always-on denominator; ETH money ratios. Every mean carries median, sample SD and n. Cash never reset by DD lifts; segment concatenation is conditional, not wallet equity.',
        controls='Automatic primary holds all nonmarket account guards fixed. Recorded human stops are a separate sensitivity; always-on deliberately removes account pauses for the requested denominator.',
        families={
          'fresh':'sum last W newly published adaptive outcomes > scale; brake S20 < -1',
          'memory':'fresh threshold scale*(1+0.5*consecutive settled losing guard episodes)',
          'trail':'shadow rebound > scale; peak giveback > 0.75*scale*brake',
          'permit':'fresh sum > scale issues 3 entries; renewal needs W new publications',
          'breadth':'fresh sum plus 60% winners from at least 2 creators',
          'fast':'fresh entry, extra last3 sum < -scale brake',
          'clock':'fresh entry, newest launch age must be <=15*scale minutes',
          'noise':'fresh sum > scale*max(0.5, SD(lastW)*sqrt(W))',
          'earned':'fresh guard; quarter stake until settled episode profit >=0.5*scale stakes; half until >=scale',
          'quarantine':'fresh guard; reject creator after >=2 published results totaling <-scale in last hour',
          'divergence':'fresh guard; stop if last5 actual simulated returns underperform their published shadow returns by >0.1*scale on average',
          'cluster':'fresh guard; stop if >=4 of last5 lose and sum <-scale',
          'exhaustion':'trail; next rebound must exceed max(scale, half previous episode peak rebound)',
          'pressure':'nonnegative cumulative fresh return credit since pause >scale and last3 positive; brake S20<-1',
          'regime':'last10 sign changes >=6 uses 2*scale recovery and last3 brake; otherwise fresh rule with S20>2 continuation'})
    if (OUT/'design.json').exists():
        if read_json(OUT/'design.json') != design: raise ValueError('Frozen design mismatch; use a new output directory')
    else: write_json(OUT/'design.json',design)
    print('Frozen',len(candidates()),'candidates;',len(SCENARIOS),'scenarios',flush=True)


def pack(run,a,b,normal_size):
    rows=close_cash(run)
    periods={}
    end=read_json(OUT/'design.json')['end']
    for name,lo,hi in [('full',a,b),('fit',a,min(b,FIT_END)),('validation',max(a,FIT_END),min(b,end-6*HOUR)),('reserved',max(a,end-6*HOUR),b)]:
        periods[name]=cash_metrics([r for r in rows if lo<=r['at']<hi])
    return dict(complete=run['complete'],unresolved=run['unresolved'],open_ids=run['open_ids'],
        cash=rows,actions=run['actions'],scores=periods,
        recovery=recovery_losses(run,b),minimum_funding_wei=required_funding(run,normal_size),
        admitted=[dict(at=d['at'],id=d['id'],size=d.get('size')) for d in run['decisions'] if d['reason'] is None],
        reasons=dict(Counter(d['reason'] or 'entered' for d in run['decisions'])))


def run(scenario_index=None):
    design=read_json(OUT/'design.json')
    if sources()!=design['source_hashes']:raise ValueError('Source changed after freeze')
    raw,models=read_json(SOURCE),read_json(ROOT/'models.json')
    passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
    models={**models,'tokens':{t:z for t,z in models['tokens'].items() if t in passed}}
    facts={f['token'].lower():f for f in raw['bot_launches']}
    base=configured_policy(raw)
    always=replace(base,name='continuous',market_enabled=False,account_pauses_enabled=False,touch_enabled=False)
    end=design['end']
    unknown=sorted(z['entry'] for z in models['tokens'].values() if any(r['status'] not in ('closed','buy_reverted','entry_price_rejected') for rs in [z['results'],*z['sized_results'].values()] for r in rs.values()) and START<=z['entry']<end)
    intervals=[];cursor=START
    for at in unknown:
        if at-cursor>360000:intervals.append([cursor,at])
        cursor=max(cursor,at+180000)
    if end-cursor>360000:intervals.append([cursor,end])
    coverage=dict(start=START,end=end,intervals=intervals,unknown_entries=unknown,
        omitted_admission_ms=end-START-sum(b-a-180000 for a,b in intervals),
        launch_count=sum(START<=z['entry']<end for z in models['tokens'].values()),
        creator_coverage=sum(bool(facts[t].get('deployer')) for t in models['tokens']),model_count=len(models['tokens']))
    if (OUT/'coverage.json').exists():
        assert read_json(OUT/'coverage.json')==coverage
    else:
        write_json(OUT/'coverage.json',coverage)
    scenarios=SCENARIOS if scenario_index is None else [SCENARIOS[scenario_index]]
    for scenario in scenarios:
        obs=observations_for(raw,models,scenario['mode']=='reconstructed_early')
        alltrades=trades_for(models,scenario['variant'])
        for i,(a,b) in enumerate(intervals):
            path=OUT/'runs'/f'{scenario["name"]}-{i:02}.json'
            if path.exists():continue
            warm=a-7*HOUR if i==0 else a
            # Preserve selected indicator: adaptive central shadow tape in every execution stress.
            shadow=simulate(obs,[t for t in trades_for(models,'adaptive') if warm<=t['entry']<b-180000],always,warm,b)
            tapes,missing=make_tapes(raw,models,shadow,obs)
            if not shadow['complete']:raise ValueError('Incomplete shadow in common interval')
            trades=[t for t in alltrades if a<=t['entry']<b-180000]
            cs=external_controls(raw) if scenario['controls'] else []
            results={}
            for name,policy,guard in [('continuous',always,None),('current_guard',base,None),('matched20',base,IndicatorGuard(tapes['matched'],SignalRule('matched20',delay_ms=scenario['delay']),base.size_wei))]:
                results[name]=pack(simulate(obs,trades,policy,a,b,controls=cs,guard=guard),a,b,base.size_wei)
            for rule in candidates():
                guard=CreativeGuard(tapes['matched'],rule,base.size_wei,a,facts,scenario['delay'])
                r=simulate(obs,trades,base,a,b,controls=cs,guard=guard)
                results[rule.name]=pack(r,a,b,base.size_wei)
                results[rule.name]['guard_transitions']=guard.transitions
            if not all(r['complete'] for r in results.values()): raise ValueError('Incomplete candidate in common interval')
            write_json(path,dict(scenario=scenario,segment=i,start=a,end=b,runs=results,
                missing_publications=missing,shadow_records=tapes['matched'].records))
            print(scenario['name'],i+1,'/',len(intervals),'accounts',len(results),flush=True)
    if sources()!=design['source_hashes']:raise ValueError('Source changed during run')


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['freeze','run']);p.add_argument('--scenario',type=int)
    args=p.parse_args()
    freeze() if args.command=='freeze' else run(args.scenario)
