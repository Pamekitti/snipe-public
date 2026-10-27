"""Offline recovery experiments. Read RECOVERY_POLICY_PROTOCOL.md first."""
from __future__ import annotations
import argparse
import bisect
import collections
from dataclasses import dataclass, replace, asdict
import gzip
import hashlib
import heapq
import json
from pathlib import Path
import sqlite3

from guard_audit import Observation, Trade, Tape, SIZE, HOUR, DAY, outcome, net_wei, describe, iso
from market_guard_audit import Candidate, Market, Frame, Streak, ERA
import market_guard_longer as longer


@dataclass(frozen=True)
class RecoveryPolicy(Candidate):
    strict_venue_resume: bool = False
    ignore_venue_age: bool = False
    trim_winner: bool = False
    dd_fresh: bool = False
    dd_short: bool = False
    rolling_lifts: int = 0
    rolling_dd: int = 0
    probation: bool = False
    small_probe: bool = False
    probe_budget: int = 10_000_000_000_000_000


def policies(config):
    base = RecoveryPolicy(**asdict(longer.policy_set(config)[0]))
    confirm = dict(on_count=6, recovery_count=6, short_confirm=True,
                   dd_fresh=True, dd_short=True, stale='shut')
    return [base,
        replace(base, name='market_3', on_count=3),
        replace(base, name='dd_confirm_6', recovery_count=6, dd_fresh=True, dd_short=True),
        replace(base, name='both_confirm_3', **{**confirm, 'on_count': 3, 'recovery_count': 3}),
        replace(base, name='both_confirm_6', **confirm),
        replace(base, name='restart_plus2', on=2, ron=2),
        replace(base, name='trim_winner', trim_winner=True, dd_fresh=True, stale='shut'),
        replace(base, name='dd_retry_once24', rolling_lifts=1),
        replace(base, name='rolling_dd_006', rolling_dd=round(.06*1e18)),
        replace(base, name='rolling_dd_009', rolling_dd=round(.09*1e18)),
        replace(base, name='restart_allowance', probation=True),
        replace(base, name='quarter_probe', probation=True, small_probe=True, probe_budget=round(.005*1e18)),
        replace(base, name='confirm_allowance', probation=True, rolling_lifts=1, **confirm),
        replace(base, name='confirm_probe', probation=True, small_probe=True,
                probe_budget=round(.005*1e18), rolling_lifts=1, **confirm)]


def live_observations(data):
    facts = {r['token'].lower(): r for r in data['bot_launches']}
    rows = []
    for r in data['gate_obs']:
        f = facts.get(r['token'].lower(), {})
        if (r['error'] or not r['bars'] or not r['launched_at'] or
            (f.get('creator_tax_bps') or 0) < 50 or (f.get('exemptions') or 0) < 3):
            continue
        rows.append(Observation(r['token'].lower(), r['block'], r['launched_at']*1000,
                                r['at'], json.loads(r['bars'])))
    return rows


def stats(run, lo, hi):
    cash = [r for r in run['cash'] if lo <= r[0] < hi]
    pnl = peak = dd = 0
    for _, _, v in cash:
        pnl += v; peak = max(peak, pnl); dd = max(dd, peak-pnl)
    return dict(n=len(cash), pnl_eth=pnl/1e18, dd_eth=dd/1e18,
                trade_eth=describe(v/1e18 for _, _, v in cash),
                returns_pct=describe(100*v/run['sizes'][i] for _, i, v in cash),
                actions=dict(collections.Counter(a['action'] for a in run['actions'] if lo <= a['at'] < hi)))


