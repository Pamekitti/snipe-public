import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from research.core.bounded_run import run
from research.core.data import write_json,read_json

class BoundedRunTest(unittest.TestCase):
 def test_three_publication_delays_reuse_execution_and_resume_verified_outputs(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);(root/'matrices').mkdir();(root/'pool-quotes').mkdir()
   write_json(root/'input-manifest.json',{'poolScenarios':[dict(id='pool-d0-h0',extraDelayMs=0,haircutBps=0)],'publicationDelaysMs':[0,60000,180000]})
   write_json(root/'matrices/0000.json',[dict(value='integer')]);write_json(root/'pool-quotes/0000.json',{'quotes':{}})
   calls=[];hydrations=[]
   def score(folder,workers,execution_only=False):
    folder=Path(folder)
    if execution_only:write_json(folder/'run-freeze.json',{'fixture':'frozen'});return
    calls.append(folder.name);(folder/'accounts').mkdir(exist_ok=True)
    write_json(folder/'accounts/a.json',{'value':'12345678901234567890'})
    write_json(folder/'comparison-summary.json',{'comparisons':1,'complete':False,'stages':[]})
   def hydrate(args,**kwargs):
    hydrations.append(args);Path(args[6]).write_bytes(Path(args[4]).read_bytes())
   with patch('research.core.bounded_run.run_grid',side_effect=score),patch('research.core.bounded_run.acquire'),patch('research.core.bounded_run.subprocess.run',side_effect=hydrate):
    run(root,'unused');run(root,'unused')
   self.assertEqual(len(hydrations),1);self.assertEqual(len(calls),3)
   self.assertEqual(read_json(root/'bounded-status.json')['completed'],3)
   self.assertEqual(len(list((root/'hydrated').rglob('*.json.gz'))),1)
   for folder in (root/'scenarios').iterdir():
    self.assertTrue((folder/'accounts/a.json.gz').exists());self.assertEqual(list((folder/'matrices').iterdir()),[])
