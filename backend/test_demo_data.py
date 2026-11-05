import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main
import seed_demo_data


class DemoDataSeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "payguard-demo.sqlite3"
        self.database_patch = patch.object(main, "DATABASE_PATH", self.database_path)
        self.database_patch.start()
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        self.client.close()
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def test_seed_is_repeatable_and_all_pages_read_shared_records(self) -> None:
        first = seed_demo_data.seed_demo_data(self.database_path)
        second = seed_demo_data.seed_demo_data(self.database_path)
        self.assertTrue(first["seeded"])
        self.assertFalse(second["seeded"])
        self.assertEqual(first["counts"], second["counts"])
        self.assertEqual(first["counts"]["bills"], 4)
        self.assertEqual(first["counts"]["universal_payment_requests"], 11)

        bills = self.client.get("/api/bills").json()
        self.assertEqual(len(bills), 4)
        duplicate = next(item for item in bills if item["id"] == "demo-bill-electricity-duplicate")
        self.assertTrue(any(item["type"] == "exact" for item in duplicate["risk"]["duplicates"]))

        rules = self.client.get("/api/payments/rules").json()
        self.assertEqual(len(rules), 3)
        self.assertEqual(
            [item["recipient"] for item in rules if not item["is_active"]],
            ["DEMO · Fictional Water Utility"],
        )

        payments = self.client.get("/api/universal-payment-requests").json()
        self.assertTrue(all(item["purpose"].startswith("FICTIONAL DEMO ·") for item in payments))
        statuses = {item["status"] for item in payments}
        self.assertTrue({"prepared", "pending", "succeeded", "failed"}.issubset(statuses))
        high_value = next(item for item in payments if item["id"] == "demo-payment-unusual-high-value")
        self.assertEqual(high_value["amount"], 15000)
        self.assertTrue(any(item["type"] == "amount_anomaly" for item in high_value["risk"]["evidence"]))
        self.assertTrue(any(item["type"] == "new_or_unverified_recipient" for item in high_value["risk"]["evidence"]))
        insufficient_history = next(item for item in payments if item["id"] == "demo-payment-insufficient-history")
        self.assertTrue(any(item["type"] == "insufficient_history" for item in insufficient_history["risk"]["evidence"]))
        duplicate_payment = next(item for item in payments if item["id"] == "demo-payment-electricity-pending")
        self.assertTrue(any(item["type"] == "duplicate_payment" for item in duplicate_payment["risk"]["evidence"]))

        transactions = self.client.get("/api/transactions").json()
        self.assertEqual(len(transactions), 11)
        self.assertTrue(all(item["execution_mode"] == "sandbox" for item in transactions))
        analytics = self.client.get("/api/finance/analytics").json()
        self.assertEqual(analytics["completed_payment_count"], 5)
        self.assertEqual(
            next(item["amount"] for item in analytics["subscription_spending"] if item["currency"] == "INR"),
            499,
        )
        self.assertEqual(analytics["budgets"][0]["currency"], "INR")
        with patch.object(main, "BASE_DIR", Path(self.temp_dir.name)):
            self.assertTrue(self.client.get("/api/health").json()["demo_mode"])

    def test_demo_mode_seeds_after_startup_schema_creation(self) -> None:
        with patch.dict(os.environ, {"DEMO_MODE": "true"}), patch.object(
            main, "DATABASE_PATH", self.database_path
        ):
            with TestClient(main.app) as client:
                self.assertEqual(client.get("/api/health").json()["demo_mode"], True)
                self.assertEqual(len(client.get("/api/bills").json()), 4)

    def test_startup_does_not_seed_when_demo_mode_is_disabled(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("DEMO_MODE", None)
            with patch.object(main, "DATABASE_PATH", self.database_path):
                with TestClient(main.app):
                    pass
        with main.database_connection() as connection:
            metadata_table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_metadata'"
            ).fetchone()
        self.assertIsNone(metadata_table)

    def test_assistant_receives_real_seeded_bills_payments_and_paused_rule_context(self) -> None:
        seed_demo_data.seed_demo_data(self.database_path)
        model_response = (
            '{"action":"none","message":"Fictional demo records are loaded.","recipient":null,'
            '"rule_id":null,"amount":null,"maximum_limit":null,"currency":null,"frequency":null,'
            '"payment_day":null,"start_date":null,"reminder_due_date":null,"recipient_id":null,'
            '"payment_category":null,"purpose":null,"payment_date":null,"order_reference":null,'
            '"recurrence":null,"qr_recipient_identifier":null}'
        )
        with patch.object(main, "call_bharatcode", new=AsyncMock(return_value=model_response)) as model:
            response = self.client.post(
                "/api/assistant/interpret",
                json={"messages": [{"role": "user", "content": "Show my electricity bill and paused rule."}]},
            )
        self.assertEqual(response.status_code, 200, response.text)
        prompt = model.await_args.args[0]
        self.assertIn("DEMO · Fictional Electricity Co.", prompt)
        self.assertIn("DEMO · Stream Service", prompt)
        self.assertIn("DEMO · New Merchant Example", prompt)
        self.assertIn('"is_active": false', prompt)
        self.assertIn("FICTIONAL DEMO ·", prompt)

    def test_reset_requires_confirmation_and_preserves_non_demo_records(self) -> None:
        seed_demo_data.seed_demo_data(self.database_path)
        with self.assertRaisesRegex(RuntimeError, "--confirm"):
            seed_demo_data.reset_demo_data(self.database_path)

        with main.database_connection() as connection:
            connection.execute(
                """
                INSERT INTO payment_rules (
                    id, recipient, amount, maximum_limit, frequency, payment_date,
                    start_date, is_active, currency
                ) VALUES ('user-owned-rule', 'User-owned record', 10, 20, 'monthly', 1, '2026-01-01', 1, 'INR')
                """
            )

        counts = seed_demo_data.reset_demo_data(self.database_path, confirm=True)
        self.assertEqual(counts["bills"], 4)
        with main.database_connection() as connection:
            remaining = connection.execute(
                "SELECT recipient FROM payment_rules WHERE id = 'user-owned-rule'"
            ).fetchone()
            demo_count = connection.execute(
                "SELECT COUNT(*) FROM payment_rules WHERE id LIKE 'demo-%'"
            ).fetchone()[0]
        self.assertEqual(remaining["recipient"], "User-owned record")
        self.assertEqual(demo_count, 0)
        self.assertFalse(self.client.get("/api/health").json()["demo_mode"])

    def test_seeder_refuses_to_mix_existing_non_demo_rows(self) -> None:
        main.initialize_payments_database()
        with main.database_connection() as connection:
            connection.execute(
                """
                INSERT INTO payment_rules (
                    id, recipient, amount, maximum_limit, frequency, payment_date,
                    start_date, is_active, currency
                ) VALUES ('user-owned-rule', 'User-owned record', 10, 20, 'monthly', 1, '2026-01-01', 1, 'INR')
                """
            )
        with self.assertRaisesRegex(RuntimeError, "not owned by the demo seeder"):
            seed_demo_data.seed_demo_data(self.database_path)
        self.assertEqual(self.client.get("/api/payments/rules").json()[0]["id"], "user-owned-rule")

    def test_seed_never_writes_to_the_configured_personal_database(self) -> None:
        personal_database = Path(self.temp_dir.name) / "payguard.sqlite3"
        with patch.object(main, "DATABASE_PATH", personal_database):
            seed_demo_data.seed_demo_data(self.database_path)
        self.assertFalse(personal_database.exists())
        self.assertTrue(self.database_path.exists())


if __name__ == "__main__":
    unittest.main()
