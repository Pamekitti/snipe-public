"""Frozen long-history guard study. All files and executions are offline research."""
from __future__ import annotations

import argparse
import bisect
from collections import Counter
import copy
from dataclasses import asdict, replace
import json
from pathlib import Path
import statistics

from .data import DAY, HOUR, Worker, digest, read_json, write_json, write_artifact
from .execution import path_request, receipt_gas, booked, describe
from .evaluation import context, entry, trade_from_model, recovery_losses, iso, cash_difference
from .account import Observation, observations, simulate
from .guard_visual import close_cash, difference
from .indicator_study import configured_policy, trades_for, make_tapes, forward_cohorts
from .indicators import candidates, SignalRule, SignalTape, IndicatorGuard
from .fidelity import cash_metrics

ROOT = Path('data/research/20260911-long-history-input')
SOURCE = Path('data/research/20260911-indicator-input/snapshot.json.gz')
OUT = Path('data/research/20260911-long-history-results-v2')


def merge():
    d = read_json(ROOT / 'merged-base.json')
    s = read_json(Path('data/research/20260911-long-history-fill-verified/dataset.json'))
    conflicts = []
    for key in ('params', 'blocks'):
        for token, value in s[key].items():
            old = d[key].get(token)
            if old and value:
                same = old == value if key == 'params' else all(old[k] == value[k] for k in ('hash', 'timestamp'))
                if not same:
                    conflicts.append([key, token])
    if conflicts:
        raise ValueError(f'Conflicting chain evidence: {conflicts[:3]}')
    for key in ('paths', 'params', 'path_coverage', 'blocks', 'receipts', 'parameter_sources'):
        d[key].update({k: v for k, v in s[key].items() if v is not None})
    d['source'] = str(SOURCE.resolve())
    coverage = Counter()
    for f in d['launches']:
        t = f['token'].lower()
        coverage['launches'] += 1
        coverage['params'] += bool(d['params'].get(t))
        coverage['full_paths'] += bool(d['path_coverage'].get(t, {}).get('all_topics'))
        coverage['timed_paths'] += t in d['paths'] and all(l['blockNumber'] in d['blocks'] for l in d['paths'][t])
    write_json(ROOT / 'dataset.json', d)
    write_json(ROOT / 'manifest.json', dict(dataset_sha256=digest(ROOT / 'dataset.json'),
        coverage=dict(coverage), conflicts=conflicts,
        sources={str(p): digest(p) for p in [ROOT/'merged-base.json', Path('data/research/20260911-long-history-fill-verified/dataset.json'),SOURCE]}))
    print('Merged coverage', dict(coverage), flush=True)


def selector_rows(raw):
    valid = []
    for o in raw['gate_obs']:
        if o.get('error') is not None or o.get('bars') is None:
            continue
        try:
            bars = json.loads(o['bars']) if isinstance(o['bars'], str) else o['bars']
        except (ValueError, TypeError):
            bars = {}
        valid.append(dict(token=o['token'].lower(), block=o['block'], available=o['at'], bars=bars))
    return sorted(valid, key=lambda o: (o['available'], o['block']))


def eligible(f, spec):
    return (f.get('pair_token') == '0x'+'0'*40
        and spec['minCreatorTaxBps'] <= (f.get('creator_tax_bps') or 0) <= spec['maxCreatorTaxBps']
        and int(f.get('dev_buy_wei') or 0) >= int(spec['minDevBuyWei'])
        and f.get('prior_launches') is not None and f['prior_launches'] <= spec['maxPriorLaunches']
        and (f.get('exemptions') or 0) >= spec['minExemptionsToEnter'])


