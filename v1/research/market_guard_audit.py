"""Offline market guard research. See MARKET_GUARD_PROTOCOL.md for scope and limits."""
from __future__ import annotations

import argparse
import bisect
import collections
from dataclasses import dataclass, replace, asdict
import gzip
import hashlib
import itertools
import json
from pathlib import Path
import random

from guard_audit import (Observation, Trade, Policy, Tape, SIZE, HOUR, DAY, BAR,
                         NON_TRADE, describe, iso, net_wei, outcome, metrics,
                         wallet_allocations)

ERA = 1788789327189
STRICT = 1788820440000  # 2026-09-07 22:34 UTC deployment, diagnostic subset only.


@dataclass(frozen=True)
class Candidate(Policy):
    window: int = 20
    off: float = -1
    on: float = 1
    family: str = 'baseline'
    on_count: int = 1
    off_count: int = 1
    dwell_ms: int = 0
    cooldown_ms: int = 0
    short_confirm: bool = False
    stale: str = 'open'
    recovery_count: int = 1
    recovery_market: bool = False


@dataclass(frozen=True)
class Frame:
    total: float
    fresh: bool
    signature: tuple
    short: float


class Streak:
    def __init__(self):
        self.count = 0
        self.since = None
        self.signature = None

    def update(self, valid, signature, at):
        if not valid:
            self.count, self.since, self.signature = 0, None, None
        elif signature != self.signature:
            self.count += 1
            if self.since is None:
                self.since = at
            self.signature = signature


class Market:
    def __init__(self):
        self.shut = False
        self.paused_at = None
        self.above, self.below = Streak(), Streak()

    def update(self, frame, at, p, decide):
        self.above.update(frame.fresh and frame.total > p.on,
                          frame.signature, at)
        self.below.update(frame.fresh and frame.total < p.off,
                          frame.signature, at)
        if not decide:
            return self.shut
        if not frame.fresh:
            return False if p.stale == 'open' else True if p.stale == 'shut' else self.shut
        if not self.shut and self.below.count >= p.off_count:
            self.shut, self.paused_at = True, at
            self.above = Streak()
        elif self.shut and self.above.count >= p.on_count:
            dwell = at - self.above.since >= p.dwell_ms
            cooldown = at - self.paused_at >= p.cooldown_ms
            if dwell and cooldown and (not p.short_confirm or frame.short > 0):
                self.shut = False
                self.below = Streak()
        return self.shut


