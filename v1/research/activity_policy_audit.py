"""Research only. Read ACTIVITY_POLICY_PROTOCOL.md before running."""
from __future__ import annotations

import bisect
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import sqlite3
from dataclasses import replace

import recovery_policy_audit as audit
import recovery_policy_models as models
import market_guard_longer as longer
from stale_policy_audit import cash_difference

ROOT = Path(__file__).resolve().parents[1] / 'data/recovery-policy-20260908'
OUT = Path(__file__).resolve().parents[1] / 'data/activity-policy-20260908'
HOUR, DAY = audit.HOUR, audit.DAY
RULES = ['market_plus2', 'launch_pace', 'turnover_per_coin', 'buyers_per_coin',
         'net_buying', 'broad_gains', 'recent_direction', 'demand_and_pace']


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def external_activity(logs, fact):
    """Emitted quote amounts, first 450 blocks, creator and own fills excluded."""
    buy = sell = 0
    buyers = set()
    deployer = (fact.get('deployer') or '').lower()
    for e in longer.chainio.decode_seq(logs):
        if e['s'] == 'BB' or not 0 <= e['b'] - fact['block'] <= 450:
            continue
        if deployer in (e['u'].lower(), e['r'].lower()):
            continue
        # CurveBuy is (quoteIn, tokensOut, fee, tax). CurveSell reverses units:
        # (tokensIn, quoteOut, fee, tax). Decoder names q/t mean word 0/1 only.
        quote = int(e['q'] if e['s'] == 'B' else e['t'], 16) / 1e18
        if e['s'] == 'B':
            buy += quote
            buyers.add(e['u'].lower())
        else:
            sell += quote
    return dict(buy=buy, sell=sell, gross=buy + sell, buyers=len(buyers))


def load_activity(data):
    facts = {r['token'].lower(): r for r in data['bot_launches']}
    values = {}
    with sqlite3.connect(f'file:{ROOT / "paths.db"}?mode=ro', uri=True) as db:
        for token, lo, hi, js in db.execute(
                'select token,from_block,to_block,js from paths where error is null'):
            f = facts.get(token)
            if f and lo <= f['block'] and hi >= f['block'] + 950:
                values[token] = external_activity(json.loads(js), f)
    return values


class Features:
    def __init__(self, data, obs, activity):
        self.obs = sorted(obs, key=lambda o: (o.scored, o.block, o.token))
        self.score_times = [o.scored for o in self.obs]
        self.activity = activity
        self.mature = sorted((max(o.scored, o.launched + 45_000), o.token)
                             for o in obs)
        self.mature_times = [at for at, _ in self.mature]
        self.detected = sorted(r['detected_at'] for r in data['bot_launches']
            if r.get('detected_at') and (r.get('creator_tax_bps') or 0) >= 50
            and (r.get('exemptions') or 0) >= 3)
        self.history_start = min(r['detected_at'] for r in data['bot_launches']
                                 if r.get('detected_at'))

    def at(self, at):
        visible = self.obs[:bisect.bisect_left(self.score_times, at)]
        chosen = audit.outcome(sorted(visible, key=lambda o: (-o.block, o.token))[:40], 20)
        vs = [v for _, v in chosen]
        fresh = len(chosen) == 20 and at - chosen[-1][0].launched <= 3 * HOUR
        def count(lo, hi):
            return bisect.bisect_left(self.detected, hi) - bisect.bisect_left(self.detected, lo)
        pace_recent, pace_previous = count(at-HOUR, at), count(at-7*HOUR, at-HOUR)
        def bucket(lo, hi):
            a, b = bisect.bisect_left(self.mature_times, lo), bisect.bisect_left(self.mature_times, hi)
            tokens = [token for _, token in self.mature[a:b]]
            rows = [self.activity[t] for t in tokens if t in self.activity]
            return rows, len(rows)/len(tokens) if tokens else 0, len(tokens)
        recent, coverage, expected = bucket(at-HOUR, at)
        previous, previous_coverage, previous_expected = bucket(at-7*HOUR, at-HOUR)
        volume_valid = (len(recent) >= 5 and len(previous) >= 20 and
                        min(coverage, previous_coverage) >= .8)
        def ratio(key):
            if not volume_valid:
                return None
            before = sum(r[key] for r in previous)/len(previous)
            current = sum(r[key] for r in recent)/len(recent)
            return current/before if before > 0 else None
        flow = sum(r['buy']-r['sell'] for r in recent) if volume_valid else None
        pace_ratio = (pace_recent/(pace_previous/6) if pace_previous and
                      at-self.history_start >= 7*HOUR else None)
        return dict(stakes=sum(vs) if len(vs) == 20 else None, fresh=fresh,
            trimmed=sum(vs)-max(vs) if fresh else None,
            short=sum(vs[:5]) if len(vs) >= 5 and at-chosen[4][0].launched <= 3*HOUR else None,
            pace=pace_ratio, launch_n=pace_recent, prior_launch_n=pace_previous,
            turnover=ratio('gross'), buyers=ratio('buyers'), net_buy=flow,
            activity_n=len(recent), activity_expected=expected, coverage=coverage,
            previous_activity_n=len(previous), previous_expected=previous_expected,
            previous_coverage=previous_coverage,
            max_used_score=max((o.scored for o, _ in chosen), default=None))


