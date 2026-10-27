"""September deployment-clock comparison. No tuning, live writes or prospective claims."""
from pathlib import Path
from dataclasses import replace
import argparse
from .data import read_json, write_json, digest
from .long_history import ROOT, SOURCE, observations_for, external_controls
from .indicator_study import configured_policy, trades_for
from .indicators import SignalTape
from .september_guards import CreativeGuard, Rule
from .account import simulate
from .september_guard_study import SCENARIOS, pack
from .september_guard_report import measure, ratios

OLD = Path('data/research/20260911-september-guards-v2')
OUT = Path('data/research/20260911-fresh-live/september')

class ScheduledGuard(CreativeGuard):
    def __init__(self, tape, size, start, facts, entries, controls):
        super().__init__(tape, Rule('fresh', 1, 8), size, start, facts)
        self.expiries = [r['launched']+10800001 for r in tape.records]
        self.schedule = set(self.times) | set(self.expiries) | set(entries) | {start}
        self.resumes = {at for at, action in controls if action == 'resume'}
        self.schedule |= self.resumes
        self.cached = None
        self.processed_at = None

    def read(self, at):
        if self.cached is None or at in self.schedule and at != self.processed_at:
            if at in self.resumes:
                self.allowed = False
            self.cached = super().read(at)
            self.processed_at = at
        return self.cached

def run():
    OUT.mkdir(parents=True, exist_ok=True)
    raw, models = read_json(SOURCE), read_json(ROOT/'models.json')
    passed = {f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
    models = {**models, 'tokens': {t:z for t,z in models['tokens'].items() if t in passed}}
    facts = {f['token'].lower():f for f in raw['bot_launches']}
    base = configured_policy(raw)
    coverage = read_json(OLD/'coverage.json')
    output = []
    for scenario in SCENARIOS:
        obs = observations_for(raw, models, scenario['mode']=='reconstructed_early')
        trades = trades_for(models, scenario['variant'])
        segments = []
        for index,(a,b) in enumerate(coverage['intervals']):
            original = read_json(OLD/'runs'/f'{scenario["name"]}-{index:02}.json')
            records = []
            for row in original['shadow_records']:
                z = models['tokens'][row['token']]
                # Earliest complete collection under the production worker's policy.
                # Unrecorded historical RPC work cannot be assigned an observed duration.
                complete = z['entry'] + z.get('send_delay_ms',0) + z.get('open_delay_ms',0) + 45000 + 3000 + 10000 + 1000
                published = ((max(row['available']-1, complete)+999)//1000)*1000+1+scenario['delay']
                records.append(dict(row, available=published))
            selected = [t for t in trades if a<=t['entry']<b-180000]
            controls = external_controls(raw) if scenario['controls'] else []
            guard = ScheduledGuard(SignalTape(records), base.size_wei, a, facts, [t['entry'] for t in selected], controls)
            expiry_controls = [(t,'signal_tick') for t in guard.expiries if a<=t<b]
            result = simulate(obs, selected, base, a, b, controls=[*controls,*expiry_controls], guard=guard)
            if not result['complete']: raise ValueError('incomplete deployment-clock comparison')
            current = pack(result,a,b,base.size_wei)
            seg = {**original, 'runs': {k:original['runs'][k] for k in ('continuous','matched20','fresh_s1_w8_b1')}}
            seg['runs']['deployment_clock'] = current
            segments.append(seg)
            write_json(OUT/'runs'/f'{scenario["name"]}-{index:02}.json',seg)
        lo, hi = coverage['start'], coverage['end']
        continuous = measure(segments,'continuous',lo,hi)
        rows = {}
        for name in ('matched20','fresh_s1_w8_b1','deployment_clock'):
            metrics = measure(segments,name,lo,hi)
            rows[name] = dict(metrics=metrics,retained=ratios(metrics,continuous))
        output.append(dict(scenario=scenario,rows=rows))
        print(scenario['name'], 'complete', flush=True)
    report = dict(start=coverage['start'],end=coverage['end'],scenarios=output,
        assumptions=['Previously inspected September data; no fitting or prospective profit claim.',
        'Production collection deadline, ten-second settled history, one-second repeated scan and one-second scheduling; historical RPC processing duration unavailable.',
        'Publication60s scenarios retain the registered extra-minute stress.',
        'Complete intervals are conditional simulations; unknown executions are not priced as zero.'],
        hashes={str(p):digest(p) for p in (Path(__file__),ROOT/'models.json',OLD/'design.json')})
    write_json(OUT/'comparison.json',report)
    lines=['# September deployment-clock comparison','',*report['assumptions'],'',
        '| Scenario / policy | Net ETH | DD ETH | Win count retained | Loss count retained | Win money retained | Loss money retained | Losing recoveries |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for scenario in output:
        for name,row in scenario['rows'].items():
            m,r=row['metrics'],row['retained']
            lines.append(f"| {scenario['scenario']['name']} / {name} | {int(m['net_wei'])/1e18:.6f} | {int(m['drawdown_wei'])/1e18:.6f} | {r['win_trades']:.2f}% | {r['loss_trades']:.2f}% | {r['win_money']:.2f}% | {r['loss_money']:.2f}% | {m['losing_recoveries']} |")
    (OUT/'report.md').write_text('\n'.join(lines)+'\n')

if __name__ == '__main__': run()
