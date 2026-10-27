"""Checks for the longer study's causal timing, coverage and cash boundaries."""
import unittest
from dataclasses import replace

from guard_audit import Observation, Trade, SIZE
from market_guard_audit import Candidate, Experiment
from market_guard_longer import observations, scoring_time, summarize, modeled_trades
from market_guard_longer_fetch import sufficient, targets


class LongerGuardTests(unittest.TestCase):
    def test_template_rejection_universe_is_explicit_and_keeps_static_floors(self):
        fact = dict(token='a', curve='curve', block=1, passed=0, launched_at=1,
                    creator_tax_bps=100, exemptions=3, dev_buy_wei=str(10**16), prior_launches=0,
                    pair_token='0x0000000000000000000000000000000000000000')
        data = {'snapshot_at': 1_000_000, 'bot_launches': [fact]}
        self.assertEqual(targets(data), {})
        self.assertEqual(set(targets(data, True)), {'a'})
        fact['prior_launches'] = 4
        self.assertEqual(targets(data, True), {})
        fact['prior_launches'] = 0
        fact['dev_buy_wei'] = str(10**16-1)
        self.assertEqual(targets(data, True), {})

    def test_rounding_never_publishes_a_reconstruction_early(self):
        for at in (0, 1, 59_999, 60_000, 61_234):
            scored = scoring_time(at, 300_000)
            self.assertGreaterEqual(scored, at+300_000)
            self.assertLess(scored, at+360_000)
            self.assertEqual(scored % 60_000, 0)

    def test_short_or_failed_cache_does_not_count_as_complete(self):
        f = {'block': 1000}
        self.assertTrue(sufficient(('a', 1000, 1950, 0, '[]', None), f))
        self.assertFalse(sufficient(('a', 1000, 1949, 0, '[]', None), f))
        self.assertFalse(sufficient(('a', 1001, 2000, 0, '[]', None), f))
        self.assertFalse(sufficient(('a', 1000, 2000, 0, None, 'timeout'), f))

    def test_recorded_availability_is_preserved_and_missing_is_not_zero(self):
        facts = {'a': {}, 'b': {}, 'c': {}}
        data = {'snapshot_at': 1_000_000, 'gate_obs': [
            {'token': 'a', 'error': None, 'bars': '{"1.75": 0.4}', 'block': 1,
             'launched_at': 1, 'at': 900_000}]}
        paths = {'a': {'block': 1, 'launched': 1000, 'observer_return': 1.},
                 'b': {'block': 2, 'launched': 2000, 'observer_return': -.2}}
        rows, known = observations(data, facts, paths)
        by_token = {r.token: r for r in rows}
        self.assertEqual(known, {'a'})
        self.assertEqual(by_token['a'].scored, 900_000)
        self.assertEqual(by_token['a'].bars['1.75'], .4)
        self.assertNotIn('c', by_token)
        recorded, _ = observations(data, facts, paths, recorded_only=True)
        self.assertEqual([r.token for r in recorded], ['a'])

    def test_smaller_event_history_preserves_complete_policy_evidence(self):
        obs = [Observation(str(i), i, i*1000, i*1000+1000, {'1.75': (-.2 if i < 80 else .3)})
               for i in range(200)]
        trades = [Trade(i, str(i), 100_000+i*1000, 100_500+i*1000, (-1 if i%3 else 2)*10**15)
                  for i in range(100)]
        p = Candidate(ron=1, on_count=3)
        full = Experiment(obs, trades, 0, 300_000).simulate(p)
        small = Experiment(obs, trades, 0, 300_000, max_observations=96).simulate(p)
        for key in ('cash', 'decisions', 'actions'):
            self.assertEqual(full[key], small[key])

    def test_cash_intervals_are_disjoint_and_returns_use_actual_size(self):
        ts = [Trade(1, 'a', 0, 10, 10**15, SIZE//2), Trade(2, 'b', 10, 20, -10**15, SIZE)]
        run = {'start': 0, 'end': 30, 'cash': [(10, 1, 10**15), (20, 2, -10**15)],
               'decisions': [], 'actions': [], 'readings': [], 'open_ids': []}
        left, right = summarize(run, ts, set(), 0, 20), summarize(run, ts, set(), 20, 30)
        self.assertEqual(left['n'], 1)
        self.assertEqual(right['n'], 1)
        self.assertEqual(left['returns_pct']['mean'], 10.)
        self.assertEqual(right['returns_pct']['mean'], -5.)
        self.assertAlmostEqual(left['pnl_eth']+right['pnl_eth'], 0.)

    def test_repricing_stress_is_per_stake_and_does_not_change_entry(self):
        paths = {'a': {'launched': 1000, 'quote_allowed': True,
                       'outcomes': {'0.6': {'ret': .5, 'age': 20.}}}}
        normal = modeled_trades(paths, 0)[0]
        stressed = modeled_trades(paths, 0, shift=.1)[0]
        self.assertEqual(normal.pnl-stressed.pnl, SIZE//10)
        self.assertEqual(normal.entry, stressed.entry)
        self.assertEqual(normal.exit, stressed.exit)


if __name__ == '__main__':
    unittest.main()
