"""Exercise Python -> real Node API worker -> loopback, with no paid provider."""
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

from real_backend import NodeAnalysis
from api_portrait_statistics import append_batch, empty_statistics, profile_from_statistics


class ApiWorkerRecoveryTests(unittest.TestCase):
    def test_malformed_json_envelopes_do_not_kill_following_responses(self):
        analyzer = NodeAnalysis(api_only=True)
        analyzer.version = "synthetic"
        process = Mock()
        analyzer.process = process
        process.stdout = iter(json.dumps(value) for value in (
            [], None, "synthetic log", {"id": [1]}, {"id": {"unexpected": 1}},
            {"id": True}, {"ready": True, "model": "invalid-status"},
            {"ready": True, "analysisVersion": "synthetic", "model": {"state": "ready"}},
            {"id": 7, "analysisVersion": "synthetic", "text": "valid synthetic result"}))
        analyzer._read(process)
        self.assertEqual(analyzer.pending[7]["text"], "valid synthetic result")
        self.assertEqual(set(analyzer.pending), {7})
        self.assertEqual(analyzer.running_version, "synthetic")

    def test_portrait_classifier_runs_once_through_real_worker_without_local_model(self):
        calls = []
        class Gateway(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                calls.append(body)
                system = next(message["content"] for message in body["messages"]
                              if message["role"] == "system")
                contract = json.loads(system.split("LOCAL_QUESTION_CONTRACT:\n", 1)[1])
                answers = {}
                for name, (_instruction, labels) in contract["questions"].items():
                    selected = labels.index("warm") if name == "relationship" else 0
                    answers[name] = [int(index == selected) for index in range(len(labels))]
                answers["emotion"] = [.4, .3, .3] + [0] * (len(answers["emotion"]) - 3)
                data = json.dumps({"choices": [{"message": {"content": json.dumps({"answers": answers})}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        worker = NodeAnalysis(api_only=True)
        try:
            generated = worker.classify_portrait_batch(
                "chat_completions", f"http://127.0.0.1:{server.server_port}/v1",
                "synthetic-key", "synthetic", [{"id": "part-a", "messageId": "synthetic-a",
                 "sender": "OTHER", "target": True, "text": "一段合成的背景材料。", "complete": True}],
                "person", 32768)
            self.assertEqual(len(calls), 1)
            self.assertAlmostEqual(generated["result"]["score"], .55)
            self.assertIsNone(generated["result"]["personalityEvidence"])
            self.assertTrue(generated["result"]["intentBroad"])
            # Exercise the full adapter boundary with legal partial routed mass
            # and no personality evidence, not just an all-one-hot fake signal.
            self.assertAlmostEqual(sum(item["probability"] for item in generated["result"]["emotion"]), .7)
            statistics = append_batch(empty_statistics(), generated["result"], [
                {"messageId": "synthetic-a", "speaker": "friend", "sender": "OTHER",
                 "target": True, "text": "一段合成的背景材料。", "_pieceIndex": 0,
                 "_last": True, "_sort": [1, "message__message_0.db", 1]}], subject="friend")
            profile = profile_from_statistics(statistics, "test", subject="friend")
            self.assertEqual(profile["analyzedCount"], 1)
            self.assertEqual(profile["affinity"], 78)
            self.assertIsNone(profile["mbti"])
            self.assertNotIn("portrait", generated)
            self.assertEqual(worker.model["state"], "ready")
        finally:
            worker.cancel()
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_api_error_cannot_replace_api_readiness_with_laya_loading(self):
        analyzer = NodeAnalysis(api_only=True)
        analyzer.version = "synthetic"
        process = Mock()
        analyzer.process = process
        observed = {}
        def lines():
            yield json.dumps({"ready": True, "analysisVersion": "synthetic", "model": {"state": "ready"}})
            yield json.dumps({"id": 1, "error": "invalid-output", "modelStatus": {"state": "loading"}})
            observed.update(analyzer.model)
        process.stdout = lines()
        analyzer._read(process)
        self.assertEqual(analyzer.pending[1]["error"], "invalid-output")
        self.assertEqual(observed["state"], "ready")

    def test_late_reader_from_replaced_worker_cannot_change_new_worker(self):
        worker = NodeAnalysis(api_only=True)
        worker.version = worker.running_version = "new"
        worker.process = Mock()
        worker.model = {"state": "ready"}
        old_process = Mock()
        old_process.stdout = iter([
            json.dumps({"ready": True, "analysisVersion": "old", "model": {"state": "loading"}}),
            json.dumps({"id": 1, "error": "invalid-output"}),
        ])
        worker._read(old_process)
        self.assertEqual(worker.model, {"state": "ready"})
        self.assertEqual(worker.running_version, "new")
        self.assertEqual(worker.pending, {})

    def test_stream_delta_is_progress_and_final_reply_stays_pending(self):
        worker = NodeAnalysis(api_only=True)
        worker.version = worker.running_version = "synthetic"
        worker.model = {"state": "ready"}
        process = Mock()
        worker.process = process
        deltas = []
        worker.stream_callbacks[7] = deltas.append
        process.stdout = iter([
            json.dumps({"id": 7, "cmd": "model:insights", "analysisVersion": "synthetic",
                        "streamDelta": "情感：关切\n"}),
            json.dumps({"id": 7, "cmd": "model:insights", "analysisVersion": "synthetic",
                        "insights": []}),
        ])
        worker._read(process)
        self.assertEqual(deltas, ["情感：关切\n"])
        self.assertEqual(worker.pending[7]["insights"], [])

    def test_failed_generation_does_not_delay_next_call_in_real_worker(self):
        calls = []
        class Gateway(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                calls.append(time.monotonic())
                content = "invalid JSON" if len(calls) == 1 else json.dumps({"items": [
                    {"id": "synthetic-target", "status": "ok", "emotion": "期待", "intent": "邀约"}]})
                body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        worker = NodeAnalysis(api_only=True)
        args = ("chat_completions", f"http://127.0.0.1:{server.server_port}/v1", "synthetic-key", "synthetic",
                [{"id": "synthetic-target", "sender": "OTHER", "text": "周末一起去吗"}], ["synthetic-target"])
        try:
            # A response with no answer must not become a cached empty success.
            # Its error still must not poison the independent API worker readiness.
            with self.assertRaisesRegex(RuntimeError, "invalid-output"):
                worker.model_insights(*args)
            self.assertEqual(worker.model["state"], "ready")
            start = time.monotonic()
            result = worker.model_insights(*args)
            self.assertLess(time.monotonic() - start, 1.0)
            self.assertEqual(len(calls), 2)
            self.assertEqual(result["insights"][0]["id"], "synthetic-target")
        finally:
            worker.cancel()
            server.shutdown()
            server.server_close()
            thread.join(2)


if __name__ == "__main__":
    unittest.main()
