"""Larger-period comparisons of frozen market policies. No network or trading writes.

See MARKET_GUARD_EXTENSION_PROTOCOL.md. The mixed-stake comparison preserves actual
stakes; it is not an estimate of trading every opportunity at today's stake.
"""
from __future__ import annotations

import argparse
import collections
from dataclasses import asdict, replace
import gzip
import hashlib
import json
from pathlib import Path

from guard_audit import HOUR, DAY, SIZE, NON_TRADE, describe, iso
from market_guard_audit import (ERA, Candidate, Experiment, candidates, detailed,
                                difference, load, missing)

EARLY = 1788732361118
HALF = 1788783709281
NAMES = ['live', 'threshold_window=10_off=-1_on=0',
         'resume_persistence_on_count=2', 'resume_persistence_on_count=3',
         'resume_persistence_on_count=5',
         'threshold_persistence_window=15_off=-2_on=2_on_count=2']


def historical_size(at):
    return SIZE//2 if HALF<=at<ERA else SIZE


def summarize(rr, failed, sizes, start=None, end=None):
    return detailed(rr,failed,start=start,end=end,sizes=sizes)


def scoped_rows(data, start, end):
    return [p for p in data['bot_positions'] if p['live'] and (p['cohort'] or 'main')=='main'
            and start <= (p['t_decide'] or p['t_detect'] or 0)<end]


def coverage(data, trades, start, end):
    rows=scoped_rows(data,start,end)
    closed=[p for p in rows if p['closed'] and p['exit_at']<=end]
    good=[p for p in closed if p['exit_reason'] not in NON_TRADE]
    book=[t for t in trades if start<=t.entry<end and t.exit<=end]
    return dict(start=iso(start),end=iso(end),hours=(end-start)/HOUR,
                completed_trades=len(good),failed_attempts=len(closed)-len(good),
                unresolved=len(rows)-len(closed),missing_receipts=sum(p['onchain_pnl_wei'] is None for p in closed),
                stakes=dict(collections.Counter(str(int(p['spend_wei'])/1e18) for p in good)),
                actual_cash_eth=sum(t.pnl+t.wallet_adjustment for t in book)/1e18,
                cash_stats_eth=describe((t.pnl+t.wallet_adjustment)/1e18 for t in book))


def bins(trades, now):
    result={}
    for label,span,n in [('24h',DAY,8),('7d',7*DAY,7)]:
        result[label]=[]
        for i in range(n):
            a,b=now-span+i*span//n,now-span+(i+1)*span//n
            current=[t for t in trades if max(a,ERA)<=t.exit<b]
            older=[t for t in trades if max(a,EARLY)<=t.exit<min(b,ERA)]
            result[label].append(dict(start=iso(a),end=iso(b),
                current_era_coverage='unavailable' if b<=ERA else 'partial' if a<ERA else 'current-era',
                current_era=describe((t.pnl+t.wallet_adjustment)/1e18 for t in current),
                older_diagnostic=describe((t.pnl+t.wallet_adjustment)/1e18 for t in older)))
    return result


