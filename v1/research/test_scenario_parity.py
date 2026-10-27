import json
import pathlib
import unittest
from core.grid_v2_guard import Rule, Guard
from core.indicators import SignalTape
from core.shared_execution import execute_batch


class ScenarioParityTests(unittest.TestCase):
    def test_all_frozen_candidates_match_the_research_rule_on_identical_scenarios(self):
        path = pathlib.Path(__file__).resolve().parents[1] / 'data/research/20260913-shared-refresh-1530/candidates.json'
        if not path.exists():
            self.skipTest('local frozen research candidates are not present on deployment hosts')
        candidates = json.loads(path.read_text())['guards']
        self.assertEqual(len(candidates), 2160)
        values = [1.25, -.75, -.5, 0, .25, -.25, 1, -.5] * 8
        records = [dict(token=f'{i:04}', block=i, launched=i*60000, available=i*60000+1000, value=value) for i, value in enumerate(values)]
        checks = sorted({0, *[r['available'] for r in records], *[r['available']+1 for r in records], 15000000})
        policies = [dict(id=str(i), n=r['n'], m=r['m'], off=r['off'], freshOn=r['fresh_on'], fullOn=r['full_on'], ageMs=r['age_min']*60000, mode=r['mode']) for i, r in enumerate(candidates)]
        tapes = [dict(id=f'p{p}-{order}', complete=True, outcomes=records) for p in (10, 50, 90) for order in ('before', 'after')]
        actual = execute_batch('scenario-guards', start=0, policies=policies, checks=checks, tapes=tapes, configId='fixed')
        tape = SignalTape(records)
        for spec, got in zip(candidates, actual):
            guard = Guard(tape, Rule(**spec), 1, 0, entries=checks)
            for at, row in zip(checks, got):
                reference = guard.read(at)
                self.assertEqual(row, [reference['allow'], reference['score20'], reference['fresh_sum'], reference['fresh']], (spec, at))
