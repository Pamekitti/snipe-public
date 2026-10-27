"""Longer retrospective guard comparisons. See MARKET_GUARD_LONGER_PROTOCOL.md."""
from __future__ import annotations
import argparse
import collections
from dataclasses import asdict, replace
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import statistics as st
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import engine
import chainio
from exit_policy_audit import replay
from guard_audit import Observation, Trade, DAY, HOUR, SIZE, NON_TRADE, net_wei, describe, iso
from market_guard_audit import Candidate, Experiment, detailed, difference, ERA
from market_guard_longer_fetch import targets, sufficient


def policy_set(config):
    assert config['bankrollEth'] == .08, 'Simulator capacity must match live configuration'
    base = Candidate(name='baseline', window=config['venuePauseWindow'],
                     off=config['venuePauseOff'], on=config['venuePauseOn'],
                     fresh_h=config['venueFreshHours'], dd=round(config['maxDrawdownEth']*1e18),
                     rwin=config['ddResumeWindow'], ron=config['ddResumeOn'])
    return [base, replace(base, name='two_updates', on_count=2),
            replace(base, name='three_updates', on_count=3),
            replace(base, name='five_updates', on_count=5),
            replace(base, name='faster_10', window=10, off=-1, on=0),
            replace(base, name='previous_historical_winner', window=15, off=-2, on=2, on_count=2),
            replace(base, name='new_historical_winner', window=20, off=-2, on=2, on_count=5)]


