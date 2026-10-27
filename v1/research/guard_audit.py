#!/usr/bin/env python3
"""Causal, current-size guard comparison on a frozen read-only export.

Run: python3 research/guard_audit.py --snapshot data/guard-audit/snapshot.json.gz
     --out data/guard-audit/results.json

See GUARD_AUDIT_PROTOCOL.md for the frozen scope and selection rule. This is a
conditional cash-flow comparison, not a simulator of unobserved executions.
Only stdlib is required. Importing the module does not access data or the network.
"""
from __future__ import annotations

import argparse
import bisect
import collections
from dataclasses import dataclass, replace, asdict
import datetime as dt
import gzip
import hashlib
import itertools
import json
import math
from pathlib import Path
import random
import statistics as stats

HOUR = 3_600_000
DAY = 24 * HOUR
SIZE = 20_000_000_000_000_000
BAR = '1.75'
NON_TRADE = {'buy-never-mined', 'buy-reverted', 'recovered-flat'}


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def describe(xs):
    xs = list(xs)
    return dict(n=len(xs), sum=sum(xs), mean=stats.mean(xs) if xs else None,
                median=stats.median(xs) if xs else None,
                sd=stats.stdev(xs) if len(xs) > 1 else None,
                win_pct=100 * sum(x > 0 for x in xs) / len(xs) if xs else None)


def net_wei(row):
    x = row.get('onchain_pnl_wei')
    return int(row.get('pnl_wei') or 0) if x is None else int(x)


@dataclass(frozen=True)
class Observation:
    token: str
    block: int
    launched: int
    scored: int
    bars: dict


@dataclass(frozen=True)
class Trade:
    id: int
    token: str
    entry: int
    exit: int
    pnl: int
    size: int = SIZE
    wallet_adjustment: int = 0


@dataclass(frozen=True)
class Policy:
    name: str = 'live'
    window: int = 60
    off: float = -4
    on: float = .5
    fresh_h: float = 3
    dd: int = 3 * SIZE
    rwin: int = 20
    ron: float = 0
    lifts: int = 2
    venue: bool = True
    drawdown: bool = True


def outcome(rows, window, bar=BAR, haircut=0):
    chosen = []
    for r in rows:
        v = r.bars.get(bar)
        if isinstance(v, (float, int)) and math.isfinite(v):
            chosen.append((r, v - haircut))
            if len(chosen) == window:
                break
    return chosen


def venue_step(rows, now, p, internal='open', seeded=False, haircut=0):
    """Mirror readVenue: retain the band, but publish open when unfresh."""
    chosen = outcome(rows[:p.window * 2], p.window, haircut=haircut)
    total = sum(v for _, v in chosen)
    age = now - chosen[-1][0].launched if chosen else None
    fresh = len(chosen) >= p.window and age <= p.fresh_h * HOUR
    if not fresh:
        return internal, seeded, False, total, len(chosen), age
    if not seeded:
        internal, seeded = ('shut' if total < p.off else 'open'), True
    if internal == 'open' and total < p.off:
        internal = 'shut'
    elif internal == 'shut' and total > p.on:
        internal = 'open'
    return internal, seeded, internal == 'shut', total, len(chosen), age


def resume_evidence(rows, halted_at, window, haircut=0):
    # The SQL LIMIT comes BEFORE the post-stop filter in production.
    chosen = outcome([r for r in rows[:window * 4] if r.scored > halted_at],
                     window, haircut=haircut)
    return sum(v for _, v in chosen), len(chosen)


