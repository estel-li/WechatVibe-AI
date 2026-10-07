"""Assistant Python -> real Node -> synthetic loopback API contract and cleanup."""
import json
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

from node_analysis import NodeAnalysis


@contextmanager
def gateway(responder):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            calls.append(body)
            status, content = responder(body)
            data = json.dumps(content).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = {"protocol": "chat_completions", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
              "apiKey": "synthetic-key", "model": "synthetic-model", "contextTokens": 4096}
    try:
        yield config, calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def completion(text):
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}}


class AssistantAdapterTests(unittest.TestCase):
    def test_complete_long_history_through_real_worker_progress_stream_and_regeneration(self):
        def respond(body):
            return 200, completion("合成回复" if body.get("stream") else "完整的事实笔记")
        messages = [{"id": f"m{i}", "side": "other", "text": "合成上下文" * 60,
                     "time": i + 1, "senderName": "合成联系人", "kind": "text"} for i in range(25)]
        with gateway(respond) as (config, calls):
            worker = NodeAnalysis(api_only=True)
            progress, deltas = [], []
            try:
                result = worker.assistant_generate(config, "reply", messages, "对长辈亲切有礼。",
                    instructions="请说明下周方便。", previous_reply="上次的建议。",
                    on_progress=progress.append, on_delta=deltas.append)
                source_rows = []
                for body in calls:
                    user = next(item["content"] for item in body["messages"] if item["role"] == "user")
                    source_rows.extend(row for line in user.splitlines() if line.startswith("{")
                                       for row in [json.loads(line)] if "id" in row)
                self.assertEqual([row["id"] for row in source_rows], [row["id"] for row in messages])
                self.assertEqual(result["messageCount"], 25)
                self.assertEqual([item["id"] for item in result["coverage"]], [row["id"] for row in messages])
                self.assertGreater(result["chunkCount"], 1)
                self.assertEqual(result["text"], "合成回复")
                self.assertEqual(deltas, ["合成回复"])
                self.assertEqual(progress[-1]["completedMessages"], 25)
                self.assertEqual(progress[-1]["completedCalls"], len(calls))
                self.assertEqual(result["usage"]["inputTokens"], len(calls) * 10)
                self.assertEqual(worker.model["state"], "ready")
                last_prompt = calls[-1]["messages"][-1]["content"]
                self.assertIn("上次的建议", last_prompt)
                self.assertIn("请说明下周方便", last_prompt)
            finally:
                worker.cancel()

    def test_provider_body_cannot_escape_as_assistant_error(self):
        with gateway(lambda _body: (401, {"error": {"message": "synthetic-key private transcript"}})) as (config, _calls):
            worker = NodeAnalysis(api_only=True)
            try:
                with self.assertRaisesRegex(RuntimeError, "^auth$"):
                    worker.assistant_generate(config, "summary", [{"id": "m1", "side": "self", "text": "合成"}], "总结。")
            finally:
                worker.cancel()

    def test_cancel_interrupts_inflight_assistant_worker(self):
        entered, release = threading.Event(), threading.Event()
        def respond(_body):
            entered.set()
            release.wait(10)
            return 200, completion("迟到的答案")
        with gateway(respond) as (config, _calls):
            worker = NodeAnalysis(api_only=True)
            errors = []
            def generate():
                try:
                    worker.assistant_generate(config, "summary", [{"id": "m1", "side": "self", "text": "合成"}], "总结。")
                except Exception as error:
                    errors.append(str(error))
            thread = threading.Thread(target=generate)
            thread.start()
            try:
                self.assertTrue(entered.wait(15))
                started = time.monotonic()
                worker.cancel()
                thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertLess(time.monotonic() - started, 4)
                self.assertEqual(errors, ["cancelled"])
            finally:
                release.set()
                worker.cancel()
                thread.join(3)

    def test_progress_is_not_final_and_refreshes_activity_even_without_callback(self):
        worker = NodeAnalysis(api_only=True)
        worker.version = worker.running_version = "v"
        process = Mock()
        worker.process = process
        worker.request_activity[7] = 1
        observed = {}
        def lines():
            yield json.dumps({"id": 7, "assistantProgress": {"phase": "map", "completedCalls": 2,
                "totalCalls": 5, "completedMessages": 20, "totalMessages": 40}})
            observed["pending"] = dict(worker.pending)
            observed["activity"] = worker.request_activity[7]
            yield json.dumps({"id": 7, "text": "final"})
        process.stdout = lines()
        worker._read(process)
        self.assertEqual(observed["pending"], {})
        self.assertGreater(observed["activity"], 1)
        self.assertEqual(worker.pending[7]["text"], "final")

    def test_live_progress_extends_inactivity_beyond_old_absolute_timeout(self):
        worker = NodeAnalysis(api_only=True)
        worker.version = worker.running_version = "v"
        worker.model = {"state": "ready"}
        process = Mock()
        process.poll.return_value = None
        worker.process = process
        clock = [0]
        class Condition:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                pass
            def wait(self, **_kwargs):
                clock[0] += 100
                worker.request_activity[1] = clock[0]
                if clock[0] == 300:
                    worker.pending[1] = {"analysisVersion": "v", "text": "final"}
        worker.condition = Condition()
        with patch.object(worker, "analysis_version", return_value="v"), \
             patch.object(worker, "_launch_locked"), patch("node_analysis.time.monotonic", side_effect=lambda: clock[0]):
            response, _ = worker._request({"cmd": "assistant:generate"}, require_model=False)
        self.assertEqual(clock[0], 300)
        self.assertEqual(response["text"], "final")
        self.assertEqual(worker.request_activity, {})

    def test_adapter_refuses_mismatched_coverage_and_non_api_worker(self):
        messages = [{"id": "m1", "side": "self", "text": "合成"}]
        worker = NodeAnalysis(api_only=True)
        with patch.object(worker, "_request", return_value=({"text": "answer", "messageCount": 1,
                "chunkCount": 1, "coverage": [{"id": "different", "parts": 1}]}, "v")):
            with self.assertRaisesRegex(RuntimeError, "invalid-output"):
                worker.assistant_generate({}, "summary", messages, "总结。")
        with self.assertRaisesRegex(ValueError, "API-only"):
            NodeAnalysis().assistant_generate({}, "summary", messages, "总结。")

    def test_cancel_before_assistant_launch_cannot_restart_disposable_worker(self):
        worker = NodeAnalysis(api_only=True)
        worker.cancel()
        with patch.object(worker, "analysis_version") as version, patch.object(worker, "_launch_locked") as launch:
            with self.assertRaisesRegex(RuntimeError, "^cancelled$"):
                worker.assistant_generate({}, "summary", [{"id": "m1", "side": "self", "text": "合成"}], "总结。")
            version.assert_not_called()
            launch.assert_not_called()

    def test_cancel_during_version_lookup_cannot_launch_or_send_provider_request(self):
        worker = NodeAnalysis(api_only=True)
        def version():
            worker.cancel()
            return "v"
        with patch.object(worker, "analysis_version", side_effect=version), \
             patch.object(worker, "_launch_locked") as launch:
            with self.assertRaisesRegex(RuntimeError, "^cancelled$"):
                worker.assistant_generate({}, "summary", [{"id": "m1", "side": "self", "text": "合成"}], "总结。")
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
