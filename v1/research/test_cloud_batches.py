"""Batch packaging preserves every candidate and the frozen core layout."""
import unittest
from research.core.cloud_run import policy_batches


class CloudBatchTest(unittest.TestCase):
    def test_core_layout_keeps_window_groups_and_original_order(self):
        rows=[dict(id=str(i),n=i%3,m=2,ageMs=100) for i in range(12)]
        groups=policy_batches(rows,'core')
        self.assertEqual([[p['id'] for p in group] for group in groups],
                         [['0','3','6','9'],['1','4','7','10'],['2','5','8','11']])
        self.assertEqual(policy_batches(rows,'coverage-preflight'),groups)

    def test_wider_batches_preserve_groups_without_dropping_duplicates(self):
        rows=[dict(id=str(i),n=i%40,m=2,ageMs=100) for i in range(600)]
        rows.append(rows[0].copy())
        core=policy_batches(rows,'core');wide=policy_batches(rows,'train3-neighbors')
        self.assertEqual([p for group in core for p in group],[p for batch in wide for p in batch])
        self.assertTrue(all(len(batch)<=256 for batch in wide))
        self.assertLess(len(wide),len(core))

    def test_large_single_window_is_not_split_and_empty_search_is_empty(self):
        rows=[dict(id=str(i),n=10,m=5,ageMs=100) for i in range(300)]
        self.assertEqual(policy_batches(rows,'train5-pairs'),[rows])
        self.assertEqual(policy_batches([],'train7-families'),[])


if __name__=='__main__':unittest.main()
