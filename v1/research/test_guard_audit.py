"""Guard audit regressions for causality and cash-flow accounting."""
import unittest
from dataclasses import replace
from guard_audit import (Observation, Trade, Policy, Tape, SIZE, HOUR, DAY,
                         metrics, venue_step, resume_evidence, select, wallet_allocations)


def obs(i, scored, value, launched=None, bars=None):
    return Observation(str(i),i,scored if launched is None else launched,scored,
                       {'1.75':value} if bars is None else bars)


class AuditTests(unittest.TestCase):
    def test_wallet_allocation_reconciles_integer_remainder(self):
        data={'bot_balance':[{'at':0,'open_n':0,'wei':'1000'},
                             {'at':100,'open_n':0,'wei':'1181'}],
              'bot_positions':[{'id':i,'live':1,'closed':1,'exit_at':50+i,
                                'onchain_pnl_wei':'100'} for i in (1,2)]}
        a,s=wallet_allocations(data,1,100)
        self.assertEqual(sum(a.values()),-19)
        self.assertEqual(set(a.values()),{-9,-10})
        self.assertEqual(s['unallocated_eth'],0)

    def test_wallet_costs_reduce_profit_without_rewriting_live_stop(self):
        t=Trade(1,'a',0,1000,-SIZE+1,wallet_adjustment=-100)
        r=Tape([], [t],0,60_000).simulate(Policy(dd=SIZE,venue=False))
        self.assertFalse(r['final_halted'])
        self.assertEqual(r['cash'][0][2],-SIZE-99)

    def test_initial_loss_counts_in_drawdown(self):
        t=Trade(1,'a',0,1000,-SIZE)
        r=Tape([], [t],0,60_000).simulate(Policy(drawdown=False,venue=False))
        self.assertEqual(metrics(r)['maxdd_eth'],.02)

    def test_open_positions_keep_exiting_after_stop(self):
        ts=[Trade(1,'a',0,1000,-2*SIZE),Trade(2,'b',1,2000,-2*SIZE),
            Trade(3,'c',1500,3000,SIZE)]
        r=Tape([],ts,0,60_000).simulate(Policy(dd=SIZE,venue=False))
        self.assertEqual(metrics(r)['pnl_eth'],-.08)
        self.assertEqual(metrics(r)['skipped'],{'drawdown':1})

    def test_future_score_cannot_resume(self):
        ts=[Trade(1,'a',0,1000,-SIZE),Trade(2,'b',31_000,40_000,SIZE)]
        r=Tape([obs(1,60_000,1)],ts,0,90_000).simulate(Policy(dd=SIZE,venue=False,rwin=1))
        self.assertEqual(r['actions'][1]['at'],60_000)
        self.assertEqual(metrics(r)['skipped'],{'drawdown':1})

    def test_post_stop_scoring_is_not_post_stop_launch(self):
        rows=[obs(1,2000,1,launched=0)]
        self.assertEqual(resume_evidence(rows,1000,1),(1,1))
        self.assertEqual(resume_evidence(rows,2000,1),(0,0))

    def test_sql_limit_precedes_post_stop_filter(self):
        rows=[obs(i,0,1) for i in range(4)]+[obs(5,20,1)]
        self.assertEqual(resume_evidence(rows,10,1),(0,0))

    def test_missing_bar_is_not_a_zero_return(self):
        rows=[obs(2,0,0,bars={'2.00':1}),obs(1,0,2)]
        self.assertEqual(resume_evidence(rows,-1,2),(2,1))

    def test_stale_window_releases_but_keeps_internal_band(self):
        p=Policy(window=1,off=-1,on=1,fresh_h=1)
        rows=[obs(1,0,-2)]
        first=venue_step(rows,1000,p)
        self.assertTrue(first[2])
        stale=venue_step(rows,HOUR+1,p,*first[:2])
        self.assertFalse(stale[2])
        self.assertEqual(stale[0],'shut')
        fresh=venue_step([obs(2,HOUR+2,0)],HOUR+3,p,*stale[:2])
        self.assertTrue(fresh[2])

    def test_staleness_changes_without_new_rows(self):
        p=Policy(window=1,off=-1,on=1,fresh_h=1,drawdown=False)
        ts=[Trade(1,'a',1000,2000,SIZE),Trade(2,'b',HOUR+31_000,HOUR+32_000,SIZE)]
        r=Tape([obs(1,0,-2)],ts,0,2*HOUR).simulate(p)
        self.assertEqual(metrics(r)['n'],1)

    def test_resume_waits_for_flat(self):
        ts=[Trade(1,'a',0,1000,-SIZE),Trade(2,'b',1,70_000,0)]
        r=Tape([obs(1,2000,1)],ts,0,120_000).simulate(Policy(dd=SIZE,venue=False,rwin=1))
        self.assertEqual(r['actions'][1]['at'],90_000)

    def test_midnight_resets_lift_budget(self):
        start=DAY-60_000
        ts=[Trade(1,'a',start,start+1000,-SIZE)]
        r=Tape([obs(1,start+2000,1)],ts,start,DAY+30_000).simulate(
            Policy(dd=SIZE,venue=False,rwin=1,lifts=1),initial={'lifts':1})
        self.assertEqual(r['actions'][1]['at'],DAY)

    def test_no_lift_budget_means_no_auto_resume(self):
        ts=[Trade(1,'a',0,1000,-SIZE)]
        r=Tape([obs(1,2000,1)],ts,0,120_000).simulate(Policy(dd=SIZE,venue=False,rwin=1,lifts=0))
        self.assertEqual([x['action'] for x in r['actions']],['stop'])

    def test_evaluation_retains_training_drawdown_state(self):
        ts=[Trade(1,'a',0,1000,-SIZE),Trade(2,'b',40_000,50_000,SIZE)]
        r=Tape([],ts,0,60_000).simulate(Policy(dd=SIZE,venue=False))
        self.assertEqual(metrics(r,start=30_000)['n'],0)

    def test_selection_cannot_see_test_outcome(self):
        live=Policy(venue=False)
        tight=replace(live,name='tight',dd=SIZE)
        common=[Trade(1,'a',0,1000,-SIZE)]
        chosen=[]
        for pnl in (-10*SIZE,10*SIZE):
            tape=Tape([],common+[Trade(2,'b',40_000,50_000,pnl)],0,60_000)
            chosen.append(select(tape,[live,tight],live,30_000)[0].name)
        self.assertEqual(chosen,['live','live'])

    def test_initial_halt_supports_recorded_episode(self):
        r=Tape([obs(1,2000,1)],[],1000,60_000).simulate(
            Policy(venue=False,rwin=1),initial={'halted':True,'halt_at':1000})
        self.assertEqual(r['actions'][0]['action'],'resume')


if __name__=='__main__':
    unittest.main()
