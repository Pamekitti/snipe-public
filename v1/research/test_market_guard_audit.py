"""Causality and state regressions for the offline persistence experiment."""
import unittest
from dataclasses import replace

from market_guard_audit import Candidate, Frame, Market, Streak, Experiment, selection, detailed
from guard_audit import Observation, Trade, SIZE, HOUR, DAY, metrics, Tape, wallet_allocations


def frame(total, token, fresh=True):
    return Frame(total,fresh,(token,),total)


def obs(i, at, value):
    return Observation(str(i),i,at,at,{'1.75':value})


class PersistenceTests(unittest.TestCase):
    def test_mixed_stakes_use_actual_return_denominators(self):
        ts=[Trade(1,'a',0,1000,SIZE//10,size=SIZE//2),
            Trade(2,'b',2000,3000,SIZE//10,size=SIZE)]
        rr=Experiment([],ts,0,60_000).simulate(Candidate(venue=False))
        result=detailed(rr,set(),sizes={t.id:t.size for t in ts})
        self.assertAlmostEqual(result['returns_pct']['mean'],15)
        self.assertAlmostEqual(result['pnl_eth'],.004)

    def test_half_stakes_do_not_use_full_stake_capacity(self):
        ts=[Trade(i,str(i),i,1000+i,0,size=SIZE//2) for i in range(9)]
        rr=Experiment([],ts,0,60_000).simulate(Candidate(venue=False))
        self.assertEqual(metrics(rr)['n'],8)
        self.assertEqual(metrics(rr)['skipped'],{'capacity':1})

    def test_repaired_holding_is_not_a_flat_gas_loss(self):
        p=dict(id=1,live=1,buy_ok=1,closed=1,t_decide=10,t_detect=10,exit_at=30,
               onchain_pnl_wei='10')
        data={'bot_positions':[p],'bot_balance':[
            dict(at=0,open_n=0,wei='100'),dict(at=20,open_n=0,wei='80'),
            dict(at=40,open_n=0,wei='110')]}
        allocations,summary=wallet_allocations(data,1,40)
        self.assertEqual(allocations,{})
        self.assertEqual(summary['false_flat_samples_removed'],1)
        self.assertEqual(summary['unallocated_eth'],0)

    def test_thresholds_are_strict(self):
        p=Candidate();m=Market()
        self.assertFalse(m.update(frame(-1,'a'),0,p,True))
        self.assertTrue(m.update(frame(-1.01,'b'),1,p,True))
        self.assertTrue(m.update(frame(1,'c'),2,p,True))
        self.assertFalse(m.update(frame(1.01,'d'),3,p,True))

    def test_polls_cannot_supply_confirmations(self):
        p=Candidate(on_count=3);m=Market()
        m.update(frame(-2,'a'),0,p,True)
        for t in range(1,10):
            self.assertTrue(m.update(frame(2,'b'),t,p,True))
        self.assertTrue(m.update(frame(2,'c'),10,p,True))
        self.assertFalse(m.update(frame(2,'d'),11,p,True))

    def test_dip_resets_positive_streak(self):
        p=Candidate(on_count=2);m=Market()
        for t,s in enumerate([-2,2,0,2]):
            self.assertTrue(m.update(frame(s,str(t)),t,p,True))
        self.assertFalse(m.update(frame(2,'e'),4,p,True))

    def test_score_events_count_but_only_timer_can_act(self):
        p=Candidate(on_count=2);m=Market()
        m.update(frame(-2,'a'),0,p,True)
        m.update(frame(2,'b'),1,p,False)
        self.assertTrue(m.update(frame(2,'c'),2,p,False))
        self.assertFalse(m.update(frame(2,'c'),3,p,True))

    def test_dwell_and_cooldown_are_separate(self):
        p=Candidate(dwell_ms=100,cooldown_ms=200);m=Market()
        m.update(frame(-2,'a'),0,p,True)
        self.assertTrue(m.update(frame(2,'b'),50,p,True))
        self.assertTrue(m.update(frame(2,'b'),199,p,True))
        self.assertFalse(m.update(frame(2,'b'),200,p,True))

    def test_stale_release_retains_internal_pause(self):
        p=Candidate();m=Market()
        m.update(frame(-2,'a'),0,p,True)
        self.assertFalse(m.update(frame(-2,'a',False),1,p,True))
        self.assertTrue(m.update(frame(0,'b'),2,p,True))

    def test_stale_resets_dwell(self):
        p=Candidate(dwell_ms=100,stale='retain');m=Market()
        m.update(frame(-2,'a'),0,p,True)
        m.update(frame(2,'b'),1,p,True)
        m.update(frame(2,'b',False),100,p,True)
        self.assertTrue(m.update(frame(2,'c'),101,p,True))
        self.assertFalse(m.update(frame(2,'c'),201,p,True))

    def test_short_window_can_refuse_resume(self):
        p=Candidate(short_confirm=True);m=Market()
        m.update(frame(-2,'a'),0,p,True)
        self.assertTrue(m.update(Frame(2,True,('b',),-1),1,p,True))
        self.assertFalse(m.update(Frame(2,True,('c',),.1),2,p,True))

    def test_future_scores_do_not_affect_earlier_entries(self):
        ts=[Trade(1,'a',1000,2000,SIZE)]
        for value in (-10,10):
            r=Experiment([obs(1,30_000,value)],ts,0,60_000).simulate(Candidate(window=1))
            self.assertEqual(metrics(r)['n'],1)

    def test_recovery_streak_needs_new_post_stop_evidence(self):
        ts=[Trade(1,'a',0,1000,-SIZE),Trade(2,'b',31_000,40_000,SIZE)]
        os=[obs(1,2000,1),obs(2,61_000,1)]
        p=Candidate(venue=False,dd=SIZE,rwin=1,recovery_count=2)
        r=Experiment(os,ts,0,120_000).simulate(p)
        self.assertEqual([a['at'] for a in r['actions'] if a['action']=='resume'],[90_000])
        self.assertEqual(metrics(r)['skipped'],{'drawdown':1})

    def test_concurrent_positions_exit_after_stop(self):
        ts=[Trade(1,'a',0,1000,-SIZE),Trade(2,'b',1,2000,-SIZE)]
        r=Experiment([],ts,0,60_000).simulate(Candidate(venue=False,dd=SIZE))
        self.assertEqual(metrics(r)['pnl_eth'],-.04)
        self.assertEqual(r['open_ids'],[])

    def test_capacity_is_enforced(self):
        ts=[Trade(i,str(i),i,1000+i,0) for i in range(5)]
        r=Experiment([],ts,0,60_000).simulate(Candidate(venue=False))
        self.assertEqual(metrics(r)['n'],4)
        self.assertEqual(metrics(r)['skipped'],{'capacity':1})

    def test_evaluation_inherits_stop(self):
        ts=[Trade(1,'a',0,1000,-SIZE),Trade(2,'b',40_000,50_000,SIZE)]
        r=Experiment([],ts,0,60_000).simulate(Candidate(venue=False,dd=SIZE))
        self.assertEqual(metrics(r,start=30_000)['n'],0)

    def test_baseline_matches_existing_cash(self):
        os=[obs(i,i*10_000,(-1 if i%3 else 2)) for i in range(30)]
        ts=[Trade(i,str(i),i*12_000+1,i*12_000+1000,SIZE//10) for i in range(20)]
        p=Candidate(window=3)
        self.assertEqual(Experiment(os,ts,0,360_000).simulate(p)['cash'],
                         Tape(os,ts,0,360_000).simulate(p)['cash'])

    def test_holdout_profit_is_not_a_selection_input(self):
        ps=[Candidate(),Candidate(name='other',on=2)]
        scores={'live':{'pnl_eth':1,'maxdd_eth':.1},'other':{'pnl_eth':.5,'maxdd_eth':.1}}
        self.assertEqual(selection(scores,ps)[0].name,'live')

    def test_midnight_budget(self):
        start=DAY-60_000
        ts=[Trade(1,'a',start,start+1000,-SIZE)]
        r=Experiment([obs(1,start+2000,1)],ts,start,DAY+30_000).simulate(
            Candidate(venue=False,dd=SIZE,rwin=1,lifts=1),initial={'lifts':1})
        self.assertEqual([a['at'] for a in r['actions'] if a['action']=='resume'],[DAY])


if __name__=='__main__':
    unittest.main()
