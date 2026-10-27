"""Acceptance checks must detect plausible-looking but inaccurate cash simulations."""

import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research.core import fidelity as f


def cash(at, identity, pnl):
    return dict(at=at, id=identity, pnl=pnl)


def perfect():
    limits = f.read_json(f.LIMITS)
    executions = {}
    for period, count in (("fit", 100), ("reserved6h", 20), ("era_1", 120)):
        rows = [
            dict(size=100, actual_wei="1", predicted_wei="1", status="closed")
            for _ in range(count)
        ]
        executions[period] = dict(paired=f.paired_metrics(rows))
    contrast = f.cash_contrast(
        [cash(1, "a", 10), cash(2, "b", -5)], [cash(1, "a", 10), cash(2, "b", -5)], 100
    )
    accounts = {
        name: dict(
            complete=True,
            entry_precision=1,
            entry_recall=1,
            cash=copy.deepcopy(contrast),
        )
        for name in ("current", "fit", "reserved6h")
    }
    evidence = {
        key: True
        for key in (
            "receipt_accounting_complete",
            "arithmetic_exact",
            "historical_source_matches",
            "calibration_is_causal",
            "input_hashes_valid",
            "account_engine_reproduces_saved_run",
        )
    }
    evidence.update(
        wallet_residual_wei="0",
        exit_reason_agreement=1,
        exit_time_error_ms=f.describe([0] * 120),
        exit_time_expected=120,
        failures_matched=4,
        actual_failures=4,
    )
    return executions, accounts, evidence, limits


