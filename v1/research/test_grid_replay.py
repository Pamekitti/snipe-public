"""Exact default replay parity plus dynamic deadline invariants."""
import gzip,json,unittest
from pathlib import Path
from core.data import Worker
from core.grid_exits import exits,variant

class GridReplayTests(unittest.TestCase):
 def test_frozen_integer_replays_and_bounded_deadlines(self):
  cases=json.loads(gzip.decompress((Path(__file__).parent.parent/'test/fixtures/replay-before-extraction.json.gz').read_bytes()))['cases']
  with Worker(Path('research/core/grid_worker.ts')) as worker:
   for case in cases:self.assertEqual(worker.call(**case['request']),case['expected'])
   case=next(c for c in cases if c['expected']['status']=='closed' and c['expected'].get('reason')=='time')
   request=case['request']
   for policy in exits():
    result=worker.call(**{**request,**variant(policy,request['rules'])})
    if result['status']=='closed':
     cap=policy.get('capMs',policy.get('maxHoldMs'))
     opened=request.get('openedAt',request['entryAt'])
     self.assertLessEqual(result['exitAt'],max(opened+cap,request.get('buyAt',request['entryAt']))+request.get('sellDelayMs',600)+2*request.get('pollMs',500))
