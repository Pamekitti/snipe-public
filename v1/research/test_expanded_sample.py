import copy
import unittest

from research.core.expanded_sample import canonical, quote_interval
from research.core.expanded_replay import build_request, median_integer, preceding_costs


class ExpandedSampleTests(unittest.TestCase):
    def test_quote_interval_contains_exactly_all_integer_preimages(self):
        for bps in (0, 1, 1000, 5000, 9999):
            for quote in (10000, 10001, 999999999999999999999999999999):
                minimum = quote*(10000-bps)//10000
                lo, hi = quote_interval(minimum, bps)
                self.assertLessEqual(lo, quote)
                self.assertGreaterEqual(hi, quote)
                self.assertEqual(lo*(10000-bps)//10000, minimum)
                self.assertEqual(hi*(10000-bps)//10000, minimum)
                self.assertLess((lo-1)*(10000-bps)//10000, minimum)
                self.assertGreater((hi+1)*(10000-bps)//10000, minimum)

    def test_invalid_quote_is_not_zero_evidence(self):
        for minimum, bps in ((0,5000),(1,10000),(-1,5000)):
            with self.assertRaises(ValueError): quote_interval(minimum,bps)

    def test_canonical_chain_order_and_duplicate_sensitivity(self):
        log = dict(blockNumber='0xa',logIndex='0x2',blockHash='0xAB',transactionHash='0xCD',address='0xEF',topics=['0xFF'],data='0x00')
        decimal = dict(log,blockNumber=10,logIndex=2,transactionIndex=8)
        self.assertEqual(canonical([log]),canonical([decimal]))
        self.assertNotEqual(canonical([log,log]),canonical([log]))

    def test_costs_exclude_current_future_and_unknown_availability(self):
        def position(i,closed,available):
            return dict(id=i,closed=1,buy_ok=1,exit_reason='time',exit_at=closed,updated_at=available,
                        gas_wei='999',buy_hash=f'b{i}',exit_hash=f's{i}',approval_gas_wei=str(i))
        at=100000000
        positions=[position(1,1,2),position(2,2,3),position(99,at-1,at),position(98,4,None)]
        receipts={f'{side}{i}':dict(gasUsed=str(i),effectiveGasPrice='10') for side in ('b','s') for i in (1,2,98,99)}
        costs, proof=preceding_costs(positions,receipts,at)
        self.assertEqual(set(proof['ids']),{1,2})
        self.assertEqual(costs['buyWei'],'15')
        positions[-2]['gas_wei']='8888888888888888888'
        self.assertEqual(preceding_costs(positions,receipts,at)[0],costs)

    def test_missing_required_receipt_does_not_reduce_sample_silently(self):
        p=dict(id=1,closed=1,buy_ok=1,exit_reason='time',exit_at=1,updated_at=2,gas_wei='1',buy_hash='b',exit_hash='s',approval_gas_wei='0')
        with self.assertRaisesRegex(ValueError,'missing_preceding_receipt'):
            preceding_costs([p],{},100000000)

    def test_no_fill_or_actual_cash_in_request(self):
        job=dict(id=1,entryAt=100000,params=dict(launchedAt='99',launchSupply='1000000'),lo=10,endAt=280000,
                 token='token',curve='curve',sizeWei='10',minTokens='20',quoteInterval=['40','41'],takeProfit=2,
                 context=dict(entryStrategy=dict(maxEntryPriceMultiple=4.5),rules=dict(maxHoldMs=45000)),
                 tokens_held='999999999',actualWei='1000000000')
        proof=dict(complete=True,inputHash='hash',fromBlock=10,endHeader=dict(timestamp=280),logs=[],headers={})
        q=build_request(job,proof,{},'wallet','hash',300000)
        changed=copy.deepcopy(job); changed.update(tokens_held='0',actualWei='-1000000000')
        self.assertEqual(q,build_request(changed,proof,{},'wallet','hash',300000))
        proof['endHeader']['timestamp']=279
        with self.assertRaisesRegex(ValueError,'incomplete_horizon'):
            build_request(job,proof,{},'wallet','hash',300000)

    def test_integer_cost_median_never_rounds_via_float(self):
        self.assertEqual(median_integer([10**30,10**30+3]),10**30+1)


if __name__=='__main__': unittest.main()
