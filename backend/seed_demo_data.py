"""Seed and reset the isolated, fictional Build League demo database."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

import main


DEMO_DATABASE_PATH = Path(
    os.getenv(
        "PAYGUARD_DATABASE_PATH",
        str(Path(__file__).resolve().parent / "payguard-demo.sqlite3"),
    )
).resolve()
DEMO_OWNER = "payguard-fictional-demo"
DEMO_VERSION = "2026-11-v2"
DEMO_PREFIX = "demo-"
DEMO_VERIFIED_PROVIDERS = (
    "demo · fictional electricity co.",
    "demo · fictional internet co.",
    "demo · fictional water utility",
)

TABLE_ID_COLUMNS = {
    "payment_rules": "id",
    "bill_reminders": "id",
    "bills": "id",
    "payment_recipients": "id",
    "universal_payment_requests": "id",
    "universal_payment_events": "id",
    "finance_budgets": "id",
    "payment_requests": "id",
    "payment_events": "id",
    "support_requests": "id",
}


def _database(path: Path):
    class DatabaseContext:
        def __enter__(self) -> sqlite3.Connection:
            path.parent.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(path)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA foreign_keys = ON")
            return self.connection

        def __exit__(self, exception_type, exception, traceback) -> bool:
            if exception_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
            self.connection.close()
            return False

    return DatabaseContext()


def _with_demo_database(path: Path):
    class DatabasePatch:
        def __enter__(self):
            self.patch = patch.object(main, "DATABASE_PATH", path)
            self.patch.start()
            main.initialize_payments_database()
            return self

        def __exit__(self, exception_type, exception, traceback):
            self.patch.stop()
            return False

    return DatabasePatch()


def _metadata(connection: sqlite3.Connection) -> dict[str, str]:
    tables = {
        row["name"] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if "demo_metadata" not in tables:
        return {}
    return {
        row["key"]: row["value"]
        for row in connection.execute("SELECT key, value FROM demo_metadata").fetchall()
    }


def _assert_demo_database(connection: sqlite3.Connection) -> dict[str, str]:
    metadata = _metadata(connection)
    if metadata.get("dataset_owner") != DEMO_OWNER:
        raise RuntimeError(
            "Refusing to modify this database: its fictional-demo ownership marker is missing."
        )
    return metadata


def _count_non_demo_rows(connection: sqlite3.Connection) -> dict[str, int]:
    non_demo: dict[str, int] = {}
    for table, id_column in TABLE_ID_COLUMNS.items():
        count = connection.execute(
            f'SELECT COUNT(*) FROM "{table}" WHERE "{id_column}" NOT LIKE ?',
            (f"{DEMO_PREFIX}%",),
        ).fetchone()[0]
        if count:
            non_demo[table] = count
    placeholders = ", ".join("?" for _ in DEMO_VERIFIED_PROVIDERS)
    verified = connection.execute(
        f"SELECT COUNT(*) FROM verified_recipients WHERE normalized_name NOT IN ({placeholders})",
        DEMO_VERIFIED_PROVIDERS,
    ).fetchone()[0]
    if verified:
        non_demo["verified_recipients"] = verified
    return non_demo


def _ensure_no_mixed_records(connection: sqlite3.Connection) -> None:
    non_demo = _count_non_demo_rows(connection)
    if non_demo:
        raise RuntimeError(
            "The dedicated demo database contains records not owned by the demo seeder "
            f"({non_demo}). Seed/reset was stopped to preserve them."
        )


def _counts(connection: sqlite3.Connection) -> dict[str, int]:
    result = {}
    for table in (
        "bills",
        "payment_recipients",
        "universal_payment_requests",
        "payment_rules",
        "finance_budgets",
    ):
        result[table] = connection.execute(
            f'SELECT COUNT(*) FROM "{table}" WHERE id LIKE ?',
            (f"{DEMO_PREFIX}%",),
        ).fetchone()[0]
    return result


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _insert_payment(
    connection: sqlite3.Connection,
    payment: dict[str, Any],
    recipient: dict[str, Any],
    history: list[dict[str, Any]],
    created_at: str,
) -> None:
    risk_payment = {
        **payment,
        "recipient_identifier": recipient["identifier"],
        "account_reference": recipient["account_reference"],
    }
    risk = main.assess_universal_payment_risk(risk_payment, recipient, history)
    connection.execute(
        """
        INSERT INTO universal_payment_requests (
            id, recipient_id, idempotency_key, category, recipient_name, recipient_type,
            recipient_identifier, account_reference, qr_recipient_identifier, qr_amount,
            qr_payee_name, qr_merchant_code, qr_transaction_reference, amount, currency,
            purpose, payment_date, order_reference, recurrence, payment_method,
            approval_status, status, risk_score, risk_level, risk_evidence,
            provider_reference, error_code, error_message, created_at, updated_at
        ) VALUES (
            :id, :recipient_id, :idempotency_key, :category, :recipient_name, :recipient_type,
            :recipient_identifier, :account_reference, :qr_recipient_identifier, :qr_amount,
            :qr_payee_name, :qr_merchant_code, :qr_transaction_reference, :amount, :currency,
            :purpose, :payment_date, :order_reference, :recurrence, :payment_method,
            :approval_status, :status, :risk_score, :risk_level, :risk_evidence,
            :provider_reference, :error_code, :error_message, :created_at, :updated_at
        )
        """,
        {
            **payment,
            "recipient_name": recipient["name"],
            "recipient_type": recipient["recipient_type"],
            "recipient_identifier": recipient["identifier"],
            "account_reference": recipient["account_reference"],
            "risk_score": risk["score"],
            "risk_level": risk["level"],
            "risk_evidence": json.dumps(risk["evidence"], separators=(",", ":")),
            "created_at": created_at,
            "updated_at": created_at,
        },
    )
    connection.execute(
        """
        INSERT INTO universal_payment_events (id, payment_id, previous_status, new_status, detail, created_at)
        VALUES (?, ?, NULL, ?, ?, ?)
        """,
        (
            f"demo-event-{payment['id']}",
            payment["id"],
            payment["status"],
            "FICTIONAL DEMO · Seeded sandbox status; no payment provider was contacted.",
            created_at,
        ),
    )
    history.append({**recipient, **payment, "recipient_id": recipient["id"]})


def _insert_demo_records(connection: sqlite3.Connection) -> None:
    today = date.today()
    now = datetime.now(timezone.utc).replace(microsecond=0)

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS demo_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )

    recipient_records = [
        ("demo-recipient-rahul", "DEMO · Rahul Example", "person", "DEMO-RAHUL-01", "DEMO-ACCOUNT-RAHUL", 1),
        ("demo-recipient-shop", "DEMO · Sample Shop", "merchant", "DEMO-MERCHANT-01", "DEMO-ORDER-ACCOUNT-01", 1),
        ("demo-recipient-subscription", "DEMO · Stream Service", "service", "DEMO-SUBSCRIPTION-01", "DEMO-SERVICE-01", 1),
        ("demo-recipient-electricity", "DEMO · Fictional Electricity Co.", "utility", "DEMO-UTILITY-ELEC-01", "DEMO-ACCOUNT-ELEC", 1),
        ("demo-recipient-internet", "DEMO · Fictional Internet Co.", "service", "DEMO-UTILITY-NET-01", "DEMO-ACCOUNT-NET", 1),
        ("demo-recipient-new-merchant", "DEMO · New Merchant Example", "merchant", "DEMO-NEW-MERCHANT-01", "DEMO-ACCOUNT-NEW", 0),
        ("demo-recipient-first-payment", "DEMO · First-Time Local Service", "other", "DEMO-FIRST-SERVICE-01", "DEMO-ACCOUNT-FIRST", 1),
        ("demo-recipient-qr", "DEMO · Sample QR Merchant", "merchant", "demo.qr@fictional", "DEMO-QR-ACCOUNT", 1),
        ("demo-recipient-water", "DEMO · Fictional Water Utility", "utility", "DEMO-UTILITY-WATER-01", "DEMO-ACCOUNT-WATER", 1),
    ]
    recipients: dict[str, dict[str, Any]] = {}
    for item in recipient_records:
        recipient_id, name, recipient_type, identifier, account_reference, is_verified = item
        timestamp = now.isoformat()
        connection.execute(
            """
            INSERT INTO payment_recipients (
                id, name, recipient_type, identifier, account_reference, is_verified,
                details_changed, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (recipient_id, name, recipient_type, identifier, account_reference, is_verified, timestamp, timestamp),
        )
        recipients[recipient_id] = {
            "id": recipient_id,
            "name": name,
            "recipient_type": recipient_type,
            "identifier": identifier,
            "account_reference": account_reference,
            "is_verified": bool(is_verified),
            "details_changed": False,
        }

    bills = [
        ("demo-bill-electricity", "DEMO · Fictional Electricity Co.", 2450, "DEMO-ELECTRICITY-2026-11", "DEMO-ACCOUNT-ELEC", today + timedelta(days=8)),
        ("demo-bill-electricity-duplicate", "DEMO · Fictional Electricity Co.", 2450, "DEMO-ELECTRICITY-2026-11", "DEMO-ACCOUNT-ELEC", today + timedelta(days=8)),
        ("demo-bill-internet", "DEMO · Fictional Internet Co.", 999, "DEMO-INTERNET-2026-11", "DEMO-ACCOUNT-NET", today + timedelta(days=5)),
        ("demo-bill-water", "DEMO · Fictional Water Utility", 650, "DEMO-WATER-2026-11", "DEMO-ACCOUNT-WATER", today + timedelta(days=12)),
    ]
    for index, (bill_id, provider, amount, invoice, account, due_date) in enumerate(bills):
        created_at = (now + timedelta(seconds=index)).isoformat()
        connection.execute(
            """
            INSERT INTO bills (
                id, provider_name, customer_name, bill_amount, tax_amount, currency,
                billing_date, due_date, invoice_number, account_reference, units_consumed,
                billing_period, document_type, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, 'INR', ?, ?, ?, ?, NULL, ?, 'utility_bill', ?, ?)
            """,
            (
                bill_id,
                provider,
                "DEMO · Fictional Build League User",
                amount,
                today.replace(day=1).isoformat(),
                due_date.isoformat(),
                invoice,
                account,
                today.strftime("%B %Y"),
                created_at,
                created_at,
            ),
        )

    for bill_id, provider in (
        ("demo-bill-electricity", "DEMO · Fictional Electricity Co."),
        ("demo-bill-internet", "DEMO · Fictional Internet Co."),
        ("demo-bill-water", "DEMO · Fictional Water Utility"),
    ):
        normalized = main.normalize_name(provider)
        connection.execute(
            """
            INSERT INTO verified_recipients (normalized_name, provider_name, confirmed_at)
            VALUES (?, ?, ?)
            """,
            (normalized, provider, now.isoformat()),
        )

    rules = [
        ("demo-rule-electricity", "DEMO · Fictional Electricity Co.", 2450, 3000, 15, 1),
        ("demo-rule-internet", "DEMO · Fictional Internet Co.", 999, 1500, 20, 1),
        ("demo-rule-paused-water", "DEMO · Fictional Water Utility", 650, 1000, 25, 0),
    ]
    for rule_id, recipient, amount, limit, payment_day, active in rules:
        connection.execute(
            """
            INSERT INTO payment_rules (
                id, recipient, amount, maximum_limit, frequency, payment_date, start_date,
                is_active, details_changed, recipient_changed, currency, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'monthly', ?, ?, ?, 0, 0, 'INR', ?, ?)
            """,
            (
                rule_id,
                recipient,
                amount,
                limit,
                payment_day,
                today.isoformat(),
                int(active),
                now.isoformat(),
                now.isoformat(),
            ),
        )

    budgets = [
        ("demo-budget-all", "all", 10000),
        ("demo-budget-merchant", "merchant", 6000),
        ("demo-budget-subscription", "subscription", 1000),
    ]
    for budget_id, category, limit in budgets:
        connection.execute(
            """
            INSERT INTO finance_budgets (id, category, currency, monthly_limit, created_at, updated_at)
            VALUES (?, ?, 'INR', ?, ?, ?)
            """,
            (budget_id, category, limit, now.isoformat(), now.isoformat()),
        )

    history: list[dict[str, Any]] = []
    payment_records = [
        ("demo-payment-p2p", "demo-recipient-rahul", "person_to_person", 1200, today - timedelta(days=2), "succeeded", "approved", None, None, "sandbox_simulator", None, None, None, None, None, None, None),
        ("demo-payment-shopping", "demo-recipient-shop", "merchant", 3499, today - timedelta(days=3), "succeeded", "approved", None, None, "card", None, None, None, "DEMO-ORDER-SHOP-01", None, None, None),
        ("demo-payment-subscription", "demo-recipient-subscription", "subscription", 499, today - timedelta(days=1), "succeeded", "approved", None, None, "card", None, None, None, None, "monthly", None, None),
        ("demo-payment-electricity-settled", "demo-recipient-electricity", "utility_bill", 2450, today, "succeeded", "approved", None, None, "sandbox_simulator", None, None, None, None, None, None, None),
        ("demo-payment-electricity-pending", "demo-recipient-electricity", "utility_bill", 2450, today, "prepared", "awaiting_approval", None, None, "sandbox_simulator", None, None, None, None, None, None, None),
        ("demo-payment-internet-failed", "demo-recipient-internet", "utility_bill", 999, today - timedelta(days=1), "failed", "approved", "SANDBOX_DEMO_FAILURE", "FICTIONAL DEMO · Simulated failure; no provider was contacted.", "sandbox_simulator", None, None, None, None, None, None, None),
        ("demo-payment-water-pending", "demo-recipient-water", "utility_bill", 650, today - timedelta(days=1), "pending", "approved", None, "FICTIONAL DEMO · Simulated provider-pending state; no provider was contacted.", "sandbox_simulator", None, None, None, None, None, None, None),
        ("demo-payment-new-merchant-baseline", "demo-recipient-new-merchant", "merchant", 1500, today - timedelta(days=10), "succeeded", "approved", None, None, "card", None, None, None, "DEMO-ORDER-NEW-01", None, None, None),
        ("demo-payment-unusual-high-value", "demo-recipient-new-merchant", "merchant", 15000, today + timedelta(days=1), "prepared", "awaiting_approval", None, None, "card", None, None, None, "DEMO-ORDER-HIGH-01", None, None, None),
        ("demo-payment-insufficient-history", "demo-recipient-first-payment", "everyday", 350, today + timedelta(days=2), "prepared", "awaiting_approval", None, None, "sandbox_simulator", None, None, None, None, None, None, None),
        ("demo-payment-qr", "demo-recipient-qr", "qr_payment", 250, today + timedelta(days=3), "prepared", "awaiting_approval", None, None, "upi_qr", "demo.qr@fictional", 250, "DEMO · Sample QR Merchant", "DEMO-QR-01", "DEMO-QR-01", None, None),
    ]
    for index, record in enumerate(payment_records):
        (
            payment_id, recipient_id, category, amount, payment_date, status, approval_status,
            error_code, error_message, payment_method, qr_identifier, qr_amount, qr_name,
            qr_reference, order_reference, recurrence, _unused,
        ) = record
        recipient = recipients[recipient_id]
        payment = {
            "id": payment_id,
            "recipient_id": recipient_id,
            "idempotency_key": f"demo-idempotency-{payment_id}",
            "category": category,
            "amount": amount,
            "currency": "INR",
            "purpose": f"FICTIONAL DEMO · {category.replace('_', ' ')} example",
            "payment_date": payment_date.isoformat(),
            "order_reference": order_reference,
            "recurrence": recurrence,
            "payment_method": payment_method,
            "approval_status": approval_status,
            "status": status,
            "provider_reference": (
                f"DEMO-SBX-{payment_id.upper()}" if status == "succeeded" else None
            ),
            "error_code": error_code,
            "error_message": error_message,
            "qr_recipient_identifier": qr_identifier,
            "qr_amount": qr_amount,
            "qr_payee_name": qr_name,
            "qr_merchant_code": "DEMO-QR-MERCHANT" if qr_identifier else None,
            "qr_transaction_reference": qr_reference,
        }
        _insert_payment(
            connection,
            payment,
            recipient,
            history,
            (now + timedelta(seconds=10 + index)).isoformat(),
        )

    connection.execute(
        "INSERT INTO demo_metadata (key, value) VALUES ('dataset_owner', ?)",
        (DEMO_OWNER,),
    )
    connection.execute(
        "INSERT INTO demo_metadata (key, value) VALUES ('dataset_version', ?)",
        (DEMO_VERSION,),
    )
    connection.execute(
        "INSERT INTO demo_metadata (key, value) VALUES ('label', 'FICTIONAL DEMO DATA · SANDBOX ONLY')"
    )