class Simulator:
    def __init__(self, obs, trades, start, end, *, variants=None, phase=0, broken=False,
                 initial=None):
        tape = Tape(obs, [], start, end, phase=phase, venue_on_score=True, max_observations=96)
        self.events = tape.events + [(t.entry, 2, t) for t in trades if start <= t.entry < end]
        self.events.sort(key=lambda x: (x[0], x[1], getattr(x[2], 'id', 0)))
        self.start, self.end = start, end
        self.variants = variants or {}
        self.broken = broken
        self.initial = initial or {}

    def simulate(self, p):
        realized, peak = self.initial.get('realized', 0), self.initial.get('peak', 0)
        dd = self.initial.get('halted', False); halt_at = self.initial.get('halt_at')
        venue = self.initial.get('venue_halted', False); market = Market(); market.shut = venue
        if venue: market.paused_at = self.start
        recovery = Streak(); failed = False
        lifts = 0; day = self.start//DAY; lift_times = []
        active = {}; closes = []; cash = []; actions = []; decisions = []; readings = []
        sizes = {}; paired = []; available = {}; broken_halt = False; last_broken_id = None
        probation = False; stage = 0; stage_n = stage_cash = probe_cash = probe_peak = 0
        rolling_curve = collections.deque([(self.start, 0)]); total_cash = 0
        rolling_block = False; i = 0; serial = 0

        def restart_probe():
            nonlocal probation, stage, stage_n, stage_cash, probe_cash, probe_peak
            if p.probation:
                probation = True; stage = stage_n = stage_cash = probe_cash = probe_peak = 0

        while i < len(self.events) or closes:
            if closes and (i == len(self.events) or closes[0][0] <= self.events[i][0]):
                at, _, t = heapq.heappop(closes); kind = 0; item = t
            else:
                at, kind, item = self.events[i]; i += 1
            if at > self.end: break
            if at//DAY != day: day, lifts = at//DAY, 0
            while len(rolling_curve) > 1 and rolling_curve[1][0] <= at-DAY:
                rolling_curve.popleft()
            rolling_block = bool(p.rolling_dd and max(v for _, v in rolling_curve)-total_cash >= p.rolling_dd)
            if kind == 0:
                active.pop(t.id)
                realized += t.pnl; peak = max(peak, realized)
                value = t.pnl+t.wallet_adjustment; total_cash += value
                cash.append((at, t.id, value)); rolling_curve.append((at, total_cash))
                paired.append(t)
                if not dd and peak-realized >= p.dd:
                    dd = True; halt_at = at; recovery = Streak()
                    actions.append(dict(at=at, action='stop', dd_wei=peak-realized))
                if probation:
                    stage_n += 1; stage_cash += value; probe_cash += value
                    probe_peak = max(probe_peak, probe_cash)
                    if not failed and probe_peak-probe_cash >= p.probe_budget:
                        failed = True; halt_at = at; recovery = Streak(); probation = False
                        actions.append(dict(at=at, action='probation_stop', loss_wei=probe_peak-probe_cash))
                continue
            if kind in (1, 3):
                for o in item: available[o.token] = o
                chosen = outcome(item[:p.window*2], p.window)
                values = [v for _, v in chosen]; total = sum(values)
                fresh = len(chosen) >= p.window and at-chosen[-1][0].launched <= p.fresh_h*HOUR
                signal_valid = len(chosen) >= p.window and (fresh or p.ignore_venue_age)
                eligible_total = total
                if p.trim_winner and values and total-max(values) <= 0:
                    eligible_total = min(total, p.on)
                frame = Frame(eligible_total, signal_valid, tuple(o.token for o, _ in chosen), sum(values[:5]))
                shut = market.update(frame, at, p, kind == 1)
                if kind == 1:
                    prev = venue
                    if shut: venue = True
                    elif not dd and (not venue or not p.strict_venue_resume or
                                     (signal_valid and eligible_total > p.on)):
                        venue = False
                    if prev != venue:
                        action = 'venue_stop' if venue else 'venue_resume'
                        actions.append(dict(at=at, action=action, sum=total, fresh=fresh))
                        if not venue and not failed: restart_probe()
                    readings.append((at, venue, fresh, total))
                    if self.broken and not broken_halt and len(paired) >= 20 and last_broken_id != paired[-1].id:
                        last_broken_id = paired[-1].id
                        pairs = [(t, available.get(t.token)) for t in paired[-20:]]
                        if all(o and isinstance(o.bars.get('1.75'), (int,float)) for t,o in pairs):
                            gap = sum(t.pnl/t.size-.78*o.bars['1.75'] for t,o in pairs)/20*100
                            if gap <= -15:
                                broken_halt = True
                                actions.append(dict(at=at, action='broken_stop', gap_pp=gap))
                    if probation and not active and stage_n >= 5 and stage_cash > 0 and fresh and total > p.on:
                        if p.small_probe and stage < 2:
                            stage += 1; stage_n = stage_cash = 0
                            actions.append(dict(at=at, action='probe_step', stage=stage))
                        else:
                            probation = False; actions.append(dict(at=at, action='probation_pass'))
                if dd or failed:
                    selected = outcome([o for o in item[:p.rwin*4] if o.scored > halt_at], p.rwin)
                    vs = [v for _,v in selected]; subtotal = sum(vs)
                    valid = len(selected) >= p.rwin and subtotal > p.ron
                    if p.dd_fresh: valid = valid and fresh and at-selected[-1][0].launched <= p.fresh_h*HOUR
                    if p.dd_short: valid = valid and sum(vs[:5]) > 0
                    if p.trim_winner: valid = valid and bool(vs) and subtotal-max(vs) > 0
                    recovery.update(valid, tuple(o.token for o,_ in selected), at)
                    lift_times = [v for v in lift_times if v > at-DAY]
                    permitted = lifts < p.lifts and (not p.rolling_lifts or len(lift_times) < p.rolling_lifts)
                    if kind == 1 and not active and not broken_halt and not rolling_block and permitted and recovery.count >= p.recovery_count:
                        was_dd = dd; dd = failed = False; lifts += 1; lift_times.append(at)
                        if was_dd: realized = peak = 0
                        actions.append(dict(at=at, action='resume' if was_dd else 'probation_resume', sum=subtotal))
                        restart_probe()
                continue
            reason = ('broken' if broken_halt else 'drawdown' if dd else 'probation' if failed else
                      'rolling_budget' if rolling_block else 'venue' if venue else None)
            if reason is None and probation and active: reason = 'probation_capacity'
            t = item
            if reason is None and probation and p.small_probe:
                size = [SIZE//4, SIZE//2, SIZE][stage]
                t = self.variants.get((item.id, size))
                if t is None: reason = 'missing_size_path'
            if reason is None and sum(z.size for z in active.values())+t.size > 4*SIZE: reason = 'capacity'
            decisions.append((at, item.id, reason))
            if reason is None:
                active[t.id] = t; sizes[t.id] = t.size; serial += 1
                heapq.heappush(closes, (t.exit, serial, t))
        return dict(start=self.start, end=self.end, cash=cash, actions=actions, decisions=decisions,
                    readings=readings, sizes=sizes, open_ids=list(active), final_halted=dd or failed or broken_halt)


def recorded(data, start):
    rows = [r for r in data['bot_positions'] if r['live'] and (r['cohort'] or 'main') == 'main'
            and (r['t_decide'] or r['t_detect']) >= start and r['closed'] and r['exit_at']]
    return [Trade(r['id'], r['token'].lower(), r['t_decide'] or r['t_detect'], r['exit_at'],
                  net_wei(r), int(r['spend_wei'])) for r in rows]


def restart_stats(run):
    times = [r['at'] for r in run['actions'] if r['action'] in ('venue_resume','resume','probation_resume')]
    periods = []
    for i, at in enumerate(times):
        end = min(at+HOUR, times[i+1] if i+1 < len(times) else run['end'])
        rows = [v for t,_,v in run['cash'] if at < t < end]
        if rows: periods.append(dict(at=iso(at), n=len(rows), eth=sum(rows)/1e18))
    return dict(periods=periods, losing=sum(r['eth']<0 for r in periods), total=len(periods),
                cash_eth=describe(r['eth'] for r in periods))


def compare(obs, trades, ps, start, now, spans, **kw):
    sim = Simulator(obs, trades, start, now, **kw); result = {}; baseline = None
    for p in ps:
        run = sim.simulate(p)
        if baseline is None: baseline = run
        cells = {name: stats(run, max(lo,start), hi) for name,(lo,hi) in spans.items() if hi>start}
        cells['restarts'] = restart_stats(run)
        cells['cash'] = run['cash']; cells['actions'] = run['actions']
        result[p.name] = cells
    return result


def sensor_check(data, obs):
    samples = [r for r in data['bot_guard_samples'] if r['live'] and r['market'] is not None]
    ordered = sorted(obs, key=lambda r:r.scored); visible=[]; i=0; errors=[]; deltas=[]
    for s in sorted(samples,key=lambda r:r['at']):
        while i<len(ordered) and ordered[i].scored<=s['at']:
            o=ordered[i]; bisect.insort(visible,(-o.block,o.token,o));i+=1
        chosen=outcome([r[2] for r in visible[:40]],20)
        if len(chosen)<20:continue
        gap=sum(v for _,v in chosen)-s['market'];deltas.append(gap)
        if abs(gap)>1e-9:errors.append(dict(at=iso(s['at']),gap=gap))
    return dict(n=len(deltas),exact=sum(abs(v)<1e-9 for v in deltas),gap=describe(deltas),examples=errors[:10])


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,default=Path('v1/data/recovery-policy-20260908'))
    args=ap.parse_args();root=args.root;d=json.load(gzip.open(root/'snapshot.json.gz','rt'))
    now=d['snapshot_at'];ps=policies(d['state']['config']['values']);obs=live_observations(d)
    spans=longer.intervals(now);spans['all_current']=(ERA,now);spans['fit']=(ERA,now-6*HOUR)
    spans['recent_6h']=(now-6*HOUR,now);spans['new_live_episode']=(1788867033293,1788868383313)
    trades=recorded(d,ERA)
    result=dict(snapshot=iso(now),eth_usd=d['state']['truth']['priceUsd'],policies=[asdict(p) for p in ps],
                sensor_check=sensor_check(d,obs),actual={k:describe(t.pnl/1e18 for t in trades if lo<=t.exit<hi) for k,(lo,hi) in spans.items()},
                recorded=compare(obs,trades,[p for p in ps if not p.small_probe],ERA,now,spans))
    result['recorded_clock_15s']=compare(obs,trades,[p for p in ps if not p.small_probe],ERA,now,spans,phase=15_000)
    # Anchor the new episode to the actual prior halt, so earlier simulated DD
    # paths cannot get credit for stopping a normal-market restart differently.
    episode_start=1788865233293
    result['isolated_live_episode']=compare(obs,trades,[p for p in ps if not p.small_probe],episode_start,
        1788868383313,{'episode':(episode_start,1788868383313)},
        initial={'venue_halted':True,'realized':-round(.006029190672729674*1e18),'peak':0})
    result['recorded_older_diagnostic']=compare(obs,recorded(d,now-7*DAY),[p for p in ps if not p.small_probe],
                                               max(now-7*DAY,min(o.scored for o in obs)),now,{'7d':(now-7*DAY,now)})
    (root/'recorded_results.json').write_text(json.dumps(result,indent=2))
    for name,c in result['recorded'].items():
        print(name,json.dumps({k:c[k] for k in ['all_current','new_live_episode']},default=str),flush=True)


if __name__=='__main__':main()
