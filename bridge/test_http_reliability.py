"""Real loopback transport regressions; all content is synthetic."""
import http.client
import json
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import real_http


class Backend:
    def health(self):
        raise RuntimeError("synthetic-secret-key /private/account/chat-message")

    def set_worker_settings(self, workers, elastic):
        return {"workers": workers, "elastic": elastic}


class HttpReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), real_http.make_handler(Backend()))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def raw_request(self, extra_headers, body=b"{}", finish=True):
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as client:
            client.sendall((f"POST /api/analysis-workers HTTP/1.0\r\n"
                            f"Host: 127.0.0.1:{self.server.server_port}\r\n"
                            f"Content-Type: application/json\r\n{extra_headers}\r\n").encode("ascii") + body)
            if finish:
                client.shutdown(socket.SHUT_WR)
            response = b""
            while True:
                chunk = client.recv(8192)
                if not chunk:
                    break
                response += chunk
            return int(response.split(b" ", 2)[1]), json.loads(response.split(b"\r\n\r\n", 1)[1])

    def test_large_rejected_posts_return_json_instead_of_windows_connection_reset(self):
        payload = json.dumps({"unused": "中" * 100000}, ensure_ascii=False).encode("utf-8")
        for path, headers, expected in (
                ("/api/analysis-workers", {"Content-Type": "application/json"}, 400),
                ("/api/analysis-workers", {"Content-Type": "text/plain"}, 415),
                ("/api/analysis-workers", {"Content-Type": "application/json", "Origin": "https://foreign.invalid"}, 403),
                ("/api/unknown", {"Content-Type": "application/json"}, 404)):
            with self.subTest(path=path, headers=headers):
                self.assertEqual(self.request("POST", path, payload, headers)[0], expected)

    def test_ambiguous_framing_and_truncated_body_are_rejected(self):
        for headers, body in (
                ("Content-Length: 2\r\nContent-Length: 2\r\n", b"{}"),
                ("Content-Length: 2\r\nTransfer-Encoding: chunked\r\n", b"{}"),
                ("Content-Length: 10\r\n", b"{}"),
                ("Content-Length: 0\r\n", b"")):
            with self.subTest(headers=headers):
                self.assertEqual(self.raw_request(headers, body)[0], 400)

    def test_stalled_body_times_out_and_transport_remains_usable(self):
        with patch.object(real_http, "REQUEST_READ_TIMEOUT", .15):
            began = time.monotonic()
            self.assertEqual(self.raw_request("Content-Length: 10\r\n", b"{", finish=False)[0], 400)
            self.assertLess(time.monotonic() - began, 2)
        self.assertEqual(self.request("POST", "/api/analysis-workers", b'{"workers":1}',
                                      {"Content-Type": "application/json"})[0], 200)

    def test_continuous_trickle_cannot_extend_the_body_deadline(self):
        with patch.object(real_http, "REQUEST_READ_TIMEOUT", .2), \
                socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as client:
            client.sendall((f"POST /api/analysis-workers HTTP/1.0\r\n"
                            f"Host: 127.0.0.1:{self.server.server_port}\r\n"
                            "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{").encode("ascii"))
            stopped = threading.Event()
            def trickle():
                try:
                    for _ in range(10):
                        if stopped.wait(.06):
                            return
                        client.sendall(b"x")
                    client.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
            thread = threading.Thread(target=trickle, daemon=True)
            thread.start()
            began, response = time.monotonic(), b""
            try:
                while True:
                    chunk = client.recv(8192)
                    if not chunk:
                        break
                    response += chunk
            finally:
                stopped.set()
                thread.join(2)
            self.assertEqual(int(response.split(b" ", 2)[1]), 400)
            self.assertLess(time.monotonic() - began, .45)

    def test_internal_error_messages_do_not_expose_keys_paths_or_chat(self):
        status, result = self.request("GET", "/api/health")
        self.assertEqual(status, 503)
        self.assertEqual(result["error"], "RuntimeError")
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertNotIn("/private/account", json.dumps(result))

    def test_duplicate_query_parameters_are_not_silently_selected(self):
        status, result = self.request("GET", "/api/messages?user=first&user=second")
        self.assertEqual((status, result["error"]), (400, "duplicate query parameter"))
        fields = "&".join(f"field{index}=x" for index in range(65))
        self.assertEqual(self.request("GET", "/api/health?" + fields)[0], 400)


if __name__ == "__main__":
    unittest.main()