class Experiment(Tape):
    def __init__(self, observations, trades, start, end, *, tick_confirm=False, **kwargs):
        super().__init__(observations, trades, start, end, venue_on_score=True, **kwargs)
        self.tick_confirm = tick_confirm
        self.frames = {}

    def prepare(self, p):
        key = (p.window, p.fresh_h)
        if key not in self.frames:
            frames = {}
            for i, (at, kind, rows) in enumerate(self.events):
                if kind not in (1, 3):
                    continue
                selected = outcome(rows[:p.window * 2], p.window, haircut=self.haircut)
                frames[i] = Frame(
                    sum(v for _, v in selected),
                    len(selected) >= p.window and at - selected[-1][0].launched <= p.fresh_h * HOUR,
                    tuple(r.token for r, _ in selected),
                    sum(v for _, v in selected[:5]))
            self.frames[key] = frames
        return self.frames[key]

    def simulate(self, p, through=None, initial=None):
        end = min(through, self.end) if through is not None else self.end
        initial = initial or {}
        realized, peak = initial.get('realized', 0), initial.get('peak', 0)
        dd_halted, halt_at = initial.get('halted', False), initial.get('halt_at')
        lifts, day = initial.get('lifts', 0), self.start // DAY
        market, recovery = Market(), Streak()
        venue_halted = False
        open_ids, kept = set(), set()
        cash, actions, decisions, readings, states = [], [], [], [], []
        frames = self.prepare(p)
        for i, (at, kind, item) in enumerate(self.events):
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
                cash.append((at, item.id, item.pnl + item.wallet_adjustment))
                if p.drawdown and not dd_halted and peak - realized >= p.dd:
                    dd_halted, halt_at, recovery = True, at, Streak()
                    actions.append(dict(at=at, action='stop', dd_wei=peak-realized))
            elif kind in (1, 3):
                if kind == 3 and self.tick_confirm:
                    continue
                frame = frames[i]
                shut = market.update(frame, at, p, kind == 1) if p.venue else False
                if kind == 1:
                    previous = venue_halted
                    if shut:
                        venue_halted = True
                    elif not dd_halted:
                        venue_halted = False
                    if previous != venue_halted:
                        actions.append(dict(at=at, action='venue_stop' if venue_halted else 'venue_resume',
                                            sum=frame.total, fresh=frame.fresh))
                    readings.append((at, venue_halted, frame.fresh, frame.total))
                if dd_halted:
                    selected = outcome([r for r in item[:p.rwin * 4] if r.scored > halt_at],
                                       p.rwin, haircut=self.haircut)
                    total = sum(v for _, v in selected)
                    valid = len(selected) >= p.rwin and total > p.ron
                    if p.recovery_market:
                        valid = valid and frame.fresh and frame.total > p.on
                    recovery.update(valid, tuple(r.token for r, _ in selected), at)
                    if kind == 1 and not open_ids and lifts < p.lifts and recovery.count >= p.recovery_count:
                        dd_halted = False
                        lifts += 1
                        realized = peak = 0
                        actions.append(dict(at=at, action='resume', sum=total, n=len(selected), lifts=lifts))
            else:
                reason = 'drawdown' if dd_halted else 'venue' if venue_halted else None
                if reason is None and sum(self.trades[j].size for j in open_ids) + item.size > 4 * SIZE:
                    reason = 'capacity'
                decisions.append((at, item.id, reason))
                if reason is None:
                    kept.add(item.id)
                    open_ids.add(item.id)
            states.append((at, dd_halted, venue_halted, len(open_ids)))
        return dict(start=self.start, end=end, cash=cash, actions=actions,
                    decisions=decisions, readings=readings, states=states,
                    open_ids=sorted(open_ids), final_halted=dd_halted, final_lifts=lifts)


def candidates():
    base = Candidate()
    result = [base]
    def add(family, **kw):
        p = replace(base, family=family, **kw)
        if all(getattr(p, k) == getattr(base, k) for k in kw):
            return
        name = family + '_' + '_'.join(f'{k}={v}' for k, v in kw.items())
        result.append(replace(p, name=name))
    for w, off, on in itertools.product((10,15,20,30,40), (-.5,-1,-2,-3), (0,.5,1,2,3)):
        add('threshold', window=w, off=off, on=on)
    for count in (2,3,5,8):
        add('resume_persistence', on_count=count)
        add('pause_persistence', off_count=count)
        add('both_persistence', on_count=count, off_count=count)
    for w, off, on, count in itertools.product((15,20,30), (-.5,-1,-2), (.5,1,2), (2,3,5)):
        add('threshold_persistence', window=w, off=off, on=on, on_count=count)
    for minutes in (2,5,10,20):
        add('dwell', dwell_ms=minutes*60_000)
    for minutes in (5,15,30):
        add('cooldown', cooldown_ms=minutes*60_000)
    add('short_confirmation', short_confirm=True)
    for stale in ('retain','shut'):
        add('stale', stale=stale)
    for ron in (.5,1,2):
        add('drawdown_threshold', ron=ron)
    for count in (2,3,5):
        add('drawdown_persistence', recovery_count=count)
    add('drawdown_market', recovery_market=True)
    # Remove identical policies reached through two family descriptions.
    unique = {}
    for p in result:
        key = tuple((k,v) for k,v in asdict(p).items() if k not in ('name','family'))
        unique.setdefault(key,p)
    return list(unique.values())


def simplicity(p):
    base = Candidate()
    fields = [k for k in asdict(p) if k not in ('name','family')]
    changed = sum(getattr(p,k) != getattr(base,k) for k in fields)
    distance = abs(p.window-20)/20 + abs(p.off+1) + abs(p.on-1)
    distance += p.on_count-1 + p.off_count-1 + p.recovery_count-1 + abs(p.ron)
    distance += (p.dwell_ms+p.cooldown_ms)/60_000
    return changed, distance, p.name


