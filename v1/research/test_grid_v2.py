import json, unittest
from pathlib import Path
from dataclasses import replace
from core.grid_v2_guard import Rule,Guard,core,neighbors
from core.indicators import SignalTape

class ExpandedGuardTests(unittest.TestCase):
 def tape(self,values,at=100):
  return SignalTape([dict(token=str(i).zfill(3),block=i,launched=i,available=at,value=v) for i,v in enumerate(values)])
 def test_all_8056_baseline_checks(self):
  cases=json.loads((Path(__file__).parent.parent/'test/fixtures/fresh-recovery-parity.json').read_text());n=0
  for case in cases:
   g=Guard(SignalTape(case['records']),Rule(),1,case['start'],entries=[x[0] for x in case['expected']])
   for at,allow,score,recent,fresh in case['expected']:
    r=g.read(at);self.assertEqual(r['allow'],allow);self.assertEqual(r['fresh'],fresh)
    if score is not None:self.assertAlmostEqual(r['score20'],score*min(20,g.index)/20)
    self.assertAlmostEqual(r['fresh_sum'],recent);n+=1
  self.assertEqual(n,8056)
 def test_both_and_floor(self):
  tape=self.tape([-1]*12+[.2]*8)
  self.assertTrue(Guard(tape,Rule(),1,0).read(100)['allow'])
  for r in [Rule(mode='both'),Rule(recovery_floor=0)]:self.assertFalse(Guard(tape,r,1,0).read(100)['allow'])
 def test_recent_brake(self):
  g=Guard(self.tape([1]*12+[-.1]*8),Rule(mode='full',fresh_brake=0),1,0,[101])
  self.assertTrue(g.read(100)['allow']);self.assertFalse(g.read(101)['allow'])
 def test_count_outcomes_since_pause(self):
  rows=self.tape([-1]*12+[.2]*8).records
  rows+= [dict(token=str(20+i),block=20+i,launched=20+i,available=200,value=1) for i in range(2)]
  g=Guard(SignalTape(rows),Rule(new_outcomes=2),1,0,[101,201])
  self.assertTrue(g.read(100)['allow']);self.assertFalse(g.read(101)['allow']);self.assertTrue(g.read(200)['allow'])
 def test_duplicate_not_evidence(self):
  t=self.tape([.2]*20)
  with self.assertRaisesRegex(ValueError,'duplicate'):SignalTape(t.records+t.records)
 def test_invalid_and_config_warmup(self):
  t=self.tape([.2]*20);t.records[-1]['invalid']=True
  self.assertFalse(Guard(t,Rule(),1,0).read(100)['allow'])
  t=self.tape([.2]*20);t.records[-1]['config']='new'
  self.assertFalse(Guard(t,Rule(),1,0).read(100)['allow'])
 def test_weighting_cap_and_participation(self):
  t=self.tape([0]*19+[4])
  self.assertFalse(Guard(t,Rule(win_cap=.5),1,0).read(100)['allow'])
  self.assertFalse(Guard(t,Rule(participation=.25),1,0).read(100)['allow'])
  t=self.tape([.2]*20)
  for weighting in ['uniform','exponential']:
   r=Guard(t,Rule(weighting=weighting),1,0).read(100)
   self.assertAlmostEqual(r['score20'],4);self.assertAlmostEqual(r['fresh_sum'],1.6)
 def test_expiry_cannot_recover(self):
  t=self.tape([.2]*20);g=Guard(t,Rule(new_outcomes=21,age_min=30),1,0)
  self.assertFalse(g.read(100)['allow']);self.assertFalse(g.read(1800001)['allow'])
 def test_unique_grid_and_joint_refinement(self):
  rules=list(core());self.assertEqual(len(rules),len({r.name for r in rules}));self.assertIn(Rule(),rules)
  self.assertTrue(any(r.n==21 and r.m==9 for r in neighbors(Rule())))
  self.assertTrue(any(r.n==60 for r in neighbors(Rule(n=40),True)))