def models():
    raw, d = read_json(SOURCE), read_json(ROOT/'dataset.json')
    design = read_json(ROOT/'frozen-design.json')
    latest = max((p for p in raw['bot_positions'] if context(p).get('entryStrategy')), key=entry)
    ctx = context(latest)
    spec = ctx['entryStrategy']
    end, warm = raw['snapshot_at'], design['warm_start']
    prior = []
    for p in raw['bot_positions']:
        if not (p['live'] and (p.get('cohort') or 'main') == 'main' and p.get('buy_ok')
                and p.get('closed') and p.get('exit_at') and p['exit_at'] < end-6*HOUR
                and p.get('onchain_pnl_wei') is not None):
            continue
        gas = int(p.get('proceeds_wei') or 0)-int(p['spend_wei'])-booked(p)
        buy = receipt_gas(d['receipts'].get(p.get('buy_hash')))
        send = p['t_sent']-entry(p) if p.get('t_sent') else None
        opened = (context(p).get('at') or p.get('t_confirmed') or entry(p))-entry(p)
        if gas >= buy > 0 and send is not None and send >= 0 and opened >= 0:
            prior.append(dict(at=p['exit_at'], gas=gas, buy=buy, send=send, opened=opened))
    prior.sort(key=lambda r:r['at'])
    clocks = [p['at'] for p in prior]
    native = selector_rows(raw)
    visible, oi = [], 0
    source_hashes = {str(p):digest(p) for p in [ROOT/'dataset.json', ROOT/'frozen-design.json',Path(__file__)]}
    path = ROOT/'models.json'
    saved = read_json(path) if path.exists() else {}
    if saved and saved['source_hashes'] != source_hashes:
        raise ValueError('model checkpoint source mismatch')
    tokens = saved.get('tokens', {})
    facts = sorted((f for f in d['launches'] if eligible(f,spec)), key=lambda f:max(f.get('detected_at') or 0,f['launched_at']*1000+2000))
    with Worker() as worker:
        for i,f in enumerate(facts):
            at = max(f.get('detected_at') or 0, f['launched_at']*1000+2000)
            if not warm <= at < end:
                continue
            while oi < len(native) and native[oi]['available'] < at:
                visible.append(native[oi]); oi += 1
            t = f['token'].lower()
            if t in tokens:
                continue
            recent = sorted(visible,key=lambda o:-o['block'])[:20]
            tp_result = worker.call(op='adaptive', rows=[o['bars'] for o in recent],
                window=20,bars=[1.25,1.36,1.5,1.75,2,2.5,3],fallback=1.75)
            prev = prior[:bisect.bisect_left(clocks,at)][-100:]
            timing = {k:round(statistics.median(p[k] for p in prev)) if prev else 0 for k in ('gas','buy','send','opened')}
            size = round(spec['tradeSizeEth']*1e18)
            fake = dict(token=t,curve=f['curve'],t_decide=at,spend_wei=str(size),take_profit=tp_result['multiple'],context_json=ctx)
            req, missing = path_request(d,fake,timing['gas'],lag=1200,poll=50)
            if len(prev)<20:
                missing='fewer_than_20_preceding_cost_observations'
            keys, variants = [], []
            for sz in (size,size//2,size//4):
                for label, lag in design['sell_delays_ms'].items():
                    keys.append((sz,label)); variants.append(dict(sizeWei=str(sz),sellDelayMs=lag))
            if missing:
                rr=[dict(status=missing) for _ in keys]
                fixed=native_result=dict(status=missing)
            else:
                req.update(buyGasWei=str(timing['buy']),buyAt=at+timing['send'],openedAt=at+timing['opened'])
                rr=worker.call(op='replay_many',request=req,variants=variants)
                fixed=worker.call(op='replay_many',request=req,variants=[dict(takeProfit=1.75)])[0]
                native_req=dict(req,entryAt=f['launched_at']*1000+2000,buyAt=f['launched_at']*1000+2000,
                    openedAt=f['launched_at']*1000+2000,maxEntryMultiple=None,gasWei='0',buyGasWei='0',pollMs=1200)
                native_result=worker.call(op='replay_many',request=native_req,
                    variants=[dict(takeProfit=1.75,sizeWei=str(10**16),sellDelayMs=600)])[0]
            bysize={}
            for (sz,label),r in zip(keys,rr): bysize.setdefault(str(sz),{})[label]=r
            tokens[t]=dict(token=t,entry=at,size=size,tp=tp_result['multiple'],tp_reason=tp_result.get('why'),
                selector_rows=len(recent),template=f"{f.get('creator_tax_bps')}:{f.get('dev_buy_wei')}:{f.get('exemptions')}",
                creator_tax_bps=f.get('creator_tax_bps'),exemptions=f.get('exemptions'),gas_wei=str(timing['gas']),
                buy_gas_wei=str(timing['buy']),gas_n=len(prev),calibration_latest=max((p['at'] for p in prev),default=None),
                send_delay_ms=timing['send'],open_delay_ms=timing['opened'],delay_ms=1200,
                results=bysize.pop(str(size)),sized_results=bysize,fixed_net_result=fixed,native_result=native_result)
            if len(tokens)%200==0:
                print('modeled',len(tokens),'of',len(facts),flush=True)
                write_json(path,dict(tokens=tokens,source_hashes=source_hashes,design=design))
    write_artifact(path,dict(tokens=tokens,source_hashes=source_hashes,design=design))
    print('Execution statuses',dict(Counter(z['results']['adaptive']['status'] for z in tokens.values())),flush=True)


def external_controls(raw):
    controls=[]
    for h in raw['bot_health']:
        if h['component']=='operator':
            action='stop' if not h['ok'] else ('resume' if 'automatic operation' in h['detail'] else 'legacy_start')
            controls.append((h['at'],action))
        elif h['component']=='halt' and 'before this restart' in h['detail']:
            controls.append((h['at'],'restart'))
        elif h['component']=='halt' and h['detail'].startswith('[manual]'):
            controls.append((h['at'],dict(halt='manual')))
    return sorted(controls,key=lambda x:x[0])


def observations_for(raw, models, reconstructed=False):
    obs=observations(dict(source=str(SOURCE),observations=raw['gate_obs']),raw=raw)
    output=[]
    for o in obs:
        z=models['tokens'].get(o.token)
        if reconstructed and z and '1.75' not in o.bars:
            r=z['native_result']
            if r['status'] in ('closed','buy_reverted'):
                o=replace(o,bars={'1.75':int(r['pnlWei'])/1e16},scored=max(o.scored,r['exitAt'])+1)
        output.append(o)
    return output


def summary(run,a,b):
    rows=[r for r in close_cash(run) if a<=r['at']<b and r['id'] not in run['open_ids']]
    unavailable=any(u['at']<b for u in run['unresolved'])
    unfinished = any(d['id'] in run['open_ids'] and d['at'] < b for d in run['decisions'])
    return dict(**cash_metrics(rows), complete=not unavailable and not unfinished,
        first_unknown=run['unresolved'][0] if unavailable else None)


def required_funding(run, normal_size):
    events=[]
    sizes={d['id']:d.get('size',normal_size) for d in run['decisions'] if d['reason'] is None}
    for d in run['decisions']:
        if d['reason'] is None:
            events.append((d['at'],1,sizes[d['id']]))
    for r in run['cash']:
        delta=-int(r['pnl'])
        if r.get('kind')=='close':
            delta-=sizes[r['id']]
        events.append((r['at'],0,delta))
    locked=peak=0
    for _,_,value in sorted(events):
        locked+=value
        peak=max(peak,locked)
    return str(peak)


def compress(run):
    # Keep the evidence required for cash, admission and stop verification.
    return {k:v for k,v in run.items() if k!='readings'}


def study(shard=0, shards=1):
    if not 0 <= shard < shards:
        raise ValueError('shard must be between zero and shards minus one')
    raw,models=read_json(SOURCE),read_json(ROOT/'models.json')
    passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
    models={**models,'tokens':{t:z for t,z in models['tokens'].items() if t in passed}}
    design=read_json(ROOT/'frozen-design.json')
    if models['source_hashes'][str(ROOT/'frozen-design.json')]!=digest(ROOT/'frozen-design.json'):
        raise ValueError('design changed')
    base=configured_policy(raw)
    end,start,warm=raw['snapshot_at'],design['comparison_start'],design['warm_start']
    defs=candidates()
    if [asdict(x) for x in defs]!=design['candidates']:
        raise ValueError('candidates changed after freeze')
    controls=external_controls(raw)
    always=replace(base,name='continuous',market_enabled=False,account_pauses_enabled=False,touch_enabled=False)
    policy_controls=[base,replace(base,name='market_plus1',on=1),replace(base,name='stale_hold',stale='hold'),
        replace(base,name='market_off',market_enabled=False),always]
    # Named checkpoints are separate hypothetical inception tests, never cash resets.
    starts=[start]+list(range(start+3*DAY,end-6*HOUR,3*DAY))+[end-7*DAY,end-4*DAY,end-2*DAY,end-6*HOUR]
    starts=sorted(set(t for t in starts if start<=t<end))
    group_keys=[]
    signal_evidence={}
    for signal_mode in ('recorded','reconstructed_early'):
        obs=observations_for(raw,models,signal_mode=='reconstructed_early')
        # Inception-local shadow paths prevent an unresolved earlier account from
        # silently providing a supposedly complete later counterfactual account.
        for start_index,inception in enumerate(starts):
            if start_index % shards != shard:
                continue
            local_warm=max(warm,inception-7*HOUR)
            shadow=simulate(obs,trades_for(models,'adaptive'),always,local_warm,end)
            tapes,missing=make_tapes(raw,models,shadow,obs)
            key=f'{signal_mode}/{inception}'
            signal_evidence[key]=dict(shadow_complete=shadow['complete'],shadow_unknown=shadow['unresolved'],
                missing_publication=missing,counts={k:len(t.records) for k,t in tapes.items()})
            for intervention in ('automatic','recorded_controls'):
                cs=controls if intervention=='recorded_controls' else []
                for variant in design['sell_delays_ms']:
                    prefix=f'{key}/{intervention}/{variant}'
                    group_path=OUT/'groups'/f'{signal_mode}-{inception}-{intervention}-{variant}.json'
                    group_keys.append(prefix)
                    if group_path.exists():
                        continue
                    group={}
                    trades=trades_for(models,variant)
                    for p in policy_controls:
                        group[p.name]=simulate(obs,trades,p,inception,end,controls=cs)
                    for rule in defs:
                        guard=IndicatorGuard(tapes[rule.source],rule,base.size_wei,halted=True)
                        r=simulate(obs,trades,base,inception,end,controls=cs,guard=guard)
                        r['probe_loss_wei']=str(guard.probe_loss)
                        group[rule.name]=r
                    periods={'full':(inception,end),'before_last48':(inception,end-2*DAY),
                        'profit48':(max(inception,end-4*DAY),end-2*DAY),
                        'loss48':(max(inception,end-2*DAY),end),'reserved6h':(max(inception,end-6*HOUR),end)}
                    scores={name:{p:summary(run,a,b) for p,(a,b) in periods.items() if a<b} for name,run in group.items()}
                    for name,run in group.items():
                        run['minimum_starting_funds_wei']=required_funding(run,base.size_wei)
                        run['recovery_losses']=recovery_losses(run,end)
                    comparisons={name:cash_difference(run,group['continuous']) for name,run in group.items()}
                    result=dict(start=inception,signal=signal_mode,intervention=intervention,variant=variant,
                        scores=scores,comparisons=comparisons,runs={k:compress(v) for k,v in group.items()})
                    print('accounts',prefix,'complete',sum(r['complete'] for r in group.values()),'/',len(group),flush=True)
                    # One immutable file per group makes long runs resumable and reviewable.
                    write_json(group_path,result)
            # Central, recorded-control publication stress for the existing smoothed rules.
            delayed={}
            for rule in [r for r in defs if r.smooth]:
                guard=IndicatorGuard(tapes[rule.source],replace(rule,delay_ms=60000),base.size_wei,halted=True)
                rr=simulate(obs,trades_for(models,'adaptive'),base,inception,end,controls=controls,guard=guard)
                delayed[rule.name]=dict(full=summary(rr,inception,end),run=compress(rr))
            write_json(OUT/'delay'/f'{signal_mode}-{inception}.json',delayed)
    metadata=dict(start=start,end=end,starts=starts,signal_evidence=signal_evidence,
        groups=group_keys,design=design,source_hashes={str(p):digest(p) for p in [ROOT/'models.json',ROOT/'dataset.json',ROOT/'frozen-design.json',SOURCE,Path(__file__)]})
    metadata.update(shard=shard,shards=shards)
    write_artifact(OUT/('index.json' if shards==1 else f'index-shard-{shard}.json'),metadata)
    print('Completed groups',len(group_keys),flush=True)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['merge','models','study'])
    p.add_argument('--shard',type=int,default=0)
    p.add_argument('--shards',type=int,default=1)
    args=p.parse_args()
    if args.command=='study':
        study(args.shard,args.shards)
    else:
        {'merge':merge,'models':models}[args.command]()

if __name__=='__main__': main()
