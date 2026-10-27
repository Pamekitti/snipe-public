import gzip,json,tempfile,unittest
from pathlib import Path
from research.core.bounded_storage import complete,is_complete
class StorageTest(unittest.TestCase):
 def test_lossless_completed_checkpoint_and_tampering(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);(root/'accounts').mkdir();p=root/'accounts/a.json';payload=b'{"value": "000000000000001"}';p.write_bytes(payload)
   (root/'input-manifest.json').write_text('{}')
   self.assertFalse(is_complete(root,'freeze'))
   complete(root,'freeze');self.assertTrue(is_complete(root,'freeze'))
   self.assertFalse(p.exists());self.assertEqual(gzip.open(str(p)+'.gz','rb').read(),payload)
   with self.assertRaisesRegex(ValueError,'another freeze'):is_complete(root,'changed')
   (root/'input-manifest.json').write_text('{"changed":true}')
   with self.assertRaisesRegex(ValueError,'artifact changed'):is_complete(root,'freeze')
