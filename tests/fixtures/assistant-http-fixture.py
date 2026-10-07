"""Real assistant HTTP/Python/Node stack, connected only to a synthetic loopback API.

Run with the repository's Python runtime. The single READY line describes fixture
ports and deterministic timestamps. POST /__fixture__/shutdown or write shutdown
to stdin for graceful cleanup. This file never reads WeChat or calls a remote API.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]
CLIENT = Path(os.environ.get("WECHATVIBE_ASSISTANT_FIXTURE_CLIENT", REPO)).resolve()
sys.path.insert(0, str(CLIENT / "bridge"))

from ai_assistant import AssistantService
from backend_contracts import AccountChangedError
from real_http import make_handler

ACCOUNT = "synthetic-ui-verification"
BASE_MS = 1760000000000
ALL_COUNT = 1305
TIME_FROM_MS, TIME_TO_MS = BASE_MS + 100 * 60000, BASE_MS + 109 * 60000
EARLIEST_MARKER = "EARLIEST_FULL_HISTORY_MARKER"
TIMED_MARKER = "TIMED_SUBSET_MARKER"


class SyntheticSource:
    def __init__(self, root, count=ALL_COUNT):
        self.root, self.account = root, ACCOUNT
        self.lock = threading.RLock()
        self.history_reads, self.recent_reads = [], []
        self.rows = {}
        for user, total in (("synthetic-a", count), ("synthetic-b", 85)):
            self.rows[user] = [{
                "id": f"{user}-history-{index + 1:04d}",
                "side": "self" if index % 2 else "other", "kind": "text",
                "text": ((EARLIEST_MARKER + "：这条最早消息在屏幕之外，包含最初的项目约定。")
                         if index == 0 else
                         (TIMED_MARKER + f"：限定时段的合成对话第 {index} 条，讨论周六下午见面。")
                         if 100 <= index <= 109 else
                         f"合成对话第 {index} 条：确认资料已经收到，后续安排稍后再讨论。"),
                "time": BASE_MS + index * 60000,
                "senderName": "我" if index % 2 else "合成朋友",
                "_sort": (index + 1, "message__message_0.db", index + 1),
            } for index in range(total)]

    def identity(self):
        return self.account, str(self.root)

    def history_highwater(self, user):
        rows = self.rows.get(user, [])
        return rows[-1]["_sort"] if rows else None

    def history_page(self, user, highwater, after=None, page_size=1000):
        rows = [item for item in self.rows.get(user, []) if item["_sort"] <= tuple(highwater) and
                (after is None or item["_sort"] > tuple(after))][:page_size]
        with self.lock:
            self.history_reads.append({"user": user, "count": len(rows), "after": after})
        return rows, rows[-1]["_sort"] if rows else None

    def messages(self, user, limit):
        with self.lock:
            self.recent_reads.append({"user": user, "limit": limit})
        return self.rows.get(user, [])[-limit:]


class MinimalBackend:
    def __init__(self, root):
        self.source, self.closing = SyntheticSource(root), False
        self.service = AssistantService(self, root=root)

    def assistant_service(self):
        return self.service

    def _assert_scope(self, scope):
        account, directory = self.source.identity()
        if self.closing or (account, str(Path(directory).resolve())) != scope:
            raise AccountChangedError()

    def health(self):
        return {"ok": True, "data": {"state": "ready", "account": self.source.account},
                "model": {"state": "idle"}}

    def close(self):
        self.closing = True
        self.service.close()


class AssistantHttpFixture:
    def __init__(self, root=None):
        allowed = (REPO / ".local").resolve()
        parent = allowed / "assistant-http-fixtures"
        parent.mkdir(parents=True, exist_ok=True)
        selected = Path(root).absolute() if root else Path(tempfile.mkdtemp(prefix="fixture-", dir=parent))
        if (not selected.resolve().is_relative_to(allowed) or
                selected.resolve() == allowed or selected.is_symlink()):
            raise ValueError("fixture root must be a new directory under the repository .local")
        selected.mkdir(parents=True, exist_ok=True)
        if any(selected.iterdir()):
            raise ValueError("fixture root must be empty; no existing runtime is reused")
        self.root = selected
        self.stop = threading.Event()
        self.lock = threading.RLock()
        self.requests, self.model_lists = [], 0
        self.delay_ms = 0
        self.backend = MinimalBackend(self.root)
        owner = self

        class ProviderHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def send_json(self, status, value):
                data = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.client_address[0] != "127.0.0.1":
                    return self.send_json(403, {"error": "loopback-only"})
                if urlsplit(self.path).path not in ("/v1/models", "/models"):
                    return self.send_json(404, {"error": "not found"})
                with owner.lock:
                    owner.model_lists += 1
                return self.send_json(200, {"object": "list", "data": [
                    {"id": "synthetic-model", "object": "model", "owned_by": "test-fixture"}]})

            def do_POST(self):
                if self.client_address[0] != "127.0.0.1":
                    return self.send_json(403, {"error": "loopback-only"})
                if urlsplit(self.path).path not in ("/v1/chat/completions", "/chat/completions"):
                    return self.send_json(404, {"error": "not found"})
                try:
                    size = int(self.headers.get("Content-Length", 0))
                    if not 0 < size <= 4 * 1024 * 1024:
                        raise ValueError("invalid body length")
                    body = json.loads(self.rfile.read(size))
                    text, record = owner.respond(body)
                except (ValueError, KeyError, TypeError):
                    return self.send_json(400, {"error": "invalid synthetic request"})
                with owner.lock:
                    owner.requests.append(record)
                    call = len(owner.requests)
                    delay_ms = owner.delay_ms
                if delay_ms:
                    owner.stop.wait(delay_ms / 1000)
                if owner.stop.is_set():
                    return
                try:
                    if not body.get("stream"):
                        return self.send_json(200, {
                            "id": f"synthetic-{call}", "object": "chat.completion",
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                         "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
                    chunks = [text[index:index + 8] for index in range(0, len(text), 8)]
                    payload = "".join("data: " + json.dumps({
                        "id": f"synthetic-{call}", "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {"role": "assistant", "content": chunk},
                                     "finish_reason": None}],
                    }, ensure_ascii=False) + "\n\n" for chunk in chunks)
                    payload += "data: " + json.dumps({"id": f"synthetic-{call}",
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5}}) + "\n\n"
                    payload += "data: [DONE]\n\n"
                    data = payload.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        self.provider.daemon_threads = True
        real_handler = make_handler(self.backend)

        class AssistantHandler(real_handler):
            def _do_GET(self):
                if urlsplit(self.path).path == "/__fixture__/stats":
                    if not self.trusted_request():
                        return self.send(403, {"error": "forbidden"})
                    return self.send(200, owner.stats())
                return super()._do_GET()

            def _do_POST(self):
                endpoint = urlsplit(self.path).path
                if endpoint == "/__fixture__/shutdown":
                    if not self.trusted_request():
                        return self.send(403, {"error": "forbidden"})
                    self.send(200, {"stopping": True})
                    owner.stop.set()
                    return
                if endpoint == "/__fixture__/delay":
                    if not self.trusted_request():
                        return self.send(403, {"error": "forbidden"})
                    try:
                        length = int(self.headers.get("Content-Length", 0))
                        if not 0 < length <= 128:
                            raise ValueError()
                        payload = json.loads(self.rfile.read(length))
                        delay = payload["delayMs"]
                        if type(delay) is not int or not 0 <= delay <= 30000:
                            raise ValueError()
                    except (ValueError, KeyError, TypeError):
                        return self.send(400, {"error": "invalid delay"})
                    with owner.lock:
                        owner.delay_ms = delay
                    return self.send(200, {"delayMs": delay})
                return super()._do_POST()

        self.assistant = ThreadingHTTPServer(("127.0.0.1", 0), AssistantHandler)
        self.assistant.daemon_threads = True
        self.provider_url = f"http://127.0.0.1:{self.provider.server_port}/v1"
        self.assistant_url = f"http://127.0.0.1:{self.assistant.server_port}"
        self.threads = []
        self.backend.service.save_settings({"preset": "custom", "protocol": "chat_completions",
            "baseUrl": self.provider_url, "model": "synthetic-model", "contextTokens": 4096})

    def respond(self, body):
        messages = body.get("messages", [])
        system = "\n".join(str(item.get("content", "")) for item in messages if item.get("role") == "system")
        prompt = "\n".join(str(item.get("content", "")) for item in messages if item.get("role") == "user")
        rows = []
        for line in prompt.splitlines():
            if line.startswith("{"):
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):
                        rows.append(value)
                except ValueError:
                    pass
        source = [item for item in rows if "id" in item]
        notes = [item for item in rows if "first" in item and "last" in item and "text" in item]
        phase = "probe" if "This is a connection test" in system else (
            "map" if prompt.startswith("整理以下全部片段") else
            "reduce" if prompt.startswith("合并以下全部笔记") else "reply" if "以我方身份" in prompt else "summary")
        earliest = EARLIEST_MARKER in prompt or "early=yes" in prompt
        timed = TIMED_MARKER in prompt or "timed=yes" in prompt
        count = len(source) if source else sum(int(value) for item in notes for value in
                                             re.findall(r"n=(\d+)", str(item["text"])))
        record = {"phase": phase, "sourceIds": [item["id"] for item in source],
                  "sourceCount": len(source), "coveredCount": count,
                  "hasEarliestMarker": earliest, "hasTimedMarker": timed,
                  "regenerated": "上轮草稿（资料）" in prompt,
                  "customPrompt": "CUSTOM_PROMPT" in system or "自定义" in system,
                  "relationships": [word for word in ("普通朋友", "亲密朋友", "同事", "亲戚", "长辈") if word in system],
                  "systemPrompt": system, "instructionsPresent": "用户补充要求" in prompt,
                  "model": str(body.get("model", ""))[:256], "stream": bool(body.get("stream"))}
        if phase == "probe":
            return '{"ok":true}', record
        if phase in ("map", "reduce"):
            return f"n={count};early={'yes' if earliest else 'no'};timed={'yes' if timed else 'no'};合成事实笔记", record
        if phase == "reply":
            return ("谢谢你的提醒，我会先确认时间，再把具体安排告诉你。" if not record["regenerated"] else
                    "收到，我先核对一下时间，确认后马上和你说。"), record
        return f"合成对话总结：本次已覆盖 {count} 条所选消息。" + (
            "最早记录包含最初的项目约定。" if earliest else "") + (
            "限定时段讨论周六下午见面。" if timed else ""), record

    def stats(self):
        with self.lock, self.backend.source.lock:
            return {"synthetic": True, "remoteCalls": 0, "account": self.backend.source.account,
                    "modelLists": self.model_lists, "requestCount": len(self.requests),
                    "requests": list(self.requests), "historyReads": list(self.backend.source.history_reads),
                    "recentReads": list(self.backend.source.recent_reads),
                    "jobCount": len(self.backend.service.jobs), "delayMs": self.delay_ms}

    def ready(self):
        return {"status": "READY", "assistantUrl": self.assistant_url, "providerUrl": self.provider_url,
                "root": str(self.root), "statsUrl": self.assistant_url + "/__fixture__/stats",
                "shutdownUrl": self.assistant_url + "/__fixture__/shutdown", "account": ACCOUNT,
                "user": "synthetic-a", "fromMs": TIME_FROM_MS, "toMs": TIME_TO_MS,
                "expectedAllCount": ALL_COUNT, "expectedTimeCount": 10,
                "earliestMarker": EARLIEST_MARKER}

    def start(self):
        for server in (self.provider, self.assistant):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.threads.append(thread)
        return self.ready()

    def close(self):
        self.stop.set()
        self.backend.close()
        for server in (self.assistant, self.provider):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", help="New empty fixture directory within repository .local")
    args = parser.parse_args()
    fixture = AssistantHttpFixture(args.root)
    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda *_args: fixture.stop.set())

    def stdin_commands():
        for line in sys.stdin:
            if line.strip().lower() in ("shutdown", "exit", "quit"):
                fixture.stop.set()
                return
        fixture.stop.set()

    try:
        print(json.dumps(fixture.start(), ensure_ascii=False), flush=True)
        threading.Thread(target=stdin_commands, daemon=True).start()
        fixture.stop.wait()
    finally:
        fixture.close()


if __name__ == "__main__":
    main()