class ExpandedSearchTests(unittest.TestCase):
 def test_exit_catalog_and_timing_neighbors(self):
  from core.grid_v2_exits import catalog,signature
  c=catalog();self.assertEqual(len(c['coarse']),54)
  self.assertEqual(len(c['policies']),len({signature(p) for p in c['policies']}))
  by={p['name']:p for p in c['policies']}
  self.assertEqual(by['fixed_120']['maxHoldMs'],120000)
  self.assertTrue(any(by[n].get('maxHoldMs')==40000 for n in c['neighbors']['fixed_45']))
 def test_family_combinations_preserve_controls(self):
  from core.grid_v2_run import combine_families
  from dataclasses import asdict
  a=Rule(fresh_brake=0);b=Rule(new_outcomes=4)
  rr=combine_families([{'rule':asdict(a)},{'rule':asdict(b)}])
  self.assertIn(a,rr);self.assertIn(b,rr)
  self.assertTrue(any(r.fresh_brake==0 and r.new_outcomes==4 for r in rr))
 def test_recorded_publication_requires_exact_input_and_result(self):
  from core.grid_clock import publications
  record=dict(token='x',entry=0,available=100000,launched=0,value=1)
  model=dict(entry=0,size=1,request_sha256='proof',results={'adaptive':dict(pnlWei='1',exitAt=45000)})
  proof=dict(request_sha256='proof',pnl='1',close_at=45000,available=110000,published_at=110000,gate_at=100000)
  r=publications([record],{'x':model},recorded={'x':proof})[0]
  self.assertEqual(r['available'],110000);self.assertEqual(r['publication_source'],'recorded_exact_request')
  r=publications([record],{'x':model},recorded={'x':dict(proof,request_sha256='different')})[0]
  self.assertEqual(r['publication_source'],'modeled_serial_worker')

class ExperimentIntegrityTests(unittest.TestCase):
 def test_selection_refuses_evaluation_data(self):
  import tempfile
  from unittest.mock import patch
  from core.data import write_json,digest
  from core.grid_v2_run import selection
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);phase=root/'core'
   write_json(phase/'jobs.json',dict(end=11,jobs=[]))
   write_json(phase/'completed.json',dict(plan_sha256=digest(phase/'jobs.json')))
   with patch('core.grid_v2_run.verify',return_value={'fit_end':10}):
    with self.assertRaisesRegex(ValueError,'evaluation'):selection(root,['core'],'selection.json')
 def test_mutated_command_checkpoint_rejected(self):
  import tempfile
  from unittest.mock import patch
  from core.data import write_json
  from core.grid_v2_run import Runner
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);write_json(root/'run.json',{})
   with patch('core.grid_v2_run.verify',return_value={}):
    runner=Runner(root);write_json(root/'phase/command.json',{'wrong':'command'})
    with self.assertRaisesRegex(ValueError,'checkpoint mismatch'):runner.command('phase','unavailable_module',[])
    runner.lock.close()

class EntryTimingTests(unittest.TestCase):
 def test_entry_modes_change_actual_entry_clock(self):
  from core.grid_models import modeled_entry
  f=dict(token='x',launched_at=100,detected_at=105000)
  self.assertEqual(modeled_entry(f,{},'reconstructed_early'),102000)
  self.assertEqual(modeled_entry(f,{},'recorded'),105000)
  self.assertEqual(modeled_entry(f,{'x':107000},'recorded'),107000)
  self.assertEqual(modeled_entry(f,{'x':107000},'reconstructed_early'),102000)
 def test_early_and_recorded_require_distinct_model_paths(self):
  import tempfile
  from core.data import write_json
  from core.grid_v2_run import account_path
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);write_json(root/'run.json',{'entry_timing_models':True})
   for mode in ('recorded','reconstructed_early'):write_json(root/'timings'/mode/'accounts/fixed_45.json',{})
   self.assertNotEqual(account_path(root,'recorded','fixed_45'),account_path(root,'reconstructed_early','fixed_45'))
   with self.assertRaisesRegex(ValueError,'repriced'):account_path(root,'recorded','missing')
 def test_numeric_identity_is_canonical(self):
  self.assertEqual(Rule(off=-1).name,Rule(off=-1.0).name)

