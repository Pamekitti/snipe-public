import random
import unittest
from dataclasses import replace
from itertools import product

from core.grid_batch_guard import grouped_transitions
from core.grid_v2_guard import Rule, Guard
from core.indicators import SignalTape


class BatchGuardParityTests(unittest.TestCase):
    def test_training_reuse_never_reads_later_cutoff(self):
        import tempfile
        from pathlib import Path
        from core.grid_v2_folds import reuse_identical_training
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            # No parent selection exists. A different cutoff must return without
            # reading or using the later training result.
            self.assertFalse(reuse_identical_training(root,root/'fold',{'fit_end':100},{'fit_end':80}))

    def test_training_reuse_checks_parent_identity_and_reselects(self):
        import tempfile
        import json
        from pathlib import Path
        from unittest.mock import patch
        from core.grid_v2_folds import reuse_identical_training
        from core.data import digest,write_json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'fold';out.mkdir()
            write_json(root/'run.json',{'fit_end':100})
            parent={'run_sha256':digest(root/'run.json'),'candidates':{'one':{'rule':'example'}}}
            write_json(root/'locked-selection.json',parent)
            for phase in ('core','families','exits','cross','pairs','pair_cross','refine','expand'):(root/phase).mkdir()
            def reselect(target,labels,name):
                self.assertEqual(labels,['cross','pair_cross','refine','expand'])
                write_json(target/name,{'candidates':parent['candidates']})
            with patch('core.grid_v2_folds.selection',side_effect=reselect) as select:
                self.assertTrue(reuse_identical_training(root,out,{'fit_end':100},{'fit_end':100}))
                self.assertEqual(select.call_count,1)
            self.assertFalse(json.loads((out/'training-reuse.json').read_text())['evaluation_reused'])
            write_json(root/'run.json',{'fit_end':101})
            with self.assertRaisesRegex(ValueError,'identity'):
                reuse_identical_training(root,out,{'fit_end':100},{'fit_end':100})

    def test_reused_snapshot_preserves_observations_without_second_read(self):
        from core.account import observations
        from unittest.mock import patch
        raw={'bot_launches':[{'token':'x','creator_tax_bps':100,'exemptions':3}]}
        data={'source':'not-read','observations':[{'token':'x','launched_at':1,'block':1,'at':2,'bars':'{"1.75":0.25}','peak':1.9}]}
        with patch('core.account.read_json',return_value=raw) as read:
            expected=observations(data)
            read.assert_called_once()
        with patch('core.account.read_json',side_effect=AssertionError('Duplicate snapshot load')):
            self.assertEqual(observations(data,raw),expected)

    def compare(self, records, rules, entries, controls, end=6_000_000):
        tape = SignalTape(records)
        expected = {}
        for rule in rules:
            guard = Guard(tape, rule, 10**16, 0, entries, controls)
            for at in sorted(x for x in guard.schedule if 0 <= x < end):
                guard.read(at)
            expected[rule.name] = guard.transitions
        actual = dict((rule.name, transitions) for rule, transitions in
            grouped_transitions(SignalTape(records), rules, 10**16, 0, end, entries, controls))
        self.assertEqual(actual, expected)

    def test_all_rule_families_with_delayed_publications_config_and_stops(self):
        rng = random.Random(8427)
        records = []
        for i in range(90):
            launched = i*40000
            records.append(dict(token=f't{i:03}',block=i,launched=launched,
                available=launched+50000+rng.choice([0,80000,400000]),
                value=rng.choice([-1,-.5,0,.125,.5,1,2]),
                config=None if i<25 else 'a' if i<55 else 'b', invalid=i in (31,71)))
        rules = []
        for weighting,cap,n,m in product(('sum','uniform','exponential'),(None,.5),(10,20),(3,8)):
            for i in range(16):
                rules.append(Rule(n=n,m=m,age_min=30,weighting=weighting,win_cap=cap,
                    off=(-1,0)[i%2],fresh_on=(.5,1)[i%2],full_on=(1,2)[i%2],
                    mode=('fresh','full','either','both')[i%4],normalized=i%2==0,
                    fresh_brake=(None,-.5)[i%2],recovery_floor=(None,0)[i%2],
                    participation=(None,.375)[i%2],new_outcomes=(1,2,4)[i%3]))
        self.compare(records,rules,range(1,6_000_000,59999),[(120000,'resume'),(2300000,'resume')])

    def test_simultaneous_publications_and_reopen_below_brake(self):
        records=[dict(token=f't{i:03}',block=i,launched=i,available=100,value=-1 if i<12 else .25) for i in range(20)]
        records.extend(dict(token=f't{i:03}',block=i,launched=i,available=200,value=.5) for i in range(20,24))
        rules=[replace(Rule(),off=-1+i*.125,new_outcomes=1+i%4) for i in range(16)]
        self.compare(records,rules,[100,101,200,201],[],end=20000000)

    def test_small_groups_empty_tape_and_threshold_equalities(self):
        self.compare([], [Rule()], [], [])
        records=[dict(token=f't{i:03}',block=i,launched=i,available=100,value=.125) for i in range(20)]
        rules=[replace(Rule(),fresh_on=1,full_on=2.5,off=2.5,mode=mode,new_outcomes=count)
            for mode,count in product(('fresh','full','either','both'),(1,2,4))]
        self.compare(records,rules,[100,101],[(102,'resume')])


if __name__=='__main__':
    unittest.main()