def seed_demo_data(database_path: Path = DEMO_DATABASE_PATH) -> dict[str, Any]:
    database_path = database_path.resolve()
    if database_path.name != "payguard-demo.sqlite3":
        raise RuntimeError("The seeder only accepts a dedicated payguard-demo.sqlite3 database.")
    with _with_demo_database(database_path):
        with _database(database_path) as connection:
            metadata = _metadata(connection)
            if metadata:
                _assert_demo_database(connection)
                _ensure_no_mixed_records(connection)
                if metadata.get("dataset_version") == DEMO_VERSION:
                    return {"seeded": False, "reason": "already_current", "counts": _counts(connection)}
                raise RuntimeError(
                    "The demo database contains an older dataset version. "
                    "Use reset --confirm before reseeding it."
                )
            else:
                _ensure_no_mixed_records(connection)
            _insert_demo_records(connection)
            return {"seeded": True, "reason": "created", "counts": _counts(connection)}


def _delete_demo_records(connection: sqlite3.Connection) -> dict[str, int]:
    _assert_demo_database(connection)
    before = _counts(connection)
    connection.execute(
        "DELETE FROM payment_events WHERE payment_request_id IN "
        "(SELECT id FROM payment_requests WHERE id LIKE 'demo-%') AND id LIKE 'demo-%'"
    )
    connection.execute("DELETE FROM payment_requests WHERE id LIKE 'demo-%'")
    connection.execute(
        "DELETE FROM universal_payment_events WHERE id LIKE 'demo-%' AND payment_id LIKE 'demo-%'"
    )
    connection.execute("DELETE FROM universal_payment_requests WHERE id LIKE 'demo-%'")
    connection.execute("DELETE FROM bills WHERE id LIKE 'demo-%'")
    connection.execute("DELETE FROM payment_recipients WHERE id LIKE 'demo-%'")
    connection.execute("DELETE FROM payment_rules WHERE id LIKE 'demo-%'")
    connection.execute("DELETE FROM bill_reminders WHERE id LIKE 'demo-%'")
    connection.execute("DELETE FROM finance_budgets WHERE id LIKE 'demo-%'")
    placeholders = ", ".join("?" for _ in DEMO_VERIFIED_PROVIDERS)
    connection.execute(
        f"DELETE FROM verified_recipients WHERE normalized_name IN ({placeholders})",
        DEMO_VERIFIED_PROVIDERS,
    )
    connection.execute("DELETE FROM demo_metadata")
    connection.execute("DROP TABLE demo_metadata")
    return before


