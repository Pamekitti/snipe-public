"""Timing and missing-data checks for the activity study."""
import unittest
from unittest.mock import patch

import activity_policy_audit as m
from guard_audit import Observation


class ActivityTests(unittest.TestCase):
    def fixture(self, future=0):
        now = 20*m.HOUR
        obs = [Observation(str(i), i, now-100_000-i*1000,
                           now-60_000-i*1000, {'1.75': .2}) for i in range(20)]
        obs.append(Observation('future', 100, now-10_000, now+future, {'1.75': 100}))
        data = {'bot_launches': [dict(detected_at=m.HOUR, creator_tax_bps=100, exemptions=3),
                                dict(detected_at=now, creator_tax_bps=100, exemptions=3)]}
        return now, data, obs

    def test_equal_timestamp_and_future_score_excluded(self):
        for future in (0, 1, 100_000):
            at, data, obs = self.fixture(future)
            f = m.Features(data, obs, {}).at(at)
            self.assertAlmostEqual(f['stakes'], 4)
            self.assertLess(f['max_used_score'], at)
            self.assertEqual(f['launch_n'], 0)

    def test_missing_volume_falls_back(self):
        at, data, obs = self.fixture()
        f = m.Features(data, obs, {}).at(at)
        for rule in ('turnover_per_coin', 'buyers_per_coin', 'net_buying'):
            self.assertEqual(m.accepts(rule, f), (True, True))

    def test_first45s_and_creator_exclusion(self):
        def event(side, who, block, quote):
            return dict(s=side, u=who, r=who, b=block,
                        q=hex((quote if side == 'B' else 1000000)*10**18),
                        t=hex((quote if side == 'S' else 1000000)*10**18))
        seq = [event('B', 'creator', 100, 999), event('B', 'buyer', 110, 3),
               event('B', 'buyer', 120, 2), event('S', 'buyer', 130, 1),
               event('B', 'other', 551, 999), dict(s='BB')]
        with patch.object(m.longer.chainio, 'decode_seq', return_value=seq):
            a = m.external_activity([], dict(deployer='creator', block=100))
        self.assertEqual(a, dict(buy=5, sell=1, gross=6, buyers=1))

    def test_raw_event_quote_words_and_own_wallet_exclusion(self):
        chain = m.longer.chainio
        actor = '0x'+'11'*20
        def log(topic, first, second, wallet=actor):
            words = [first, second, 0, 0]
            return dict(topics=[topic, '0x'+wallet[2:].rjust(64, '0'),
                                '0x'+actor[2:].rjust(64, '0')],
                        data='0x'+''.join(f'{v:064x}' for v in words),
                        blockNumber='0x6e', logIndex='0x1', transactionHash='0x123')
        logs = [log(chain.TOPIC_BUY, 3*10**18, 1000000*10**18),
                log(chain.TOPIC_SELL, 1000000*10**18, 2*10**18),
                log(chain.TOPIC_BUY, 999*10**18, 1000000*10**18, chain.WALLET)]
        a = m.external_activity(logs, dict(block=100, deployer='0x'+'22'*20))
        self.assertEqual(a, dict(buy=3, sell=2, gross=5, buyers=1))

    def test_normalizes_turnover_per_coin(self):
        now = 20*m.HOUR
        data = {'bot_launches': [dict(detected_at=m.HOUR, creator_tax_bps=100, exemptions=3)]}
        obs, activity = [], {}
        for i in range(25):
            at = now-10_000 if i < 5 else now-2*m.HOUR
            o = Observation(str(i), i, at-50_000, at, {'1.75': .1})
            obs.append(o)
            activity[o.token] = dict(buy=3, sell=1, gross=4, buyers=2)
        f = m.Features(data, obs, activity).at(now)
        self.assertEqual(f['turnover'], 1)
        self.assertEqual(f['buyers'], 1)
        self.assertEqual(f['net_buy'], 10)
        self.assertEqual(m.accepts('turnover_per_coin', f), (True, False))
        del activity['0']
        self.assertIsNone(m.Features(data, obs, activity).at(now)['turnover'])

    def test_full_45_seconds_must_have_elapsed(self):
        at, data, obs = self.fixture()
        obs = [Observation('early', 100, at-20_000, at-10_000, {'1.75': .1})]
        a = {'early': dict(buy=1, sell=0, gross=1, buyers=1)}
        self.assertEqual(m.Features(data, obs, a).at(at)['activity_n'], 0)

    def test_strict_zero_and_missing_rules(self):
        for rule, key in [('broad_gains', 'trimmed'), ('recent_direction', 'short'),
                          ('net_buying', 'net_buy')]:
            self.assertEqual(m.accepts(rule, {key: 0}), (False, False))
            self.assertEqual(m.accepts(rule, {key: None}), (True, True))
        self.assertEqual(m.accepts('demand_and_pace', {'pace': .5, 'buyers': None}),
                         (False, True))


if __name__ == '__main__':
    unittest.main()
