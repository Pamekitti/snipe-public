import random
import unittest
from core.grid_select import frontier, neighbors
from core.grid_guard import GridRule


class SelectionTests(unittest.TestCase):
    def test_frontier_matches_brute_force_and_preserves_ties(self):
        random.seed(42)
        vectors={str(i):tuple(random.randrange(5) for _ in range(4)) for i in range(100)}
        vectors['tie']=vectors['0']
        rows={key:dict(worst_net_wei=-v[0],worst_dd_wei=v[1],worst_recovery_loss_wei=v[2],worst_losing_recoveries=v[3]) for key,v in vectors.items()}
        expected={key for key,v in vectors.items() if not any(w!=v and all(a<=b for a,b in zip(w,v)) for w in vectors.values())}
        self.assertEqual(set(frontier(rows)),expected)

    def test_neighbors_stay_in_declared_range(self):
        for base in (GridRule(),GridRule(n=10,m=10,mode='full'),GridRule(n=40,m=15,mode='either')):
            for rule in neighbors(base):
                self.assertLessEqual(rule.m,rule.n)
                self.assertTrue(10<=rule.n<=40)
                self.assertTrue(30<=rule.age_min<=180)
                if rule.mode=='full':self.assertEqual(rule.m,rule.n)

    def test_selection_rejects_later_period_results(self):
        import tempfile
        from pathlib import Path
        from core.data import write_json,digest
        from core.grid_select import select
        from core.grid_jobs import FIT_END
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);job=root/'job'
            write_json(job/'design.json',dict(end=FIT_END+1))
            write_json(root/'joint_coarse/jobs.json',dict(jobs=[dict(output=str(job))]))
            write_json(root/'joint_coarse/completed.json',dict(plan_sha256=digest(root/'joint_coarse/jobs.json')))
            with self.assertRaisesRegex(ValueError,'cannot read validation'):
                select(root,'joint_coarse')