def reset_demo_data(
    database_path: Path = DEMO_DATABASE_PATH,
    *,
    confirm: bool = False,
) -> dict[str, int]:
    if not confirm:
        raise RuntimeError("Reset requires the explicit --confirm flag.")
    database_path = database_path.resolve()
    if database_path.name != "payguard-demo.sqlite3":
        raise RuntimeError("Reset only accepts the dedicated payguard-demo.sqlite3 database.")
    if not database_path.exists():
        return {"bills": 0, "payment_recipients": 0, "universal_payment_requests": 0, "payment_rules": 0, "finance_budgets": 0}
    with _with_demo_database(database_path):
        with _database(database_path) as connection:
            _assert_demo_database(connection)
            return _delete_demo_records(connection)


def verify_demo_data(database_path: Path = DEMO_DATABASE_PATH) -> dict[str, Any]:
    database_path = database_path.resolve()
    if database_path.name != "payguard-demo.sqlite3" or not database_path.exists():
        raise RuntimeError("The dedicated fictional demo database has not been seeded.")
    with _with_demo_database(database_path):
        with _database(database_path) as connection:
            metadata = _assert_demo_database(connection)
            _ensure_no_mixed_records(connection)
            return {
                "label": metadata.get("label"),
                "version": metadata.get("dataset_version"),
                "counts": _counts(connection),
                "payment_statuses": dict(connection.execute(
                    "SELECT status, COUNT(*) FROM universal_payment_requests "
                    "WHERE id LIKE 'demo-%' GROUP BY status"
                ).fetchall()),
            }


def main_cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "verify", "reset"), nargs="?", default="seed")
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required acknowledgement before deleting only demo-prefixed seed records.",
    )
    args = parser.parse_args()
    try:
        if args.action == "seed":
            result = seed_demo_data()
        elif args.action == "verify":
            result = verify_demo_data()
        else:
            result = reset_demo_data(confirm=args.confirm)
        print(json.dumps(result, indent=2, sort_keys=True))
    except (RuntimeError, sqlite3.Error) as error:
        print(f"Demo data operation refused/failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
