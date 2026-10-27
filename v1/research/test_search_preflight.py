import unittest
from research.core.search_preflight import assess


class SearchPreflightTest(unittest.TestCase):
    def comparison(self, complete):
        return {'periods': {k: [{'complete': complete}] * 6 for k in ['train3', 'train5', 'train7']}}

    def test_missing_accounts_block_before_large_search(self):
        self.assertFalse(assess([])['ready'])
        self.assertFalse(assess([self.comparison(False)] * 20)['ready'])

    def test_all_chronological_cutoffs_need_support(self):
        good = self.comparison(True)
        self.assertTrue(assess([good])['ready'])
        good['periods']['train3'][0] = {'complete': False}
        self.assertFalse(assess([good])['ready'])


if __name__ == '__main__':
    unittest.main()