class Tape:
    def __init__(self, observations, trades, start, end, delay=0, phase=0,
                 tick_ms=30_000, haircut=0, venue_on_score=False,
                 max_observations=800):
        self.start, self.end = start, end
        self.haircut = haircut
        self.trades = {t.id: t for t in trades if start <= t.entry < end}
        self.events = []
        for t in self.trades.values():
            self.events.append((t.entry, 2, t))
            if t.exit <= end:
                self.events.append((t.exit, 0, t))
        # Earliest fixture tick includes start. Production phase is unknowable across
        # restarts, so phase is a sensitivity parameter, not an invented exact clock.
        first = start + phase
        ordered = sorted(observations, key=lambda r: (r.scored, r.block, r.token))
        visible, i = [], 0
        for at in range(first, end + 1, tick_ms):
            while i < len(ordered) and ordered[i].scored + delay <= at:
                r = ordered[i]
                bisect.insort(visible, (-r.block, r.token, r))
                i += 1
            self.events.append((at, 1, tuple(x[2] for x in visible[:max_observations])))
        if venue_on_score:
            # The live in-process observation ring can refresh the venue between
            # housekeeping ticks. Its full history is absent. Immediate score-time
            # refresh is a timing sensitivity; DD recovery still only runs on ticks.
            visible=[]
            for r in ordered:
                bisect.insort(visible,(-r.block,r.token,r))
                at=r.scored+delay
                if start <= at <= end:
                    self.events.append((at,3,tuple(x[2] for x in visible[:max_observations])))
        self.events.sort(key=lambda x: (x[0], x[1], getattr(x[2], 'id', 0)))

    def simulate(self, p, through=None, initial=None):
        end = self.end if through is None else min(through, self.end)
        realized = peak = 0
        dd_halted = False
        halt_at = None
        lifts = 0
        day = self.start // DAY
        internal, seeded, venue_halted = 'open', False, False
        open_ids, kept = set(), set()
        cash, actions, decisions, readings, states = [], [], [], [], []
        if initial:
            realized = initial.get('realized', 0)
            peak = initial.get('peak', 0)
            dd_halted = initial.get('halted', False)
            halt_at = initial.get('halt_at')
            lifts = initial.get('lifts', 0)
        for at, kind, item in self.events:
            if at > end:
                break
            if at // DAY != day:
                day, lifts = at // DAY, 0
            if kind == 0:
                if item.id not in kept:
                    continue
                open_ids.discard(item.id)
                realized += item.pnl
                peak = max(peak, realized)
                # The production stop sees the booked ledger. Performance must also
                # pay wallet costs absent from that ledger, without silently changing
                # the production stop into a different policy.
                cash.append((at, item.id, item.pnl + item.wallet_adjustment))
                if p.drawdown and not dd_halted and peak - realized >= p.dd:
                    dd_halted, halt_at = True, at
                    actions.append(dict(at=at, action='stop', dd_wei=peak-realized))
            elif kind in (1,3):
                if p.venue:
                    internal, seeded, shut, total, n, age = venue_step(
                        item, at, p, internal, seeded, self.haircut)
                    # A DD stop outranks venue resume in RiskManager.resume().
                    if shut:
                        venue_halted = True
                    elif not dd_halted:
                        venue_halted = False
                    fresh = n >= p.window and age is not None and age <= p.fresh_h * HOUR
                    readings.append((at, venue_halted, fresh, total))
                if kind == 1 and dd_halted and not open_ids and lifts < p.lifts:
                    total, n = resume_evidence(item, halt_at, p.rwin, self.haircut)
                    if n >= p.rwin and total > p.ron:
                        dd_halted = False
                        lifts += 1
                        realized = peak = 0
                        actions.append(dict(at=at, action='resume', sum=total,
                                            n=n, lifts=lifts))
            else:
                reason = 'drawdown' if dd_halted else 'venue' if venue_halted else None
                if reason is None and sum(self.trades[x].size for x in open_ids) + item.size > 4 * SIZE:
                    reason = 'capacity'
                decisions.append((at, item.id, reason))
                if reason is None:
                    kept.add(item.id)
                    open_ids.add(item.id)
            states.append((at,dd_halted,venue_halted,len(open_ids)))
        return dict(start=self.start, end=end, cash=cash, actions=actions,
                    decisions=decisions, readings=readings, states=states,
                    open_ids=sorted(open_ids), final_halted=dd_halted,
                    final_lifts=lifts)


