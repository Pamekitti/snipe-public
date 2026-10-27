"""Common complete intervals supplement, but do not replace, strict account paths."""
from dataclasses import replace,asdict
from pathlib import Path
from collections import Counter
from .data import read_json,write_json,write_artifact,digest,HOUR
from .long_history import ROOT,SOURCE,OUT,observations_for,external_controls,summary,compress,required_funding
from .indicator_study import configured_policy,trades_for,make_tapes
from .indicators import IndicatorGuard,candidates
from .account import simulate
from .evaluation import recovery_losses,cash_difference


def run():
    raw,models=read_json(SOURCE),read_json(ROOT/'models.json')
    design=read_json(ROOT/'frozen-design.json')
    passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
    models={**models,'tokens':{t:z for t,z in models['tokens'].items() if t in passed}}
    start,end=design['comparison_start'],raw['snapshot_at']
    unknown=sorted((z for z in models['tokens'].values() if any(r['status'] not in ('closed','buy_reverted','entry_price_rejected')
        for rs in [z['results'],*z['sized_results'].values()] for r in rs.values())),key=lambda z:z['entry'])
    intervals=[];cursor=start
    for z in unknown:
        if not start<=z['entry']<end:continue
        if z['entry']-cursor>360000:intervals.append((cursor,z['entry']))
        cursor=max(cursor,z['entry']+180000)
    if end-cursor>360000:intervals.append((cursor,end))
    base=configured_policy(raw)
    always=replace(base,name='continuous',market_enabled=False,account_pauses_enabled=False,touch_enabled=False)
    controls=[base,replace(base,name='market_plus1',on=1),replace(base,name='stale_hold',stale='hold'),replace(base,name='market_off',market_enabled=False),always]
    external=external_controls(raw)
    records=[]
    for mode in ('recorded','reconstructed_early'):
        obs=observations_for(raw,models,mode=='reconstructed_early')
        for i,(a,b) in enumerate(intervals):
            warm=design['warm_start'] if i==0 else a
            last_entry=b-180000
            tape_trades=[t for t in trades_for(models,'adaptive') if warm<=t['entry']<last_entry]
            shadow=simulate(obs,tape_trades,always,warm,b)
            tapes,missing=make_tapes(raw,models,shadow,obs)
            for intervention in ('automatic','recorded_controls'):
                cs=external if intervention=='recorded_controls' else []
                for variant in design['sell_delays_ms']:
                    path=OUT/'segments'/f'{mode}-{i:02}-{intervention}-{variant}.json'
                    if path.exists():continue
                    trades=[t for t in trades_for(models,variant) if a<=t['entry']<last_entry]
                    group={p.name:simulate(obs,trades,p,a,b,controls=cs) for p in controls}
                    for rule in candidates():
                        guard=IndicatorGuard(tapes[rule.source],rule,base.size_wei,halted=True)
                        r=simulate(obs,trades,base,a,b,controls=cs,guard=guard)
                        r['probe_loss_wei']=str(guard.probe_loss)
                        group[rule.name]=r
                    scores={n:summary(r,a,b) for n,r in group.items()}
                    for n,r in group.items():
                        r['recovery_losses']=recovery_losses(r,b)
                        r['minimum_starting_funds_wei']=required_funding(r,base.size_wei)
                    result=dict(segment=i,start=a,end=b,last_entry=last_entry,signal=mode,
                        intervention=intervention,variant=variant,scores=scores,
                        comparisons={n:cash_difference(r,group['continuous']) for n,r in group.items()},
                        shadow_complete=shadow['complete'],missing_publications=missing,
                        runs={n:compress(r) for n,r in group.items()})
                    write_json(path,result)
                    print('segment',i,mode,intervention,variant,'complete',sum(r['complete'] for r in group.values()),'/',len(group),flush=True)
            delayed={}
            for rule in [r for r in candidates() if r.smooth]:
                guard=IndicatorGuard(tapes[rule.source],replace(rule,delay_ms=60000),base.size_wei,halted=True)
                r=simulate(obs,[t for t in tape_trades if t['entry']>=a],base,a,b,controls=external,guard=guard)
                delayed[rule.name]=dict(score=summary(r,a,b),run=compress(r))
            write_json(OUT/'segment-delay'/f'{mode}-{i:02}.json',delayed)
            records.append(dict(mode=mode,segment=i,start=a,end=b,admission_end=last_entry,
                shadow_complete=shadow['complete'],missing_publication_count=len(missing)))
    meta=dict(start=start,end=end,intervals=intervals,records=records,
        modeled_qualifying_launches=len(models['tokens']),unknown_tokens=[dict(token=z['token'],entry=z['entry'],statuses=sorted({r['status'] for rs in [z['results'],*z['sized_results'].values()] for r in rs.values()})) for z in unknown],
        omitted_admission_ms=end-start-sum(b-180000-a for a,b in intervals),
        limitations=['Separate hypothetical accounts at coverage boundaries, not one continuous wallet.',
            'All losses remain included in interval cash; cross-interval account state is not inferred.',
            'Missing graduated exits remain unavailable in the strict comparison.'],
        source_hashes={str(p):digest(p) for p in [Path(__file__),ROOT/'models.json',ROOT/'frozen-design.json',SOURCE]})
    write_artifact(OUT/'segments-index.json',meta)
    print('Segment comparison completed',len(intervals),flush=True)

if __name__=='__main__':run()
