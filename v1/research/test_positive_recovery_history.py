import unittest

from core.positive_recovery_history import Signal, bounded_recovery_score, clusters


def row(token, launched, value, deployer="", label="", template=""):
    return Signal(token, 1, launched, launched + 52_000, value, deployer, label, template)


class PositiveRecoveryHistoryTests(unittest.TestCase):
    def test_linked_positive_burst_gets_one_positive_stake(self):
        rows = [row(str(i), i * 1_000, value, deployer="same") for i, value in enumerate([1.98, 3.34, 2.67, -0.04, 1.82])]
        self.assertEqual(len(clusters(rows)), 1)
        self.assertAlmostEqual(bounded_recovery_score(rows), 0.96)

    def test_linked_losses_are_not_damped(self):
        rows = [row("a", 0, -0.7, deployer="same"), row("b", 1_000, -0.6, deployer="same")]
        self.assertAlmostEqual(bounded_recovery_score(rows), -1.3)

    def test_name_links_different_deployers_inside_one_minute(self):
        rows = [row("a", 0, 2, deployer="one", label="vlad|vlad"), row("b", 6_000, 2, deployer="two", label="vlad|vlad")]
        self.assertEqual(len(clusters(rows)), 1)

    def test_same_actor_outside_one_minute_is_independent(self):
        rows = [row("a", 0, 2, deployer="same"), row("b", 61_000, 2, deployer="same")]
        self.assertEqual(len(clusters(rows)), 2)


if __name__ == "__main__":
    unittest.main()
