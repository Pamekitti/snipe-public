"""Causality and coverage checks for the cloud account input adapter."""
import copy,json,tempfile,unittest
from pathlib import Path
from research.core.cloud_accounts import run
from research.core.parallel_accounts import run as parallel_run
class CloudAccountsTest(unittest.TestCase):
 def fixture(self,root):
  start=1788220800000;config={'entry':{'minCreatorTaxBps':50,'minExemptionsToEnter':3,'templateLossBlockMs':60000,'tradeSizeEth':.01},'bankrollWei':'100000000000000000','maxConcurrent':3,'maxDrawdownWei':'60000000000000000','entryHours':[]}
  (root/'matrices').mkdir();(root/'input-manifest.json').write_text(json.dumps(dict(start=start,through=start+30000,config=config,controls=[])))
  rows=[]
  for i in range(25):
   at=start+i*1000
   matrix=[[[dict(pnlWei=str(100 if t==0 else -100),exitAt=at+100,status='closed') for t in range(7)] for h in range(9)] for s in range(6)]
   rows.append(dict(id=str(i),token=str(i),at=at,sequence=i,block=i+1,launched=at-500,creatorTaxBps='100',exemptions=3,template=str(i),configId='test',config=config,sizeWei='10000000000000000',publicationFloor=at+101,selectorPopulation=True,matrix=matrix,coverage={'complete':True,'independentlyChecked':True,'gaps':[]}))
  return rows
 def test_selector_waits_for_twenty_complete_publications_and_never_uses_future_labels(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);rows=self.fixture(root);(root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   pinned=json.loads((root/'accounts/fixed-memory20-hold-45-pinned.json').read_text())
   self.assertEqual([r['target'] for r in pinned[:20]],[1.75]*20);self.assertEqual(pinned[20]['target'],1.25)
   rows[-1]['matrix'][3][5][6]['pnlWei']='10000000000000000';(root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   changed=json.loads((root/'accounts/fixed-memory20-hold-45-pinned.json').read_text());self.assertEqual(changed,pinned)
 def test_missing_clock_prefix_is_labeled_and_incomplete_common_bars_cannot_select_tp(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);rows=self.fixture(root);rows[0]['matrix'][0][5][0]['pnlWei']=None
   for row in rows[20:]:row['matrix']+=copy.deepcopy(row['matrix'])
   (root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   pinned=json.loads((root/'accounts/fixed-memory20-hold-45-pinned.json').read_text());self.assertEqual(pinned[20]['target'],1.75)
   manifest=json.loads((root/'account-manifest.json').read_text());corrected=next(v for v in manifest['inputs'] if v['lane']=='corrected')
   self.assertEqual(corrected['unavailablePrefixLaunches'],20);self.assertEqual(corrected['start'],rows[20]['at'])
 def test_modeled_publication_is_explicit_and_does_not_resolve_unknown_execution(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);rows=self.fixture(root)
   for row in rows:row['publicationFloor']+=86400000
   rows[0]['matrix'][0][5][0]['pnlWei']=None
   (root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   before=json.loads((root/'accounts/fixed-memory20-hold-45-pinned.json').read_text())
   self.assertTrue(all(r['target']==1.75 for r in before))
   manifest=json.loads((root/'input-manifest.json').read_text())
   manifest['publicationPolicy']={'kind':'modeled-periodic-v1','periodMs':1000,'phaseMs':0,'workerMs':0,'sourceHorizonMs':0}
   (root/'input-manifest.json').write_text(json.dumps(manifest));run(root)
   account=json.loads((root/'accounts/fixed-memory20-hold-45.json').read_text())
   self.assertTrue(all(o['publicationEvidence']['historicalPublicationRecovered'] is False for o in account['opportunities']))
   pinned=json.loads((root/'accounts/fixed-memory20-hold-45-pinned.json').read_text())
   self.assertEqual(pinned[-1]['target'],1.25)
   self.assertEqual(rows[0]['publicationFloor'],account['opportunities'][0]['publicationEvidence']['recordedFloor'])
   # Make the pinned target itself unknown. Scheduling cannot turn it into a result.
   rows[0]['matrix'][0][5][3]['pnlWei']=None
   rows[0]['matrix'][0][5][3].update(status='unavailable',reason='missing_pool_fixture',exitAt=None)
   (root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   account=json.loads((root/'accounts/fixed-memory20-hold-45.json').read_text())
   self.assertFalse(account['opportunities'][0]['bundle']['complete'])
   self.assertIsNone(account['opportunities'][0]['bundle']['scenarios'][0]['result']['pnlWei'])
 def test_exit_subsets_preserve_pinned_adaptive_selection(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);rows=self.fixture(root);(root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   subset=root/'subset';run(root,only_exits=['adaptive-hold','hold-45'],output_root=subset)
   for path in (subset/'accounts').glob('*.json'):
    self.assertEqual(path.read_bytes(),(root/'accounts'/path.name).read_bytes())
   with self.assertRaisesRegex(ValueError,'invalid exit subset'):run(root,only_exits=['unknown-exit'])
 def test_parallel_preparation_matches_every_serial_payload_and_refuses_changed_capture(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);rows=self.fixture(root);(root/'matrices/0000.json').write_text(json.dumps(rows));run(root)
   target=root/'parallel';parallel_run(root,workers=3,output_root=target)
   self.assertEqual({p.name for p in (target/'accounts').glob('*.json')},{p.name for p in (root/'accounts').glob('*.json')})
   for path in (target/'accounts').glob('*.json'):
    self.assertEqual(path.read_bytes(),(root/'accounts'/path.name).read_bytes())
   parallel_run(root,workers=3,output_root=target)
   manifest=json.loads((root/'input-manifest.json').read_text());manifest['publicationExtraDelayMs']=60000;(root/'input-manifest.json').write_text(json.dumps(manifest))
   with self.assertRaisesRegex(ValueError,'different frozen inputs'):parallel_run(root,workers=3,output_root=target)
if __name__=='__main__':unittest.main()