class CompactScoreTests(unittest.TestCase):
 def test_logical_rows_and_account_values_match_legacy(self):
  import sqlite3
  from core.grid_score_store import initialize,insert
  rule=Rule();results=[]
  value=dict(complete=True,metrics={'net_wei':'-12','n':1},cash=[{'id':'x','at':1,'pnl':-12}],recovery={'episodes':[]})
  for compact in (False,True):
   db=sqlite3.connect(':memory:');initialize(db,[rule],compact)
   for segment in range(3):insert(db,segment,rule,0,'same-account',value,compact)
   rows=[(segment,name,json.loads(definition),json.loads(ref)) for segment,name,definition,ref in db.execute('select * from scores order by segment')]
   results.append(rows)
   self.assertEqual(db.execute('select count(*) from accounts').fetchone()[0],1)
   self.assertEqual(dict(db.execute('select segment,count(*) from scores group by segment')),{0:1,1:1,2:1})
   db.close()
  self.assertEqual(results[0],results[1])

class PublicationCompatibilityTests(unittest.TestCase):
 def test_wrong_configuration_cannot_supply_recorded_publication(self):
  from core.grid_clock import recorded_publications
  job=dict(config='old',status='published',request={},token='x',pnl='1',close_at=10,available=20,published_at=20,gate_at=15)
  job['request']={'entryAt':0}
  raw=dict(state={'risk':{'venue':{'configId':'current'}}},bot_shadow_jobs=[job])
  self.assertEqual(recorded_publications(raw),{})
  raw['bot_shadow_jobs']=[dict(job,config='current')]
  self.assertIn('x',recorded_publications(raw))

class BoundaryCoverageTests(unittest.TestCase):
 def test_all_integer_main_window_boundary_values_are_searched(self):
  rr=list(neighbors(Rule(n=40),expand=True))
  self.assertTrue(set(range(41,61))<={r.n for r in rr})
 def test_inactive_dead_timer_is_valid(self):
  from core.grid_v2_exits import valid
  self.assertTrue(valid({'kind':'fixed','maxHoldMs':15000,'deadCoinAfterMs':30000}))

class DynamicExitExpansionTests(unittest.TestCase):
 def test_dynamic_cap_boundary_has_full_upper_extension(self):
  from core.grid_v2_exits import catalog
  c=catalog();byname={p['name']:p for p in c['policies']}
  for name in ('progress_20_15_300_90','inactivity_10_300_90'):
   self.assertEqual({byname[n]['capMs'] for n in c['expansions'][name]},set(range(100000,120001,5000)))

class CommonControlTests(unittest.TestCase):
 def test_manual_stop_clear_and_gap_seed(self):
  from core.grid_controls import experiment_controls,interval_controls
  raw={'bot_health':[dict(at=1,component='halt',detail='[manual] HALT=1',ok=0),dict(at=3,component='halt',detail='armed',ok=1)],'bot_guard_samples':[]}
  controls=experiment_controls(raw)
  self.assertEqual(controls,[(1,{'halt':'manual','active':True}),(3,{'halt':'manual','active':False})])
  self.assertEqual(interval_controls(controls,2)[0],(2,{'halt':'manual','active':True}))
  self.assertEqual(interval_controls(controls,4),[])
 def test_recorded_overlay_is_independent_of_simulated_stop(self):
  from core.grid_controls import experiment_controls
  raw={'bot_health':[],'bot_guard_samples':[dict(at=1,live=1,halts='["venue","drawdown"]'),dict(at=2,live=1,halts='["venue"]')]}
  self.assertEqual(experiment_controls(raw,True),[(1,{'force_halt':'drawdown','active':True}),(2,{'force_halt':'drawdown','active':False})])
 def test_opportunity_reference_has_no_capacity_or_template_ceiling(self):
  from core.grid_controls import opportunity_policy
  from core.policies import Policy
  p=opportunity_policy(Policy(),100)
  self.assertEqual(p.bankroll_wei,p.size_wei*100)
  self.assertEqual(p.max_concurrent,100)
  self.assertEqual(p.template_loss_ms,0)

