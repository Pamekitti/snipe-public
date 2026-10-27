import unittest
from core.grid_guard import GridGuard,GridRule,grid
from core.indicators import SignalTape

class GridTests(unittest.TestCase):
 def tape(self,values,available=100):
  return SignalTape([dict(token=str(i).zfill(3),block=i,launched=i,available=available,value=v) for i,v in enumerate(values)])
 def test_default_reopens_below_brake_then_stops(self):
  g=GridGuard(self.tape([-1]*12+[.2]*8),GridRule(),1,0,entries=[101])
  self.assertTrue(g.read(100)['allow']);self.assertFalse(g.read(101)['allow'])
  self.assertFalse(g.read(101)['allow'])
 def test_reads_do_not_advance(self):
  g=GridGuard(self.tape([-1]*12+[.2]*8),GridRule(),1,0)
  self.assertTrue(g.read(100)['allow']);self.assertTrue(g.read(101)['allow'])
 def test_stale_and_warmup(self):
  g=GridGuard(self.tape([1]*19),GridRule(),1,0)
  self.assertFalse(g.read(100)['allow'])
  g=GridGuard(self.tape([1]*20),GridRule(),1,0)
  self.assertTrue(g.read(100)['allow']);self.assertFalse(g.read(10800001)['allow'])
 def test_grid_unique(self):
  rows=list(grid());self.assertEqual(len(rows),len({r.name for r in rows}));self.assertIn(GridRule(),rows)
 def test_all_frozen_guard_checks(self):
  import json
  from pathlib import Path
  rows=json.loads((Path(__file__).parent.parent/'test/fixtures/fresh-recovery-parity.json').read_text())
  count=0
  for case in rows:
   g=GridGuard(SignalTape(case['records']),GridRule(),1,case['start'],entries=[x[0] for x in case['expected']])
   for at,allowed,score,recent,fresh in case['expected']:
    r=g.read(at)
    self.assertEqual(r['allow'],allowed);self.assertEqual(r['fresh'],fresh)
    if score is not None:self.assertAlmostEqual(r['score20'],score*min(20,g.index)/20)
    self.assertAlmostEqual(r['fresh_sum'],recent);count+=1
  self.assertEqual(count,8056)
 def test_selector_common_completion_and_strict_clock(self):
  from core.grid_selector import HoldSelector
  row=dict(token='a',block=1,entry=0,published=10,size=1,results={'45':dict(status='closed',exitAt=45,pnlWei=1),'90':dict(status='closed',exitAt=90,pnlWei=2)})
  s=HoldSelector([row],['45','90'],1,'45')
  self.assertEqual(s.select(91)[0],'45')
  self.assertEqual(s.select(92)[0],'90')
 def test_fingerprint_preserves_different_thresholds(self):
  from core.account import simulate
  from core.policies import Policy
  from core.guard_visual import close_cash
  tape=self.tape([.2]*20)
  trades=[dict(id='x',token='x',entry=101,exit=102,size=10,pnl=2,template='x',creator_tax_bps=100,exemptions=4,is_trade=True,costs=[])]
  runs=[];signatures=[]
  for threshold in (.5,1):
   rule=GridRule(fresh_on=threshold)
   g=GridGuard(tape,rule,10,0,[101])
   for at in sorted(x for x in g.schedule if 0<=x<200):g.read(at)
   signatures.append([(r['at'],r['allow']) for r in g.transitions])
   g=GridGuard(tape,rule,10,0,[101])
   runs.append(close_cash(simulate([],trades,Policy(size_wei=10,bankroll_wei=100,dd_wei=100,touch_enabled=False),0,200,guard=g)))
  self.assertEqual(signatures[0],signatures[1]);self.assertEqual(runs[0],runs[1])