def selection(scores, policies):
    byname = {p.name:p for p in policies}
    baseline = scores['live']
    allowed = [p for p in policies if scores[p.name]['maxdd_eth'] <= baseline['maxdd_eth']+1e-14]
    allowed.sort(key=lambda p: (-round(scores[p.name]['pnl_eth'],12),simplicity(p)))
    best = allowed[0]
    return best, dict(selected=best.name, candidates=len(policies), admissible=len(allowed),
                     ties=sum(abs(scores[p.name]['pnl_eth']-scores[best.name]['pnl_eth'])<1e-12 for p in allowed))


def load(path, start=ERA, require_size=SIZE):
    data = json.load(gzip.open(path,'rt'))
    now = data['snapshot_at']
    launches = {r['token'].lower():r for r in data['bot_launches']}
    obs, all_obs = [], []
    for r in data['gate_obs']:
        if r['error'] or not r['bars'] or not r['launched_at'] or r['at'] > now:
            continue
        o = Observation(r['token'].lower(),r['block'],r['launched_at']*1000,r['at'],json.loads(r['bars']))
        all_obs.append(o)
        l = launches.get(o.token,{})
        if (l.get('creator_tax_bps') or 0)>=50 and (l.get('exemptions') or 0)>=3:
            obs.append(o)
    # A historically stranded holding was once marked closed, then repaired. Its
    # old balance.open_n=0 samples are not flat under the corrected holding history.
    # Do not misallocate its temporarily deployed principal as gas on another coin.
    allocations, wallet = wallet_allocations(data,start,now)
    raw = [p for p in data['bot_positions'] if p['live'] and p['closed'] and (p['cohort'] or 'main')=='main'
           and start <= (p['t_decide'] or p['t_detect'] or 0) < now and (p['exit_at'] or now+1)<=now]
    if require_size is not None:
        assert all(int(p['spend_wei'])==require_size for p in raw)
    trades = [Trade(p['id'],p['token'].lower(),p['t_decide'] or p['t_detect'],p['exit_at'],
                    net_wei(p),size=int(p['spend_wei']),wallet_adjustment=allocations.get(p['id'],0)) for p in raw]
    return data, launches, obs, all_obs, raw, trades, wallet


def detailed(result, failed, start=None, end=None, sizes=None):
    m = metrics(result,start,end)
    a = result['start'] if start is None else start
    b = result['end'] if end is None else end
    cash = [r for r in result['cash'] if a<=r[0]<=b]
    vals = [v/1e18 for _,i,v in cash if i not in failed]
    m['attempts'] = m['n']
    m['n'] = len(vals)
    m['failed_buys'] = sum(i in failed for _,i,_ in cash)
    m['pnl_distribution_eth'] = describe(vals)
    m['returns_pct'] = describe(v/(sizes or {}).get(i,SIZE)*100 for _,i,v in cash if i not in failed)
    m['without_best_eth'] = sum(v for _,_,v in cash)/1e18 - max([0]+vals)
    return m


def difference(result, baseline, trades, start, end):
    actual = {i:v for at,i,v in result['cash'] if start<=at<=end}
    base = {i:v for at,i,v in baseline['cash'] if start<=at<=end}
    removed = [v/1e18 for i,v in base.items() if i not in actual]
    added = [v/1e18 for i,v in actual.items() if i not in base]
    return dict(delta_eth=(sum(actual.values())-sum(base.values()))/1e18,
                gross_winners_forgone_eth=sum(v for v in removed if v>0),
                gross_losses_avoided_eth=-sum(v for v in removed if v<0),
                added_pnl_eth=sum(added),removed_n=len(removed),added_n=len(added))


