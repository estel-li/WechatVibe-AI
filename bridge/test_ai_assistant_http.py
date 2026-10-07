"""Loopback transport and privacy checks for assistant routes."""
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from ai_assistant import AssistantRequestError
from real_http import make_handler


class Service:
    def __init__(self):
        self.calls = []
        self.failure = None

    def call(self, name, payload=None):
        if self.failure:
            raise self.failure
        self.calls.append((name, payload))
        return {"operation": name, "hasKey": True} if name != "job" else {
            "id": payload[1], "account": payload[0], "status": "completed", "text": "合成总结"}

    def settings(self): return self.call("settings")
    def save_settings(self, payload): return self.call("save", payload)
    def list_models(self, payload): return self.call("models", payload)
    def test_model(self, payload): return self.call("test", payload)
    def start_job(self, payload): return self.call("start", payload)
    def get_job(self, account, job): return self.call("job", (account, job))
    def cancel_job(self, payload): return self.call("cancel", payload)


class AssistantHttpTests(unittest.TestCase):
    def setUp(self):
        self.service = Service()
        backend = type("Backend", (), {"assistant_service": lambda _: self.service})()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(backend))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
            actual_headers = {"Content-Type": "application/json"} if payload is not None else {}
            actual_headers.update(headers or {})
            connection.request(method, path, payload, actual_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_routes_forward_settings_jobs_models_and_cancellation(self):
        self.assertEqual(self.request("GET", "/api/assistant/settings")[0], 200)
        for endpoint, name, code in (("settings", "save", 200), ("models", "models", 200),
                                     ("test", "test", 200), ("jobs", "start", 202), ("cancel", "cancel", 200)):
            status, result = self.request("POST", "/api/assistant/" + endpoint, {"account": "synthetic", "id": "job1"})
            self.assertEqual((status, result["operation"]), (code, name))
        status, result = self.request("GET", "/api/assistant/jobs?account=synthetic&id=job1")
        self.assertEqual((status, result["text"]), (200, "合成总结"))
        self.assertEqual(self.service.calls[-1], ("job", ("synthetic", "job1")))

    def test_structured_provider_failure_and_unexpected_failure_never_echo_secrets(self):
        self.service.failure = AssistantRequestError(409, "account-changed", "当前账号已变化")
        self.assertEqual(self.request("POST", "/api/assistant/jobs", {})[0], 409)
        for failure in (RuntimeError("synthetic-private-key"), ValueError("synthetic-private-key")):
            self.service.failure = failure
            for method, path, body in (("GET", "/api/assistant/settings", None),
                                       ("POST", "/api/assistant/test", {"apiKey": "synthetic-private-key"})):
                status, result = self.request(method, path, body)
                self.assertIn(status, (400, 503))
                self.assertNotIn("synthetic-private-key", json.dumps(result))

    def test_cross_origin_host_content_type_and_client_supplied_chat_are_rejected(self):
        for headers in ({"Origin": "https://foreign.invalid"}, {"Host": "foreign.invalid"},
                        {"Content-Type": "text/plain"}):
            self.assertIn(self.request("POST", "/api/assistant/jobs", {}, headers)[0], (403, 415))
        self.assertEqual(self.request("POST", "/api/assistant/jobs", {"texts": ["injected"]})[0], 400)
        self.assertEqual(self.request("GET", "/api/assistant/jobs?account=synthetic")[0], 400)
        self.assertEqual(self.service.calls, [])

    def test_all_relationship_prompts_can_cross_transport_as_multibyte_text(self):
        prompts = {name: "中" * 32000 for name in ("friend", "close_friend", "colleague", "relative", "elder", "custom")}
        status, _ = self.request("POST", "/api/assistant/settings", {"relationshipPrompts": prompts})
        self.assertEqual(status, 200)
        self.assertEqual(self.service.calls[-1][1]["relationshipPrompts"], prompts)
        self.assertEqual(self.request("POST", "/api/assistant/jobs", {"instructions": "x" * 300000})[0], 400)


if __name__ == "__main__": unittest.main()