class RecordedStopIsolationTests(unittest.TestCase):
 def test_clearing_recorded_stop_does_not_clear_manual_stop(self):
  from core.account import simulate
  from core.policies import Policy
  p=Policy(size_wei=100,bankroll_wei=1000,market_enabled=False,touch_enabled=False)
  trades=[dict(id=i,token=str(i),entry=i,exit=i+1,pnl=10,size=100) for i in (10,20,30)]
  controls=[(0,{'force_halt':'broken'}),(5,{'halt':'manual'}),(15,{'force_halt':'broken','active':False}),(25,{'halt':'manual','active':False})]
  result=simulate([],trades,p,0,100,controls=controls)
  self.assertEqual([r['reason'] for r in result['decisions']],['recorded_broken','manual',None])

class LosslessModelStorageTests(unittest.TestCase):
 def test_duplicate_results_preserve_exact_integer_cash_and_flags(self):
  from core.grid_model_store import pack_results,unpack_results
  result={'status':'closed','pnlWei':'-123456789012345678901','exitAt':45,'failedExecution':False}
  model={'token':'x','results':{'a':result,'b':dict(result),'c':{'status':'unavailable'}}}
  packed=pack_results(model)
  self.assertEqual(len(packed['result_pool']),2)
  self.assertEqual(unpack_results(json.loads(json.dumps(packed))),model)
  self.assertIs(unpack_results(model),model)

class ProspectiveObservationTests(unittest.TestCase):
 def test_first_open_reading_is_not_a_new_recovery(self):
  import tempfile
  from types import SimpleNamespace
  from unittest.mock import patch
  from core.data import write_json,read_json,digest
  from core.grid_v2_prospective import run
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);write_json(root/'locked-selection.json',{})
   write_json(root/'candidate-lock.json',dict(at=100,selection_sha256=digest(root/'locked-selection.json')))
   capture=dict(start=100,end=200,rows={'shadow_jobs':[],'positions':[],'shadow_decisions':[dict(at=110,reading='{"state":"open"}')]})
   with patch('core.grid_v2_prospective.verify'),patch('core.grid_v2_prospective.subprocess.run',return_value=SimpleNamespace(stdout=json.dumps(capture))):run(root)
   result=read_json(root/'prospective-observations/summary.json')
   self.assertEqual(result['recorded_baseline_recoveries'],0)
   self.assertFalse(result['candidate_performance_assessed'])

class FullRecoveryFreshFamilyTests(unittest.TestCase):
 def test_full_recovery_still_tests_recent_window_for_recent_brake(self):
  from core.grid_v2_guard import family_rules
  rows=[r for r in family_rules('fresh_brake') if r.mode=='full' and r.n==20 and r.fresh_brake==0]
  self.assertEqual({r.m for r in rows},{3,5,8,10,15})
 def test_full_recovery_recent_family_neighbors_preserve_recent_window(self):
  rows=list(neighbors(Rule(mode='full',n=20,m=8,fresh_brake=0)))
  self.assertTrue(any(r.m==9 and r.n==20 for r in rows))
  self.assertTrue(any(r.m==8 and r.n==21 for r in rows))

class DerivedReadingCacheTests(unittest.TestCase):
 def test_scope_binding_rejects_other_observation_population(self):
  from core.account import simulate
  from core.policies import Policy
  observations=[];cache={};p=Policy(market_enabled=False)
  a=simulate(observations,[],p,0,100,derived_cache=cache)
  b=simulate(observations,[],p,0,100,derived_cache=cache)
  self.assertEqual(a,b)
  with self.assertRaisesRegex(ValueError,'immutable observation'):simulate([],[],p,0,100,derived_cache=cache)
