import unittest
import exit_policy_audit as a

def path(points):
    return {'X':.01,'tok':1_000_000,'comp':0,'slot_out':0,'ctax':100,
            'pts':[(age*10,m,2.,t,grad,ev) for age,m,t,grad,ev in points]}

def pt(age,m=1.,t=800_000_000,grad=False,ev=None):return (age,m,t,grad,ev)

class ExitTests(unittest.TestCase):
    def test_dead_uses_peak(self):
        p=path([pt(0),pt(5,1.04),pt(20,.8),pt(21,.8),pt(45,.8),pt(46,.8)])
        self.assertEqual(a.replay(p,3,{},lag=.6)['reason'],'time')
    def test_dead_never_moved(self):
        p=path([pt(0),pt(20,.99),pt(21,.99),pt(45,.6)])
        r=a.replay(p,3,{},lag=.6);self.assertEqual(r['reason'],'dead');self.assertEqual(r['age'],21)
    def test_clock_pays_lag(self):
        p=path([pt(0),pt(15,1.1),pt(16,.7),pt(20,.5)])
        r=a.replay(p,3,{'hold':15},lag=.6);self.assertEqual(r['age'],16)
    def test_tp_precedes_time(self):
        p=path([pt(0),pt(45,2.),pt(46,2.)])
        self.assertEqual(a.replay(p,2,{},lag=.6)['reason'],'tp')
    def test_graduated_execution_is_loss(self):
        p=path([pt(0),pt(5,2.,grad=True),pt(6,3.,t=a.engine.RES,grad=True)])
        r=a.replay(p,3,{},gas=.0001);self.assertAlmostEqual(r['ret'],-1.01)
    def test_trailing_waits_for_arm(self):
        p=path([pt(0),pt(5,1.05),pt(10,.8),pt(45,.8),pt(46,.8)])
        self.assertEqual(a.replay(p,3,{'arm':1.1,'trail':.15})['reason'],'time')
    def test_creator_exit_after_event(self):
        p=path([pt(0),pt(5,1.2,ev={'s':'S','tok':500_000,'creator':True,'early':False}),pt(6,.6)])
        r=a.replay(p,3,{'seller':'creator'});self.assertEqual(r['age'],6);self.assertEqual(r['reason'],'creator_sell')
    def test_unknown_target_fallback_and_tie(self):
        self.assertEqual(a.argmax([]),1.75)
        self.assertEqual(a.argmax([{f'{b:.2f}':1 for b in a.BARS}]*20),1.25)
    def test_adaptive_clock_excludes_unresolved_launch(self):
        rows=[{'at':i,'resolved':20,'outcomes':{f'adapt_clock_source_{h}':{'ret':int(h==30)} for h in (20,30,45,60)}} for i in range(20)]
        rows.append({'at':100,'resolved':100_001,'outcomes':{f'adapt_clock_source_{h}':{'ret':1000*int(h==60)} for h in (20,30,45,60)}})
        self.assertEqual(a.choose_clock(rows,100_000),30)
        self.assertEqual(a.choose_clock(rows[:19],100_000),45)
    def test_flow_decision_cannot_see_future_buy(self):
        p=path([pt(0),pt(5,1.05,ev={'s':'B','eth':.1}),pt(13,1.,ev={'s':'S','tok':1_000_000}),pt(15,.99),pt(16,1.2,ev={'s':'B','eth':10})])
        r=a.replay(p,3,{'flow_age':15});self.assertEqual(r['reason'],'flow');self.assertEqual(r['trigger'],15)
    def test_signal_excludes_future_score_and_uses_block_order(self):
        d=a.Data.__new__(a.Data)
        d.obs=[{'at':50,'block':i,'eligible':True,'bars':{'3.00':1}} for i in range(20)]
        d.obs.append({'at':101,'block':100,'eligible':True,'bars':{'1.25':1000}})
        self.assertEqual(d.signal(100)[0],3.)
        self.assertEqual(d.signal(100,delay=60)[0],1.75)

if __name__=='__main__':unittest.main()
