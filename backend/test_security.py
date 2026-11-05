import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main


class AssistantSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_patch = patch.object(
            main, "DATABASE_PATH", Path(self.temp_dir.name) / "security.sqlite3"
        )
        self.database_patch.start()
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        self.client.close()
        self.database_patch.stop()
        self.temp_dir.cleanup()

    def test_anonymous_session_sets_http_only_session_and_csrf_cookie(self) -> None:
        response = self.client.get("/api/session")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["csrf_token"])
        set_cookie = response.headers.get("set-cookie", "")
        self.assertIn(f"{main.SESSION_COOKIE}=", set_cookie)
        self.assertIn(f"{main.CSRF_COOKIE}=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)

    def test_cross_origin_state_change_requires_csrf_token(self) -> None:
        self.client.get("/api/session")
        response = self.client.post(
            "/api/assistant/interpret",
            headers={"Origin": "https://payguard.example"},
            json={"messages": [{"role": "user", "content": "What is upcoming?"}]},
        )
        self.assertEqual(response.status_code, 403)

    def test_assistant_proposal_requires_matching_token_and_is_single_use(self) -> None:
        session = self.client.get("/api/session").json()
        model_response = (
            '{"action":"create_payment_rule","message":"Review it.","recipient":"Electricity",'
            '"rule_id":null,"amount":100,"maximum_limit":120,"currency":"INR",'
            '"frequency":"monthly","payment_day":1,"start_date":"2026-11-05",'
            '"reminder_due_date":null,"recipient_id":null,"payment_category":null,'
            '"purpose":null,"payment_date":null,"order_reference":null,"recurrence":null,'
            '"qr_recipient_identifier":null}'
        )
        with patch.object(main, "call_bharatcode", new=AsyncMock(return_value=model_response)):
            interpreted = self.client.post(
                "/api/assistant/interpret",
                json={"messages": [{"role": "user", "content": "Create my electricity rule."}]},
            )
        self.assertEqual(interpreted.status_code, 200, interpreted.text)
        proposal = interpreted.json()["proposal"]
        self.assertTrue(proposal["proposal_id"])
        self.assertTrue(proposal["confirmation_token"])

        invalid = self.client.post(
            "/api/assistant/confirm",
            json={
                "proposal_id": proposal["proposal_id"],
                "confirmation_token": "invalid-token-value-that-is-long-enough",
            },
        )
        self.assertEqual(invalid.status_code, 403)

        confirmed = self.client.post(
            "/api/assistant/confirm",
            headers={"Origin": "https://payguard.example", "X-CSRF-Token": session["csrf_token"]},
            json={
                "proposal_id": proposal["proposal_id"],
                "confirmation_token": proposal["confirmation_token"],
            },
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertEqual(confirmed.json()["action"], "create_payment_rule")
        self.assertEqual(len(self.client.get("/api/payments/rules").json()), 1)

        replay = self.client.post(
            "/api/assistant/confirm",
            json={
                "proposal_id": proposal["proposal_id"],
                "confirmation_token": proposal["confirmation_token"],
            },
        )
        self.assertEqual(replay.status_code, 409)
        self.assertEqual(len(self.client.get("/api/payments/rules").json()), 1)

    def test_expired_proposal_is_rejected(self) -> None:
        session = self.client.get("/api/session").json()
        model_response = (
            '{"action":"set_bill_reminder","message":"Review it.","recipient":"Internet",'
            '"rule_id":null,"amount":null,"maximum_limit":null,"currency":null,'
            '"frequency":null,"payment_day":null,"start_date":null,"reminder_due_date":"2026-12-10",'
            '"recipient_id":null,"payment_category":null,"purpose":null,"payment_date":null,'
            '"order_reference":null,"recurrence":null,"qr_recipient_identifier":null}'
        )
        with patch.object(main, "call_bharatcode", new=AsyncMock(return_value=model_response)):
            interpreted = self.client.post(
                "/api/assistant/interpret",
                json={"messages": [{"role": "user", "content": "Remind me about internet."}]},
            )
        proposal = interpreted.json()["proposal"]
        with main.database_connection() as connection:
            connection.execute(
                "UPDATE assistant_proposals SET expires_at = ? WHERE id = ?",
                ("2000-01-01T00:00:00+00:00", proposal["proposal_id"]),
            )
        expired = self.client.post(
            "/api/assistant/confirm",
            headers={"Origin": "https://payguard.example", "X-CSRF-Token": session["csrf_token"]},
            json={
                "proposal_id": proposal["proposal_id"],
                "confirmation_token": proposal["confirmation_token"],
            },
        )
        self.assertEqual(expired.status_code, 410)


if __name__ == "__main__":
    unittest.main()
