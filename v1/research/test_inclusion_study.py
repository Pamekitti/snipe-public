import unittest
from core.inclusion_study import inclusion_interval,prior_samples
from core.inclusion_order_study import rank_before_order


class InclusionEvidenceTests(unittest.TestCase):
    def test_inclusion_interval_is_bounded_by_send_and_adoption(self):
        self.assertEqual(inclusion_interval(10200,10000,10600),dict(lower=0,midpoint=200,upper=400))
        self.assertEqual(inclusion_interval(9800,10000,12000),dict(lower=200,midpoint=700,upper=1200))
        self.assertIsNone(inclusion_interval(10200,10000,10100))
        self.assertIsNone(inclusion_interval(10200,10000,None))

    def test_never_calibrates_with_current_later_or_unpublished_attempts(self):
        at=100000000;cutoff=at-21600000
        sample=dict(id=1,completedAt=1,availableAt=2)
        samples=[sample,dict(sample,id=2,availableAt=cutoff),dict(sample,id=3,completedAt=cutoff),dict(sample,id=4,completedAt=at,availableAt=at)]
        self.assertEqual(prior_samples(samples,at),[sample])
        many=[dict(sample,id=i,completedAt=i) for i in range(200)]
        self.assertEqual(len(prior_samples(many,at)),100)
        self.assertEqual(prior_samples(many,at)[-1]['id'],100)

    def test_rank_counts_whole_transactions_and_excludes_own_transaction(self):
        def log(tx,index,hash):return dict(blockNumber='0xa',transactionIndex=tx,logIndex=index,transactionHash=hash,topics=[],at=10000)
        logs=[log(1,0,'before'),log(1,1,'before'),log(2,2,'ours'),log(2,3,'ours'),log(3,4,'after')]
        self.assertEqual(rank_before_order(logs,'ours','0xabcdef',10000),.5)
        self.assertIsNone(rank_before_order(logs,'missing','0xabcdef',10000))
        self.assertIsNone(rank_before_order([log(2,2,'ours')],'ours','0xabcdef',10000))


if __name__=='__main__':unittest.main()
