"""Isolate market-window age policies. Read STALE_POLICY_PROTOCOL.md first."""
from __future__ import annotations
import bisect
import collections
from dataclasses import asdict, replace
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import shutil
from zoneinfo import ZoneInfo

import recovery_policy_audit as audit
import recovery_policy_models as models
import market_guard_longer as longer

ROOT = Path(__file__).resolve().parents[1] / 'data/recovery-policy-20260908'
OUT = ROOT / 'stale-policy'
TZ = ZoneInfo('Europe/London')
MODES = {
    'open': 'Allow stale reopening',
    'hold': 'Preserve pause while stale',
    'any_age': 'Use latest 20 at any age',
    'fresh_only': 'Pause all entries while stale',
}


def policy_set(base):
    result = []
    for threshold in [1, 2]:
        for mode in MODES:
            name = ('baseline' if threshold == 1 else 'venue_plus2_only') if mode == 'open' else f'market{threshold}_{mode}'
            result.append(replace(base, name=name, on=threshold,
                stale='open' if mode == 'open' else 'shut' if mode == 'fresh_only' else 'hold',
                strict_venue_resume=mode != 'open', ignore_venue_age=mode == 'any_age'))
    return result


def cash_difference(run, reference):
    current = {i: v for _, i, v in run['cash']}
    previous = {i: v for _, i, v in reference['cash']}
    added = [v for i, v in current.items() if i not in previous]
    removed = [v for i, v in previous.items() if i not in current]
    def parts(values):
        return {'n': len(values), 'net_eth': sum(values)/1e18,
                'winning_eth': sum(v for v in values if v > 0)/1e18,
                'losing_eth': sum(v for v in values if v < 0)/1e18,
                'trade_eth': audit.describe(v/1e18 for v in values)}
    delta = (sum(current.values()) - sum(previous.values()))/1e18
    assert abs(delta - (sum(added)-sum(removed))/1e18) < 1e-12
    return {'added': parts(added), 'removed': parts(removed), 'delta_eth': delta}


def stale_exposure(run):
    readings = run['readings']
    times = [r[0] for r in readings]
    stale_ms = sum(max(0, min(run['end'], readings[i+1][0] if i+1 < len(readings) else run['end']) - row[0])
                   for i, row in enumerate(readings) if not row[2])
    ids = set()
    for at, tid, reason in run['decisions']:
        i = bisect.bisect_right(times, at)-1
        if reason is None and i >= 0 and not readings[i][2]:
            ids.add(tid)
    cash = [v for _, i, v in run['cash'] if i in ids]
    return {'stale_hours': stale_ms/audit.HOUR, 'stale_admitted_attempts': len(ids),
        'stale_entry_closed_eth': sum(cash)/1e18,
        'stale_entry_trade_eth': audit.describe(v/1e18 for v in cash),
        'stale_reopenings': [a for a in run['actions'] if a['action'] == 'venue_resume' and not a['fresh']]}


def compare(obs, trades, policies, start, end, spans, *, saved=None, include_cash=False, **kwargs):
    sim = audit.Simulator(obs, trades, start, end, **kwargs)
    runs = {p.name: sim.simulate(p) for p in policies}
    output = {}
    for policy in policies:
        run = runs[policy.name]
        if saved and policy.name in saved:
            assert [list(row) for row in run['cash']] == saved[policy.name]['cash'], policy.name
            assert run['actions'] == saved[policy.name]['actions'], policy.name
        assert len({row[1] for row in run['cash']}) == len(run['cash'])
        reference = runs['baseline' if policy.on == 1 else 'venue_plus2_only']
        cells = {name: {**audit.stats(run, max(lo, start), hi),
            'available_start': audit.iso(max(lo, start)), 'complete_window': lo >= start}
            for name, (lo, hi) in spans.items() if hi > start}
        cells.update(stale=stale_exposure(run), compared_with_same_threshold=cash_difference(run, reference),
            open_ids=run['open_ids'], actions=run['actions'], restarts=audit.restart_stats(run))
        if include_cash:
            cells['cash'] = run['cash']
        if '14d' in cells and start == end-14*audit.DAY:
            daily = sum(cells[f'day_{i:02}']['pnl_eth'] for i in range(1, 15))
            assert abs(daily-cells['14d']['pnl_eth']) < 1e-12
        if policy.strict_venue_resume:
            for row in run['actions']:
                if row['action'] == 'venue_resume':
                    assert row['sum'] > policy.on
                    assert row['fresh'] or policy.ignore_venue_age
        output[policy.name] = cells
    return output