def metrics(result, start=None, end=None):
    start = result['start'] if start is None else start
    end = result['end'] if end is None else end
    rows = [(at, i, pnl) for at, i, pnl in result['cash'] if start <= at <= end]
    pnl = peak = dd = 0
    for _, _, x in rows:
        pnl += x
        peak = max(peak, pnl)
        dd = max(dd, peak - pnl)
    decisions = [r for r in result['decisions'] if start <= r[0] <= end]
    return dict(n=len(rows), pnl_eth=pnl / 1e18, maxdd_eth=dd / 1e18,
                returns_pct=describe(x / SIZE * 100 for _, _, x in rows),
                skipped=dict(collections.Counter(r[2] for r in decisions if r[2])),
                stops=sum(a['action']=='stop' and start <= a['at'] <= end for a in result['actions']),
                resumes=sum(a['action']=='resume' and start <= a['at'] <= end for a in result['actions']),
                open=len(result['open_ids']))


def distance(p, live):
    return (abs(p.dd-live.dd)/SIZE + abs(p.window-live.window)/20 + abs(p.off-live.off)
            + abs(p.on-live.on) + abs(p.rwin-live.rwin)/10 + abs(p.ron-live.ron))


def select(tape, candidates, live, boundary):
    base = metrics(tape.simulate(live, through=boundary))
    scores = [(p, metrics(tape.simulate(p, through=boundary))) for p in candidates]
    ok = [(p,m) for p,m in scores if m['maxdd_eth'] <= base['maxdd_eth'] + 1e-14]
    ok.sort(key=lambda x: (-round(x[1]['pnl_eth'], 12), distance(x[0], live), x[0].name))
    p, m = ok[0]
    tied = sum(abs(v['pnl_eth']-m['pnl_eth']) < 1e-12 for _,v in ok)
    return p, dict(selected=p.name, training=m, baseline=base, tied_best=tied,
                   candidates=len(scores), admissible=len(ok)), scores


def make_candidates(live):
    out = []
    venues = [(60,-4,.5), (40,-3,.5), (30,-2,1), (20,-1,1)]
    for dd, rw, ron, (w,off,on) in itertools.product((2,2.5,3,3.5), (15,20,30), (0,1,2), venues):
        name = f'dd{dd:g}_r{rw}_{ron:g}_v{w}_{off:g}_{on:g}'
        p = replace(live, name=name, dd=round(dd*SIZE), rwin=rw, ron=ron,
                    window=w, off=off, on=on)
        if distance(p,live)==0:
            p = replace(p,name='live')
        out.append(p)
    return out


def load_snapshot(path):
    data = json.loads(gzip.decompress(path.read_bytes()))
    launches = {r['token'].lower(): r for r in data['bot_launches']}
    obs, all_obs = [], []
    for r in data['gate_obs']:
        if r['error'] or not r['bars'] or not r['launched_at']:
            continue
        o = Observation(r['token'].lower(), r['block'], r['launched_at']*1000,
                        r['at'], json.loads(r['bars']))
        all_obs.append(o)
        l = launches.get(o.token, {})
        # Match production's SQL floors, including its lack of an upper tax bound.
        if (l.get('creator_tax_bps') or 0) >= 50 and (l.get('exemptions') or 0) >= 3:
            obs.append(o)
    primary = [r for r in data['bot_positions'] if r['id'] >= 2001 and r['live']
               and r['cohort']=='main' and int(r['spend_wei'] or 0)==SIZE]
    start = min(r['t_decide'] or r['t_detect'] for r in primary)
    closed = [r for r in primary if r['closed'] and r['buy_ok'] and r['exit_reason'] not in NON_TRADE]
    allocations,_ = wallet_allocations(data,start,data['snapshot_at'])
    trades = [Trade(r['id'], r['token'].lower(), r['t_decide'] or r['t_detect'],
                    r['exit_at'], net_wei(r),wallet_adjustment=allocations.get(r['id'],0)) for r in closed]
    return data, launches, obs, all_obs, closed, trades, start


