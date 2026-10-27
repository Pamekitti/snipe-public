import unittest

from research.core.shared_execution import ExecutionWorker, execute_batch


class ExecutionWorkerTests(unittest.TestCase):
    def test_reuses_process_and_recovers_after_request_error(self):
        with ExecutionWorker() as worker:
            pid = worker.process.pid
            identity = worker.call('identity')
            with self.assertRaisesRegex(RuntimeError, 'unknown operation'):
                worker.call('invalid-operation')
            self.assertEqual(worker.call('identity'), identity)
            self.assertEqual(worker.process.pid, pid)
            self.assertEqual(worker.call('predict', requests=[]), [])
        self.assertIsNotNone(worker.process.poll())
        with self.assertRaisesRegex(RuntimeError, 'not running'):
            worker.call('identity')

    def test_existing_one_shot_interface_matches_persistent_interface(self):
        with ExecutionWorker() as worker:
            self.assertEqual(worker.call('identity'), execute_batch('identity'))


if __name__ == '__main__':
    unittest.main()