def scoring_time(launched_ms, delay_ms):
    return ((launched_ms + delay_ms + 59_999)//60_000)*60_000


def observer_return(path):
    next_poll = 0
    def rule(x):
        nonlocal next_poll
        if x['off'] < next_poll:
            return None
        next_poll = x['off'] + 12
        if x['m'] >= 1.75:
            return 1., 'tp'
        if x['m'] <= .5:
            return 1., 'sl'
        if x['off'] >= 200 and x['peak'] < 1.03:
            return 1., 'dead'
        return None
    return engine.evaluate(path, rule, exit_lag=6, hold=450)['mult']-1


def make_path(fact, seq, size, entry=20, native=False):
    if not seq:
        return None
    launch = {'token': fact['token'], 'block': fact['block'], 'deployer': fact['deployer'], 'tx': ''}
    if native:
        seq = [r for r in seq if r['b'] <= fact['block']+510]
    return engine.path(launch, size, seq, fact['creator_tax_bps'] or 0,
                       entry_blk=entry, comp=0, haircut=0, horizon=500 if native else 850, tick=5)


def costs(data, start, end):
    by_size = collections.defaultdict(list)
    for r in data['bot_positions']:
        if not (r['live'] and r['closed'] and (r['cohort'] or 'main') == 'main'
                and start <= (r['t_decide'] or r['t_detect'] or 0) < end
                and r['exit_reason'] not in NON_TRADE and r['onchain_pnl_wei'] is not None):
            continue
        paid = (int(r['proceeds_wei'] or 0)-int(r['spend_wei'])-net_wei(r))/1e18
        if paid >= 0:
            by_size[int(r['spend_wei'])/1e18].append(paid)
    assert by_size, 'No training-only fee observations'
    stats = {str(k): describe(v) for k, v in sorted(by_size.items())}
    key = min(by_size, key=lambda s: abs(s-.02))
    return st.median(by_size[key]), dict(by_size=stats, chosen_size=key, target_size=.02,
                                        nearest_size_fallback=key != .02, fit_start=iso(start), fit_end=iso(end))


def compute_paths(data, root, facts, gas):
    rows, calibration, missing = {}, [], []
    positions = collections.defaultdict(list)
    for r in data['bot_positions']:
        if r['live'] and r['closed'] and r['exit_reason'] not in NON_TRADE and (r['cohort'] or 'main') == 'main':
            positions[r['token'].lower()].append(r)
    with sqlite3.connect(f'file:{root / "paths.db"}?mode=ro', uri=True) as db:
        cached = {r[0]: r for r in db.execute('select token,from_block,to_block,fetched_at,js,error from paths')}
    for token, f in sorted(facts.items(), key=lambda x: x[1]['block']):
        row = cached.get(token)
        if row is None or not sufficient(row, f):
            missing.append({'token': token, 'reason': 'missing_complete_range' if row is None else row[5] or 'short_range'})
            continue
        try:
            logs = json.loads(row[4])
            ids = [(x['transactionHash'], x['logIndex']) for x in logs]
            assert len(ids) == len(set(ids)), 'Duplicate event identities'
            assert all(f['block'] <= int(x['blockNumber'], 16) <= f['block']+950
                       and x['address'].lower() == f['curve'].lower() for x in logs)
            seq = chainio.decode_seq(logs)
            native = make_path(f, seq, .01, native=True)
            own = make_path(f, seq, .02)
            if native is None or own is None:
                missing.append({'token': token, 'reason': 'no_enterable_path'})
                continue
            v = observer_return(native)
            assert math.isfinite(v)
            c = engine.Curve(f['creator_tax_bps'] or 0)
            clean_tokens, _ = c.buy(.02, engine.snipe_bps(2, f['creator_tax_bps'] or 0))
            quote = clean_tokens/own['tok']
            modeled = {str(lag): replay(own, 1.75, {'hold': 45}, gas=gas, lag=lag, poll=1.2)
                       for lag in (.6, 1.2, 2.4)}
            assert all(z['ret'] is not None and math.isfinite(z['ret']) for z in modeled.values())
            rows[token] = dict(token=token, launched=f['launched_at']*1000,
                               block=f['block'], observer_return=v, quote=quote,
                               quote_allowed=quote < 4.5, outcomes=modeled, log_n=len(logs))
            for p in positions[token]:
                entry = (p['fill_block'] or 0)-f['block']
                if entry < 0 or entry+500 > 950 or not p['take_profit'] or p['onchain_pnl_wei'] is None:
                    continue
                context = json.loads(p['context_json'] or '{}')
                rules = context.get('rules', {})
                hold = rules.get('maxHoldMs', 45000)/1000
                if hold > 45 or rules.get('hardStopMultiple', .5) != .5 or rules.get('deadCoinBelowMult', 1.03) != 1.03:
                    continue
                size = int(p['spend_wei'])/1e18
                path = make_path(f, seq, size, entry=entry)
                if path is None:
                    continue
                paid = (int(p['proceeds_wei'] or 0)-int(p['spend_wei'])-net_wei(p))/1e18
                z = replay(path, p['take_profit'], {'hold': hold, 'dead': (p['dead_after_ms'] or 20000)/1000}, gas=paid)
                if z['ret'] is not None:
                    actual = net_wei(p)/1e18
                    calibration.append(dict(id=p['id'], token=token, at=p['t_decide'], size=size,
                                            actual_pnl=actual, modeled_pnl=z['ret']*size,
                                            gap_pp=100*(z['ret']-actual/size), reason=z['reason']))
        except Exception as exc:
            missing.append({'token': token, 'reason': type(exc).__name__+': '+str(exc)})
    return rows, calibration, missing


def observations(data, facts, paths, delay=300_000, recorded_only=False):
    known = {}
    for r in data['gate_obs']:
        token = r['token'].lower()
        if token not in facts or r['error'] or not r['bars'] or not r['launched_at'] or r['at'] > data['snapshot_at']:
            continue
        bars = json.loads(r['bars'])
        v = bars.get('1.75')
        if isinstance(v, (int, float)) and math.isfinite(v):
            known[token] = Observation(token, r['block'], r['launched_at']*1000, r['at'], bars)
    output = list(known.values())
    if not recorded_only:
        for token, r in paths.items():
            if token not in known:
                output.append(Observation(token, r['block'], r['launched'],
                                          scoring_time(r['launched'], delay), {'1.75': r['observer_return']}))
    assert len({r.token for r in output}) == len(output)
    assert all(r.scored >= r.launched for r in output)
    return output, set(known)


def recorded_trades(data, facts, start):
    raw = [r for r in data['bot_positions'] if r['live'] and (r['cohort'] or 'main') == 'main'
           and r['token'].lower() in facts and start <= (r['t_decide'] or r['t_detect'] or 0) < data['snapshot_at']]
    closed = [r for r in raw if r['closed'] and r['exit_at'] and r['exit_at'] <= data['snapshot_at']]
    trades = [Trade(r['id'], r['token'].lower(), r['t_decide'] or r['t_detect'], r['exit_at'],
                    net_wei(r), size=int(r['spend_wei'])) for r in closed]
    return trades, closed, dict(eligible_attempts=len(raw), closed_attempts=len(closed),
                                open_or_unresolved=len(raw)-len(closed),
                                missing_receipts=sum(r['onchain_pnl_wei'] is None for r in closed),
                                sizes=dict(collections.Counter(str(t.size/1e18) for t in trades)))


def modeled_trades(paths, start, lag=.6, shift=0):
    result = []
    for i, (token, row) in enumerate(sorted(paths.items(), key=lambda x: (x[1]['launched'], x[0]))):
        if row['launched']+2000 < start or not row['quote_allowed']:
            continue
        z = row['outcomes'][str(lag)]
        result.append(Trade(i+1, token, row['launched']+2000, round(row['launched']+2000+z['age']*1000),
                            round((z['ret']-shift)*SIZE)))
    return result


def intervals(now):
    out = {f'{d}d': (now-d*DAY, now) for d in (1, 2, 7, 14)}
    out['first_7d'] = (now-14*DAY, now-7*DAY)
    out['last_6h'] = (now-6*HOUR, now)
    out.update({f'day_{i+1:02}': (now-14*DAY+i*DAY, now-14*DAY+(i+1)*DAY) for i in range(14)})
    out.update({f'24h_bin_{i+1}': (now-DAY+i*3*HOUR, now-DAY+(i+1)*3*HOUR) for i in range(8)})
    # 23:00 to 10:00 London = 22:00 to 09:00 UTC during this study.
    for i in range(16):
        midnight = now//DAY*DAY-i*DAY
        lo, hi = midnight+22*HOUR, midnight+DAY+9*HOUR
        if lo >= now-14*DAY and hi <= now:
            out['night_'+dt.datetime.fromtimestamp(lo/1000, dt.UTC).date().isoformat()] = lo, hi
    return out


def summarize(run, trades, failed, lo, hi):
    m = detailed(run, failed, start=lo, end=hi-1, sizes={t.id: t.size for t in trades})
    readings = [x for x in run['readings'] if lo <= x[0] < hi]
    m['fresh_readings'] = sum(x[2] for x in readings)
    m['total_readings'] = len(readings)
    m['venue_stops'] = sum(x['action'] == 'venue_stop' and lo <= x['at'] < hi for x in run['actions'])
    return m


def actual_cash_bins(data, spans):
    raw = [r for r in data['bot_positions'] if r['live'] and r['closed']
           and (r['cohort'] or 'main') == 'main' and r['exit_at']]
    result = {}
    for name, (lo, hi) in spans.items():
        result[name] = {}
        for era, current in [('current', True), ('older', False)]:
            rows = [r for r in raw if lo <= r['exit_at'] < hi
                    and ((r['t_decide'] or r['t_detect'] or 0) >= ERA) == current]
            successful = [r for r in rows if r['exit_reason'] not in NON_TRADE]
            result[name][era] = dict(pnl_eth=sum(net_wei(r) for r in rows)/1e18,
                attempts=len(rows), trade_pnl_eth=describe(net_wei(r)/1e18 for r in successful),
                returns_pct=describe(net_wei(r)/int(r['spend_wei'])*100 for r in successful))
    return result


def run_set(obs, trades, policies, start, now, spans, failed=None, haircut=0, phase=0):
    failed = failed or set()
    tape = Experiment(obs, trades, start, now, haircut=haircut, phase=phase, max_observations=96)
    scores, baseline = {}, None
    for p in policies:
        run = tape.simulate(p)
        if baseline is None:
            baseline = run
        scores[p.name] = {name: summarize(run, trades, failed, max(start, lo), hi)
                          for name, (lo, hi) in spans.items() if hi > start}
        for name, (lo, hi) in spans.items():
            if hi > start:
                scores[p.name][name]['versus_baseline'] = difference(run, baseline, trades, max(start, lo), hi-1)
        assert len({i for _, i, _ in run['cash']}) == len(run['cash'])
        capacity_n = 4*SIZE//min((t.size for t in trades), default=SIZE)
        assert all(n <= capacity_n for _, _, _, n in run['states'])
    return scores


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=Path, default=Path('v1/data/market-guard-longer-20260908'))
    args = ap.parse_args()
    root = args.root
    data = json.load(gzip.open(root/'snapshot.json.gz', 'rt'))
    now, facts = data['snapshot_at'], targets(data)
    broad_facts = targets(data, include_template_rejects=True)
    start = now-14*DAY
    policies = policy_set(data['state']['config']['values'])
    (root/'fixed_policies.json').write_text(json.dumps([asdict(p) for p in policies], indent=2))
    gas, fee_stats = costs(data, start, now-7*DAY)
    broad_paths, calibration, missing = compute_paths(data, root, broad_facts, gas)
    paths = {t: r for t, r in broad_paths.items() if t in facts}
    (root/'modeled_paths.json').write_text(json.dumps(paths))
    (root/'modeled_template_rejects.json').write_text(json.dumps({t: r for t, r in broad_paths.items() if t not in facts}))
    (root/'calibration.json').write_text(json.dumps(calibration, indent=2))
    (root/'missing.json').write_text(json.dumps(missing, indent=2))
    print('paths computed', len(paths), 'missing', len(missing), flush=True)
    obs, known = observations(data, facts, paths)
    spans = intervals(now)
    coverage = {}
    obs_tokens = {r.token for r in obs}
    for name, (lo, hi) in spans.items():
        tokens = {t for t, f in facts.items() if lo <= f['launched_at']*1000 < hi}
        coverage[name] = dict(start=iso(lo), end=iso(hi), launches=len(tokens),
                              complete_replay=len(tokens & paths.keys()), recorded_signals=len(tokens & known),
                              reconstructed_signals=len(tokens & obs_tokens-known), missing_signals=len(tokens-obs_tokens),
                              quote_rejects=sum(not paths[t]['quote_allowed'] for t in tokens & paths.keys()))
    trades, raw, cash_quality = recorded_trades(data, facts, start)
    failed = {r['id'] for r in raw if r['exit_reason'] in NON_TRADE}
    result = dict(snapshot=iso(now), snapshot_ms=now, source_sha256=hashlib.sha256((root/'snapshot.json.gz').read_bytes()).hexdigest(),
                  eth_usd=data['state']['truth']['priceUsd'], policies=[asdict(p) for p in policies],
                  coverage=coverage, cash_quality=cash_quality, fees=fee_stats, missing=missing,
                  actual_cash_bins=actual_cash_bins(data, spans),
                  calibration={}, sensor_reproduction=describe(100*(paths[t]['observer_return']-r.bars['1.75'])
                       for r in obs if (t := r.token) in paths and t in known))
    for key, group in [('all', calibration), ('current_002', [r for r in calibration if r['at'] and r['at'] >= ERA and r['size'] == .02])]:
        result['calibration'][key] = dict(gap_pp=describe(r['gap_pp'] for r in group),
                                         actual_eth=sum(r['actual_pnl'] for r in group), modeled_eth=sum(r['modeled_pnl'] for r in group))
    result['calibration']['by_size'] = {str(s): describe(r['gap_pp'] for r in calibration if r['size'] == s) for s in sorted({r['size'] for r in calibration})}
    result['recorded'] = run_set(obs, trades, policies, start, now, spans, failed)
    unreconciled = {r['id'] for r in raw if r['onchain_pnl_wei'] is None}
    result['recorded_missing_receipts_zeroed'] = run_set(obs,
        [replace(t, pnl=0) if t.id in unreconciled else t for t in trades], policies[:3],
        start, now, {k: spans[k] for k in ('7d', '14d')}, failed)
    print('recorded-trade replay complete', flush=True)
    synth = modeled_trades(paths, start)
    result['modeled_fixed_exit'] = run_set(obs, synth, policies, start, now, spans)
    print('modeled opportunity replay complete', flush=True)
    core = policies[:3]
    short_spans = {k: spans[k] for k in ('1d', '2d', '7d', '14d', 'first_7d', 'last_6h')}
    result['stress'] = {}
    for lag in (1.2, 2.4):
        result['stress'][f'sell_lag_{lag}'] = run_set(obs, modeled_trades(paths, start, lag=lag), core, start, now, short_spans)
    result['stress']['trade_returns_minus_10pp'] = run_set(obs, modeled_trades(paths, start, shift=.1), core, start, now, short_spans)
    result['stress']['signal_returns_minus_5pp'] = run_set(obs, synth, core, start, now, short_spans, haircut=.05)
    result['stress']['clock_phase_15s'] = run_set(obs, synth, core, start, now, short_spans, phase=15_000)
    extra_tokens = broad_facts.keys()-facts.keys()
    result['template_rejection_sensitivity'] = dict(extra_candidates=len(extra_tokens),
        extra_replays=len(extra_tokens & broad_paths.keys()),
        missing=[r for r in missing if r['token'] in extra_tokens])
    result['stress']['original_template_rejects_included'] = run_set(obs, modeled_trades(broad_paths, start), core, start, now, short_spans)
    for delay in (120_000, 600_000):
        changed, _ = observations(data, facts, paths, delay=delay)
        result['stress'][f'reconstructed_delay_{delay//1000}s'] = run_set(changed, synth, core, start, now, short_spans)
    result['stress']['fresh_account_7d'] = run_set(obs, synth, core, now-7*DAY, now, {'7d': spans['7d']})
    native_obs, _ = observations(data, facts, paths, recorded_only=True)
    observed_start = min(r.scored for r in native_obs)
    result['recorded_signal_only'] = dict(start=iso(observed_start), hours=(now-observed_start)/HOUR,
        scores=run_set(native_obs, trades, core, observed_start, now,
                       {'all': (observed_start, now), '2d': spans['2d'], '1d': spans['1d']}, failed))
    result['current_era'] = dict(start=iso(ERA), hours=(now-ERA)/HOUR,
        scores=run_set(native_obs, trades, core, ERA, now, {'all': (ERA, now)}, failed))
    result['model_exit_reasons'] = dict(collections.Counter(r['outcomes']['0.6']['reason'] for r in paths.values()))
    for scope in ('recorded', 'modeled_fixed_exit'):
        for policy, scores in result[scope].items():
            daily = [scores[f'day_{i+1:02}'] for i in range(14)]
            assert abs(sum(r['pnl_eth'] for r in daily)-scores['14d']['pnl_eth']) < 1e-12
            assert sum(r['n'] for r in daily) == scores['14d']['n']
            deltas = [r['versus_baseline']['delta_eth'] for r in daily]
            scores['daily_comparison'] = dict(positive=sum(d > 1e-12 for d in deltas),
                negative=sum(d < -1e-12 for d in deltas), tied=sum(abs(d) <= 1e-12 for d in deltas),
                delta_eth=describe(deltas))
    (root/'results.json').write_text(json.dumps(result, indent=2))
    print('saved', root/'results.json', flush=True)


if __name__ == '__main__':
    main()
