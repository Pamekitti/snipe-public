"""Long-history accounting must not hide an unknown holding or financing need."""
import unittest
from research.core.long_history import required_funding, summary


class LongHistoryAccounting(unittest.TestCase):
    def test_funding_counts_stake_and_cost_without_counting_gas_twice(self):
        run=dict(decisions=[dict(id='a',at=10,reason=None,size=100),dict(id='b',at=40,reason=None,size=100)],
            cash=[dict(id='a',at=10,kind='cost',pnl=-2),dict(id='a',at=30,kind='close',pnl=-18),
                  dict(id='b',at=40,kind='cost',pnl=-2),dict(id='b',at=50,kind='close',pnl=12)])
        self.assertEqual(required_funding(run,100),'122')

    def test_future_unknown_does_not_erase_earlier_complete_partition(self):
        run=dict(cash=[dict(id='a',at=20,pnl=10)],open_ids=['b'],
            decisions=[dict(id='a',at=10,reason=None),dict(id='b',at=50,reason='unsupported_execution')],
            unresolved=[dict(id='b',at=50)])
        self.assertTrue(summary(run,0,40)['complete'])
        self.assertFalse(summary(run,0,60)['complete'])

    def test_cost_on_unclosed_trade_is_not_reported_as_completed_profit(self):
        run=dict(cash=[dict(id='a',at=20,pnl=-2)],open_ids=['a'],
            decisions=[dict(id='a',at=10,reason=None)],unresolved=[])
        got=summary(run,0,30)
        self.assertFalse(got['complete'])
        self.assertEqual(got['n'],0)


if __name__=='__main__':unittest.main()
