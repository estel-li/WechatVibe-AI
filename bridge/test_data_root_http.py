"""Data-directory HTTP contract; no WeChat account or inference is touched."""
import http.client
import json
import os
import tempfile
import threading
import unittest
from contextlib import nullcontext
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from data_root_source import CUSTOM_ROOT_ENV, DataRootSource
from real_backend import Backend
from real_http import make_handler


class DataRootHttpTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, {CUSTOM_ROOT_ENV: ""})
        env.start()
        self.addCleanup(env.stop)
        backend = object.__new__(Backend)
        backend.data_root_store = DataRootSource(self.root)
        backend.request_lease = nullcontext
        backend.source = None
        self.backend = backend
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(backend))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.data = self.root / "custom" / "xwechat_files"
        (self.data / "synthetic-a" / "db_storage").mkdir(parents=True)

    def request(self, method, path, body=None, origin=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_settings_work_when_no_account_is_ready_and_do_not_read_chat_data(self):
        self.assertEqual(self.request("GET", "/api/data-root")[1]["state"], "unset")
        status, saved = self.request("POST", "/api/data-root", {"path": str(self.data)})
        self.assertEqual(status, 200)
        self.assertEqual((saved["state"], saved["accounts"]), ("ready", 1))
        self.assertEqual(self.request("GET", "/api/data-root")[1], saved)
        self.assertEqual(self.request("POST", "/api/data-root/clear", {})[1]["state"], "unset")

    def test_invalid_shapes_and_paths_are_rejected_without_overwriting_settings(self):
        self.request("POST", "/api/data-root", {"path": str(self.data)})
        for body in ({}, {"path": "relative"}, {"path": None}, {"path": "x\x00"},
                     {"path": str(self.root)}, {"path": str(self.data), "extra": True}):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/api/data-root", body)[0], 400)
        self.assertEqual(self.request("POST", "/api/data-root/clear", {"extra": True})[0], 400)
        self.assertEqual(self.request("GET", "/api/data-root")[1]["path"], str(self.data.resolve()))

    def test_cross_origin_cannot_read_or_write_path_settings(self):
        # Rejection occurs before body parsing. Do not send an unread body:
        # Windows can reset that connection before the 403 reaches http.client.
        for method, path, body in (("GET", "/api/data-root", None),
                                   ("POST", "/api/data-root", None),
                                   ("POST", "/api/data-root/clear", None)):
            self.assertEqual(self.request(method, path, body, "https://untrusted.example")[0], 403)
        self.assertFalse(self.backend.data_root_store.config.exists())


if __name__ == "__main__":
    unittest.main()