def calibration(raw, obs, cutoff=None, allocations=None):
    bytok = {r.token:r for r in obs}
    pairs = []
    for t in raw:
        if cutoff is not None and t['exit_at'] >= cutoff:
            continue
        o = bytok.get(t['token'].lower())
        key = f"{t['take_profit']:.2f}" if t['take_profit'] else ''
        if o is None or key not in o.bars:
            continue
        # Fit-time calibration also cannot use a score not yet published.
        if cutoff is not None and o.scored >= cutoff:
            continue
        real = (net_wei(t)+(allocations or {}).get(t['id'],0)) / int(t['spend_wei'])
        pairs.append((o.bars[key], real))
    return dict(n=len(pairs), real=describe(r*100 for _,r in pairs),
                replay=describe(s*100 for s,_ in pairs),
                optimism_pp=describe((s-r)*100 for s,r in pairs),
                sign_disagree=sum((s>0)!=(r>0) for s,r in pairs),
                replay_positive_real_negative=sum(s>0 and r<=0 for s,r in pairs))


def bins(trades, now, era):
    out={}
    for hours,n in ((24,8),(168,7)):
        rows=[]
        for i in range(n):
            a=now-(n-i)*hours*HOUR//n; b=now-(n-i-1)*hours*HOUR//n
            t=[t for t in trades if a <= t.exit < b]
            rows.append(dict(start=iso(a),end=iso(b),era_coverage_h=max(0,b-max(a,era))/HOUR,
                             status='outside_era' if b<=era else 'partial_era' if a<era else 'covered',
                             n=len(t),pnl_eth=None if b<=era else sum(t.pnl+t.wallet_adjustment for t in t)/1e18,
                             returns_pct=describe((t.pnl+t.wallet_adjustment)/t.size*100 for t in t)))
        out[f'{hours}h']=rows
    return out


def coverage(launches, observations, start, end):
    eligible=[r for r in launches.values() if r.get('launched_at') and start <= r['launched_at']*1000 < end
              and r['passed'] and 50 <= (r['creator_tax_bps'] or 0) <= 200 and (r['exemptions'] or 0)>=3]
    have={r.token for r in observations if r.scored <= end and BAR in r.bars}
    lags=[(r.scored-r.launched)/1000 for r in observations if start <= r.launched < end]
    return dict(eligible=len(eligible),observed=sum(r['token'].lower() in have for r in eligible),
                score_lag_seconds=describe(lags),
                recorded_entry_rejects=dict(collections.Counter(r['entry_reject'] for r in eligible)))


def unknown_entries(result, launches):
    times=[x[0] for x in result['states']]
    possible=[]
    for r in launches.values():
        reason=r.get('entry_reject') or ''
        at=r.get('entry_reject_at') or r['detected_at']
        if not (result['start'] <= at <= result['end'] and reason.startswith('halted:')
                and r['passed'] and 50 <= (r['creator_tax_bps'] or 0) <= 200
                and (r['exemptions'] or 0)>=3):
            continue
        i=bisect.bisect_right(times,at)-1
        if i>=0:
            _,dd,venue,opened=result['states'][i]
            if not dd and not venue and opened<4:
                possible.append(dict(token=r['token'],at=at,original_reject=reason))
    return possible


