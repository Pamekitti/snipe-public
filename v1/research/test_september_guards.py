"""Causality and state-transition tests for research guard hypotheses."""
import unittest
from core.indicators import SignalTape
from core.september_guards import CreativeGuard, Rule, candidates


def setup(family, values, scale=1, start=21000):
    rows=[dict(token=str(i),launched=i*1000,available=i*1000+100,block=i,value=v)
          for i,v in enumerate(values)]
    facts={str(i):dict(deployer=str(i%3)) for i in range(len(values))}
    return CreativeGuard(SignalTape(rows),Rule(family,scale),20000,start,facts)


class GuardTests(unittest.TestCase):
    def test_unique_families(self):
        self.assertEqual(len({r.family for r in candidates()}),15)
        self.assertEqual(len({r.name for r in candidates()}),len(candidates()))

    def test_no_future_outcome(self):
        a=setup('fresh',[-0.1]*21+[0.5]*5+[999])
        b=setup('fresh',[-0.1]*21+[0.5]*5+[-999])
        self.assertEqual(a.read(25100),b.read(25100))

    def test_before_publication(self):
        g=setup('fresh',[-0.1]*21+[2])
        self.assertFalse(g.read(21099)['allow'])
        self.assertTrue(g.read(21100)['allow'])

    def test_no_clock_only_recovery(self):
        g=setup('fresh',[-0.1]*21+[2])
        self.assertFalse(g.read(21000)['allow'])
        self.assertFalse(g.read(21099)['allow'])

    def test_permit_exactly_three(self):
        g=setup('permit',[-0.1]*21+[0.5]*5)
        self.assertTrue(g.read(25100)['allow'])
        for j in range(3):
            t=dict(id=j,token='25',size=20000,pnl=100,entry=25100)
            self.assertIsNone(g.entry(25100,t,{})[1]);g.entered(t)
        self.assertEqual(g.entry(25100,t,{})[1],'venue')
        self.assertFalse(g.read(25101)['allow'])

    def test_memory_waits_for_outcome(self):
        g=setup('memory',[-0.1]*21+[2])
        g.read(21100)
        t=dict(id=1,token='21',size=20000,pnl=-200,entry=21100)
        g.entered(t);g._switch(21200,False,'test')
        self.assertEqual(g.failures,0)
        g.closed(t)
        self.assertEqual(g.failures,1)
        g._settle(1)
        self.assertEqual(g.failures,1)

    def test_trail_rebound_and_giveback(self):
        g=setup('trail',[0]*21+[0.6,0.6,-0.8])
        self.assertFalse(g.read(21100)['allow'])
        self.assertTrue(g.read(22100)['allow'])
        self.assertFalse(g.read(23100)['allow'])

    def test_breadth_creators(self):
        g=setup('breadth',[0]*21+[0.5]*5)
        g.facts={k:dict(deployer='same') for k in g.facts}
        self.assertFalse(g.read(25100)['allow'])

    def test_delay_defers_signal(self):
        g=setup('fresh',[-0.1]*21+[2]);g.delay=1000;g.times=[t+1000 for t in g.tape.times]
        g.cursor=21
        self.assertFalse(g.read(21100)['allow'])
        self.assertTrue(g.read(22100)['allow'])

    def test_earned_size_does_not_copy_normal_outcome(self):
        g=setup('earned',[-0.1]*21+[2]);g.read(21100)
        self.assertEqual(g.entry(21100,dict(token='21'),{})[0],5000)

    def test_stale_closes_all_families(self):
        for f in {r.family for r in candidates()}:
            g=setup(f,[0.5]*30)
            self.assertFalse(g.read(4*3600000)['allow'])

if __name__=='__main__':unittest.main()

class PublicationBatchTests(unittest.TestCase):
    def test_simultaneous_returns_do_not_invent_peak(self):
        rows=[dict(token=str(i),launched=i*1000,available=i*1000+100,block=i,value=0) for i in range(21)]
        rows += [dict(token='a',launched=21000,available=23000,block=21,value=3),
                 dict(token='b',launched=22000,available=23000,block=22,value=-3)]
        g=CreativeGuard(SignalTape(rows),Rule('trail'),20000,21000,{})
        g._switch(21000,True,'test')
        self.assertTrue(g.read(23000)['allow'])
        self.assertEqual(g.high,0)
        self.assertEqual(g.total,0)

    def test_all_families_ignore_changed_future(self):
        for f in {r.family for r in candidates()}:
            a=setup(f,[-0.1]*21+[0.5]*5+[999])
            b=setup(f,[-0.1]*21+[0.5]*5+[-999])
            for at in (21000,21100,22100,23100,24100,25100):
                self.assertEqual(a.read(at),b.read(at),f)

class SelectionBoundaryTests(unittest.TestCase):
    def test_training_metrics_ignore_future_cash(self):
        from core.september_guard_report import measure
        from core.september_guard_study import START,FIT_END
        def sample(future):
            return [dict(runs={'x':dict(cash=[dict(id='past',at=START+1000,pnl=100),
                  dict(id='future',at=FIT_END+1000,pnl=future)],recovery=dict(episodes=[]),actions=[])})]
        self.assertEqual(measure(sample(10**20),'x',START,FIT_END),measure(sample(-10**20),'x',START,FIT_END))

    def test_zero_denominator_stays_unavailable(self):
        from core.september_guard_report import ratios
        empty=dict(winners=0,losers=0,profit_wei='0',loss_wei='0')
        self.assertTrue(all(v is None for v in ratios(empty,empty).values()))
