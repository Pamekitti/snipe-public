import unittest
from research.core.publication import publication_time


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.row = {'at': 1000, 'publicationFloor': 86400000}
        self.policy = {'kind': 'modeled-periodic-v1', 'periodMs': 60000,
                       'phaseMs': 0, 'workerMs': 600, 'sourceHorizonMs': 180000}

    def test_recorded_timestamps_never_move_earlier(self):
        self.assertEqual(publication_time(self.row, 45000)[0], 86400000)
        self.assertEqual(publication_time(self.row, 45000, selector=True)[0], 86400001)

    def test_modeled_lane_preserves_recorded_evidence_and_labels_assumption(self):
        at, proof = publication_time(self.row, 45000, self.policy)
        self.assertEqual(at, 240601)
        self.assertEqual(proof['recordedFloor'], 86400000)
        self.assertFalse(proof['historicalPublicationRecovered'])
        self.assertEqual(self.row['publicationFloor'], 86400000)

    def test_waits_for_latest_closure_and_durable_completion(self):
        self.assertEqual(publication_time(self.row, 300000, self.policy)[0], 300601)
        self.assertEqual(publication_time(self.row, 300001, self.policy)[0], 360601)

    def test_invalid_closure_and_policy_are_not_silently_replaced(self):
        for close in [None, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                publication_time(self.row, close, self.policy)
        for values in [{'periodMs': 0}, {'workerMs': -1}, {'phaseMs': 60000}, {'kind': 'guess'}]:
            with self.assertRaises(ValueError):
                publication_time(self.row, 45000, {**self.policy, **values})


if __name__ == '__main__':
    unittest.main()