def paired_blocks(a,b,now,start,repeats=5000):
    """Descriptive paired block resampling. Five blocks are not five independent days."""
    aa={i:pnl for _,i,pnl in a['cash']}; bb={i:pnl for _,i,pnl in b['cash']}
    times={i:at for at,i,_ in a['cash']+b['cash']}
    blocks=[]
    for k in range(8):
        lo=now-(8-k)*3*HOUR;hi=lo+3*HOUR
        if hi<=start:continue
        blocks.append(sum(bb.get(i,0)-aa.get(i,0) for i,t in times.items() if lo<=t<hi)/1e18)
    rng=random.Random(0)
    res=sorted(sum(rng.choices(blocks,k=len(blocks))) for _ in range(repeats))
    return dict(block_hours=3,n_blocks=len(blocks),block_delta_eth=blocks,
                delta_eth=sum(blocks),percentile_90_eth=[res[int(.05*repeats)],res[int(.95*repeats)]],
                warning='Descriptive only: few dependent blocks, post-selection, not a significance test.')


def wallet_check(data,start,end):
    flats=sorted((r for r in data['bot_balance'] if r['open_n']==0),key=lambda r:r['at'])
    before=[r for r in flats if r['at']<=start]
    after=[r for r in flats if r['at']<=end]
    if not before or not after:return {'verified':False}
    a,b=before[-1],after[-1]
    ps=[r for r in data['bot_positions'] if r['live'] and r['closed'] and r['exit_at']
        and a['at']<r['exit_at']<=b['at']]
    change=int(b['wei'])-int(a['wei']);book=sum(net_wei(r) for r in ps)
    return dict(from_=iso(a['at']),to=iso(b['at']),wallet_change_eth=change/1e18,
                booked_eth=book/1e18,difference_eth=(change-book)/1e18,
                note='Matching flat samples; residual can include transfers or unbooked gas.')


def wallet_allocations(data,start,end):
    """Allocate measured wallet-minus-book residual, retaining the booked stop ledger.

    A single-trade flat interval gives an exact allocation. Multi-trade intervals use
    equal shares, with integer remainders on the earliest ids. This does not establish
    the source of a residual. The accompanying audit checks approval receipts separately.
    """
    flats=sorted((r for r in data['bot_balance'] if r['open_n']==0 and r['at']<=end),key=lambda r:r['at'])
    # Repaired stranded positions can contradict an old open_n=0 sample. Principal
    # still deployed in those holdings must not become another trade's inferred gas.
    holdings=[(r.get('t_decide') or r.get('t_detect'),r.get('exit_at') or end+1)
              for r in data['bot_positions'] if r.get('live') and r.get('buy_ok')
              and (r.get('t_decide') or r.get('t_detect')) is not None]
    recorded_flat_n=len(flats)
    flats=[r for r in flats if not any(a<=r['at']<b for a,b in holdings)]
    false_flat_n=recorded_flat_n-len(flats)
    before=[r for r in flats if r['at']<=start]
    if not before:return {},{'available':False}
    flats=[before[-1]]+[r for r in flats if r['at']>start]
    positions=[r for r in data['bot_positions'] if r['live'] and r['closed'] and r['exit_at']
               and flats[0]['at']<r['exit_at']<=flats[-1]['at']]
    allocations={};groups=[];unallocated=0
    for a,b in zip(flats,flats[1:]):
        ps=sorted((r for r in positions if a['at']<r['exit_at']<=b['at']),key=lambda r:r['id'])
        residual=int(b['wei'])-int(a['wei'])-sum(net_wei(r) for r in ps)
        if not residual:continue
        if not ps:
            unallocated+=residual
            continue
        each,remainder=divmod(residual,len(ps))
        for i,p in enumerate(ps):allocations[p['id']]=each+(i<remainder)
        groups.append(dict(ids=[p['id'] for p in ps],residual_eth=residual/1e18))
    return allocations,dict(groups=len(groups),single_trade_groups=sum(len(g['ids'])==1 for g in groups),
                            false_flat_samples_removed=false_flat_n,
                            allocated_trades=len(allocations),unallocated_eth=unallocated/1e18,
                            total_eth=sum(allocations.values())/1e18,
                            per_trade_cost_eth=describe(-v/1e18 for v in allocations.values()),
                            detail=groups)