def evaluate_set(obs,trades,start,end,policies,failed,report_starts):
    tape=Experiment(obs,trades,start,end)
    sizes={t.id:t.size for t in trades}
    results={p.name:tape.simulate(p) for p in policies}
    rows=[]
    for p in policies:
        r=results[p.name]
        rows.append(dict(policy=asdict(p),full=summarize(r,failed,sizes),
            slices={key:summarize(r,failed,sizes,start=at) for key,at in report_starts.items()},
            delta=difference(r,results['live'],trades,start,end),
            actions=[dict(a,time=iso(a['at'])) for a in r['actions']]))
    return tape, results, rows


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--snapshot',type=Path,required=True)
    ap.add_argument('--previous',type=Path,required=True)
    ap.add_argument('--out',type=Path,required=True)
    args=ap.parse_args()
    data,launches,obs,all_obs,raw,trades,wallet=load(args.snapshot,start=EARLY,require_size=None)
    previous=json.load(gzip.open(args.previous,'rt'))
    previous_results=json.loads(args.previous.with_name('results.json').read_text())
    now,old_end=data['snapshot_at'],previous['snapshot_at']
    cut=now-6*HOUR
    cfg=data['state']['config']['values']
    assert (cfg['tradeSizeEth'],cfg['bankrollEth'])==(.02,.08)
    assert all(t.size==historical_size(t.entry) for t in trades)
    failed={p['id'] for p in raw if p['exit_reason'] in NON_TRADE}
    sizes={t.id:t.size for t in trades}
    all_policies=candidates()
    byname={p.name:p for p in all_policies}
    frozen=[byname[n] for n in NAMES]
    common=dict(dd=round(cfg['maxDrawdownEth']*1e18),rwin=cfg['ddResumeWindow'],
                ron=cfg['ddResumeOn'],fresh_h=cfg['venueFreshHours'])
    policies=[replace(p,**common) for p in frozen]
    args.out.with_name('fixed_policies.json').write_text(json.dumps(dict(
        current_account_settings=common,policies=[asdict(p) for p in policies],
        prior_policies=[asdict(p) for p in frozen]),indent=2)+'\n')
    scopes={}
    plans=[('current_002',ERA,now,{'added_since_previous':old_end+1,'latest_six_hours':cut+1}),
           ('earlier_002',EARLY,HALF,{}),
           ('historical_stakes',EARLY,now,{'last24h':now-DAY,'added_since_previous':old_end+1,'latest_six_hours':cut+1})]
    for label,start,end,slices in plans:
        tape,rs,rows=evaluate_set(obs,trades,start,end,policies,failed,slices)
        _,_,old_rows=evaluate_set(obs,trades,start,end,frozen,failed,slices)
        scopes[label]=dict(coverage=coverage(data,trades,start,end),comparison=rows,old_account_settings=old_rows)
        if label=='historical_stakes':mixed_tape=tape
        print('Completed scope',label,flush=True)
    scopes['last24h_coverage']=coverage(data,trades,now-DAY,now)
    # Verify the prior saved result rather than treating the same trades as new evidence.
    od,_,oo,_,orp,ot,_=load(args.previous)
    old_failed={p['id'] for p in orp if p['exit_reason'] in NON_TRADE}
    old_tape=Experiment(oo,ot,ERA,old_end)
    verification=[]
    prev_byname={r['policy']['name']:r for r in previous_results['all_scores']}
    for p in frozen:
        m=summarize(old_tape.simulate(p),old_failed,{t.id:t.size for t in ot})
        expected=prev_byname[p.name]['full']
        assert abs(m['pnl_eth']-expected['pnl_eth'])<1e-12
        assert abs(m['maxdd_eth']-expected['maxdd_eth'])<1e-12
        verification.append(dict(policy=p.name,prior_pnl_exact=True,prior_drawdown_exact=True))
    old_obs={r['token']:r for r in previous['gate_obs']}
    revisions=[r for r in data['gate_obs'] if r['token'] in old_obs and
               any(r[k]!=old_obs[r['token']][k] for k in ('bars','at','error'))]
    usable_revisions=[r for r in revisions if old_obs[r['token']]['bars']]
    assert not usable_revisions, 'Scored observations were rewritten; versioned replay is required.'
    # Rebase the existing definitions onto the common account settings. Explicit
    # drawdown-threshold hypotheses retain their declared threshold. A definition
    # equal to today's baseline can now be a duplicate; report the distinct count.
    # This ranking does not replace the six frozen primary comparisons.
    rankings=[]
    for p in all_policies:
        evaluated=replace(p,**{**common,'ron':p.ron if p.family=='drawdown_threshold' else common['ron']})
        rr=mixed_tape.simulate(evaluated)
        rankings.append(dict(policy=asdict(evaluated),full=summarize(rr,failed,sizes),
            last24h=summarize(rr,failed,sizes,start=now-DAY),fit=summarize(rr,failed,sizes,end=cut),
            recent=summarize(rr,failed,sizes,start=cut+1)))
    print('Completed descriptive grid',len(rankings),flush=True)
    winner=max(rankings,key=lambda r:(r['full']['pnl_eth'],-r['full']['maxdd_eth']))
    diagnostic=Candidate(**winner['policy'])
    if diagnostic.name not in NAMES:
        for label,start,end,slices in plans:
            _,_,rows=evaluate_set(obs,trades,start,end,[policies[0],diagnostic],failed,slices)
            scopes[label]['comparison'].append(rows[-1])
        # This policy was chosen after looking at the expanded history. Its extra
        # stress checks are post-hoc diagnostics, never a fresh validation set.
        policies=policies+[diagnostic]
    stress=[]
    for label,opts in [('delay60',dict(delay=60_000)),('delay180',dict(delay=180_000)),
                       ('one_confirmation_per_tick',dict(tick_confirm=True)),('signal_minus5pp',dict(haircut=.05))]:
        tape=Experiment(obs,trades,ERA,now,**opts)
        baseline=tape.simulate(policies[0])
        for p in policies:
            rr=tape.simulate(p)
            stress.append(dict(case=label,policy=p.name,full=summarize(rr,failed,sizes),
                               delta_eth=difference(rr,baseline,trades,ERA,now)['delta_eth']))
    proxy,unpriced,fee,fees=missing(launches,all_obs,raw,now,cut,start=EARLY)
    scenarios=[]
    for shift in (-.20,0,.20):
        from guard_audit import Trade
        added=[Trade(-i-1,r['token'],r['at'],r['at']+45_000,
                     round(historical_size(r['at'])*max(-1,r['value']+shift))-fee,
                     size=historical_size(r['at'])) for i,r in enumerate(proxy)]
        augmented=trades+added;aug_sizes={t.id:t.size for t in augmented}
        for label,start in [('current_002',ERA),('historical_stakes',EARLY)]:
            tape=Experiment(obs,augmented,start,now)
            baseline=tape.simulate(policies[0])
            for p in policies:
                rr=tape.simulate(p)
                scenarios.append(dict(case=label,shift_pp=shift*100,policy=p.name,
                    full=summarize(rr,failed,aug_sizes),last24h=summarize(rr,failed,aug_sizes,start=max(start,now-DAY)),
                    added_since_previous=summarize(rr,failed,aug_sizes,start=old_end+1),
                    synthetic_fills=sum(i<0 for _,i,_ in rr['cash']),
                    delta_eth=difference(rr,baseline,augmented,start,now)['delta_eth']))
    # A clean start at the 24-hour boundary is a sensitivity, not the primary replay.
    _,_,clean24=evaluate_set(obs,trades,now-DAY,now,policies,failed,{})
    current_tokens={t.id for t in trades if t.entry>=ERA}
    old_tokens={p['id'] for p in previous['bot_positions']}
    changes=json.loads(next(r['value'] for r in data['bot_chain_truth'] if r['key']=='filter_changes'))
    out=dict(snapshot=dict(at=iso(now),sha256=hashlib.sha256(args.snapshot.read_bytes()).hexdigest(),
                           previous_at=iso(old_end),price_usd=data['state']['truth']['priceUsd']),
        config=cfg,changes=[r for r in changes if r.get('at',0)>=EARLY],scopes=scopes,
        incremental=dict(hours=(now-old_end)/HOUR,new_actual_attempts=sum(t.id not in old_tokens for t in trades),
                         new_scored_observations=sum(o.scored>old_end for o in all_obs),
                         new_eligible_observations=sum(o.scored>old_end for o in obs),
                         failed_observation_retries=len(revisions),rewritten_usable_observations=len(usable_revisions)),
        wallet=wallet,verification=verification,descriptive_rankings=rankings,stress=stress,
        descriptive_winner=diagnostic.name,
        distinct_descriptive_policies=len({tuple((k,v) for k,v in r['policy'].items() if k not in ('name','family')) for r in rankings}),
        missing=dict(priced=len(proxy),unpriced=len(unpriced),unpriced_tokens=unpriced,fees_eth=fees,
                     scenarios=scenarios,rows=proxy),
        clean_start_24h=clean24,bins=bins(trades,now))
    args.out.write_text(json.dumps(out,indent=2)+'\n')
    print('All extension comparisons complete',flush=True)


if __name__=='__main__':
    main()
