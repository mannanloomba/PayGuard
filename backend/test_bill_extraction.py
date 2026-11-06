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
            self.assertEqual(urlopen.call_count, 2)

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