def report(result):
    usd = result['eth_usd']
    policies = result['policies']
    end = datetime.fromtimestamp(result['end_ms']/1000, TZ)
    lines = ['# Stale-indicator comparison', '',
        f'Frozen input ends {end:%d %B %Y, %H:%M:%S} London. USD conversion: ${usd:,.2f}/ETH.', '',
        'All results are retrospective. The 14-day columns are the fixed-1.75, 0.02 ETH opportunity model, '
        'not actual wallet profit or an earnings forecast. Current-era cash only retains or removes actual '
        'recorded attempts; it cannot establish additional fills. The comparison is offline; any subsequent '
        'live configuration change is recorded separately in rollout.json.', '',
        '## Decision', '',
        'Keep Market +2 with the existing stale-data exception (`venue_plus2_only`). '
        'In this model, holding pauses while stale removed 22 trades worth $237.54 net and did not '
        'reduce maximum, rolling-24-hour or rolling-48-hour drawdown. It earned less in all seven '
        'scenarios, with equal or higher maximum drawdown. This evidence does not support that replacement.', '',
        'The any-age alternative earned $104.92 less with $84.30 more maximum drawdown in the main run. '
        'It did earn more in three sensitivities, including the adverse-return stress, so it is not '
        'universally inferior. Fresh-only cost $2,402.46 to reduce full-run maximum drawdown by $19.76.', '',
        'All four +2 versions tied in the 22.62-hour current-era recorded replay at $697.96 retained '
        'cash and $99.88 maximum drawdown, and all excluded the isolated ten-trade false recovery. '
        'Those are conditional retained-trade results, not actual wallet totals. There were only three '
        'stale-exception reopening events in the main two-week run, all before the current-size era. '
        'There is insufficient evidence to call any rule a live optimum.', '',
        '## Rules', '',
        '| ID | Normal recovery | Stale-data behavior |', '|---|---:|---|']
    for p in policies:
        mode = 'open' if not p['strict_venue_resume'] else 'any_age' if p['ignore_venue_age'] else 'fresh_only' if p['stale'] == 'shut' else 'hold'
        lines.append(f'| `{p["name"]}` | >+{p["on"]} | {MODES[mode]} |')
    lines += ['', 'All use the latest 20 available scored launch outcomes and stop below -1. '
        'Freshness means the oldest of those launches is no more than three hours old. '
        'Hold preserves an existing pause but allows already-open trading to continue during staleness. '
        'Any-age still requires a complete window and never reads future scores. Fresh-only places a '
        'pause when stale, and requires fresh evidence above the recovery line to release it. '
        'DD recovery remains 20 post-stop scores above +1, with 0.06 ETH DD and two DD lifts per UTC day.', '',
        '## Main comparison', '',
        '| Policy | Current-era cash | Current-era DD | 14d model net | 14d model DD | First 7d net | Latest 7d net | Last 48h net |',
        '|---|---:|---:|---:|---:|---:|---:|---:|']
    for p in policies:
        n=p['name']; r=result['recorded'][n]['all_current']; z=result['scenarios']['base'][n]
        vals=[r['pnl_eth'],r['dd_eth'],z['14d']['pnl_eth'],z['14d']['dd_eth'],
              z['first_7d']['pnl_eth'],z['7d']['pnl_eth'],z['2d']['pnl_eth']]
        lines.append(f'| `{n}` | '+' | '.join(f'${v*usd:,.2f}' for v in vals)+' |')
    lines += ['', '## Sensitivity at Market +2', '',
        'Each cell is modeled 14-day net profit / maximum realized drawdown. Scenarios reuse the same '
        'history, so they are not independent validation samples.', '',
        '| Scenario | Allow stale reopening | Preserve pause | Latest 20, any age | Pause while stale |',
        '|---|---:|---:|---:|---:|']
    selected = ['venue_plus2_only','market2_hold','market2_any_age','market2_fresh_only']
    for scenario, rows in result['scenarios'].items():
        cells=[f'${rows[n]["14d"]["pnl_eth"]*usd:,.0f} / ${rows[n]["14d"]["dd_eth"]*usd:,.0f}' for n in selected]
        lines.append(f'| {scenario} | '+' | '.join(cells)+' |')
    lines += ['', '## What changes during stale periods', '',
        '| Market +2 rule | Hours stale | Entries while stale | Net from these entries | Stale reopenings | Added net vs allow | Removed winners | Removed losses |',
        '|---|---:|---:|---:|---:|---:|---:|---:|']
    for n in selected:
        z=result['scenarios']['base'][n]; s=z['stale']; diff=z['compared_with_same_threshold']
        lines.append(f'| `{n}` | {s["stale_hours"]:.2f} | {s["stale_admitted_attempts"]} | '
            f'${s["stale_entry_closed_eth"]*usd:,.2f} | {len(s["stale_reopenings"])} | '
            f'${diff["added"]["net_eth"]*usd:,.2f} | ${diff["removed"]["winning_eth"]*usd:,.2f} | '
            f'${diff["removed"]["losing_eth"]*usd:,.2f} |')
    lines += ['', 'The any-age rule\'s two reopenings while stale still passed +2. The existing rule\'s three '
        'stale-exception reopenings occurred at +1.242, +0.852 and +1.854, all below +2.', '',
        'Added and removed trades describe the whole changed account path, including later DD pauses. '
        'They are not independent causal estimates for a single stale interval.', '',
        '## Final 24 hours in eight bins', '',
        'Current-era recorded cash. The first bin is incomplete because the 0.02 ETH era began '
        '22.62 hours before the snapshot.', '',
        '| Three-hour bin, London | Allow stale reopening | Preserve pause | Any age | Pause while stale |',
        '|---|---:|---:|---:|---:|']
    for i in range(8):
        lo=result['end_ms']-audit.DAY+i*3*audit.HOUR
        label=datetime.fromtimestamp(lo/1000,TZ).strftime('%d %b %H:%M')
        lines.append('| '+label+' | '+' | '.join(f'${result["recorded"][n][f"24h_bin_{i+1}"]["pnl_eth"]*usd:,.2f}' for n in selected)+' |')
    lines += ['', '## Final seven days in seven bins', '',
        'These are older-history opportunity-model results. The current 0.02 ETH era covers only '
        'the final 22.62 hours; there is no seven-day current-era live test.', '',
        '| Day beginning, London | Allow stale reopening | Preserve pause | Any age | Pause while stale |',
        '|---|---:|---:|---:|---:|']
    for i in range(7):
        lo=result['end_ms']-7*audit.DAY+i*audit.DAY
        label=datetime.fromtimestamp(lo/1000,TZ).strftime('%d %b %H:%M')
        lines.append('| '+label+' | '+' | '.join(f'${result["scenarios"]["base"][n][f"day_{i+8:02}"]["pnl_eth"]*usd:,.2f}' for n in selected)+' |')
    lines += ['', '## Limits and checks', '',
        '- Baseline and original Market +2 cash and actions match the saved experiment exactly in every '
        'comparable scenario and current-era/isolated replay. Daily cash sums reconcile and trade IDs are unique.',
        '- New guards require fresh evidence above the threshold except any-age, which requires a full '
        'window above it. A fresh neutral window cannot bypass a placed pause.',
        '- 3,862 usable paths include warm-up. There are 2,430 reconstructed score records and 1,432 '
        'records with native scoring times. Stale windows are concentrated in older, thinner history.',
        '- Graduation exits, adaptive targets, touch/template feedback, funding history and counterparty '
        'reaction remain imperfect. Virtual graduation value is not an executable quote or verified upper bound.',
        '- The final six hours were excluded from fee fitting in the original study but have already been '
        'inspected. No result here is from an untouched holdout.',
        '- Drawdown is cumulative realized cash from its running peak, across resets. Open marks are excluded; '
        'the stop trigger is not a hard maximum loss.',
        '- Exact mean, median, sample standard deviation and n for every trade distribution are in results.json.', '']
    (OUT/'report.md').write_text('\n'.join(lines))


