import tempfile
import unittest
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import AsyncMock, Mock, patch
from urllib.error import HTTPError

from fastapi.testclient import TestClient
import pymupdf
from PIL import Image

import main


class PaymentRuleApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "payments.sqlite3"
        self.database_patch = patch.object(main, "DATABASE_PATH", self.database_path)
        self.database_patch.start()
        main.initialize_payments_database()
        self.client = TestClient(main.app)
        self.rule_payload = {
            "recipient": "Water utility",
            "amount": 42.50,
            "maximum_limit": 50,
            "frequency": "monthly",
            "payment_date": 15,
            "start_date": date.today().isoformat(),
        }

    def tearDown(self) -> None:
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def test_create_list_update_pause_resume_schedule_and_delete(self) -> None:
        created_response = self.client.post("/api/payments/rules", json=self.rule_payload)
        self.assertEqual(created_response.status_code, 201)
        created = created_response.json()
        rule_id = created["id"]
        self.assertEqual(created["recipient"], "Water utility")
        self.assertTrue(created["is_active"])

        listed = self.client.get("/api/payments/rules")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([rule["id"] for rule in listed.json()], [rule_id])

        updated_payload = {**self.rule_payload, "recipient": "Updated water utility", "amount": 60}
        updated_response = self.client.put(f"/api/payments/rules/{rule_id}", json=updated_payload)
        self.assertEqual(updated_response.status_code, 200)
        self.assertEqual(updated_response.json()["recipient"], "Updated water utility")
        self.assertTrue(updated_response.json()["recipient_changed"])
        self.assertTrue(updated_response.json()["details_changed"])

        paused = self.client.patch(f"/api/payments/rules/{rule_id}/status?is_active=false")
        self.assertEqual(paused.status_code, 200)
        self.assertFalse(paused.json()["is_active"])
        self.assertEqual(self.client.get("/api/payments/schedule").json(), [])

        resumed = self.client.patch(f"/api/payments/rules/{rule_id}/status?is_active=true")
        self.assertEqual(resumed.status_code, 200)
        self.assertTrue(resumed.json()["is_active"])

        schedule = self.client.get("/api/payments/schedule")
        self.assertEqual(schedule.status_code, 200)
        self.assertTrue(schedule.json())
        self.assertTrue(all(payment["requires_approval"] for payment in schedule.json()))
        self.assertTrue(all(payment["exceeds_limit"] for payment in schedule.json()))
        self.assertTrue(all(payment["recipient_changed"] for payment in schedule.json()))
        self.assertTrue(all(payment["status"] in {"pending_approval", "overdue"} for payment in schedule.json()))

        deleted = self.client.delete(f"/api/payments/rules/{rule_id}")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get("/api/payments/rules").json(), [])
        self.assertEqual(self.client.delete(f"/api/payments/rules/{rule_id}").status_code, 404)

    def test_invalid_rules_are_rejected(self) -> None:
        invalid = [
            {**self.rule_payload, "recipient": "  "},
            {**self.rule_payload, "amount": 0},
            {**self.rule_payload, "maximum_limit": -1},
            {**self.rule_payload, "frequency": "daily"},
            {**self.rule_payload, "frequency": "weekly", "payment_date": 8},
            {**self.rule_payload, "payment_date": 32},
            {**self.rule_payload, "start_date": "not-a-date"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/api/payments/rules", json=payload).status_code, 422)

    def test_finance_analytics_budget_persistence_and_evidence_limited_insights(self) -> None:
        analytics = self.client.get("/api/finance/analytics")
        self.assertEqual(analytics.status_code, 200, analytics.text)
        self.assertEqual(analytics.json()["completed_payment_count"], 0)
        self.assertEqual(self.client.get("/api/finance/budgets").json(), [])

        empty_insights = self.client.post("/api/finance/insights")
        self.assertEqual(empty_insights.status_code, 200, empty_insights.text)
        self.assertEqual(empty_insights.json()["insights"], [])

        payload = {"category": "all", "currency": "INR", "monthly_limit": 1000}
        saved = self.client.put("/api/finance/budgets", json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["monthly_limit"], 1000)
        self.assertEqual(saved.json()["spent"], 0)
        self.assertEqual(self.client.get("/api/finance/budgets").json(), [saved.json()])

        expected_evidence_id = f"budget-{saved.json()['category']}-{saved.json()['currency']}"
        with patch.object(
            main,
            "call_bharatcode",
            new=AsyncMock(return_value=main.json.dumps({
                "insights": [{
                    "title": "Budget status",
                    "message": "No spending is recorded against this budget.",
                    "evidence_ids": [expected_evidence_id],
                }],
            })),
        ) as model:
            insights = self.client.post("/api/finance/insights")
        self.assertEqual(insights.status_code, 200, insights.text)
        self.assertEqual(insights.json()["insights"][0]["evidence_ids"], [expected_evidence_id])
        model.assert_awaited_once()

        with patch.object(
            main,
            "call_bharatcode",
            new=AsyncMock(return_value=main.json.dumps({
                "insights": [{
                    "title": "Unsupported claim",
                    "message": "Unsupported evidence.",
                    "evidence_ids": ["not-provided"],
                }],
            })),
        ):
            invalid_insight = self.client.post("/api/finance/insights")
        self.assertEqual(invalid_insight.status_code, 502)

        invalid_budget = self.client.put(
            "/api/finance/budgets", json={**payload, "monthly_limit": 0}
        )
        self.assertEqual(invalid_budget.status_code, 422)
        deleted = self.client.delete("/api/finance/budgets/all/INR")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get("/api/finance/budgets").json(), [])
        self.assertEqual(self.client.delete("/api/finance/budgets/all/INR").status_code, 404)

    def test_schedule_marks_latest_missed_and_upcoming_payments(self) -> None:
        rule = {
            "id": "monthly",
            "recipient": "Monthly provider",
            "amount": 20,
            "maximum_limit": 30,
            "currency": "USD",
            "frequency": "monthly",
            "payment_date": 1,
            "start_date": "2026-10-01",
            "is_active": True,
            "details_changed": False,
            "recipient_changed": False,
        }
        schedule = main.build_schedule([rule], today=date(2026, 11, 4))
        self.assertEqual(schedule[0]["payment_date"], "2026-11-01")
        self.assertEqual(schedule[0]["status"], "overdue")
        self.assertEqual(schedule[1]["payment_date"], "2026-12-01")
        self.assertEqual(schedule[1]["status"], "pending_approval")


class PaymentAssistantApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "assistant.sqlite3"
        )
        self.database_patch.start()
        main.initialize_payments_database()
        self.client = TestClient(main.app)
        self.api_key_patch = patch.dict("os.environ", {"BHARATCODE_API_KEY": "test-key"})
        self.api_key_patch.start()
        self.rule_payload = {
            "recipient": "Electricity Provider",
            "amount": 2400,
            "maximum_limit": 2800,
            "currency": "INR",
            "frequency": "monthly",
            "payment_date": 5,
            "start_date": date.today().isoformat(),
        }

    def tearDown(self) -> None:
        self.api_key_patch.stop()
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def interpret(self, interpretation: dict, message: str = "Please help.") -> dict:
        with patch.object(
            main, "call_bharatcode",
            new=AsyncMock(return_value=main.json.dumps(interpretation)),
        ):
            response = self.client.post(
                "/api/assistant/interpret",
                json={"messages": [{"role": "user", "content": message}]},
            )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_assistant_prompt_declares_exact_output_fields(self) -> None:
        prompt = main.assistant_prompt([
            main.AgentChatMessage(role="user", content="What payments are coming up?"),
        ], [])
        self.assertIn('"maximum_limit": null', prompt)
        self.assertIn("Return exactly one JSON object with exactly these keys", prompt)
        self.assertIn("do not return missing_fields, requires_clarification", prompt)

    def test_assistant_compares_only_an_explicit_upi_id_to_saved_records(self) -> None:
        recipient = self.client.post("/api/payment-recipients", json={
            "name": "Rahul",
            "recipient_type": "person",
            "identifier": "rahul@upi",
        }).json()
        compared = self.interpret({
            "action": "compare_qr_recipient",
            "message": "Compare the decoded UPI ID.",
            "qr_recipient_identifier": "rahul@upi",
        }, "Compare this QR recipient with saved recipients: rahul@upi")
        self.assertIn("matches the saved recipient record", compared["message"])
        self.assertIn("not account or bank verification", compared["message"])
        self.assertIsNone(compared["proposal"])

        missing = self.interpret({
            "action": "compare_qr_recipient",
            "message": "Please scan the QR first.",
        }, "Check whether this UPI QR is suspicious")
        self.assertIn("Open Scan & Pay", missing["message"])
        self.assertEqual(self.client.get("/api/payment-recipients").json()[0]["id"], recipient["id"])

    def test_create_rule_is_only_a_proposal_until_existing_api_is_confirmed(self) -> None:
        proposal = {
            "action": "create_payment_rule",
            "message": "I can prepare that.",
            "recipient": "Electricity Provider",
            "amount": 2400,
            "maximum_limit": 3000,
            "currency": "INR",
            "frequency": "monthly",
            "payment_day": 5,
            "start_date": date.today().isoformat(),
        }
        interpreted = self.interpret(proposal, "Create a monthly electricity rule for ₹2400, limit ₹3000, due on the 5th, starting today.")
        self.assertEqual(interpreted["proposal"]["action"], "create_payment_rule")
        self.assertEqual(interpreted["proposal"]["missing_fields"], [])
        self.assertEqual(self.client.get("/api/payments/rules").json(), [])

        draft = interpreted["proposal"]
        saved = self.client.post(
            "/api/payments/rules",
            json={
                "recipient": draft["recipient"],
                "amount": draft["amount"],
                "maximum_limit": draft["maximum_limit"],
                "currency": draft["currency"],
                "frequency": draft["frequency"],
                "payment_date": draft["payment_day"],
                "start_date": draft["start_date"],
            },
        )
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(saved.json()["currency"], "INR")

    def test_missing_rule_details_are_asked_for_not_invented(self) -> None:
        interpreted = self.interpret({
            "action": "create_payment_rule",
            "message": "I need more details.",
            "recipient": "Electricity Provider",
            "amount": None,
            "maximum_limit": None,
            "currency": "INR",
            "frequency": "monthly",
            "payment_day": None,
            "start_date": None,
        }, "Create a monthly electricity payment rule.")
        self.assertEqual(
            set(interpreted["proposal"]["missing_fields"]),
            {"amount", "maximum_limit", "payment_day", "start_date"},
        )
        self.assertIn("please provide", interpreted["message"].lower())
        self.assertEqual(self.client.get("/api/payments/rules").json(), [])

    def test_limit_proposal_requires_user_confirmation_and_checks_currency(self) -> None:
        created = self.client.post("/api/payments/rules", json=self.rule_payload)
        rule_id = created.json()["id"]
        interpreted = self.interpret({
            "action": "set_payment_limit",
            "message": "I can update the limit.",
            "recipient": "Electricity Provider",
            "maximum_limit": 3000,
            "currency": "INR",
        }, "Set a ₹3,000 approval threshold for Electricity Provider.")
        self.assertEqual(interpreted["proposal"]["rule_id"], rule_id)
        self.assertEqual(interpreted["proposal"]["maximum_limit"], 3000)
        self.assertEqual(self.client.get("/api/payments/rules").json()[0]["maximum_limit"], 2800)

        changed = self.client.patch(
            f"/api/payments/rules/{rule_id}/limit",
            json={"maximum_limit": 3000, "currency": "INR"},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["maximum_limit"], 3000)
        mismatch = self.client.patch(
            f"/api/payments/rules/{rule_id}/limit",
            json={"maximum_limit": 3500, "currency": "USD"},
        )
        self.assertEqual(mismatch.status_code, 409)
        invalid = self.client.patch(
            f"/api/payments/rules/{rule_id}/limit",
            json={"maximum_limit": 1.001, "currency": "INR"},
        )
        self.assertEqual(invalid.status_code, 422)

    def test_pause_is_proposed_then_confirmed_using_status_api(self) -> None:
        created = self.client.post("/api/payments/rules", json=self.rule_payload)
        rule_id = created.json()["id"]
        interpreted = self.interpret({
            "action": "pause_payment_rule",
            "message": "I can pause it.",
            "recipient": "Electricity Provider",
        }, "Pause Electricity Provider.")
        self.assertEqual(interpreted["proposal"]["rule_id"], rule_id)
        self.assertTrue(self.client.get("/api/payments/rules").json()[0]["is_active"])

        paused = self.client.patch(f"/api/payments/rules/{rule_id}/status?is_active=false")
        self.assertEqual(paused.status_code, 200)
        self.assertFalse(paused.json()["is_active"])

    def test_ambiguous_rule_match_requires_follow_up(self) -> None:
        first = self.client.post("/api/payments/rules", json={
            **self.rule_payload, "recipient": "Electricity North",
        })
        second = self.client.post("/api/payments/rules", json={
            **self.rule_payload, "recipient": "Electricity South",
        })
        interpreted = self.interpret({
            "action": "pause_payment_rule",
            "message": "I can pause that rule.",
            "recipient": "Electricity",
        }, "Pause my electricity rule.")
        self.assertEqual(interpreted["proposal"]["missing_fields"], ["recipient"])
        self.assertIsNone(interpreted["proposal"]["rule_id"])
        self.assertTrue(all(
            rule["is_active"]
            for rule in (first.json(), second.json())
        ))

    def test_upcoming_query_uses_database_schedule_not_generated_facts(self) -> None:
        self.client.post("/api/payments/rules", json=self.rule_payload)
        interpreted = self.interpret({
            "action": "query_upcoming_payments",
            "message": "Here is your upcoming schedule.",
        }, "What payments are coming up?")
        self.assertIsNone(interpreted["proposal"])
        self.assertTrue(interpreted["upcoming_payments"])
        self.assertTrue(all(
            item["recipient"] == "Electricity Provider"
            and item["currency"] == "INR"
            and item["requires_approval"]
            for item in interpreted["upcoming_payments"]
        ))

    def test_bill_reminder_is_proposed_before_persistence(self) -> None:
        due_date = date.today().isoformat()
        interpreted = self.interpret({
            "action": "set_bill_reminder",
            "message": "I can prepare a reminder.",
            "recipient": "Internet Provider",
            "reminder_due_date": due_date,
            "amount": 900,
            "currency": "INR",
        }, f"Remind me when my internet bill is due on {due_date}.")
        self.assertEqual(interpreted["proposal"]["missing_fields"], [])
        self.assertEqual(self.client.get("/api/bill-reminders").json(), [])

        draft = interpreted["proposal"]
        saved = self.client.post("/api/bill-reminders", json={
            "recipient": draft["recipient"],
            "due_date": draft["reminder_due_date"],
            "amount": draft["amount"],
            "currency": draft["currency"],
        })
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(saved.json()["recipient"], "Internet Provider")

    def test_assistant_payment_is_recipient_resolved_and_only_proposed(self) -> None:
        recipient = self.client.post("/api/payment-recipients", json={
            "name": "Asha",
            "recipient_type": "person",
            "identifier": "asha@example",
        }).json()
        interpreted = self.interpret({
            "action": "prepare_universal_payment",
            "message": "Review this transfer.",
            "recipient": "Asha",
            "recipient_id": None,
            "payment_category": "person_to_person",
            "amount": 2000,
            "currency": "INR",
            "purpose": "Rent share",
            "payment_date": date.today().isoformat(),
        }, "Send ₹2,000 to Asha for rent share today.")
        proposal = interpreted["proposal"]
        self.assertEqual(proposal["recipient_id"], recipient["id"])
        self.assertEqual(proposal["missing_fields"], [])
        self.assertEqual(self.client.get("/api/universal-payment-requests").json(), [])

    def test_assistant_qr_payment_requires_and_preserves_a_valid_decoded_identifier(self) -> None:
        recipient = self.client.post("/api/payment-recipients", json={
            "name": "Shop",
            "recipient_type": "merchant",
            "identifier": "shop@upi",
        }).json()
        common = {
            "action": "prepare_universal_payment",
            "message": "Review the QR request.",
            "recipient": "Shop",
            "recipient_id": recipient["id"],
            "payment_category": "qr_payment",
            "amount": 500,
            "currency": "INR",
            "purpose": "Purchase",
            "payment_date": date.today().isoformat(),
        }
        missing = self.interpret(common, "Prepare a QR payment to Shop.")
        self.assertIn("qr_recipient_identifier", missing["proposal"]["missing_fields"])

        invalid = self.interpret({
            **common,
            "qr_recipient_identifier": "not-a-vpa",
        }, "Prepare a QR payment to Shop.")
        self.assertIn("qr_recipient_identifier", invalid["proposal"]["missing_fields"])

        valid = self.interpret({
            **common,
            "qr_recipient_identifier": "shop@upi",
        }, "Prepare a QR payment to Shop using shop@upi.")
        self.assertEqual(valid["proposal"]["missing_fields"], [])
        self.assertEqual(valid["proposal"]["qr_recipient_identifier"], "shop@upi")
        self.assertEqual(self.client.get("/api/universal-payment-requests").json(), [])

    def test_assistant_queries_use_saved_universal_transactions(self) -> None:
        recipient = self.client.post("/api/payment-recipients", json={
            "name": "Asha",
            "recipient_type": "person",
            "identifier": "asha@example",
        }).json()
        self.client.post(f"/api/payment-recipients/{recipient['id']}/verify")
        prepared = self.client.post(
            "/api/universal-payment-requests",
            headers={"Idempotency-Key": "assistant-test-payment"},
            json={
                "recipient_id": recipient["id"],
                "category": "person_to_person",
                "amount": 2000,
                "currency": "INR",
                "purpose": "Rent share",
                "payment_date": date.today().isoformat(),
            },
        )
        self.assertEqual(prepared.status_code, 201, prepared.text)
        self.assertEqual(
            self.client.post(
                f"/api/universal-payment-requests/{prepared.json()['id']}/approve",
                json={"confirm_sandbox_payment": True},
            ).json()["status"],
            "succeeded",
        )

        history = self.interpret({
            "action": "query_transactions",
            "message": "Showing saved transactions.",
        }, "Show my transfers this month.")
        self.assertIn("1 saved transaction", history["message"])
        self.assertEqual(history["upcoming_payments"][0]["recipient"], "Asha")

        spending = self.interpret({
            "action": "query_spending",
            "message": "Calculating spending.",
        }, "How much did I spend this month?")
        self.assertIn("INR 2000.00", spending["message"])

    def test_assistant_duplicate_and_bill_comparison_queries_use_saved_bills(self) -> None:
        bill_payload = {
            "provider_name": "North Electricity",
            "bill_amount": 100,
            "currency": "INR",
            "billing_date": "2026-09-01",
            "due_date": "2026-09-20",
            "invoice_number": "NE-001",
            "account_reference": "AC-001",
        }
        first = self.client.post("/api/bills", json=bill_payload)
        self.assertEqual(first.status_code, 201, first.text)
        self.client.post("/api/bills", json={**bill_payload, "invoice_number": "NE-002", "bill_amount": 200, "billing_date": "2026-10-01", "due_date": "2026-10-20"})
        duplicate = self.client.post("/api/bills", json=bill_payload)
        self.assertEqual(duplicate.status_code, 201, duplicate.text)

        duplicates = self.interpret({
            "action": "query_duplicates",
            "message": "I will check saved records.",
        }, "Find duplicate transactions.")
        self.assertIn("1 possible or exact duplicate group", duplicates["message"])
        self.assertEqual(duplicates["upcoming_payments"][0]["status"], "exact_duplicate_bill")
        self.assertEqual(duplicates["upcoming_payments"][0]["details"], "Same provider and invoice number.")

        comparison = self.interpret({
            "action": "query_bill_comparison",
            "message": "I will compare the saved bills.",
            "recipient": "North Electricity",
        }, "Compare my electricity bills.")
        self.assertIn("change +100.00%", comparison["message"])

    def test_assistant_unusual_spending_query_requires_historical_evidence(self) -> None:
        no_history = self.interpret({
            "action": "explain_unusual_spending",
            "message": "I will compare completed payments.",
        }, "Explain unusual spending.")
        self.assertIn("Available history may be limited", no_history["message"])
        self.assertEqual(no_history["upcoming_payments"], [])


class BillAndPaymentApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "bills.sqlite3"
        )
        self.database_patch.start()
        main.initialize_payments_database()
        self.client = TestClient(main.app)
        self.bill_payload = {
            "provider_name": "North Electricity",
            "customer_name": "Test Customer",
            "bill_amount": 100,
            "currency": "INR",
            "due_date": "2026-11-20",
            "invoice_number": "NE-100",
            "account_reference": "AC-100",
        }

    def tearDown(self) -> None:
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def save_bill(self, payload: dict | None = None) -> dict:
        response = self.client.post("/api/bills", json=payload or self.bill_payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_bill_persistence_duplicate_checks_and_user_verified_recipient(self) -> None:
        first = self.save_bill({
            **self.bill_payload,
            "tax_amount": 8.5,
            "billing_date": "2026-11-01",
            "document_type": "utility_bill",
        })
        self.assertEqual(first["bill"]["invoice_number"], "NE-100")
        self.assertEqual(first["bill"]["tax_amount"], 8.5)
        self.assertEqual(first["bill"]["billing_date"], "2026-11-01")
        self.assertEqual(first["bill"]["document_type"], "utility_bill")
        self.assertIn("new_or_unverified_recipient", {
            item["type"] for item in first["risk"]["evidence"]
        })

        duplicate = self.save_bill({**self.bill_payload, "invoice_number": "NE-100"})
        self.assertEqual(duplicate["risk"]["duplicates"][0]["type"], "exact")
        self.assertEqual(duplicate["risk"]["level"], "Medium")
        blocked = self.client.post(
            "/api/payment-requests",
            headers={"Idempotency-Key": "exact-duplicate-001"},
            json={"bill_id": duplicate["bill"]["id"]},
        )
        self.assertEqual(blocked.status_code, 409)

        verified = self.client.post(
            "/api/recipients/verify", json={"provider_name": "North Electricity"}
        )
        self.assertEqual(verified.status_code, 201)
        listed = self.client.get("/api/bills").json()
        first_after_verification = next(item for item in listed if item["id"] == first["bill"]["id"])
        self.assertNotIn("new_or_unverified_recipient", {
            item["type"] for item in first_after_verification["risk"]["evidence"]
        })
        self.assertEqual(len(self.client.get("/api/recipients").json()), 1)

    def test_historical_amount_anomaly_and_recipient_mismatch_have_evidence(self) -> None:
        self.save_bill({
            **self.bill_payload,
            "provider_name": "Other Utility",
            "invoice_number": "OU-1",
            "account_reference": "SHARED-REF",
            "bill_amount": 100,
            "due_date": "2026-09-01",
        })
        self.save_bill({
            **self.bill_payload,
            "provider_name": "North Electricity",
            "invoice_number": "NE-1",
            "account_reference": "SHARED-REF",
            "bill_amount": 100,
            "due_date": "2026-10-01",
        })
        current = self.save_bill({
            **self.bill_payload,
            "invoice_number": "NE-2",
            "account_reference": "SHARED-REF",
            "bill_amount": 200,
            "due_date": "2026-11-02",
        })
        evidence = current["risk"]["evidence"]
        anomaly = next(item for item in evidence if item["type"] == "amount_increase")
        self.assertEqual(anomaly["previous_amount"], 100)
        self.assertEqual(anomaly["current_amount"], 200)
        self.assertEqual(anomaly["percentage_change"], 100)
        self.assertIn("recipient_mismatch", {item["type"] for item in evidence})
        self.assertEqual(current["risk"]["level"], "High")

    def test_account_reference_change_and_large_amount_decrease_are_evidence(self) -> None:
        self.save_bill({
            **self.bill_payload,
            "invoice_number": "NE-OLD",
            "account_reference": "AC-OLD",
            "bill_amount": 100,
            "due_date": "2026-10-01",
        })
        changed_account = self.save_bill({
            **self.bill_payload,
            "invoice_number": "NE-NEW",
            "account_reference": "AC-NEW",
            "bill_amount": 40,
            "due_date": "2026-11-02",
        })
        evidence = changed_account["risk"]["evidence"]
        account_change = next(item for item in evidence if item["type"] == "account_reference_change")
        self.assertEqual(account_change["previous_account_reference"], "AC-OLD")
        decrease = next(item for item in evidence if item["type"] == "amount_decrease")
        self.assertEqual(decrease["percentage_change"], -60)
        self.assertEqual(changed_account["risk"]["level"], "Medium")

    def test_payment_request_is_idempotent_explicit_and_sandbox_only(self) -> None:
        bill = self.save_bill()["bill"]
        headers = {"Idempotency-Key": "payment-prepare-001"}
        request = self.client.post(
            "/api/payment-requests", headers=headers, json={"bill_id": bill["id"]}
        )
        self.assertEqual(request.status_code, 201, request.text)
        payment_id = request.json()["id"]
        self.assertEqual(request.json()["status"], "prepared")
        self.assertEqual(request.json()["execution_mode"], "sandbox")

        repeated = self.client.post(
            "/api/payment-requests", headers=headers, json={"bill_id": bill["id"]}
        )
        self.assertEqual(repeated.status_code, 201)
        self.assertEqual(repeated.json()["id"], payment_id)
        second_key = self.client.post(
            "/api/payment-requests",
            headers={"Idempotency-Key": "payment-prepare-002"},
            json={"bill_id": bill["id"]},
        )
        self.assertEqual(second_key.status_code, 409)

        approval = self.client.post(
            f"/api/payment-requests/{payment_id}/approve",
            json={"confirm_sandbox_payment": True, "simulate_failure": True},
        )
        self.assertEqual(approval.status_code, 200, approval.text)
        self.assertEqual(approval.json()["status"], "failed")
        self.assertEqual(approval.json()["error_code"], "SANDBOX_SIMULATED_FAILURE")
        recovery = self.client.get(f"/api/payment-requests/{payment_id}/recovery")
        self.assertEqual(recovery.status_code, 200)
        self.assertIn("failed", recovery.json()["recommended_action"])
        self.assertEqual(len(recovery.json()["events"]), 2)
        support = self.client.post(f"/api/payment-requests/{payment_id}/support", json={})
        self.assertEqual(support.status_code, 201)
        self.assertEqual(
            self.client.post(
                f"/api/payment-requests/{payment_id}/approve",
                json={"confirm_sandbox_payment": True},
            ).status_code,
            409,
        )

    def test_due_bill_preparation_requires_verified_recipient_and_is_idempotent(self) -> None:
        today = date.today()
        bill = self.save_bill({
            **self.bill_payload,
            "due_date": today.isoformat(),
        })["bill"]
        rule = {
            "recipient": bill["provider_name"],
            "amount": bill["bill_amount"],
            "maximum_limit": 150,
            "currency": bill["currency"],
            "frequency": "monthly",
            "payment_date": today.day,
            "start_date": today.isoformat(),
        }
        created_rule = self.client.post("/api/payments/rules", json=rule)
        self.assertEqual(created_rule.status_code, 201, created_rule.text)

        unverified = self.client.post("/api/payment-requests/prepare-due").json()
        self.assertEqual(unverified["prepared"], [])
        self.assertIn("User-confirm", unverified["skipped"][0]["reason"])

        verified = self.client.post(
            "/api/recipients/verify", json={"provider_name": bill["provider_name"]}
        )
        self.assertEqual(verified.status_code, 201)
        prepared = self.client.post("/api/payment-requests/prepare-due").json()
        self.assertEqual(len(prepared["prepared"]), 1)
        self.assertEqual(prepared["prepared"][0]["status"], "prepared")
        self.assertEqual(prepared["execution_mode"], "sandbox")
        self.assertEqual(self.client.post("/api/payment-requests/prepare-due").json()["prepared"], [])
        self.assertEqual(len(self.client.get("/api/payment-requests").json()), 1)

    def test_high_risk_sandbox_payment_needs_explicit_risk_acknowledgement(self) -> None:
        self.save_bill({
            **self.bill_payload,
            "provider_name": "Other Utility",
            "invoice_number": "OU-1",
            "account_reference": "SHARED-REF",
            "bill_amount": 100,
            "due_date": "2026-09-01",
        })
        self.save_bill({
            **self.bill_payload,
            "invoice_number": "NE-1",
            "account_reference": "SHARED-REF",
            "bill_amount": 100,
            "due_date": "2026-10-01",
        })
        high_risk = self.save_bill({
            **self.bill_payload,
            "invoice_number": "NE-2",
            "account_reference": "SHARED-REF",
            "bill_amount": 200,
            "due_date": "2026-11-02",
        })
        self.assertEqual(high_risk["risk"]["level"], "High")
        prepared = self.client.post(
            "/api/payment-requests",
            headers={"Idempotency-Key": "high-risk-payment-001"},
            json={"bill_id": high_risk["bill"]["id"]},
        )
        self.assertEqual(prepared.status_code, 201)
        payment_id = prepared.json()["id"]
        blocked = self.client.post(
            f"/api/payment-requests/{payment_id}/approve",
            json={"confirm_sandbox_payment": True},
        )
        self.assertEqual(blocked.status_code, 409)
        approved = self.client.post(
            f"/api/payment-requests/{payment_id}/approve",
            json={"confirm_sandbox_payment": True, "acknowledge_high_risk": True},
        )
        self.assertEqual(approved.status_code, 200)
        self.assertEqual(approved.json()["status"], "succeeded")
        self.assertIn("SBX-", approved.json()["provider_reference"])

    def test_invalid_bill_currency_and_amount_are_rejected(self) -> None:
        for invalid in (
            {**self.bill_payload, "currency": "EUR"},
            {**self.bill_payload, "bill_amount": -1},
        ):
            with self.subTest(payload=invalid):
                self.assertEqual(self.client.post("/api/bills", json=invalid).status_code, 422)

    def test_bill_extraction_sends_only_locally_extracted_text_to_bharatcode(self) -> None:
        extracted = {
            "provider_name": "North Electricity",
            "customer_name": "Test Customer",
            "bill_amount": 100,
            "tax_amount": 8.5,
            "currency": "INR",
            "billing_date": "2026-11-01",
            "due_date": "2026-11-20",
            "invoice_number": "NE-100",
            "account_reference": "AC-100",
            "units_consumed": None,
            "billing_period": None,
            "document_type": "utility_bill",
            "missing_fields": ["units_consumed"],
            "uncertain_fields": ["tax_amount"],
        }
        pdf_content = b"%PDF-1.7 private document bytes"
        with (
            patch.dict("os.environ", {"BHARATCODE_API_KEY": "test-key"}),
            patch.object(main, "extract_document_text", return_value="North Electricity invoice NE-100") as local_extract,
            patch.object(main, "call_bharatcode", new_callable=AsyncMock, return_value=main.json.dumps(extracted)) as ai_call,
        ):
            response = self.client.post(
                "/api/extract",
                files={"file": ("bill.pdf", pdf_content, "application/pdf")},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["provider_name"], "North Electricity")
        self.assertEqual(response.json()["tax_amount"], 8.5)
        self.assertEqual(response.json()["billing_date"], "2026-11-01")
        self.assertEqual(response.json()["missing_fields"], ["units_consumed"])
        self.assertEqual(response.json()["uncertain_fields"], ["tax_amount"])
        local_extract.assert_called_once_with(pdf_content, "application/pdf")
        prompt = ai_call.await_args.args[1]
        self.assertIn("North Electricity invoice NE-100", prompt)
        self.assertNotIn(pdf_content.decode(), prompt)

    def test_scanned_pdf_uses_local_tesseract_before_bharatcode(self) -> None:
        document = pymupdf.open()
        document.new_page().insert_text((72, 72), "A scanned bill image")
        pdf_content = document.tobytes()
        document.close()
        with (
            patch.object(main.shutil, "which", return_value="tesseract"),
            patch.object(
                main.subprocess,
                "run",
                return_value=CompletedProcess(args=[], returncode=0, stdout=b"Local OCR bill text", stderr=b""),
            ) as local_ocr,
        ):
            text = main.extract_document_text(pdf_content, "application/pdf")

        self.assertEqual(text, "Local OCR bill text")
        self.assertEqual(local_ocr.call_count, 1)
        self.assertTrue(local_ocr.call_args.kwargs["input"].startswith(b"\x89PNG"))

    def test_digital_pdf_text_is_extracted_without_ocr(self) -> None:
        document = pymupdf.open()
        document.new_page().insert_text(
            (72, 72),
            "Demo Power Services\nInvoice Number: DP-100\nAmount Due: INR 2000",
        )
        pdf_content = document.tobytes()
        document.close()
        with patch.object(main.subprocess, "run") as local_ocr:
            text = main.extract_document_text(pdf_content, "application/pdf")
        self.assertIn("Invoice Number: DP-100", text)
        self.assertIn("INR 2000", text)
        local_ocr.assert_not_called()

    def test_image_ocr_fails_clearly_when_tesseract_is_unavailable(self) -> None:
        image_buffer = BytesIO()
        Image.new("RGB", (2, 2), "white").save(image_buffer, format="PNG")
        with (
            patch.dict("os.environ", {"TESSERACT_CMD": ""}),
            patch.object(main.shutil, "which", return_value=None),
        ):
            with self.assertRaises(main.HTTPException) as raised:
                main.extract_document_text(image_buffer.getvalue(), "image/png")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Tesseract OCR", raised.exception.detail)

    def test_oversized_image_is_rejected_before_local_ocr(self) -> None:
        image_buffer = BytesIO()
        Image.new("RGB", (2, 2), "white").save(image_buffer, format="PNG")
        with patch.object(main, "MAX_IMAGE_PIXELS", 3):
            with self.assertRaises(main.HTTPException) as raised:
                main.extract_document_text(image_buffer.getvalue(), "image/png")
        self.assertEqual(raised.exception.status_code, 413)


class UniversalPaymentsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "universal.sqlite3"
        )
        self.database_patch.start()
        main.initialize_payments_database()
        self.client = TestClient(main.app)
        self.recipient = self.create_recipient()

    def tearDown(self) -> None:
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def create_recipient(
        self,
        name: str = "Asha",
        recipient_type: str = "person",
        identifier: str = "asha@example",
    ) -> dict:
        response = self.client.post(
            "/api/payment-recipients",
            json={
                "name": name,
                "recipient_type": recipient_type,
                "identifier": identifier,
                "account_reference": "account-001",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def prepare(
        self,
        *,
        recipient_id: str | None = None,
        category: str = "person_to_person",
        amount: float = 2000,
        payment_date: str | None = None,
        order_reference: str | None = None,
        recurrence: str | None = None,
        qr_recipient_identifier: str | None = None,
        qr_amount: float | None = None,
        qr_payee_name: str | None = None,
        qr_merchant_code: str | None = None,
        qr_transaction_reference: str | None = None,
        key: str = "universal-payment-001",
    ):
        return self.client.post(
            "/api/universal-payment-requests",
            headers={"Idempotency-Key": key},
            json={
                "recipient_id": recipient_id or self.recipient["id"],
                "category": category,
                "amount": amount,
                "currency": "INR",
                "purpose": "Test transfer",
                "payment_date": payment_date or date.today().isoformat(),
                "order_reference": order_reference,
                "recurrence": recurrence,
                "qr_recipient_identifier": qr_recipient_identifier,
                "qr_amount": qr_amount,
                "qr_payee_name": qr_payee_name,
                "qr_merchant_code": qr_merchant_code,
                "qr_transaction_reference": qr_transaction_reference,
            },
        )

    def approve(self, payment_id: str, **overrides):
        return self.client.post(
            f"/api/universal-payment-requests/{payment_id}/approve",
            json={"confirm_sandbox_payment": True, **overrides},
        )

    def test_p2p_requires_recipient_confirmation_then_sandbox_approval(self) -> None:
        prepared = self.prepare()
        self.assertEqual(prepared.status_code, 201, prepared.text)
        record = prepared.json()
        self.assertEqual(record["category"], "person_to_person")
        self.assertEqual(record["status"], "prepared")
        self.assertEqual(record["approval_status"], "awaiting_approval")
        self.assertEqual(record["payment_method"], "sandbox_simulator")
        self.assertEqual(record["risk"]["score"], 25)
        blocked = self.approve(record["id"])
        self.assertEqual(blocked.status_code, 409)

        verified = self.client.post(
            f"/api/payment-recipients/{self.recipient['id']}/verify"
        )
        self.assertTrue(verified.json()["is_verified"])
        approved = self.approve(record["id"])
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["status"], "succeeded")
        self.assertEqual(approved.json()["approval_status"], "approved")
        self.assertTrue(approved.json()["provider_reference"].startswith("SBX-"))

    def test_prepared_request_can_be_updated_or_audit_cancelled(self) -> None:
        prepared = self.prepare(key="update-payment-01")
        self.assertEqual(prepared.status_code, 201, prepared.text)
        payment_id = prepared.json()["id"]
        unchanged = self.client.put(
            f"/api/universal-payment-requests/{payment_id}",
            json={
                "recipient_id": self.recipient["id"],
                "category": "person_to_person",
                "amount": 2000,
                "currency": "INR",
                "purpose": "Test transfer",
                "payment_date": date.today().isoformat(),
            },
        )
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        self.assertNotIn(
            "duplicate_payment",
            {item["type"] for item in unchanged.json()["risk"]["evidence"]},
        )
        updated_payload = {
            "recipient_id": self.recipient["id"],
            "category": "account_transfer",
            "payment_method": "bank_transfer",
            "amount": 2500,
            "currency": "INR",
            "purpose": "Updated purpose",
            "payment_date": date.today().isoformat(),
            "order_reference": None,
            "recurrence": None,
        }
        updated = self.client.put(
            f"/api/universal-payment-requests/{payment_id}",
            json=updated_payload,
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["amount"], 2500)
        self.assertEqual(updated.json()["payment_method"], "bank_transfer")
        self.assertEqual(updated.json()["approval_status"], "awaiting_approval")

        cancelled = self.client.delete(f"/api/universal-payment-requests/{payment_id}")
        self.assertEqual(cancelled.status_code, 204)
        stored = self.client.get("/api/universal-payment-requests").json()
        cancelled_record = next(item for item in stored if item["id"] == payment_id)
        self.assertEqual(cancelled_record["approval_status"], "cancelled")
        self.assertEqual(cancelled_record["transaction_status"], "cancelled")
        self.assertEqual(self.approve(payment_id).status_code, 409)
        self.assertEqual(
            self.client.put(
                f"/api/universal-payment-requests/{payment_id}",
                json=updated_payload,
            ).status_code,
            409,
        )
        replacement = self.client.post(
            "/api/universal-payment-requests",
            headers={"Idempotency-Key": "cancelled-payment-replacement"},
            json=updated_payload,
        )
        self.assertEqual(replacement.status_code, 201, replacement.text)

        with main.database_connection() as connection:
            events = connection.execute(
                "SELECT new_status FROM universal_payment_events WHERE payment_id = ? ORDER BY created_at, rowid",
                (payment_id,),
            ).fetchall()
        self.assertEqual(
            [event["new_status"] for event in events],
            ["prepared", "prepared", "prepared", "cancelled"],
        )

    def test_idempotency_key_cannot_be_reused_for_different_payment_method(self) -> None:
        first = self.prepare(key="method-idempotency-01")
        self.assertEqual(first.status_code, 201, first.text)
        repeated = self.client.post(
            "/api/universal-payment-requests",
            headers={"Idempotency-Key": "method-idempotency-01"},
            json={
                "recipient_id": self.recipient["id"],
                "category": "person_to_person",
                "payment_method": "upi_qr",
                "amount": 2000,
                "currency": "INR",
                "purpose": "Test transfer",
                "payment_date": date.today().isoformat(),
            },
        )
        self.assertEqual(repeated.status_code, 409)

    def test_idempotency_duplicate_detection_and_unified_history_filters(self) -> None:
        verified = self.client.post(
            f"/api/payment-recipients/{self.recipient['id']}/verify"
        )
        self.assertEqual(verified.status_code, 200)
        first = self.prepare()
        repeated = self.prepare()
        self.assertEqual(first.json()["id"], repeated.json()["id"])
        self.assertEqual(self.approve(first.json()["id"]).json()["status"], "succeeded")
        duplicate = self.prepare(key="universal-payment-002")
        self.assertEqual(duplicate.status_code, 409)

        history = self.client.get(
            "/api/transactions",
            params={"category": "person_to_person", "recipient": "asha", "min_amount": "1000"},
        )
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(len(history.json()), 1)
        self.assertEqual(history.json()[0]["status"], "succeeded")
        self.assertEqual(self.client.get("/api/universal-payment-requests?status=succeeded").json()[0]["id"], first.json()["id"])

    def test_merchant_failure_refund_and_future_schedule_guards(self) -> None:
        merchant = self.create_recipient(
            name="Shop", recipient_type="merchant", identifier="shop@example"
        )
        self.client.post(f"/api/payment-recipients/{merchant['id']}/verify")
        merchant_payment = self.prepare(
            recipient_id=merchant["id"],
            category="merchant",
            amount=450,
            order_reference="ORDER-42",
            key="merchant-payment-001",
        )
        self.assertEqual(merchant_payment.status_code, 201, merchant_payment.text)
        failed = self.approve(merchant_payment.json()["id"], simulate_failure=True)
        self.assertEqual(failed.json()["status"], "failed")
        self.assertIsNone(failed.json()["provider_reference"])
        self.assertEqual(
            self.client.post(
                f"/api/universal-payment-requests/{merchant_payment.json()['id']}/refund",
                json={"confirm_sandbox_refund": True, "reason": "Not successful"},
            ).status_code,
            409,
        )

        scheduled = self.prepare(
            recipient_id=self.recipient["id"],
            category="scheduled_transfer",
            amount=1000,
            payment_date="2099-01-01",
            recurrence="monthly",
            key="scheduled-payment-001",
        )
        self.assertEqual(scheduled.status_code, 201, scheduled.text)
        self.client.post(f"/api/payment-recipients/{self.recipient['id']}/verify")
        self.assertEqual(self.approve(scheduled.json()["id"]).status_code, 409)

    def test_successful_payment_can_be_refunded_and_recipient_changes_revoke_verification(self) -> None:
        self.client.post(f"/api/payment-recipients/{self.recipient['id']}/verify")
        prepared = self.prepare()
        self.assertEqual(self.approve(prepared.json()["id"]).json()["status"], "succeeded")
        refunded = self.client.post(
            f"/api/universal-payment-requests/{prepared.json()['id']}/refund",
            json={"confirm_sandbox_refund": True, "reason": "Duplicate order in sandbox"},
        )
        self.assertEqual(refunded.status_code, 200, refunded.text)
        self.assertEqual(refunded.json()["status"], "refunded")
        self.assertIn("Duplicate order", refunded.json()["refund_reason"])

        changed = self.client.put(
            f"/api/payment-recipients/{self.recipient['id']}",
            json={
                "name": "Asha",
                "recipient_type": "person",
                "identifier": "new-destination@example",
                "account_reference": "account-001",
            },
        )
        self.assertTrue(changed.json()["details_changed"])
        self.assertFalse(changed.json()["is_verified"])

    def test_merchant_validation_and_local_qr_parsing(self) -> None:
        missing_order = self.prepare(
            category="merchant", amount=100, key="merchant-payment-no-order"
        )
        self.assertEqual(missing_order.status_code, 422)

        parsed = self.client.post(
            "/api/qr/parse",
            json={"payload": "upi://pay?pa=merchant%40upi&pn=Local%20Shop&am=125.50&cu=INR&tn=Lunch&mc=5411&tr=ORDER-5"},
        )
        self.assertEqual(parsed.status_code, 200, parsed.text)
        self.assertEqual(parsed.json()["recipient_identifier"], "merchant@upi")
        self.assertEqual(parsed.json()["amount"], 125.5)
        self.assertTrue(parsed.json()["upi_id_valid"])
        self.assertEqual(parsed.json()["merchant_code"], "5411")
        self.assertEqual(parsed.json()["transaction_reference"], "ORDER-5")
        self.assertFalse(parsed.json()["payment_initiated"])
        self.assertEqual(self.client.post("/api/qr/parse", json={"payload": "https://example.com"}).status_code, 422)

    def test_upi_qr_missing_invalid_and_optional_fields_are_reported(self) -> None:
        missing_identifier = self.client.post(
            "/api/qr/parse", json={"payload": "upi://pay?pn=Shop&am=25"}
        )
        self.assertEqual(missing_identifier.status_code, 200, missing_identifier.text)
        self.assertFalse(missing_identifier.json()["upi_id_valid"])
        self.assertIsNone(missing_identifier.json()["recipient_identifier"])
        self.assertIn("UPI identifier is missing.", missing_identifier.json()["validation_warnings"])

        invalid_identifier = self.client.post(
            "/api/qr/parse", json={"payload": "upi://pay?pa=not-a-vpa&pn=Shop"}
        )
        self.assertEqual(invalid_identifier.status_code, 200, invalid_identifier.text)
        self.assertFalse(invalid_identifier.json()["upi_id_valid"])
        self.assertIsNone(invalid_identifier.json()["amount"])
        self.assertIn("UPI identifier format is invalid.", invalid_identifier.json()["validation_warnings"])

        malformed = self.client.post(
            "/api/qr/parse", json={"payload": "upi://pay?pa=shop%40upi&am=1.234"}
        )
        self.assertEqual(malformed.status_code, 422)
        ambiguous = self.client.post(
            "/api/qr/parse", json={"payload": "upi://pay?pa=shop%40upi&pa=other%40upi"}
        )
        self.assertEqual(ambiguous.status_code, 422)

    def test_qr_bharatcode_explanation_uses_structured_data_and_surfaces_failures(self) -> None:
        recipient = self.create_recipient(
            name="Known Shop", recipient_type="merchant", identifier="known@upi"
        )
        request = {
            "payload": "upi://pay?pa=known%40upi&pn=Known%20Shop&am=25&mc=5411&tr=REF-BC-1",
            "expected_recipient_id": recipient["id"],
            "expected_amount": 25,
        }
        explanation = main.json.dumps({
            "explanation": "The details match the selected local record, but are not externally verified.",
            "recommended_action": "Verify the payee independently.",
        })
        with patch.object(main, "call_bharatcode", new=AsyncMock(return_value=explanation)) as model:
            response = self.client.post("/api/qr/explain", json=request)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("not externally verified", response.json()["explanation"])
        prompt = model.call_args.args[1]
        self.assertIn("known@upi", prompt)
        self.assertIn("5411", prompt)
        self.assertNotIn(request["payload"], prompt)

        with patch.object(
            main, "call_bharatcode",
            new=AsyncMock(side_effect=main.HTTPException(status_code=503, detail="BharatCode unavailable.")),
        ):
            unavailable = self.client.post("/api/qr/explain", json=request)
        self.assertEqual(unavailable.status_code, 503)
        self.assertIn("BharatCode unavailable", unavailable.json()["detail"])

        with patch.object(main, "call_bharatcode", new=AsyncMock(return_value='{"explanation":""}')):
            invalid = self.client.post("/api/qr/explain", json=request)
        self.assertEqual(invalid.status_code, 502)

    def test_qr_risk_compares_recipient_amount_saved_name_and_duplicate_reference(self) -> None:
        recipient = self.create_recipient(
            name="Known Shop", recipient_type="merchant", identifier="known@upi"
        )
        self.client.post(f"/api/payment-recipients/{recipient['id']}/verify")
        prepared = self.prepare(
            recipient_id=recipient["id"],
            category="qr_payment",
            amount=125,
            order_reference="QR-REF-01",
            qr_recipient_identifier="known@upi",
            qr_amount=125,
            qr_payee_name="Known Shop",
            qr_merchant_code="5411",
            qr_transaction_reference="QR-REF-01",
            key="qr-persist-001",
        )
        self.assertEqual(prepared.status_code, 201, prepared.text)
        self.assertEqual(prepared.json()["qr_transaction_reference"], "QR-REF-01")
        self.assertEqual(prepared.json()["qr_merchant_code"], "5411")

        assessment = self.client.post("/api/qr/assess", json={
            "payload": "upi://pay?pa=changed%40upi&pn=Known%20Shop&am=150&tr=QR-REF-01",
            "expected_recipient_id": recipient["id"],
            "expected_amount": 200,
            "payment_date": date.today().isoformat(),
            "category": "qr_payment",
        })
        self.assertEqual(assessment.status_code, 200, assessment.text)
        risk = assessment.json()["risk"]
        evidence_types = {item["type"] for item in risk["evidence"]}
        self.assertIn("recipient_mismatch", evidence_types)
        self.assertIn("qr_amount_mismatch", evidence_types)
        self.assertIn("duplicate_qr_reference", evidence_types)
        self.assertIn("saved_name_identifier_conflict", evidence_types)
        self.assertTrue(risk["duplicate_blocked"])
        self.assertGreaterEqual(risk["score"], 60)

        duplicate = self.prepare(
            recipient_id=recipient["id"],
            category="qr_payment",
            amount=150,
            order_reference="QR-REF-01",
            qr_recipient_identifier="changed@upi",
            qr_amount=150,
            qr_transaction_reference="QR-REF-01",
            key="qr-persist-duplicate",
        )
        self.assertEqual(duplicate.status_code, 409)
        transactions = self.client.get("/api/transactions", params={"category": "qr_payment"})
        self.assertEqual(transactions.status_code, 200)
        self.assertEqual(len(transactions.json()), 1)
        persisted = self.client.get("/api/universal-payment-requests?category=qr_payment")
        self.assertEqual(persisted.json()[0]["id"], prepared.json()["id"])

    def test_risk_flags_anomalous_amount_and_mismatched_recipient_type(self) -> None:
        self.client.post(f"/api/payment-recipients/{self.recipient['id']}/verify")
        first = self.prepare(amount=100, key="anomaly-payment-001")
        self.assertEqual(self.approve(first.json()["id"]).json()["status"], "succeeded")
        next_payment = self.prepare(amount=300, key="anomaly-payment-002")
        self.assertEqual(next_payment.status_code, 201, next_payment.text)
        evidence = next_payment.json()["risk"]["evidence"]
        self.assertIn("amount_anomaly", {item["type"] for item in evidence})

    def test_qr_recipient_and_amount_mismatches_are_scored_and_persisted(self) -> None:
        prepared = self.prepare(
            category="qr_payment",
            amount=100,
            qr_recipient_identifier="shop@upi",
            qr_amount=125,
            key="qr-mismatch-payment",
        )
        self.assertEqual(prepared.status_code, 201, prepared.text)
        record = prepared.json()
        evidence = {item["type"] for item in record["risk"]["evidence"]}
        self.assertIn("qr_recipient_mismatch", evidence)
        self.assertIn("qr_amount_mismatch", evidence)
        self.assertEqual(record["qr_recipient_identifier"], "shop@upi")
        self.assertEqual(record["qr_amount"], 125)

        non_qr_category = self.prepare(
            category="person_to_person",
            qr_recipient_identifier="shop@upi",
            key="non-qr-with-qr-details",
        )
        self.assertEqual(non_qr_category.status_code, 201, non_qr_category.text)
        invalid_identifier = self.prepare(
            category="qr_payment",
            qr_recipient_identifier="not-a-vpa",
            key="invalid-qr-identifier",
        )
        self.assertEqual(invalid_identifier.status_code, 422)
        missing_identifier = self.prepare(
            category="qr_payment",
            key="missing-qr-identifier",
        )
        self.assertEqual(missing_identifier.status_code, 422)

    def test_universal_payment_risk_endpoint_scores_saved_recipient_and_requires_qr_details(self) -> None:
        payload = {
            "recipient_id": self.recipient["id"],
            "category": "person_to_person",
            "amount": 2000,
            "currency": "INR",
            "purpose": "Test transfer",
            "payment_date": date.today().isoformat(),
        }
        risk = self.client.post("/api/universal-payment-risk", json=payload)
        self.assertEqual(risk.status_code, 200, risk.text)
        self.assertEqual(risk.json()["score"], 25)
        self.assertIn(
            "new_or_unverified_recipient",
            {item["type"] for item in risk.json()["evidence"]},
        )
        self.assertIn(
            "insufficient_history",
            {item["type"] for item in risk.json()["evidence"]},
        )

        missing_qr = self.client.post(
            "/api/universal-payment-risk",
            json={**payload, "category": "qr_payment"},
        )
        self.assertEqual(missing_qr.status_code, 422)
        valid_qr = self.client.post(
            "/api/universal-payment-risk",
            json={
                **payload,
                "category": "qr_payment",
                "qr_recipient_identifier": "other@upi",
                "qr_payee_name": "Asha",
            },
        )
        self.assertEqual(valid_qr.status_code, 200, valid_qr.text)
        qr_evidence = {item["type"] for item in valid_qr.json()["evidence"]}
        self.assertIn("qr_recipient_mismatch", qr_evidence)

    def test_merchant_burst_and_subscription_amount_change_use_category_history(self) -> None:
        merchant = self.create_recipient(
            name="Shop", recipient_type="merchant", identifier="shop@example"
        )
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        for index, amount in enumerate((100, 101, 102), start=1):
            previous = self.prepare(
                recipient_id=merchant["id"],
                category="merchant",
                amount=amount,
                payment_date=yesterday,
                order_reference=f"ORDER-{index}",
                key=f"merchant-history-{index}",
            )
            self.assertEqual(previous.status_code, 201, previous.text)
        merchant_burst = self.prepare(
            recipient_id=merchant["id"],
            category="merchant",
            amount=500,
            order_reference="ORDER-CURRENT",
            key="merchant-burst-current",
        )
        merchant_evidence = {item["type"] for item in merchant_burst.json()["risk"]["evidence"]}
        self.assertIn("unusual_merchant_activity", merchant_evidence)

        service = self.create_recipient(
            name="Video Service", recipient_type="service", identifier="video@example"
        )
        for index, previous_date in enumerate(
            (date.today() - timedelta(days=60), date.today() - timedelta(days=30)),
            start=1,
        ):
            previous = self.prepare(
                recipient_id=service["id"],
                category="subscription",
                amount=100,
                payment_date=previous_date.isoformat(),
                recurrence="monthly",
                key=f"subscription-history-{index}",
            )
            self.assertEqual(previous.status_code, 201, previous.text)
        changed_subscription = self.prepare(
            recipient_id=service["id"],
            category="subscription",
            amount=160,
            recurrence="monthly",
            key="subscription-current",
        )
        subscription_evidence = {
            item["type"] for item in changed_subscription.json()["risk"]["evidence"]
        }
        self.assertIn("subscription_amount_change", subscription_evidence)
        self.assertNotIn("amount_anomaly", subscription_evidence)


class BharatCodeClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_completion_uses_configured_model_store_and_backend_key(self) -> None:
        body = main.json.dumps({
            "choices": [{"message": {"content": '{"action":"none"}'}, "finish_reason": "stop"}],
        }).encode()
        response = Mock()
        response.status = 200
        response.read.return_value = body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.dict("os.environ", {
            "BHARATCODE_API_KEY": "secret-test-key",
            "BHARATCODE_BASE_URL": "https://example.test/api/model/v1",
            "BHARATCODE_MODEL": "qwen-test",
        }), patch("main.urllib.request.urlopen", return_value=response) as urlopen:
            result = await main.call_bharatcode("system", "user")
        self.assertEqual(result, '{"action":"none"}')
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.test/api/model/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-test-key")
        payload = main.json.loads(request.data)
        self.assertEqual(payload["model"], "qwen-test")
        self.assertFalse(payload["store"])
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertTrue(request.get_header("X-request-id"))
        self.assertEqual(payload["messages"], [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "user"},
        ])

    async def test_bharatcode_rejects_incomplete_response(self) -> None:
        body = main.json.dumps({"choices": []}).encode()
        response = Mock()
        response.status = 200
        response.read.return_value = body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.dict("os.environ", {"BHARATCODE_API_KEY": "test-key"}), \
                patch("main.urllib.request.urlopen", return_value=response):
            with self.assertRaises(main.HTTPException) as raised:
                await main.call_bharatcode("system", "user")
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("incomplete response", raised.exception.detail)

    async def test_bharatcode_rejects_truncated_completion(self) -> None:
        body = main.json.dumps({
            "choices": [{"message": {"content": '{"action":'}, "finish_reason": "length"}],
        }).encode()
        response = Mock()
        response.status = 200
        response.read.return_value = body
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.dict("os.environ", {"BHARATCODE_API_KEY": "test-key"}), \
                patch("main.urllib.request.urlopen", return_value=response):
            with self.assertRaises(main.HTTPException) as raised:
                await main.call_bharatcode("system", "user")
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("incomplete", raised.exception.detail)

    async def test_missing_api_key_and_timeout_fail_clearly(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(main.HTTPException) as missing_key:
                await main.call_bharatcode("system", "user")
        self.assertEqual(missing_key.exception.status_code, 503)
        self.assertIn("BHARATCODE_API_KEY", missing_key.exception.detail)

        with (
            patch.dict("os.environ", {"BHARATCODE_API_KEY": "test-key"}),
            patch("main.urllib.request.urlopen", side_effect=TimeoutError()),
        ):
            with self.assertRaises(main.HTTPException) as timeout:
                await main.call_bharatcode("system", "user")
        self.assertEqual(timeout.exception.status_code, 504)
        self.assertIn("did not respond before the request timed out", timeout.exception.detail)
        self.assertIn("Nothing was saved or paid", timeout.exception.detail)

    async def test_provider_http_errors_are_actionable_and_do_not_leak_body(self) -> None:
        expected_fragments = {
            400: "request format",
            401: "API key",
            403: "not permitted",
            429: "rate limit",
            503: "temporarily unavailable",
        }
        with patch.dict("os.environ", {"BHARATCODE_API_KEY": "test-key"}):
            for status, expected in expected_fragments.items():
                with self.subTest(status=status):
                    error = HTTPError(
                        "https://example.test/chat/completions",
                        status,
                        "provider failure",
                        {},
                        BytesIO(b"private account details"),
                    )
                    with patch("main.urllib.request.urlopen", side_effect=error):
                        with self.assertRaises(main.HTTPException) as raised:
                            await main.call_bharatcode("system", "user")
                    self.assertEqual(raised.exception.status_code, 502)
                    self.assertIn(expected, raised.exception.detail)
                    self.assertNotIn("private account details", raised.exception.detail)

    async def test_missing_key_short_circuits_and_key_is_not_logged_or_returned(self) -> None:
        with patch.dict("os.environ", {}, clear=True), \
                patch("main.urllib.request.urlopen") as urlopen:
            with self.assertRaises(main.HTTPException) as raised:
                await main.call_bharatcode("system", "user")
        self.assertEqual(raised.exception.status_code, 503)
        urlopen.assert_not_called()

        secret = "secret-that-must-not-leak"
        error = HTTPError(
            "https://example.test/chat/completions",
            401,
            "provider failure",
            {},
            BytesIO(b"private account details"),
        )
        with patch.dict("os.environ", {"BHARATCODE_API_KEY": secret}), \
                patch("main.urllib.request.urlopen", side_effect=error):
            with self.assertLogs("main", level="WARNING") as logs:
                with self.assertRaises(main.HTTPException) as raised:
                    await main.call_bharatcode("system", "user")
        self.assertNotIn(secret, raised.exception.detail)
        self.assertNotIn(secret, "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
