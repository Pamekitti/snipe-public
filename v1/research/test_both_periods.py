import copy
import unittest
from research.core.both_periods import preceding_candidates,cost_model,scenario_defs


class BothPeriodsTests(unittest.TestCase):
    def fixture(self):
        rows=[];receipts={}
        for i in range(25):
            row=dict(id=i,closed=1,buy_ok=1,exit_at=1000+i,buy_hash=f'b{i}',exit_hash=f's{i}',
                exit_reason='time',approval_gas_wei='7',pnl_wei=str(i-12))
            rows.append(row)
            receipts[f'b{i}']=dict(gasUsed='10',effectiveGasPrice='2')
            receipts[f's{i}']=dict(gasUsed='30',effectiveGasPrice='2')
        return rows,receipts

    def test_strict_six_hour_cost_cutoff(self):
        rows,_=self.fixture()
        selected=preceding_candidates(rows,21601010)
        self.assertEqual([r['id'] for r in selected],list(reversed(range(10))))

    def test_current_and_future_results_cannot_change_costs(self):
        rows,receipts=self.fixture();at=30000000
        expected=cost_model(rows,receipts,at)
        changed=copy.deepcopy(rows)
        for row in changed:row['pnl_wei']='999999999999999999999999'
        future=dict(changed[0],id=100,exit_at=at,buy_hash='future',exit_hash='future-sale')
        self.assertEqual(cost_model(changed+[future],receipts,at),expected)
        self.assertEqual(expected[0]['buyWei'],'20')
        self.assertEqual(expected[0]['sellWei'],'60')

    def test_missing_approval_ledger_is_explicit_proxy(self):
        rows,receipts=self.fixture()
        for row in rows:row['approval_gas_wei']=None
        costs,proof=cost_model(rows,receipts,30000000)
        self.assertEqual(costs['approvalWei'],'60')
        self.assertEqual(proof['approvalSource'],'preceding_sell_gas_proxy')

    def test_missing_receipts_remain_unavailable(self):
        rows,receipts=self.fixture()
        for i in range(6):del receipts[f'b{i}']
        with self.assertRaisesRegex(ValueError,'fewer_than_20'):cost_model(rows,receipts,30000000)

    def test_scenarios_are_fixed_and_balanced(self):
        candidates=scenario_defs()
        self.assertEqual(len(candidates),36)
        self.assertEqual(len({c['name'] for c in candidates}),36)
        self.assertEqual(sum(c['slippageBps']==500 for c in candidates),18)
        self.assertEqual(sum(c['slippageBps']==5000 for c in candidates),18)


if __name__=='__main__':unittest.main()