def missing(launches, all_obs, raw, now, cut, start=ERA):
    ordered = sorted(all_obs,key=lambda r:r.scored)
    times = [r.scored for r in ordered]
    bytoken = {r.token:r for r in ordered}
    actual_tokens = {p['token'].lower() for p in raw}
    rows, unpriced = [], []
    for l in launches.values():
        at = l.get('entry_reject_at') or l['detected_at'] or 0
        if not (start<=at<now-90_000 and l['passed'] and (l['creator_tax_bps'] or 0)>=50
                and (l['exemptions'] or 0)>=3 and (l.get('entry_reject') or '').startswith('halted:')):
            continue
        if l['token'].lower() in actual_tokens:
            continue
        visible = sorted(ordered[:bisect.bisect_right(times,at)],key=lambda r:(-r.block,r.token))[:20]
        keys = ['1.25','1.36','1.50','1.75','2.00','2.50','3.00']
        key = max(keys,key=lambda k:sum(o.bars.get(k,0) for o in visible)) if len(visible)>=20 else BAR
        o = bytoken.get(l['token'].lower())
        if o is None or key not in o.bars:
            unpriced.append(l['token'])
        else:
            rows.append(dict(token=l['token'].lower(),at=at,value=o.bars[key],bar=key))
    gas = []
    for p in raw:
        if p['exit_at']>cut or p['exit_reason'] in NON_TRADE:
            continue
        gas.append(sum(int(p.get(k) or 0) for k in ('gas_wei','burned_gas_wei','approval_gas_wei','graduation_prep_gas_wei')))
    return rows, unpriced, round(sum(gas)/len(gas)) if gas else 0, describe(v/1e18 for v in gas)


