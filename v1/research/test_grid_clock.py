import unittest
from core.grid_clock import publications


class ClockTests(unittest.TestCase):
    def test_serial_completion_and_gate_wait(self):
        models={t:dict(entry=0) for t in ('a','b','c')}
        records=[dict(token=t,entry=0,available=100001 if t=='a' else 1) for t in ('a','b','c')]
        rows=publications(records,models)
        self.assertEqual([r['modeled_durable_at'] for r in rows],[59000,60000,61000])
        self.assertEqual([r['available'] for r in rows],[100001,60001,61001])

    def test_closure_and_stress_are_lower_bounds(self):
        record=dict(token='x',entry=0,available=80001)
        self.assertEqual(publications([record],{'x':dict(entry=0)},60000)[0]['available'],140001)