def missing_fill_scenarios(launches,all_observations,trades,start,end,policies,fee):
    """Sensitivity only, not reconstructed trades or calibrated profit forecasts.

    Add launches rejected solely at the recorded halt check. Pin the adaptive target
    using only scores visible then. Use the observer's 0.01 ETH outcome as a proxy for
    a 0.02 ETH fill, stress its return by +/-20 percentage points, and assume a 45s
    hold. These are deliberately disclosed assumptions. Other path-dependent entry
    filters and impact cannot be recovered from the available cache.
    """
    bytok={r.token:r for r in all_observations}
    ordered=sorted(all_observations,key=lambda r:r.scored)
    score_times=[r.scored for r in ordered]
    imputed=[];unpriced=[]
    for r in launches.values():
        at=r.get('entry_reject_at') or r['detected_at']
        if not (start <= at < end-45_000 and (r.get('entry_reject') or '').startswith('halted:')
                and r['passed'] and 50 <= (r['creator_tax_bps'] or 0) <= 200
                and (r['exemptions'] or 0)>=3):continue
        visible=sorted(ordered[:bisect.bisect_right(score_times,at)],key=lambda r:-r.block)[:20]
        keys=['1.25','1.36','1.50','1.75','2.00','2.50','3.00']
        key=max(keys,key=lambda k:sum(o.bars.get(k,0) for o in visible)) if len(visible)>=20 else BAR
        o=bytok.get(r['token'].lower())
        if o is None or key not in o.bars:
            unpriced.append(r['token'])
            continue
        imputed.append((r['token'],at,o.bars[key],key))
    results=[]
    for shift in (-.20,0,.20):
        added=[Trade(-i-1,token,at,at+45_000,round(SIZE*(value+shift)),
                     wallet_adjustment=-fee) for i,(token,at,value,key) in enumerate(imputed)]
        # Primary signal observations remain the same current-book cohort.
        book=[o for o in all_observations if (launches.get(o.token,{}).get('creator_tax_bps') or 0)>=50
              and (launches.get(o.token,{}).get('exemptions') or 0)>=3]
        tape=Tape(book,trades+added,start,end)
        for p in policies:
            rr=tape.simulate(p)
            results.append(dict(return_shift_pp=shift*100,policy=p.name,metrics=metrics(rr),
                                synthetic_fills=sum(i<0 for _,i,_ in rr['cash'])))
    return dict(imputed_launches=len(imputed),unpriced_launches=len(unpriced),
                assumed_hold_seconds=45,results=results,
                warning='Post-selection scenario analysis; proxy stake is 0.01 ETH, actual stake is 0.02 ETH. Not a profit forecast.')


