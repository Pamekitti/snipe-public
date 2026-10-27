import unittest
from core.execution import archive_execution_coverage


class ExecutionCoverageTests(unittest.TestCase):
    def fixture(self):
        return {'paths': {'a': [{'blockNumber': '0x2', 'blockHash': 'b'}]},
                'blocks': {'0x2': {'hash': 'b', 'timestamp': 1}, '0x3': {'hash': 'c', 'timestamp': 5}},
                'path_coverage': {'a': {'from': 1, 'to': 4, 'all_topics': True}}}, {'token': 'a', 'entry_block': 1}

    def test_uses_verified_cached_horizon_within_the_scanned_interval(self):
        data, position = self.fixture()
        proof = archive_execution_coverage(data, position, 4000)
        self.assertTrue(proof['complete'])
        self.assertFalse(proof['independentlyChecked'])

    def test_missing_horizon_or_mismatched_block_hash_stays_unavailable(self):
        data, position = self.fixture()
        self.assertIn('unproved_execution_horizon', archive_execution_coverage(data, position, 6000)['faults'])
        data['blocks']['0x2']['hash'] = 'wrong'
        self.assertIn('unverified_log_header', archive_execution_coverage(data, position, 4000)['faults'])

    def test_requires_explicit_independent_verification_and_all_topics(self):
        data, position = self.fixture()
        data['path_coverage']['a']['independently_checked'] = True
        self.assertTrue(archive_execution_coverage(data, position, 4000)['independentlyChecked'])
        data['path_coverage']['a']['all_topics'] = False
        self.assertFalse(archive_execution_coverage(data, position, 4000)['complete'])
