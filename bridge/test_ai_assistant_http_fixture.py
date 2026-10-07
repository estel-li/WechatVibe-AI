"""Entire real HTTP -> AssistantService -> Node -> loopback API assistance flow."""
import importlib.util
import json
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

path = Path(__file__).resolve().parents[1] / "tests/fixtures/assistant-http-fixture.py"
spec = importlib.util.spec_from_file_location("assistant_http_fixture", path)
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)


class AssistantHttpFixtureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.AssistantHttpFixture()
        self.ready = self.fixture.start()
        self.base = self.ready["assistantUrl"]

    def tearDown(self):
        self.fixture.close()

    def request(self, endpoint, body=None):
        request = Request(self.base + endpoint, data=None if body is None else json.dumps(body).encode(),
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=15) as response:
            return json.load(response)

    def job(self, **kwargs):
        return self.request("/api/assistant/jobs", {"account": self.ready["account"],
            "user": "synthetic-a", "kind": "summary", "range": "all", **kwargs})

    def poll(self, job):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            value = self.request(f"/api/assistant/jobs?account={job['account']}&id={job['id']}")
            if value["status"] in ("completed", "failed", "cancelled"):
                return value
            time.sleep(.025)
        self.fail("real HTTP assistant did not complete")

    def test_whole_history_passes_every_original_id_through_real_map_reduce_and_sse(self):
        settings = self.request("/api/assistant/settings")
        self.assertTrue(settings["ready"])
        self.assertFalse(settings["hasKey"])
        self.assertEqual(self.request("/__fixture__/stats")["requestCount"], 0)
        self.assertEqual(self.request("/api/assistant/models", {})["models"][0]["id"], "synthetic-model")
        self.assertTrue(self.request("/api/assistant/test", {})["ok"])
        result = self.poll(self.job())
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["messageCount"], 1305)
        self.assertEqual(result["scannedCount"], 1305)
        self.assertGreater(result["chunkCount"], 1)
        self.assertIn("最早记录", result["text"])
        stats = self.request("/__fixture__/stats")
        sent = [message_id for call in stats["requests"] for message_id in call["sourceIds"]]
        expected = [f"synthetic-a-history-{index + 1:04d}" for index in range(1305)]
        self.assertEqual(sent, expected)
        self.assertGreaterEqual(len(stats["historyReads"]), 3)
        self.assertTrue(any(call["phase"] == "reduce" for call in stats["requests"]))
        self.assertTrue(stats["requests"][-1]["stream"])
        self.assertEqual(stats["remoteCalls"], 0)

    def test_1295_messages_recover_first_truncated_map_with_complete_original_batch(self):
        self.fixture.backend.source.rows["synthetic-a"] = self.fixture.backend.source.rows["synthetic-a"][:1295]
        self.request("/api/assistant/settings", {"contextTokens": 65536})
        self.request("/__fixture__/truncate", {"count": 1})
        result = self.poll(self.job())
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["messageCount"], 1295)
        calls = self.request("/__fixture__/stats")["requests"]
        self.assertTrue(calls[0]["truncated"])
        self.assertFalse(calls[1]["truncated"])
        self.assertEqual(calls[0]["sourceIds"], calls[1]["sourceIds"])
        self.assertGreater(calls[1]["maxOutputTokens"], calls[0]["maxOutputTokens"])
        succeeded = [message_id for call in calls if not call["truncated"] for message_id in call["sourceIds"]]
        self.assertEqual(succeeded, [f"synthetic-a-history-{index + 1:04d}" for index in range(1295)])
        self.assertIn("1295 条所选消息", result["text"])
        self.assertNotIn("INCOMPLETE_SYNTHETIC_NOTE", result["text"])
        self.assertEqual(result["progress"]["completed"], result["progress"]["total"])

    def test_repeated_truncation_is_bounded_and_never_uses_partial_notes(self):
        self.request("/api/assistant/settings", {"contextTokens": 65536})
        self.request("/__fixture__/truncate", {"count": 2})
        result = self.poll(self.job())
        self.assertEqual(result["status"], "failed", result)
        self.assertEqual(result["error"]["code"], "output-truncated")
        self.assertEqual(result["text"], "")
        calls = self.request("/__fixture__/stats")["requests"]
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call["truncated"] for call in calls))

    def test_time_selection_filters_real_history_before_model_call_inclusively(self):
        result = self.poll(self.job(range="time", fromMs=self.ready["fromMs"], toMs=self.ready["toMs"]))
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["messageCount"], 10)
        self.assertEqual(result["scannedCount"], 1305)
        calls = self.request("/__fixture__/stats")["requests"]
        sent = [message_id for call in calls for message_id in call["sourceIds"]]
        self.assertEqual(sent, [f"synthetic-a-history-{index + 1:04d}" for index in range(100, 110)])
        self.assertFalse(any(call["hasEarliestMarker"] for call in calls))
        self.assertTrue(any(call["hasTimedMarker"] for call in calls))

    def test_relationship_custom_prompt_regeneration_and_conversation_scoping(self):
        first = self.poll(self.job(kind="reply", range="recent", relationship="elder"))
        self.assertEqual(first["status"], "completed", first)
        self.assertEqual(first["messageCount"], 80)
        stats = self.request("/__fixture__/stats")
        self.assertEqual(stats["recentReads"], [{"user": "synthetic-a", "limit": 80}])
        self.assertIn("长辈", stats["requests"][-1]["relationships"])
        custom = "E2E_CUSTOM_PROMPT：请用温和的语言回复。"
        second = self.poll(self.job(user="synthetic-b", kind="reply", range="recent", relationship="custom",
                                   systemPrompt=custom, previousReply=first["text"], instructions="重新措辞"))
        self.assertEqual(second["status"], "completed", second)
        stats = self.request("/__fixture__/stats")
        self.assertIn(custom, stats["requests"][-1]["systemPrompt"])
        self.assertTrue(stats["requests"][-1]["regenerated"])
        self.assertTrue(stats["requests"][-1]["instructionsPresent"])
        self.assertNotEqual(first["text"], second["text"])
        self.assertEqual(stats["recentReads"][-1]["user"], "synthetic-b")

    def test_cancel_during_actual_provider_call_returns_no_late_output(self):
        self.request("/__fixture__/delay", {"delayMs": 10000})
        job = self.job(kind="reply", range="recent")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and self.request("/__fixture__/stats")["requestCount"] == 0:
            time.sleep(.05)
        self.assertGreater(self.request("/__fixture__/stats")["requestCount"], 0)
        cancelled = self.request("/api/assistant/cancel", {"account": job["account"], "id": job["id"]})
        self.assertEqual(cancelled["status"], "cancelled")
        result = self.poll(job)
        self.assertEqual(result["text"], "")
        self.assertNotIn("partialText", result)


if __name__ == "__main__":
    unittest.main()
