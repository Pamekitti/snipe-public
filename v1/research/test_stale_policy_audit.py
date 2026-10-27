import unittest
from dataclasses import replace

from guard_audit import HOUR, Observation, Trade
from recovery_policy_audit import RecoveryPolicy, Simulator


class StalePolicyTests(unittest.TestCase):
    def policy(self, mode):
        return RecoveryPolicy(on=2, stale='shut' if mode == 'fresh_only' else
                              'open' if mode == 'open' else 'hold',
                              strict_venue_resume=mode != 'open',
                              ignore_venue_age=mode == 'any_age')

    def outcomes(self, total, age, n=20, scored=None, first_id=0):
        return [Observation(str(i), i, -age, -age if scored is None else scored,
                            {'1.75': total/n}) for i in range(first_id, first_id+n)]

    def simulate(self, mode, observations, *, halted=True, end=60000, trades=None):
        trades = trades or [Trade(1, 'trade', 1000, 2000, 1)]
        return Simulator(observations, trades, 0, end,
                         initial={'venue_halted': halted}).simulate(self.policy(mode))

    def test_existing_exception_can_release_old_negative_evidence(self):
        obs = self.outcomes(-2, 4*HOUR)
        self.assertEqual(len(self.simulate('open', obs)['cash']), 1)
        for mode in ['hold', 'any_age', 'fresh_only']:
            self.assertEqual(self.simulate(mode, obs)['cash'], [], mode)

    def test_only_any_age_and_existing_exception_release_old_positive_window(self):
        obs = self.outcomes(3, 4*HOUR)
        for mode in ['hold', 'fresh_only']:
            self.assertEqual(self.simulate(mode, obs)['cash'], [], mode)
        for mode in ['open', 'any_age']:
            self.assertEqual(len(self.simulate(mode, obs)['cash']), 1, mode)

    def test_hold_does_not_stop_already_open_trading_when_age_expires(self):
        obs = self.outcomes(-2, 4*HOUR)
        self.assertEqual(len(self.simulate('hold', obs, halted=False)['cash']), 1)
        for mode in ['any_age', 'fresh_only']:
            self.assertEqual(self.simulate(mode, obs, halted=False)['cash'], [], mode)

    def test_incomplete_positive_window_cannot_release_pause(self):
        obs = self.outcomes(3, HOUR, n=19)
        for mode in ['hold', 'any_age', 'fresh_only']:
            self.assertEqual(self.simulate(mode, obs)['cash'], [], mode)

    def test_equality_at_resume_threshold_keeps_pause(self):
        # Binary-exact returns avoid floating summation noise at the boundary.
        obs = self.outcomes(0, HOUR)
        obs = [replace(o, bars={'1.75': 2 if i == 0 else 0}) for i, o in enumerate(obs)]
        for mode in ['hold', 'any_age', 'fresh_only']:
            self.assertEqual(self.simulate(mode, obs)['cash'], [], mode)

    def test_fresh_return_inside_band_does_not_bypass_stale_pause(self):
        obs = self.outcomes(3, 4*HOUR)
        obs += [Observation(str(i), i, 35000, 35000, {'1.75': .05}) for i in range(20, 40)]
        trades = [Trade(1, 'trade', 70000, 71000, 1)]
        result = self.simulate('fresh_only', obs, halted=False, end=90000, trades=trades)
        self.assertEqual(result['cash'], [])
        self.assertEqual(result['actions'][0]['action'], 'venue_stop')

    def test_fresh_recovery_can_release_after_stale_pause(self):
        obs = self.outcomes(-2, 4*HOUR)
        obs += [Observation(str(i), i, 35000, 35000, {'1.75': .2}) for i in range(20, 40)]
        for mode in ['hold', 'any_age', 'fresh_only']:
            result = self.simulate(mode, obs, end=90000,
                                   trades=[Trade(1, 'trade', 70000, 71000, 1)])
            self.assertEqual(result['cash'], [(71000, 1, 1)], mode)

    def test_any_age_does_not_read_future_scored_outcomes(self):
        obs = self.outcomes(-2, HOUR)
        obs += [Observation(str(i), i, 0, 100000, {'1.75': .2}) for i in range(20, 40)]
        result = self.simulate('any_age', obs)
        self.assertEqual(result['cash'], [])


if __name__ == '__main__':
    unittest.main()
