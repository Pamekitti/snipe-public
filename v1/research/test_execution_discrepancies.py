import copy
import unittest

from research.core.execution_discrepancies import preceding, substitute, timing_samples
from research.core.sell_clock_study import sell_sample


class ExecutionDiscrepanciesTests(unittest.TestCase):
    def test_prior_requires_both_clocks_strictly_before_embargo(self):
        at=30_000_000;cutoff=at-21_600_000
        samples=[dict(id=1,completedAt=cutoff-1,availableAt=cutoff-1),
                 dict(id=2,completedAt=cutoff,availableAt=cutoff-1),
                 dict(id=3,completedAt=cutoff-1,availableAt=cutoff),
                 dict(id=4,completedAt=at,availableAt=at)]
        self.assertEqual([s['id'] for s in preceding(samples,at)],[1])

    def test_prior_uses_latest_100_with_stable_ties(self):
        ss=[dict(id=i,completedAt=10,availableAt=11) for i in range(110)]
        self.assertEqual([s['id'] for s in preceding(ss,30_000_000)],list(range(109,9,-1)))

    def test_missing_timestamps_are_not_inferred_from_outcomes(self):
        p=dict(id=1,closed=1,buy_ok=1,exit_reason='tp',exit_at=1500,
               updated_at=None,t_sent=100,t_confirmed=None)
        samples,missing=timing_samples([p],{1:[dict(at=500,reason=None),dict(at=700,reason='tp')]})
        self.assertEqual(samples,[])
        self.assertEqual(missing[0]['reason'],'missing_marks_or_durable_clock')

    def test_first_mark_is_explicit_upper_bound(self):
        p=dict(id=1,closed=1,buy_ok=1,exit_reason='tp',exit_at=1500,
               updated_at=1700,t_sent=100,t_confirmed=None)
        samples,_=timing_samples([p],{1:[dict(at=500,reason=None),dict(at=700,reason='tp')]})
        self.assertEqual(samples[0]['confirmationMs'],400)
        self.assertEqual(samples[0]['sellMs'],800)
        self.assertEqual(samples[0]['adoptionSource'],'first_mark_upper_bound')

    def test_substitution_does_not_change_other_inputs(self):
        q=dict(timing=dict(label='old',sellMs=1200,confirmationMs=600,observationMs=600,
                          sameTimeOrder='after',buyInclusionMs=300),
               costs=dict(approvalDelayMs=600),logs=[dict(at=100,observedAt=700)],rules=dict(maxHoldMs=45000))
        original=copy.deepcopy(q)
        timing=dict(n=20,fitThrough=0,sellMs=800,confirmationMs=900)
        r=substitute(q,'sell-p50','before',timing)
        self.assertEqual(q,original)
        self.assertEqual(r['timing']['sellMs'],800)
        self.assertEqual(r['timing']['confirmationMs'],600)
        self.assertEqual(r['timing']['observationMs'],600)
        self.assertEqual(r['logs'],q['logs'])
        self.assertEqual(r['costs'],q['costs'])

    def test_sell_block_precedes_recorded_close(self):
        p=dict(id=1,exit_hash='0xABC',exit_at=2400,updated_at=2500)
        q=dict(logs=[dict(transactionHash='0xabc',at=1000)])
        sample=sell_sample(p,[dict(at=1300,reason='tp')],q)
        self.assertEqual((sample['lower'],sample['midpoint'],sample['upper']),(0,350,700))

    def test_recorded_close_bounds_sell_inclusion(self):
        p=dict(id=1,exit_hash='0xabc',exit_at=1700,updated_at=1800)
        sample=sell_sample(p,[dict(at=1300,reason='tp')],dict(logs=[dict(transactionHash='0xabc',at=1000)]))
        self.assertEqual(sample['upper'],400)

    def test_missing_and_inconsistent_chain_clocks_stay_unavailable(self):
        p=dict(id=1,exit_hash='0xabc',exit_at=1700,updated_at=1800)
        self.assertIsNone(sell_sample(p,[dict(at=1300,reason='tp')],dict(logs=[])))
        self.assertIsNone(sell_sample(p,[dict(at=2100,reason='tp')],dict(logs=[dict(transactionHash='0xabc',at=1000)])))


if __name__=='__main__':unittest.main()
