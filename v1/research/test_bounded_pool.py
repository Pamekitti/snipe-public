import unittest
from research.core.bounded_pool import latest_header
class Headers:
    def __init__(self,missing=False):self.missing=missing
    def get(self,method,args):
        n=int(args[0],16)
        return None if self.missing else dict(number=hex(n),timestamp=hex(n//10),hash='0x'+str(n))
class BoundedPoolTests(unittest.TestCase):
    def test_latest_block_in_timestamp_second(self):
        a,b=latest_header(Headers(),100,12345)
        self.assertEqual(int(a['number'],16),129)
        self.assertEqual(int(b['number'],16),130)
        self.assertLessEqual(int(a['timestamp'],16)*1000,12345)
        self.assertGreater(int(b['timestamp'],16)*1000,12345)
    def test_missing_and_outside_coverage(self):
        for c,at in [(Headers(True),12345),(Headers(),9999),(Headers(),999999)]:
            with self.assertRaises(ValueError):latest_header(c,100,at)