class FidelityTests(unittest.TestCase):
    def test_same_net_can_hide_wrong_wins_and_losses(self):
        z = f.cash_contrast(
            [cash(1, "a", 100), cash(2, "b", -90)],
            [cash(1, "a", 20), cash(2, "b", -10)],
            100,
        )
        self.assertEqual(z["net_error_wei"], "0")
        self.assertEqual(z["gross_profit_relative_error"], 0.8)
        self.assertEqual(z["maximum_equity_gap_wei"], "80")
        args = perfect()
        args[1]["fit"]["cash"] = z
        self.assertFalse(f.grade(*args)["historical_fidelity_passed"])

    def test_drawdown_persists_across_account_resets(self):
        rows = [cash(3, "c", -20), cash(1, "a", -30), cash(2, "b", 10)]
        rows[0]["epoch"] = 2
        self.assertEqual(f.cash_metrics(rows)["drawdown_wei"], "40")

    def test_unknown_is_distinct_from_definite_no_entry(self):
        z = f.paired_metrics(
            [
                dict(
                    size=100,
                    actual_wei="-10",
                    predicted_wei=None,
                    status="pool_required",
                ),
                dict(
                    size=100,
                    actual_wei="-10",
                    predicted_wei="0",
                    status="entry_price_rejected",
                ),
            ]
        )
        self.assertEqual((z["expected"], z["known"], z["missing"]), (2, 1, 1))
        self.assertEqual(z["signed_error_pp"]["mean"], 10)

    def test_offsetting_errors_fail_despite_zero_bias(self):
        args = perfect()
        args[0]["fit"]["paired"] = f.paired_metrics(
            [
                dict(size=100, actual_wei="10", predicted_wei="-10", status="closed"),
                dict(size=100, actual_wei="-10", predicted_wei="10", status="closed"),
            ]
            * 50
        )
        verdict = f.grade(*args)
        self.assertFalse(verdict["historical_fidelity_passed"])
        self.assertTrue(
            any(
                c["name"] == "fit.absolute_error_mean" and not c["passed"]
                for c in verdict["checks"]
            )
        )

    def test_perfect_historical_fit_never_authorizes_live_trading(self):
        verdict = f.grade(*perfect())
        self.assertTrue(verdict["historical_fidelity_passed"])
        self.assertFalse(verdict["live_change_authorized"])
        self.assertFalse(verdict["prospective_validation"])

    def test_insufficient_reserved_sample_fails(self):
        args = perfect()
        args[0]["reserved6h"]["paired"]["expected"] = 9
        self.assertFalse(f.grade(*args)["historical_fidelity_passed"])

    def test_missing_timing_cannot_pass_on_known_subset(self):
        args = perfect()
        args[2]["exit_time_error_ms"] = f.describe([0])
        self.assertFalse(f.grade(*args)["historical_fidelity_passed"])

    def test_unexplained_wallet_cash_and_stale_sources_fail(self):
        for field, value in (
            ("wallet_residual_wei", "1"),
            ("input_hashes_valid", False),
            ("calibration_is_causal", False),
        ):
            with self.subTest(field=field):
                args = perfect()
                args[2][field] = value
                self.assertFalse(f.grade(*args)["historical_fidelity_passed"])

    def test_failure_cash_is_predicted_not_copied(self):
        class Worker:
            def call(self, **kwargs):
                return dict(status="buy_reverted", pnlWei="-3", exitAt=12)

        p = dict(
            id=1,
            token="a",
            t_decide=10,
            spend_wei="100",
            closed=1,
            exit_at=13,
            exit_reason="buy-reverted",
            onchain_pnl_wei="-99",
        )
        z = dict(
            entry=10,
            size=100,
            gas_wei="5",
            buy_gas_wei="3",
            delay_ms=1,
            send_delay_ms=1,
            open_delay_ms=2,
        )
        with patch.object(f, "path_request", return_value=({}, None)):
            r = f.prediction_rows({}, [p], {"tokens": {"a": z}}, Worker())[0]
        self.assertEqual(r["actual_wei"], "-99")
        self.assertEqual(r["predicted_wei"], "-3")
        self.assertTrue(r["simulated_failure"])

    def test_missing_clock_inputs_remain_unavailable(self):
        p = dict(id=1, token="a", t_decide=10, spend_wei="100", closed=0)
        z = dict(entry=10, size=100, gas_wei="5")
        r = f.prediction_rows({}, [p], {"tokens": {"a": z}}, None)[0]
        self.assertIsNone(r["predicted_wei"])

    def test_account_unknown_truncates_both_paths_and_entry_sets(self):
        positions = [
            dict(
                token=t, t_decide=at, closed=1, exit_at=at + 1, onchain_pnl_wei=str(pnl)
            )
            for t, at, pnl in (("a", 10, 10), ("b", 20, -50), ("c", 40, 100))
        ]
        account = dict(
            cash=[cash(11, "a", 10), cash(41, "c", 900)],
            decisions=[
                dict(id="a", at=10, reason=None),
                dict(id="x", at=20, reason=None),
            ],
            unresolved=[dict(at=30)],
            complete=False,
        )
        z = f.account_windows(positions, account, 0, 100, 100)["current"]
        self.assertFalse(z["complete"])
        self.assertEqual(z["cash"]["actual"]["net_wei"], "-40")
        self.assertEqual(z["cash"]["predicted"]["net_wei"], "10")
        self.assertEqual(z["entry_precision"], 0.5)
        self.assertEqual(z["entry_recall"], 0.5)

    def test_missing_certificate_is_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(f.validation_status(directory)["passed"])

    def test_modified_inputs_invalidate_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.json"
            source.write_text("{}")
            artifact = root / "fidelity.json"
            f.write_json(
                artifact,
                dict(
                    model_version="execution-account-v3",
                    source_hashes={"input.json": f.digest(source)},
                    runtime_hashes={},
                    limits_sha256=f.digest(f.LIMITS),
                    verdict=dict(
                        status="historical_fidelity_pass",
                        historical_fidelity_passed=True,
                    ),
                ),
            )
            f.write_json(
                root / "fidelity-current.json",
                dict(
                    artifact=str(artifact),
                    sha256=f.digest(artifact),
                    report="report.md",
                ),
            )
            self.assertTrue(f.validation_status(root)["passed"])
            source.write_text('{"changed": true}')
            self.assertFalse(f.validation_status(root)["passed"])


if __name__ == "__main__":
    unittest.main()