def windows(trades, now):
    result = {}
    for label,span,n in [('24h',DAY,8),('7d',7*DAY,7)]:
        result[label] = []
        for i in range(n):
            a,b = now-span+i*span//n, now-span+(i+1)*span//n
            result[label].append(dict(start=iso(a),end=iso(b),
                coverage='unavailable' if b<=ERA else 'partial' if a<ERA else 'current-era',
                stats=describe((t.pnl+t.wallet_adjustment)/1e18 for t in trades if max(a,ERA)<=t.exit<b)))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args = parser.parse_args()
    data, launches, obs, all_obs, raw, trades, wallet = load(args.snapshot)
    now, cut = data['snapshot_at'], data['snapshot_at']-6*HOUR
    failed = {p['id'] for p in raw if p['exit_reason'] in NON_TRADE}
    policies = candidates()
    live = policies[0]
    cfg = data['state']['config']['values']
    assert (cfg['tradeSizeEth'],cfg['venuePauseWindow'],cfg['venuePauseOff'],cfg['venuePauseOn'],cfg['maxDrawdownEth']) == (.02,20,-1,1,.06)
    tape = Experiment(obs,trades,ERA,now)
    results = {p.name:tape.simulate(p) for p in policies}
    fit = {p.name:detailed(results[p.name],failed,end=cut) for p in policies}
    winner, selected = selection(fit,policies)
    args.out.with_name('frozen_selection.json').write_text(json.dumps(dict(
        selection=selected,policy=asdict(winner),fit_end=iso(cut),
        snapshot_sha256=hashlib.sha256(args.snapshot.read_bytes()).hexdigest()),indent=2)+'\n')
    print('Frozen choice',selected,flush=True)
    family_choices = {}
    for family in sorted({p.family for p in policies}):
        pool = [live]+[p for p in policies if p.family==family and p.name!='live']
        choice, detail = selection(fit,pool)
        family_choices[family] = detail
    names = {'live',winner.name}|{v['selected'] for v in family_choices.values()}
    # Explicit user-requested persistence cases remain visible even when not selected.
    names.update(p.name for p in policies if p.family in ('resume_persistence','drawdown_persistence','drawdown_market'))
    shortlist = [p for p in policies if p.name in names]
    diagnostics = [replace(live,name='no_market_pause',family='diagnostic',venue=False),
                   replace(live,name='no_added_guards',family='diagnostic',venue=False,drawdown=False)]
    for p in diagnostics:
        results[p.name]=tape.simulate(p)
    comparison=[]
    for p in shortlist+diagnostics:
        rr=results[p.name]
        comparison.append(dict(policy=asdict(p),fit=detailed(rr,failed,end=cut),
            recency=detailed(rr,failed,start=cut+1),full=detailed(rr,failed),
            strict=detailed(rr,failed,start=STRICT),
            delta=difference(rr,results['live'],trades,ERA,now),
            actions=[dict(a,time=iso(a['at'])) for a in rr['actions']]))
    folds=[]
    boundary=ERA+6*HOUR
    while boundary+3*HOUR<=now:
        scores={p.name:detailed(results[p.name],failed,end=boundary) for p in policies}
        chosen,sel=selection(scores,policies)
        folds.append(dict(fit_end=iso(boundary),test_end=iso(boundary+3*HOUR),selection=sel,
            chosen=detailed(results[chosen.name],failed,start=boundary+1,end=boundary+3*HOUR),
            live=detailed(results['live'],failed,start=boundary+1,end=boundary+3*HOUR)))
        boundary+=3*HOUR
    stress=[]
    for label,opts in [('delay60',dict(delay=60_000)),('delay180',dict(delay=180_000)),
                       ('phase10',dict(phase=10_000)),('phase20',dict(phase=20_000)),
                       ('one_confirmation_per_tick',dict(tick_confirm=True)),('signal_minus5pp',dict(haircut=.05))]:
        alt=Experiment(obs,trades,ERA,now,**opts)
        base=alt.simulate(live)
        for p in shortlist:
            rr=alt.simulate(p)
            stress.append(dict(case=label,policy=p.name,full=detailed(rr,failed),
                recency=detailed(rr,failed,start=cut+1),delta_eth=difference(rr,base,trades,ERA,now)['delta_eth']))
    imputed,unpriced,fee,fees=missing(launches,all_obs,raw,now,cut)
    scenarios=[]
    for shift,hold in [(-.20,45),(0,45),(.20,45),(0,20),(0,90)]:
        added=[Trade(-i-1,r['token'],r['at'],r['at']+hold*1000,
                     round(SIZE*(max(-1,r['value']+shift)))-fee) for i,r in enumerate(imputed)]
        alt=Experiment(obs,trades+added,ERA,now)
        base=alt.simulate(live)
        for p in shortlist+diagnostics:
            rr=alt.simulate(p)
            scenarios.append(dict(shift_pp=shift*100,hold_seconds=hold,policy=p.name,
                full=detailed(rr,failed),recency=detailed(rr,failed,start=cut+1),
                synthetic_fills=sum(i<0 for _,i,_ in rr['cash']),
                delta_eth=difference(rr,base,trades+added,ERA,now)['delta_eth']))
    legacy=Tape(obs,trades,ERA,now).simulate(live)
    assert legacy['cash']==results['live']['cash'], 'Baseline differs from the established guard simulator'
    # Validate recorded sensor values at their own timestamps, without phase assumptions.
    ordered=sorted(obs,key=lambda r:r.scored);times=[r.scored for r in ordered]
    errors=[];matched=0;cached_matches=0;signal_cache={}
    def signal(index):
        if index not in signal_cache:
            visible=sorted(ordered[:index],key=lambda o:(-o.block,o.token))
            values=outcome(visible[:40],20)
            signal_cache[index]=sum(v for _,v in values) if len(values)==20 else None
        return signal_cache[index]
    for r in data['bot_guard_samples']:
        if not (ERA<=r['at']<=now and r['market_fresh'] and r['market'] is not None):continue
        index=bisect.bisect_right(times,r['at']);value=signal(index)
        if value is not None:
            error=value-r['market'];errors.append(error)
            matched+=abs(error)<1e-8
            first=bisect.bisect_right(times,r['at']-30_000)
            cached_matches+=any(signal(j) is not None and abs(signal(j)-r['market'])<1e-8
                                for j in range(first,index+1))
    recorded_resumes=[]
    for r in data['bot_health']:
        if r['at']>=ERA and r['component']=='drawdown' and (r['detail'] or '').startswith('auto-resumed:'):
            actions=[a for a in results['live']['actions'] if a['action']=='resume']
            closest=min(actions,key=lambda a:abs(a['at']-r['at'])) if actions else None
            recorded_resumes.append(dict(at=iso(r['at']),detail=r['detail'],simulated=closest,
                difference_ms=abs(closest['at']-r['at']) if closest else None))
    actual_by_token={p['token'].lower():p for p in raw if p['id'] not in failed}
    calibration=[]
    for o in all_obs:
        p=actual_by_token.get(o.token)
        if not p or p['take_profit'] is None:continue
        value=o.bars.get(f"{p['take_profit']:.2f}")
        if value is None:continue
        calibration.append(dict(at=p['exit_at'],replay=value*100,actual=net_wei(p)/SIZE*100,
                                gap=(value-net_wei(p)/SIZE)*100))
    actual_cash=sum(t.pnl+t.wallet_adjustment for t in trades)/1e18
    assert len({t.id for t in trades})==len(trades)
    assert len({o.token for o in obs})==len(obs)
    assert all(t.entry<=t.exit<=now for t in trades)
    assert cached_matches==len(errors), 'Recorded signal disagreement exceeds refresh timing'
    # The recorded prior epoch anchors the risk state at the current-size seam.
    epoch=json.loads(next(r['value'] for r in data['bot_chain_truth'] if r['key']=='epoch_base_prev'))
    prior=sorted((p for p in data['bot_positions'] if p['live'] and p['closed'] and p['id']>epoch['was']
                  and (p['exit_at'] or now)>0 and (p['exit_at'] or now)<=ERA),key=lambda p:p['exit_at'])
    realized=peak=0
    for p in prior:
        realized+=net_wei(p);peak=max(peak,realized)
    initial_gap=peak-realized
    initial_sensitivity=[]
    for p in shortlist:
        rr=tape.simulate(p,initial={'peak':initial_gap})
        initial_sensitivity.append(dict(policy=p.name,full=detailed(rr,failed)))
    hindsight=max(policies,key=lambda p:(round(detailed(results[p.name],failed)['pnl_eth'],12),tuple(-x for x in simplicity(p)[:2])))
    all_scores=[dict(policy=asdict(p),fit=fit[p.name],recency=detailed(results[p.name],failed,start=cut+1),
                     full=detailed(results[p.name],failed)) for p in policies]
    # Fixed policy paired block uncertainty is descriptive, not a selection-adjusted p-value.
    blocks=[]
    for a in range(cut+1,now,3*HOUR):
        blocks.append(difference(results[winner.name],results['live'],trades,a,min(a+3*HOUR-1,now))['delta_eth'])
    rng=random.Random(8)
    boot=sorted(sum(rng.choice(blocks) for _ in blocks) for _ in range(2000)) if blocks else []
    out=dict(snapshot=dict(at=iso(now),sha256=hashlib.sha256(args.snapshot.read_bytes()).hexdigest()),
        scope=dict(start=iso(ERA),fit_end=iso(cut),hours=(now-ERA)/HOUR,n=len(raw)-len(failed),failed_buys=len(failed),
                   receipt_missing=sum(p['onchain_pnl_wei'] is None for p in raw),actual_cash_eth=actual_cash,
                   actual_booked_eth=sum(t.pnl for t in trades)/1e18),
        wallet=wallet,bins=windows(trades,now),selection=selected,family_choices=family_choices,
        comparisons=comparison,folds=folds,stress=stress,all_scores=all_scores,
        initial_risk=dict(gap_eth=initial_gap/1e18,results=initial_sensitivity),
        hindsight_winner=hindsight.name,
        missing=dict(priced=len(imputed),unpriced=len(unpriced),unpriced_tokens=unpriced,
                     fees_eth=fees,scenarios=scenarios,rows=imputed),
        verification=dict(legacy_cash_exact=True,recorded_market_n=len(errors),recorded_market_exact=matched,
                          recorded_market_matches_within_refresh=cached_matches,
                          recorded_market_error=describe(errors),recorded_resumes=recorded_resumes),
        calibration={label:{key:describe(r[key] for r in calibration if pred(r)) for key in ('replay','actual','gap')}
                     for label,pred in [('fit',lambda r:r['at']<=cut),('recent',lambda r:r['at']>cut)]},
        descriptive_recency_bootstrap=dict(blocks=describe(blocks),p05=boot[100] if boot else None,
                                          p95=boot[1899] if boot else None))
    args.out.write_text(json.dumps(out,indent=2)+'\n')
    print('Completed',len(policies),'candidates;',len(folds),'chronological folds;',len(imputed),'missing-fill proxies',flush=True)


if __name__=='__main__':
    main()