def live_event_check(data, observations, trades):
    epoch=json.loads(next(r['value'] for r in data['bot_chain_truth'] if r['key']=='epoch_base_prev'))
    resume_at=epoch['at']
    stops=sorted(r['at'] for r in data['bot_health'] if r['component']=='halt'
                 and (r['detail'] or '').startswith('[drawdown]'))
    previous=max(x for x in stops if x < resume_at)
    visible=sorted((r for r in observations if r.scored <= resume_at),key=lambda r:(-r.block,r.token))
    total,n=resume_evidence(visible,previous,20)
    logged_sum=float(epoch['why'].split('venue paid +',1)[1].split(' ',1)[0])
    if n!=20 or round(total,2)!=logged_sum:
        raise ValueError('The reconstructed restart signal does not match the recorded event.')
    after=[t for t in trades if t.entry >= resume_at]
    tape=Tape(observations,after,resume_at,data['snapshot_at'],phase=0)
    result=tape.simulate(Policy())
    subsequent=[x for x in stops if x>resume_at]
    reconstructed=[x['at'] for x in result['actions'] if x['action']=='stop']
    if not subsequent or not reconstructed or abs(subsequent[0]-reconstructed[0])>30_000:
        raise ValueError('The recorded post-resume stop is not reproduced within one housekeeping interval.')
    return dict(recorded_resume_at=iso(resume_at),recorded_reason=epoch['why'],
                reconstructed_sum=total,reconstructed_n=n,actual_stops=[iso(x) for x in stops],
                replay_actions=[{**a,'time':iso(a['at'])} for a in result['actions']],
                post_resume=metrics(result),
                note='Historical receipt-correction time is missing; final booked P&L is charged at recorded exit.')


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--snapshot',type=Path,required=True)
    ap.add_argument('--out',type=Path,required=True)
    args=ap.parse_args()
    data,launches,obs,all_obs,raw,trades,start=load_snapshot(args.snapshot)
    now=data['snapshot_at']; cut=now-6*HOUR
    cfg=data['state']['config']['values']
    live=Policy(window=int(cfg['venuePauseWindow']),off=cfg['venuePauseOff'],on=cfg['venuePauseOn'],
                fresh_h=cfg['venueFreshHours'],dd=round(cfg['maxDrawdownEth']*1e18),
                rwin=int(cfg['ddResumeWindow']),ron=cfg['ddResumeOn'])
    assert cfg['tradeSizeEth']==.02, 'This frozen protocol is for the 0.02 ETH era.'
    candidates=make_candidates(live)
    print('Building causal tape',flush=True)
    tape=Tape(obs,trades,start,now)
    chosen,selection,scores=select(tape,candidates,live,cut)
    print('Training selection',selection['selected'],'ties',selection['tied_best'],flush=True)
    named=[live,chosen,replace(live,name='no_added_guards',venue=False,drawdown=False),
           replace(live,name='old_0.112_stop',dd=112_000_000_000_000_000),
           replace(live,name='one_restart_per_day',lifts=1),replace(live,name='no_auto_restart',lifts=0),
           replace(live,name='restart_above_1',ron=1),replace(live,name='restart_above_2',ron=2),
           replace(live,name='faster_venue_30',window=30,off=-2,on=1),
           replace(live,name='faster_venue_20',window=20,off=-1,on=1)]
    named=list({p.name:p for p in named}.values())
    comparisons=[]
    for p in named:
        r=tape.simulate(p)
        comparisons.append(dict(policy=asdict(p),full=metrics(r),fit=metrics(r,end=cut),
                                recency=metrics(r,start=cut+1),
                                unknown_entries=unknown_entries(r,launches),
                                actions=[{**a,'time':iso(a['at'])} for a in r['actions']]))
    # Historical forward selection, maintaining the full prior path for each policy.
    folds=[]
    boundary=start+6*HOUR
    while boundary+3*HOUR <= now:
        p,sel,_=select(tape,candidates,live,boundary)
        end=boundary+3*HOUR
        folds.append(dict(train_end=iso(boundary),test_end=iso(end),selection=sel,
                          chosen=metrics(tape.simulate(p,through=end),start=boundary+1),
                          live=metrics(tape.simulate(live,through=end),start=boundary+1)))
        boundary=end
    allocations,allocation_summary=wallet_allocations(data,start,now)
    fit_cal=calibration(raw,obs,cut,allocations)
    haircut=max(0,fit_cal['optimism_pp']['mean'] or 0)/100
    sensitivities=[]
    # Even a non-positive fitted mean bias has uncertainty. Add a fixed 5pp adverse
    # signal perturbation as an explicitly labelled, post-audit stress, not a fit.
    for delay,phase,hc,fast in [(0,0,0,False),(0,10_000,0,False),(0,20_000,0,False),
                              (60_000,0,0,False),(180_000,0,0,False),(0,0,haircut,False),
                              (0,0,.05,False),(0,0,0,True)]:
        alt=Tape(obs,trades,start,now,delay=delay,phase=phase,haircut=hc,venue_on_score=fast)
        for p in named:
            r=alt.simulate(p)
            sensitivities.append(dict(delay_ms=delay,phase_ms=phase,haircut_pp=hc*100,
                                      venue_on_score=fast,
                                      policy=p.name,full=metrics(r),recency=metrics(r,start=cut+1)))
    # Pareto frontier is retrospective description, never selection on the holdout.
    all_scores=[]
    for p in candidates:
        m=metrics(tape.simulate(p))
        all_scores.append(dict(policy=asdict(p),metrics=m))
    frontier=[r for r in all_scores if not any(
        q['metrics']['pnl_eth'] >= r['metrics']['pnl_eth']-1e-14
        and q['metrics']['maxdd_eth'] <= r['metrics']['maxdd_eth']+1e-14
        and (q['metrics']['pnl_eth'] > r['metrics']['pnl_eth']+1e-14
             or q['metrics']['maxdd_eth'] < r['metrics']['maxdd_eth']-1e-14)
        for q in all_scores)]
    strict=int(dt.datetime(2026,9,7,1,21,2,tzinfo=dt.timezone.utc).timestamp()*1000)
    strict_tape=Tape(obs,[t for t in trades if t.entry>=strict],strict,now)
    strict_results=[dict(policy=p.name,metrics=metrics(strict_tape.simulate(p))) for p in named]
    other_costs=[r for r in data['bot_positions'] if r['live'] and r['closed'] and r['exit_at']
                 and start <= r['exit_at'] <= now and r['exit_reason'] in NON_TRADE and net_wei(r)]
    missing_stress=missing_fill_scenarios(launches,all_obs,trades,start,now,named,
                                         round(-sum(allocations.values())/len(trades)))
    out=dict(snapshot=dict(at=iso(now),sha256=hashlib.sha256(args.snapshot.read_bytes()).hexdigest(),
                           protocol_sha256=hashlib.sha256(Path(__file__).with_name('GUARD_AUDIT_PROTOCOL.md').read_bytes()).hexdigest()),
             scope=dict(era_start=iso(start),recency_boundary=iso(cut),n=len(trades),size_eth=.02,
                        calendar_days=len({t.exit//DAY for t in trades}),
                        receipts_missing=sum(r['onchain_pnl_wei'] is None for r in raw),
                        other_costs_eth=sum(net_wei(r) for r in other_costs)/1e18,
                        strict_era_start=iso(strict)),
             actual=describe((t.pnl+t.wallet_adjustment)/1e18 for t in trades),
             actual_booked=describe(t.pnl/1e18 for t in trades),bins=bins(trades,now,start),
             wallet=wallet_check(data,start,now),
             wallet_allocations=allocation_summary,
             coverage=coverage(launches,obs,start,now),
             calibration=calibration(raw,obs,allocations=allocations),fit_calibration=fit_cal,
             live_event=live_event_check(data,obs,trades),selection=selection,
             comparisons=comparisons,forward_folds=folds,sensitivities=sensitivities,
             paired_blocks=paired_blocks(tape.simulate(live),tape.simulate(chosen),now,start),
             strict_era=strict_results,frontier=frontier,candidate_scores=all_scores,
             missing_fill_stress=missing_stress,
             data_limits=['Only actual trades can be removed; skipped fills and feedback are unobserved.',
                          'No primary profits from earlier sizes or probes.',
                          'The final six hours were already inspected; this is not a virgin holdout.',
                          'Observer timestamps are actual scoring times; receipt correction times are missing.',
                          'In-process touch and execution-health histories are not fully reproducible.',
                          'Timing stress is partial model uncertainty, not a proof of future profitability.'])
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(out,indent=2)+'\n')
    for c in comparisons:
        print(c['policy']['name'], 'full',c['full']['pnl_eth'], 'DD',c['full']['maxdd_eth'],
              'recency',c['recency']['pnl_eth'],flush=True)
    print('Wrote',args.out,flush=True)


if __name__=='__main__':
    main()
