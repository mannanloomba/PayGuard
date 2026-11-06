import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main


class BillExtractionTests(unittest.TestCase):
    def test_numeric_units_consumed_is_normalized_to_string(self) -> None:
        result = main.BillExtraction.model_validate({"units_consumed": 286})
        self.assertEqual(result.units_consumed, "286")
        self.assertIsInstance(result.units_consumed, str)

    def test_string_units_consumed_preserves_explicit_unit(self) -> None:
        result = main.BillExtraction.model_validate({"units_consumed": "286 kWh"})
        self.assertEqual(result.units_consumed, "286 kWh")

    def test_missing_or_null_units_consumed_remains_missing(self) -> None:
        self.assertIsNone(main.BillExtraction.model_validate({}).units_consumed)
        self.assertIsNone(
            main.BillExtraction.model_validate({"units_consumed": None}).units_consumed
        )

    def test_invalid_units_consumed_values_are_rejected(self) -> None:
        for value in (True, [], {}, float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                main.BillExtraction.model_validate({"units_consumed": value})

    def test_numeric_units_are_serialized_as_strings_in_api_shape(self) -> None:
        result = main.BillExtraction.model_validate({"units_consumed": 286})
        self.assertEqual(result.model_dump()["units_consumed"], "286")

    def test_pdf_embedded_text_skips_ocr_and_is_cleaned(self) -> None:
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((72, 72), "Provider: Fictional Power Co.\n\nAmount: INR 1,200")
        content = document.tobytes()
        document.close()

        with patch.object(main, "run_local_ocr") as ocr:
            text = main.extract_document_text(content, "application/pdf")

        self.assertIn("Provider: Fictional Power Co.", text)
        self.assertNotIn("\n\n", text)
        ocr.assert_not_called()

    def test_scanned_pdf_uses_ocr_fallback(self) -> None:
        document = pymupdf.open()
        document.new_page()
        content = document.tobytes()
        document.close()

        with patch.object(main, "get_tesseract_path", return_value="tesseract"), patch.object(
            main, "run_local_ocr", return_value="OCR provider\nAmount INR 500"
        ) as ocr:
            text = main.extract_document_text(content, "application/pdf")

        self.assertIn("OCR provider", text)
        ocr.assert_called_once()

    def test_bharatcode_timeout_retries_then_returns_504(self) -> None:
        async def run() -> None:
            with patch.dict(os.environ, {"BHARATCODE_API_KEY": "test-key"}), patch.object(
                main.urllib.request, "urlopen", side_effect=TimeoutError
            ) as urlopen, patch.object(main.time, "sleep"):
                with self.assertRaises(HTTPException) as raised:
                    await main.call_bharatcode("system", "user")
            self.assertEqual(raised.exception.status_code, 504)
            self.assertEqual(urlopen.call_count, 1)

        asyncio.run(run())

    def test_invalid_model_response_is_not_returned_as_extraction(self) -> None:
        root = Path(tempfile.mkdtemp())
        try:
            database_path = root / "payguard.sqlite3"
            with patch.object(main, "DATABASE_PATH", database_path), patch.dict(
                os.environ, {"BHARATCODE_API_KEY": "test-key"}
            ):
                with TestClient(main.app) as client, patch.object(
                    main, "extract_document_text", return_value="Provider: Fictional"
                ), patch.object(
                    main, "call_bharatcode", return_value='{"not_bill_fields": true}'
                ):
                    response = client.post(
                        "/api/extract",
                        files={"file": ("bill.pdf", b"%PDF-1.4", "application/pdf")},
                    )
            self.assertEqual(response.status_code, 502)
            self.assertIn("invalid bill details", response.json()["detail"])
        finally:
            for path in root.iterdir():
                path.unlink()
            root.rmdir()

    def test_fenced_valid_model_response_is_validated_as_bill(self) -> None:
        valid_response = """```json
        {
          "provider_name": "Fictional Electricity Co.",
          "customer_name": "Demo Customer",
          "bill_amount": 2450,
          "tax_amount": 100,
          "currency": "INR",
          "billing_date": "2026-11-01",
          "due_date": "2026-11-15",
          "invoice_number": "DEMO-INV-01",
          "account_reference": "DEMO-ACCOUNT-01",
          "units_consumed": "120 kWh",
          "billing_period": "October 2026",
          "document_type": "utility_bill",
          "missing_fields": [],
          "uncertain_fields": []
        }
        ```"""
        result = main.BillExtraction.model_validate_json(
            main.normalize_json_response(valid_response)
        )
        self.assertEqual(result.provider_name, "Fictional Electricity Co.")
        self.assertEqual(result.bill_amount, 2450)

    def test_truncated_model_response_still_fails_validation(self) -> None:
        truncated_response = '{"provider_name":"Fictional Electricity Co.","bill_amount":2450'
        with self.assertRaises(ValueError):
            main.BillExtraction.model_validate_json(
                main.normalize_json_response(truncated_response)
            )
