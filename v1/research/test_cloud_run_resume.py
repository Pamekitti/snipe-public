"""Completed work must not inflate the measured scoring throughput."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from research.core import cloud_run
from research.core.data import digest

BASELINE=dict(id='baseline',n=10,m=5,off=-2,freshOn=1,fullOn=2,ageMs=10800000,mode='both')

class CloudResumeTest(unittest.TestCase):
 def fixture(self,root,shared):
  root.mkdir();(root/'matrices').mkdir();(root/'accounts').mkdir()
  chunk=root/'chunk.json';chunk.write_text('[]')
  matrix=root/'matrices/chunk.json';matrix.write_text('[]')
  account=root/'accounts/fixed-memory20-hold-45.json';account.write_text('{}')
  manifest=dict(start=0,through=100,chunks=[dict(path=str(chunk),sha256=digest(chunk))],preparedMatrices={'chunk.json':digest(matrix)},boundedResearch=True,sharedPilotPath=str(shared),scoringPilotWorkers=[1])
  (root/'input-manifest.json').write_text(json.dumps(manifest))
  (root/'account-manifest.json').write_text(json.dumps({'inputManifestHash':digest(root/'input-manifest.json'),'inputs':[dict(path=str(account),sha256=digest(account),lane='fixed',memory=20,exit='hold-45')]}))
 def mocks(self):
  def output(args,**kwargs):
   return json.dumps({'result':{'modelHash':'fixture-model'}} if 'scripts/execution-worker.ts' in args else {'policies':[BASELINE], 'families':{}}).encode()
  def execute(args,**kwargs):
   class Completed: returncode=0
   if 'research/core/cloud_score.ts' in args:
    policies=json.loads(Path(args[5]).read_text())
    # Incomplete training blocks wider fitting, preserving the causal gate.
    rows=[dict(policy=p,scenarios=[],periods={k:[dict(complete=False)] for k in ['train3','train5','train7']}) for p in policies]
    Path(args[6]).write_text(json.dumps(dict(results=rows)))
   return Completed()
  return patch.object(cloud_run.subprocess,'check_output',side_effect=output),patch.object(cloud_run.subprocess,'run',side_effect=execute),patch.object(cloud_run,'assess',return_value={'ready':False})
 def test_shared_pilot_is_reused_and_cached_results_are_not_counted(self):
  with tempfile.TemporaryDirectory() as temp:
   parent=Path(temp);root=parent/'first';shared=parent/'pilot.json';self.fixture(root,shared)
   a,b,c=self.mocks()
   with a,b,c:cloud_run.run(root,1)
   pilot=json.loads(shared.read_text());self.assertEqual(pilot['bands'][0]['completedCandidates'],1)
   self.assertTrue(pilot['complete']);self.assertTrue(pilot['endedEarlyBecauseCoreComplete'])
   second=parent/'second';self.fixture(second,shared)
   a,b,c=self.mocks()
   with a,b,c:cloud_run.run(second,1)
   self.assertEqual(json.loads(shared.read_text()),pilot)
   # Remove the pilot to exercise a resume with only cached jobs.
   shared.unlink()
   a,b,c=self.mocks()
   with a,b,c:cloud_run.run(root,1)
   self.assertFalse(shared.exists())
   resumed=json.loads((root/'parallelism-pilot.json').read_text())
   self.assertEqual(resumed['bands'][0]['completedCandidates'],0)

if __name__=='__main__':unittest.main()
