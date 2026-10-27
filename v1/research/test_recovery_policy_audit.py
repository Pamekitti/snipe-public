import unittest
from dataclasses import replace
from guard_audit import Observation, Trade, SIZE, DAY
from market_guard_audit import Experiment
from recovery_policy_audit import RecoveryPolicy, Simulator, policies


class RecoveryTests(unittest.TestCase):
    def test_baseline_matches_previous_state_machine(self):
        obs=[Observation(str(i),i,i*1000,i*1000+500,{'1.75':(-.3 if i%80<40 else .35)}) for i in range(250)]
        ts=[Trade(i,str(i),i*1000+750,i*1000+950,round((-.01 if i%3 else .015)*1e18)) for i in range(25,240)]
        p=RecoveryPolicy()
        old=Experiment(obs,ts,0,300000).simulate(p)
        new=Simulator(obs,ts,0,300000).simulate(p)
        for key in ['cash','decisions','readings']:
            self.assertEqual(old[key],new[key],key)

    def test_repeated_ticks_are_not_new_evidence(self):
        obs=[Observation('a',1,1000,1000,{'1.75':-2}),Observation('b',2,35000,35000,{'1.75':2})]
        t=Trade(1,'t',120000,121000,1)
        p=RecoveryPolicy(window=1,on_count=2)
        r=Simulator(obs,[t],0,180000).simulate(p)
        self.assertEqual(r['decisions'][0][2],'venue')

    def test_existing_venue_halt_can_recover(self):
        obs=[Observation(str(i),i,0,0,{'1.75':.2}) for i in range(20)]
        r=Simulator(obs,[Trade(1,'t',1000,2000,1)],0,60000,
                    initial={'venue_halted':True}).simulate(RecoveryPolicy())
        self.assertEqual(r['cash'],[(2000,1,1)])
        self.assertEqual(r['actions'][0]['action'],'venue_resume')

    def test_rolling_budget_survives_midnight_and_dd_reset(self):
        ts=[Trade(1,'a',DAY-50000,DAY-49000,-int(.061e18)),Trade(2,'b',DAY+70000,DAY+71000,1)]
        obs=[Observation(str(i),i,DAY+i*1000,DAY+i*1000,{'1.75':1}) for i in range(25)]
        p=RecoveryPolicy(rolling_dd=int(.06e18))
        r=Simulator(obs,ts,DAY-60000,DAY+100000).simulate(p)
        self.assertEqual(len(r['cash']),1)
        self.assertFalse(any(a['action']=='resume' for a in r['actions']))

    def test_size_variant_changes_cash_and_close_time(self):
        obs=[Observation('a',1,0,0,{'1.75':-2}),Observation('b',2,35000,35000,{'1.75':2})]
        ts=[Trade(1,'t',70000,100000,999),Trade(2,'u',85000,86000,1)]
        small=Trade(1,'t',70000,80000,-7,SIZE//4)
        p=RecoveryPolicy(window=1,probation=True,small_probe=True)
        r=Simulator(obs,ts,0,110000,variants={(1,SIZE//4):small,(2,SIZE//4):replace(ts[1],size=SIZE//4)}).simulate(p)
        self.assertEqual(r['cash'][0],(80000,1,-7))
        self.assertEqual(r['sizes'][1],SIZE//4)
        self.assertIsNone(r['decisions'][1][2])

    def test_restart_allowance_blocks_after_loss_but_keeps_existing_exit(self):
        obs=[Observation('a',1,0,0,{'1.75':-2}),Observation('b',2,35000,35000,{'1.75':2})]
        ts=[Trade(1,'t',70000,71000,-int(.012e18)),Trade(2,'u',72000,73000,1)]
        p=RecoveryPolicy(window=1,probation=True)
        r=Simulator(obs,ts,0,100000).simulate(p)
        self.assertEqual(len(r['cash']),1)
        self.assertEqual(r['decisions'][1][2],'probation')

    def test_broken_guard_cannot_see_unscored_outcomes(self):
        ts=[Trade(i,str(i),1000+i*1000,1500+i*1000,-int(.001e18)) for i in range(20)]
        obs=[Observation(str(i),i,1000,100000,{'1.75':1}) for i in range(20)]
        p=RecoveryPolicy()
        r=Simulator(obs,ts,0,60000,broken=True).simulate(p)
        self.assertFalse(any(a['action']=='broken_stop' for a in r['actions']))

    def test_broken_stop_is_sticky_when_new_evidence_is_positive(self):
        ts=[Trade(i,str(i),1000+i*1000,1500+i*1000,-int(.001e18)) for i in range(20)]
        ts.append(Trade(21,'next',70000,71000,1))
        obs=[Observation(str(i),i,0,0,{'1.75':1}) for i in range(20)]
        r=Simulator(obs,ts,0,100000,broken=True).simulate(RecoveryPolicy())
        self.assertEqual(r['decisions'][-1][2],'broken')


if __name__=='__main__':unittest.main()
