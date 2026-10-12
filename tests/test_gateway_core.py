"""Unit tests for the gateway's rules. No model, sandbox or network needed.

Run with:  py -m unittest discover -s tests
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gateway"))

import core  # noqa: E402

SMALL = core.REGISTRY["small"]


class PricingTests(unittest.TestCase):
    def test_rate_combines_cpu_and_memory(self):
        expected = 4 * core.CPU_CORE_SECOND_USD + 4 * core.MEMORY_GIB_SECOND_USD
        self.assertAlmostEqual(SMALL.usd_per_second, expected)

    def test_cost_scales_with_seconds(self):
        self.assertAlmostEqual(core.cost_usd(SMALL, 10), 10 * SMALL.usd_per_second)

    def test_negative_seconds_cost_nothing(self):
        self.assertEqual(core.cost_usd(SMALL, -5), 0.0)

    def test_an_hour_costs_about_22_cents(self):
        self.assertAlmostEqual(core.cost_usd(SMALL, 3600), 0.2206, places=3)


class BudgetTests(unittest.TestCase):
    def test_under_limit_is_not_exhausted(self):
        status = core.budget_status(0.10, limit_usd=0.50)
        self.assertFalse(status["exhausted"])
        self.assertAlmostEqual(status["remaining_usd"], 0.40)

    def test_reaching_limit_is_exhausted(self):
        self.assertTrue(core.budget_status(0.50, limit_usd=0.50)["exhausted"])

    def test_over_limit_has_zero_remaining(self):
        status = core.budget_status(0.75, limit_usd=0.50)
        self.assertTrue(status["exhausted"])
        self.assertEqual(status["remaining_usd"], 0.0)

    def test_month_key_is_year_and_month(self):
        self.assertEqual(core.month_key(datetime(2026, 10, 12, tzinfo=timezone.utc)), "2026-10")


class LedgerTests(unittest.TestCase):
    RECORDS = [
        {"role": "worker", "cost_usd": 0.001, "billed_seconds": 16.0, "prompt_tokens": 100, "output_tokens": 50},
        {"role": "worker", "cost_usd": 0.002, "billed_seconds": 32.0, "prompt_tokens": 200, "output_tokens": 80},
        {"role": "triage", "cost_usd": 0.0005, "billed_seconds": 8.0, "prompt_tokens": 40, "output_tokens": 5},
    ]

    def test_total_spent(self):
        self.assertAlmostEqual(core.total_spent(self.RECORDS), 0.0035)

    def test_empty_ledger(self):
        self.assertEqual(core.total_spent([]), 0)
        self.assertEqual(core.summarise([])["calls"], 0)

    def test_summary_groups_by_role(self):
        summary = core.summarise(self.RECORDS)
        self.assertEqual(summary["calls"], 3)
        self.assertEqual(summary["by_role"]["worker"]["calls"], 2)
        self.assertAlmostEqual(summary["by_role"]["worker"]["cost_usd"], 0.003)
        self.assertEqual(summary["by_role"]["worker"]["output_tokens"], 130)
        self.assertEqual(summary["by_role"]["triage"]["prompt_tokens"], 40)

    def test_idle_is_the_gap_when_next_call_comes_within_the_window(self):
        self.assertEqual(core.idle_seconds(previous_end=100.0, started=125.0, window=60), 25.0)

    def test_idle_is_capped_at_the_window_after_the_machine_shut_down(self):
        self.assertEqual(core.idle_seconds(previous_end=100.0, started=5000.0, window=60), 60)

    def test_no_idle_for_the_first_call_or_a_clock_that_went_backwards(self):
        self.assertEqual(core.idle_seconds(previous_end=None, started=125.0, window=60), 0.0)
        self.assertEqual(core.idle_seconds(previous_end=200.0, started=125.0, window=60), 0.0)

    def test_last_end_finds_latest_call_for_the_tier(self):
        records = [
            {"tier": "small", "ended_at": 10.0},
            {"tier": "small"},  # written before ended_at existed
            {"tier": "medium", "ended_at": 99.0},
        ]
        self.assertEqual(core.last_end(records, "small"), 10.0)
        self.assertIsNone(core.last_end(records, "large"))

    def test_record_prices_call_time_plus_preceding_idle(self):
        request, _ = core.validate_chat_request({"messages": [{"role": "user", "content": "hi"}]})
        record = core.make_record(
            at=datetime(2026, 10, 12, 15, 0, tzinfo=timezone.utc),
            request=request,
            entry=SMALL,
            billed_seconds=12.0,
            idle=60.0,
            ended_at=1790000000.0,
            reply={"model_seconds": 2.0, "prompt_eval_count": 30, "eval_count": 9},
        )
        self.assertAlmostEqual(record["cost_usd"], 72.0 * SMALL.usd_per_second, places=7)
        self.assertEqual(record["idle_seconds"], 60.0)
        self.assertEqual(record["prompt_tokens"], 30)
        self.assertEqual(record["output_tokens"], 9)
        self.assertEqual(record["hardware"], "cpu")
        self.assertIsNone(record["error"])


class ValidationTests(unittest.TestCase):
    def ok(self, **overrides):
        return {"messages": [{"role": "user", "content": "hi"}], **overrides}

    def test_minimal_request_gets_defaults(self):
        clean, problem = core.validate_chat_request(self.ok())
        self.assertIsNone(problem)
        self.assertEqual(clean["tier"], "small")
        self.assertEqual(clean["role"], "manual")
        self.assertEqual(clean["max_tokens"], core.DEFAULT_OUTPUT_TOKENS)

    def test_max_tokens_is_capped(self):
        clean, _ = core.validate_chat_request(self.ok(max_tokens=999999))
        self.assertEqual(clean["max_tokens"], core.MAX_OUTPUT_TOKENS)

    def test_rejections(self):
        bad_bodies = [
            "not an object",
            {},
            {"messages": []},
            {"messages": [{"role": "robot", "content": "hi"}]},
            {"messages": [{"role": "user", "content": 5}]},
            self.ok(tier="enormous"),
            self.ok(role="intruder"),
            self.ok(tools="read_file"),
            self.ok(max_tokens=0),
            self.ok(max_tokens=True),
            self.ok(temperature=9),
            self.ok(run_id="x" * 101),
        ]
        for body in bad_bodies:
            with self.subTest(body=body):
                clean, problem = core.validate_chat_request(body)
                self.assertIsNone(clean)
                self.assertTrue(problem)


if __name__ == "__main__":
    unittest.main()
