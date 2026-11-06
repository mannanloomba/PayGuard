import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


class FrontendServingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.frontend_dir = root / "dist"
        self.frontend_dir.mkdir()
        (self.frontend_dir / "index.html").write_text(
            "<html><body><div id='root'>PayGuard</div></body></html>",
            encoding="utf-8",
        )
        (self.frontend_dir / "assets").mkdir()
        (self.frontend_dir / "assets" / "app.js").write_text(
            "console.log('demo');",
            encoding="utf-8",
        )
        self.database_path = root / "payguard.sqlite3"
        self.dist_patch = patch.object(main, "FRONTEND_DIST", self.frontend_dir)
        self.database_patch = patch.object(main, "DATABASE_PATH", self.database_path)
        self.dist_patch.start()
        self.database_patch.start()
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        self.client.close()
        self.database_patch.stop()
        self.dist_patch.stop()
        self.temp_dir.cleanup()

    def test_root_and_client_routes_serve_index(self) -> None:
        for path in ("/", "/bills", "/assistant"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertIn("PayGuard", response.text)

    def test_static_assets_are_served_without_spa_fallback(self) -> None:
        response = self.client.get("/assets/app.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "console.log('demo');")

    def test_api_docs_and_unknown_api_routes_remain_backend_routes(self) -> None:
        self.assertEqual(self.client.get("/docs").status_code, 200)
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        self.assertEqual(self.client.get("/api/not-a-route").status_code, 404)