def accepts(rule, f):
    """None means missing evidence and falls back to the unchanged market guard."""
    if rule == 'market_plus2':
        return True, False
    checks = {
        'launch_pace': ('pace', 1, False),
        'turnover_per_coin': ('turnover', 1, False),
        'buyers_per_coin': ('buyers', 1, False),
        'net_buying': ('net_buy', 0, True),
        'broad_gains': ('trimmed', 0, True),
        'recent_direction': ('short', 0, True),
    }
    if rule == 'demand_and_pace':
        a, missing_a = accepts('launch_pace', f)
        b, missing_b = accepts('buyers_per_coin', f)
        return a and b, missing_a or missing_b
    key, threshold, strict = checks[rule]
    value = f[key]
    if value is None:
        return True, True
    return (value > threshold if strict else value >= threshold), False


def spans(end, start):
    d = {'all': (start, end), 'selection': (start, max(start, end-6*HOUR)),
         'reserved_6h': (max(start, end-6*HOUR), end)}
    d.update({f'24h_{i+1}': (end-DAY+i*3*HOUR, end-DAY+(i+1)*3*HOUR) for i in range(8)})
    d.update({f'7d_{i+1}': (end-7*DAY+i*DAY, end-7*DAY+(i+1)*DAY) for i in range(7)})
    d.update({f'day_{i+1}': (end-14*DAY+i*DAY, end-14*DAY+(i+1)*DAY) for i in range(14)})
    d['first7'] = (end-14*DAY, end-7*DAY)
    d['last7'] = (end-7*DAY, end)
    return d


def compare(data, obs, trades, activity, start, end, policy, *, saved=None):
    feature_tape = Features(data, obs, activity)
    fs = {t.id: feature_tape.at(t.entry) for t in sorted(trades, key=lambda t: t.entry)
          if start <= t.entry < end}
    for t in trades:
        if t.id in fs and fs[t.id]['max_used_score'] is not None:
            assert fs[t.id]['max_used_score'] < t.entry
    result = {}
    baseline = None
    for name in RULES:
        admitted = [t for t in trades if t.id in fs and accepts(name, fs[t.id])[0]]
        run = audit.Simulator(obs, admitted, start, end).simulate(policy)
        if baseline is None:
            baseline = run
            if saved:
                assert [list(row) for row in run['cash']] == saved['cash']
                assert run['actions'] == saved['actions']
        metrics = {k: {**audit.stats(run, max(lo, start), hi),
                      'available': hi > start, 'complete': lo >= start,
                      'from': audit.iso(max(lo, start)), 'to': audit.iso(hi)}
                   for k, (lo, hi) in spans(end, start).items()}
        assert len({i for _, i, _ in run['cash']}) == len(run['cash'])
        assert abs(sum(metrics[f'day_{i+1}']['pnl_eth'] for i in range(14))-
                   metrics['all']['pnl_eth']) < 1e-10
        baseline_ids = {i for _, i, _ in baseline['cash']}
        result[name] = dict(metrics=metrics, difference=cash_difference(run, baseline),
            fallback_n=sum(accepts(name, fs[i])[1] for i in baseline_ids),
            evaluated_n=len(baseline_ids), cash=run['cash'], actions=run['actions'],
            rejected_n=sum(not accepts(name, f)[0] for f in fs.values()),
            features_n=len(fs), restarts=audit.restart_stats(run))
    features = [{'id': t.id, 'at': t.entry, 'pnl_eth': t.pnl/1e18,
                 'return_pct': 100*t.pnl/t.size, **fs[t.id]} for t in trades if t.id in fs]
    return result, features


def segment(features, start, end):
    rows = [f for f in features if start <= f['at'] < end and f['fresh']]
    result = {}
    for band, lo, hi in [('negative', -math.inf, 0), ('zero_to_two', 0, 2), ('above_two', 2, math.inf)]:
        for busy in (False, True):
            chosen = [f for f in rows if lo < f['stakes'] <= hi and f['pace'] is not None
                      and (f['pace'] >= 1) == busy]
            result[f'{band}_{"busy" if busy else "quiet"}'] = dict(
                return_pct=audit.describe(f['return_pct'] for f in chosen),
                pnl_eth=audit.describe(f['pnl_eth'] for f in chosen))
    return result


