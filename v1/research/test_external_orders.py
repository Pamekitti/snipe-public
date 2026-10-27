import copy
import gzip
import json
import unittest
from pathlib import Path
from research.core.external_orders import buy_input, enrich


class ExternalOrderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).parents[1] / 'test/fixtures/refunded-external-buy.json.gz'
        cls.fixture = json.loads(gzip.decompress(path.read_bytes()))

    def test_original_budget_and_minimum_are_recovered_without_mutating_capture(self):
        f = self.fixture
        log = next(x for x in f['request']['logs'] if x.get('externalBuy'))
        result = buy_input(log, f['receipt'], f['trace'])
        self.assertEqual(result, log['externalBuy'])
        self.assertEqual(result['quoteInWei'], '1500000000000000000')
        self.assertEqual(int(log['data'][2:66], 16), 62671876586666435)
        before = copy.deepcopy(f['request'])
        enrich(f['request'], {log['transactionHash']: f})
        self.assertEqual(before, f['request'])

    def test_wrong_receipt_and_ambiguous_trace_fail_closed(self):
        f = self.fixture
        log = next(x for x in f['request']['logs'] if x.get('externalBuy'))
        receipt = copy.deepcopy(f['receipt'])
        receipt['transactionHash'] = '0xwrong'
        with self.assertRaisesRegex(ValueError, 'identity'):
            buy_input(log, receipt, f['trace'])
        trace = copy.deepcopy(f['trace'])
        trace['calls'] *= 2
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            buy_input(log, f['receipt'], trace)


if __name__ == '__main__':
    unittest.main()
