"""A corrupt result bundle must fail verification before resource cleanup."""
import hashlib,io,json,tarfile,tempfile,unittest
from pathlib import Path
from research.core.cloud_cleanup import verify_bundle
class ArchiveVerificationTest(unittest.TestCase):
 def bundle(self,root,corrupt=False):
  value=b'{"complete":true}';name='report/result.json'
  manifest=json.dumps({'files':{name:hashlib.sha256(value).hexdigest()}}).encode()
  (root/'artifact-manifest.json').write_bytes(manifest)
  with tarfile.open(root/'results-bundle.tar.gz','w:gz') as tar:
   for path,data in [('artifact-manifest.json',manifest),(name,b'wrong' if corrupt else value)]:
    member=tarfile.TarInfo('./'+path);member.size=len(data);tar.addfile(member,io.BytesIO(data))
  (root/'bundle-proof.json').write_text(json.dumps({'sha256':hashlib.sha256((root/'results-bundle.tar.gz').read_bytes()).hexdigest(),'manifestHash':hashlib.sha256(manifest).hexdigest()}))
 def test_good_bundle_is_verified_and_report_extracted(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.bundle(root);self.assertEqual(len(verify_bundle(root)['files']),1);self.assertTrue((root/'report/result.json').exists())
 def test_matching_bundle_hash_does_not_hide_a_corrupt_member(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);self.bundle(root,True)
   with self.assertRaisesRegex(RuntimeError,'artifact verification failed'):verify_bundle(root)
if __name__=='__main__':unittest.main()
