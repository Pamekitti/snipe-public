import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from research.core.data import Cache
from research.core.fork_archive import reply


class ForkArchiveTest(unittest.TestCase):
    def test_permanent_provider_rejection_does_not_backoff_and_retry(self):
        calls=[]
        def rejected(*args, **kwargs):
            calls.append(1)
            raise urllib.error.HTTPError('https://example.invalid',413,'range too large',{},None)
        with tempfile.TemporaryDirectory() as tmp, Cache(Path(tmp)/'cache.sqlite',True,opener=rejected,sleeper=lambda _:None) as cache:
            self.assertIsNone(cache.get('eth_getLogs',[{'fromBlock':'0x1','toBlock':'latest'}]))
            self.assertEqual(len(calls),1)

    def test_nullable_receipt_is_not_confused_with_missing_state_or_provider_failure(self):
        with tempfile.TemporaryDirectory() as tmp, Cache(Path(tmp) / 'cache.sqlite', False) as cache:
            for method in ['eth_getTransactionReceipt', 'eth_getStorageAt']:
                args = ['0x1234']
                cache.db.execute('insert into failures values(?,?,?,?)',
                                 (cache.key(method,args),json.dumps([method,args]),'missing result',1))
                response = reply(cache,dict(id=1,method=method,params=args))
                if method == 'eth_getTransactionReceipt':
                    self.assertIn('result',response)
                    self.assertIsNone(response['result'])
                else:
                    self.assertIn('error',response)
            cache.db.execute("update failures set error='monthly capacity limit exceeded'")
            self.assertIn('error',reply(cache,dict(id=1,method='eth_getTransactionReceipt',params=['0x1234'])))

    def test_no_write_method_can_reach_upstream(self):
        for method in ['eth_sendRawTransaction', 'eth_sendTransaction', 'anvil_setBalance', 'personal_unlockAccount']:
            with self.assertRaisesRegex(ValueError,'read-only'):
                reply(None,dict(id=1,method=method,params=[]))


if __name__ == '__main__':
    unittest.main()