def main():
    OUT.mkdir(exist_ok=True)
    data=json.load(gzip.open(ROOT/'snapshot.json.gz','rt'))
    mdata=json.loads((ROOT/'model_paths.json').read_text())
    old=json.loads((ROOT/'ablation_results.json').read_text())
    end=data['snapshot_at']; start=end-14*audit.DAY
    base=audit.policies(data['state']['config']['values'])[0]
    policies=policy_set(base)
    spans=longer.intervals(end); spans['all_current']=(audit.ERA,end)
    native=audit.live_observations(data); known={o.token for o in native}
    actual=audit.recorded(data,audit.ERA)
    result={'end_ms':end,'start_ms':start,'eth_usd':data['state']['truth']['priceUsd'],
            'policies':[asdict(p) for p in policies], 'scenarios':{}}
    result['recorded']=compare(native,actual,policies,audit.ERA,end,spans,saved=old['recorded'],include_cash=True)
    result['recorded_phase15']=compare(native,actual,policies,audit.ERA,end,spans,phase=15000)
    lo,hi=1788865233293,1788868383313
    result['isolated']=compare(native,actual,policies,lo,hi,{'episode':(lo,hi)},saved=old['isolated'],
        initial={'venue_halted':True,'realized':-round(.006029190672729674*1e18),'peak':0})
    def observations(delay):
        return native+[longer.Observation(t,z['block'],z['launched'],longer.scoring_time(z['launched'],delay),
            {'1.75':z['observer_return']}) for t,z in mdata['paths'].items() if t not in known]
    cases=[('base',.6,0,300000,'zero',False,'zero'),
           ('sell_1p2s',1.2,0,300000,'zero',False,'slower'),
           ('clock_plus15s',.6,15000,300000,'zero',False,'phase15'),
           ('score_delay_2m',.6,0,120000,'zero',False,'delay_120000'),
           ('score_delay_10m',.6,0,600000,'zero',False,'delay_600000'),
           ('return_minus5pp',.6,0,300000,'zero',True,'trade_minus5pp'),
           ('virtual_graduation',.6,0,300000,'virtual',False,None)]
    for label,lag,phase,delay,valuation,stress,previous in cases:
        trades,variants=models.variants(mdata['paths'],start,lag,valuation)
        if stress:
            trades=[replace(t,pnl=t.pnl-round(.05*t.size)) for t in trades]
            variants={}
        result['scenarios'][label]=compare(observations(delay),trades,policies,start,end,spans,
            variants=variants,phase=phase,saved=old[previous] if previous else None,
            include_cash=label=='base')
        print('completed',label,flush=True)
    (OUT/'results.json').write_text(json.dumps(result,indent=2))
    report(result)
    sources=[Path(__file__).resolve(),Path(audit.__file__),Path(models.__file__),Path(longer.__file__),
             Path(__file__).with_name('guard_audit.py'),Path(__file__).with_name('market_guard_audit.py'),
             Path(__file__).with_name('STALE_POLICY_PROTOCOL.md'),Path(__file__).with_name('test_stale_policy_audit.py')]
    (OUT/'source').mkdir(exist_ok=True)
    for p in sources:
        shutil.copy2(p,OUT/'source'/p.name)
    files=sources+[ROOT/'snapshot.json.gz',ROOT/'model_paths.json',ROOT/'ablation_results.json',OUT/'results.json']
    (OUT/'manifest.json').write_text(json.dumps({'frozen_end':audit.iso(end),
        'checks':['old cash and actions match exactly','daily sums reconcile','unique IDs','valid resume evidence'],
        'hashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}},indent=2))
    print('saved',str(OUT),flush=True)


if __name__=='__main__':
    main()