def main():
    OUT.mkdir(exist_ok=True)
    inputs = [ROOT/'snapshot.json.gz', ROOT/'paths.db', ROOT/'model_paths.json',
              ROOT/'decision_table.md', ROOT/'decision_table.json',
              ROOT/'stale-policy/results.json', ROOT/'stale-policy/report.md']
    original_hashes = {str(p): digest(p) for p in inputs}
    benchmark = OUT/'benchmark'
    benchmark.mkdir(exist_ok=True)
    for p in inputs[3:]:
        shutil.copy2(p, benchmark/('stale_'+p.name if p.parent.name == 'stale-policy' else p.name))
    (benchmark/'manifest.json').write_text(json.dumps(original_hashes, indent=2))
    old = json.load(gzip.open(ROOT/'snapshot.json.gz', 'rt'))
    new = json.load(gzip.open(OUT/'snapshot.json.gz', 'rt'))
    modeled = json.loads((ROOT/'model_paths.json').read_text())['paths']
    saved = json.loads((ROOT/'stale-policy/results.json').read_text())
    policy = replace(audit.policies(old['state']['config']['values'])[0],
                     name='venue_plus2_only', on=2)
    activity = load_activity(new)
    (OUT/'activity.json').write_text(json.dumps(activity))
    end, old_end = new['snapshot_at'], old['snapshot_at']
    current_obs = audit.live_observations(new)
    actual = audit.recorded(new, audit.ERA)
    recorded, features = compare(new, current_obs, actual, activity, audit.ERA, end, policy)
    print('current recorded comparison complete', flush=True)
    output = dict(snapshot_at=end, model_end=old_end, policy=policy.__dict__,
        coverage=dict(cached_curves=len(activity), native_scores=len(current_obs),
                      actual_attempts=len(actual), current_hours=(end-audit.ERA)/HOUR,
                      reserved_attempts=sum(end-6*HOUR <= t.entry < end for t in actual),
                      actual_receipt_count=sum(r['onchain_pnl_wei'] is not None for r in new['bot_positions']
                          if r['id'] in {t.id for t in actual})),
        recorded=recorded, recorded_features=features,
        segments_selection=segment(features, audit.ERA, end-6*HOUR),
        segments_reserved=segment(features, end-6*HOUR, end), scenarios={})
    native = audit.live_observations(old)
    known = {o.token for o in native}
    start = old_end-14*DAY
    for name, lag, valuation, haircut, delay in [
        ('base', .6, 'zero', 0, 300000), ('slower_sell', 1.2, 'zero', 0, 300000),
        ('minus5pp', .6, 'zero', .05, 300000), ('virtual_graduation', .6, 'virtual', 0, 300000),
        ('score_delay10m', .6, 'zero', 0, 600000)]:
        obs = native + [longer.Observation(t, z['block'], z['launched'],
            longer.scoring_time(z['launched'], delay), {'1.75': z['observer_return']})
            for t, z in modeled.items() if t not in known]
        trades, _ = models.variants(modeled, start, lag, valuation)
        if haircut:
            trades = [replace(t, pnl=t.pnl-round(haircut*t.size)) for t in trades]
        result, ff = compare(old, obs, trades, activity, start, old_end, policy,
            saved=saved['scenarios']['base']['venue_plus2_only'] if name == 'base' else None)
        output['scenarios'][name] = result
        if name == 'base':
            output['model_segments'] = segment(ff, start, old_end)
            output['model_features'] = ff
        print('completed', name, flush=True)
    assert original_hashes == {str(p): digest(p) for p in inputs}
    (OUT/'results.json').write_text(json.dumps(output, indent=2))
    sources = [Path(__file__).resolve(), Path(__file__).with_name('ACTIVITY_POLICY_PROTOCOL.md'),
               Path(audit.__file__), Path(models.__file__), Path(longer.__file__),
               Path(__file__).with_name('guard_audit.py'),
               Path(__file__).with_name('market_guard_audit.py'),
               Path(__file__).with_name('stale_policy_audit.py'), Path(longer.chainio.__file__),
               Path(__file__).with_name('test_activity_policy_audit.py'),
               Path(__file__).resolve().parents[1]/'src/abi.ts']
    source_dir = OUT/'source'
    source_dir.mkdir(exist_ok=True)
    for p in sources:
        shutil.copy2(p, source_dir/p.name)
    (OUT/'manifest.json').write_text(json.dumps(dict(originals_unchanged=True,
        files={str(p): digest(p) for p in inputs+sources+[OUT/'snapshot.json.gz', OUT/'results.json']},
        current_endpoint=audit.iso(end), model_endpoint=audit.iso(old_end)), indent=2))
    print('saved results and verified benchmark hashes', flush=True)


if __name__ == '__main__':
    main()
