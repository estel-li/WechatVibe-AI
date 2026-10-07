"""Explicit, account-scoped chat assistance with an independent encrypted API profile.

This service never changes the automatic message-analysis source and never starts a
paid request while reading settings. Results live only in memory for this process.
"""
from __future__ import annotations

import copy
import math
import threading
import time
import uuid
from collections import OrderedDict, deque
from pathlib import Path

from backend_contracts import (AccountChangedError, AccountUnavailableError,
                               MODEL_CONNECTOR_ERRORS, ROOT)
from conversation_selection import _session_id
from model_source import (ModelSourceStore, ModelSourceUnavailable, _MISSING,
                          connection_values)
from node_analysis import NodeAnalysis

RELATIONSHIPS = ("friend", "close_friend", "colleague", "relative", "elder", "custom")
DEFAULT_PROMPTS = {
    "friend": "你帮我回复普通朋友。语气自然友好，尊重彼此边界，不默认亲密关系。结合对方最后的表达和我平时的说话习惯，给出一条可直接发送的简洁回复。",
    "close_friend": "你帮我回复亲密朋友。语气熟悉、真诚、有温度，先接住对方的情绪，再回应具体事情；可以适度轻松，但不要默认恋爱关系、过度讨好或强行开玩笑。给出一条可直接发送的回复。",
    "colleague": "你帮我回复同事。礼貌、清晰、专业但不生硬。先回应工作事项，必要时确认行动、时间和责任边界。不替我承诺聊天记录未确认的事项。给出一条可直接发送的回复。",
    "relative": "你帮我回复亲戚。语气亲切有礼，照顾家庭关系和双方感受，保持合理边界；不要编造家庭情况、义务或承诺。给出一条自然的、可直接发送的回复。",
    "elder": "你帮我回复长辈。尊重、耐心、亲切，用清楚朴实的语言回应关心或问题，避免居高临下和敷衍；保持我自己的意愿和边界。给出一条可直接发送的回复。",
    "custom": "你是我的聊天回复助手。结合完整给定上下文和我的表达风格，写一条自然、得体、可直接发送的回复。遵循我补充的关系、语气和要求，不编造事实或替我作未经确认的承诺。",
}
DEFAULT_SUMMARY_PROMPT = (
    "请总结给定的全部对话。按需要整理主要话题、重要事实、双方立场、情绪变化、已达成的决定和待办事项。"
    "保留关键时间、人物和条件，区分已确认事项与猜测，指出信息不足或分歧。非文本消息只能说明其类型，不能猜测图片或语音内容。"
    "使用清楚的中文，合并重复内容；不要给人物做心理诊断，不要编造未出现的事实。")
DEEPSEEK_CONTEXT_TOKENS = 1000000
LEGACY_DEFAULT_CONTEXT_TOKENS = 65536
DEEPSEEK_MODELS = frozenset({"deepseek-flash", "deepseek-v4-pro"})
DEEPSEEK_BASE_URLS = frozenset({"https://api.deepseek.com", "https://api.deepseek.com/v1"})
DEFAULT_CONFIG = {"protocol": "chat_completions", "baseUrl": "https://api.deepseek.com",
                  "model": "deepseek-flash", "contextTokens": DEEPSEEK_CONTEXT_TOKENS}
TERMINAL = frozenset({"completed", "failed", "cancelled"})
ERROR_MESSAGES = {
    "auth": "API 密钥无效或没有该模型的权限，请检查助手设置。",
    "rate-limit": "API 请求达到限额，请稍后手动重试。",
    "timeout": "模型响应超时，请稍后手动重试。",
    "network": "无法连接模型服务，请检查地址和网络。",
    "context-too-long": "模型上下文不足，请调整上下文容量或选择较短的时间范围。",
    "output-truncated": "模型输出达到本次上限，请精简总结要求后重试，或选择支持更长输出的模型。",
    "account-changed": "当前微信账号或数据目录已变化，请重新选择会话。",
    "empty-conversation": "所选范围没有可读取的对话，请调整时间范围。",
    "assistant-failed": "助手任务未完成，请检查模型设置后手动重试。",
}


class AssistantRequestError(RuntimeError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _prompt(value, field, maximum=32000, *, empty=False):
    if (not isinstance(value, str) or len(value) > maximum or
            (not empty and not value.strip()) or
            any(0xD800 <= ord(char) <= 0xDFFF or ord(char) == 0 for char in value)):
        raise ValueError("invalid " + field)
    return value


def _account(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 256 or
            any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
        raise ValueError("invalid account")
    return value


def _official_deepseek(config, preset):
    """A custom host/model or a retired model ID cannot inherit this capacity."""
    return (preset == "deepseek" and config.get("protocol") == "chat_completions" and
            isinstance(config.get("baseUrl"), str) and isinstance(config.get("model"), str) and
            config.get("baseUrl") in DEEPSEEK_BASE_URLS and config.get("model") in DEEPSEEK_MODELS)


class _PreferenceStore:
    """Reuse the existing root/symlink checks and durable atomic JSON writer."""
    def __init__(self, path, root):
        self.writer = ModelSourceStore(path, root=root)

    @staticmethod
    def validate(value):
        if not isinstance(value, dict) or set(value) != {
                "preset", "summaryPrompt", "relationshipPrompts", "defaultRelationship"}:
            raise ValueError("invalid assistant preferences")
        if value["preset"] not in ("deepseek", "custom"):
            raise ValueError("invalid preset")
        if value["defaultRelationship"] not in RELATIONSHIPS:
            raise ValueError("invalid relationship")
        prompts = value["relationshipPrompts"]
        if not isinstance(prompts, dict) or set(prompts) != set(RELATIONSHIPS):
            raise ValueError("invalid relationship prompts")
        _prompt(value["summaryPrompt"], "summaryPrompt")
        for key, text in prompts.items():
            _prompt(text, "relationshipPrompts." + key)
        return copy.deepcopy(value)

    def read(self):
        raw = self.writer._read_json(self.writer.path)
        if raw is _MISSING:
            return {"preset": "deepseek", "summaryPrompt": DEFAULT_SUMMARY_PROMPT,
                    "relationshipPrompts": dict(DEFAULT_PROMPTS), "defaultRelationship": "friend"}
        try:
            return self.validate(raw)
        except ValueError as exc:
            raise ModelSourceUnavailable("assistant settings unavailable") from exc

    def write(self, value):
        self.writer._write(self.validate(value))


class AssistantService:
    def __init__(self, backend, *, root=ROOT, store=None, analyzer_factory=None):
        self.backend, self.root = backend, Path(root)
        runtime = self.root / ".local" / "real-client-runtime"
        self.store = store or ModelSourceStore(runtime / "assistant-model-source.json", root=self.root)
        self.preferences = _PreferenceStore(runtime / "assistant-preferences.json", self.root)
        self.analyzer_factory = analyzer_factory or (lambda: NodeAnalysis(api_only=True))
        self.lock = threading.RLock()
        self.settings_lock = threading.RLock()
        self.jobs = OrderedDict()
        self.probes = set()
        self.closed = False
        self.settings_revision = 0

    def settings(self):
        with self.settings_lock:
            saved = self.store.public()["api"]
            preferences = self.preferences.read()
            result = {**DEFAULT_CONFIG, **(saved or {}), **preferences,
                      "hasKey": bool(saved and saved["hasKey"]), "ready": bool(saved)}
            official = _official_deepseek(result, preferences["preset"])
            # Version 1 did not record whether 65536 was a default or an explicit
            # user choice. Keep every saved numeric value; offer an explicit UI
            # upgrade instead of silently overriding a user's budget. Missing
            # official capacity is an automatic default and can safely advance.
            if saved and saved.get("contextTokens") is None and official:
                result["contextTokens"] = DEEPSEEK_CONTEXT_TOKENS
            result["contextUpgradeAvailable"] = bool(
                saved and official and saved.get("contextTokens") == LEGACY_DEFAULT_CONTEXT_TOKENS)
            return result

    def save_settings(self, payload):
        allowed = {"protocol", "baseUrl", "model", "contextTokens", "apiKey", "clearKey",
                   "preset", "summaryPrompt", "relationshipPrompts", "defaultRelationship"}
        if not isinstance(payload, dict) or not payload.keys() <= allowed:
            raise ValueError("invalid assistant settings")
        if "clearKey" in payload and type(payload["clearKey"]) is not bool:
            raise ValueError("invalid clearKey")
        if payload.get("clearKey") and payload.get("apiKey"):
            raise ValueError("cannot set and clear apiKey")
        with self.settings_lock:
            current = self.settings()
            merged = {**current, **payload}
            if not current["ready"] and "contextTokens" not in payload:
                merged["contextTokens"] = (DEEPSEEK_CONTEXT_TOKENS if
                    _official_deepseek(merged, merged["preset"]) else LEGACY_DEFAULT_CONTEXT_TOKENS)
            preferences = _PreferenceStore.validate({key: merged[key] for key in
                ("preset", "summaryPrompt", "relationshipPrompts", "defaultRelationship")})
            config = connection_values({key: merged[key] for key in
                                        ("protocol", "baseUrl", "model", "contextTokens")}, True)
            if "apiKey" in payload:
                config["apiKey"] = connection_values({"protocol": config["protocol"],
                    "baseUrl": config["baseUrl"], "apiKey": payload["apiKey"]})["apiKey"]
            key = self.store.resolve_key(config["protocol"], config["baseUrl"], config["apiKey"])
            with self.lock:
                if self.closed:
                    raise AccountUnavailableError()
            if payload.get("clearKey"):
                self.store.clear_key()
                key = None
            self.store.save_api(config["protocol"], config["baseUrl"], config["model"], key,
                                context_tokens=config["contextTokens"])
            self.preferences.write(preferences)
            result = self.settings()
            with self.lock:
                self.settings_revision += 1
            self._cancel_all("settings-changed", purge=True)
        return result

    def _connection(self, payload, require_model):
        if not isinstance(payload, dict):
            raise ValueError("invalid assistant connection")
        allowed = {"protocol", "baseUrl", "apiKey"} | (
            {"model", "contextTokens"} if require_model else set())
        if not payload.keys() <= allowed:
            raise ValueError("invalid assistant connection")
        with self.settings_lock:
            current = self.settings()
            merged = {key: current[key] for key in allowed if key != "apiKey" and key in current}
            merged.update(payload)
            config = connection_values(merged, require_model)
            config["apiKey"] = self.store.resolve_key(config["protocol"], config["baseUrl"],
                                                       config["apiKey"])
            return config

    def _probe(self, payload, *, test):
        config = self._connection(payload, test)
        with self.lock:
            if self.closed:
                raise AccountUnavailableError()
            analyzer = self.analyzer_factory()
            self.probes.add(analyzer)
        try:
            if test:
                result = analyzer.model_test(config["protocol"], config["baseUrl"],
                                             config["apiKey"], config["model"])
            else:
                result = analyzer.model_list(config["protocol"], config["baseUrl"], config["apiKey"])
            with self.lock:
                if self.closed:
                    raise AccountUnavailableError()
            return {**result, "protocol": config["protocol"], "baseUrl": config["baseUrl"]}
        except (AccountUnavailableError, AssistantRequestError):
            raise
        except Exception as exc:
            code = str(exc) if str(exc) in MODEL_CONNECTOR_ERRORS else "assistant-failed"
            raise AssistantRequestError(502, code, ERROR_MESSAGES.get(code, ERROR_MESSAGES["assistant-failed"])) from None
        finally:
            with self.lock:
                self.probes.discard(analyzer)
            analyzer.cancel()

    def list_models(self, payload):
        return self._probe(payload, test=False)

    def test_model(self, payload):
        return self._probe(payload, test=True)

    def _capture_scope(self, account):
        if self.closed or getattr(self.backend, "closing", False):
            raise AccountUnavailableError()
        source = self.backend.source
        verified = getattr(source, "verified_identity", None)
        if callable(verified):
            actual, workdir = verified(messages=True)
        else:
            ready = getattr(source, "require_messages_ready", None)
            if callable(ready):
                ready()
            actual, workdir = source.identity()
        if str(actual) != account:
            raise AccountChangedError()
        return account, str(Path(workdir).resolve())

    def _assert_scope(self, scope):
        if self.closed or getattr(self.backend, "closing", False):
            raise AccountChangedError()
        verifier = getattr(self.backend, "_assert_scope", None)
        if callable(verifier):
            verifier(scope)
        elif self._capture_scope(scope[0]) != scope:
            raise AccountChangedError()

    @staticmethod
    def _validate_job(payload):
        if not isinstance(payload, dict) or not payload.keys() <= {
                "account", "user", "kind", "range", "fromMs", "toMs", "relationship",
                "systemPrompt", "instructions", "previousReply"}:
            raise ValueError("invalid assistant job")
        _account(payload.get("account"))
        _session_id(payload.get("user"))
        if payload.get("kind") not in ("summary", "reply"):
            raise ValueError("invalid assistant kind")
        selected = payload.get("range", "all" if payload["kind"] == "summary" else "recent")
        if selected not in ("all", "time", "recent") or (
                payload["kind"] == "summary" and selected == "recent"):
            raise ValueError("invalid assistant range")
        if selected == "time":
            for key in ("fromMs", "toMs"):
                if type(payload.get(key)) is not int or not 0 <= payload[key] <= 8640000000000000:
                    raise ValueError("invalid " + key)
            if payload["fromMs"] > payload["toMs"]:
                raise ValueError("invalid time range")
        elif "fromMs" in payload or "toMs" in payload:
            raise ValueError("time bounds require time range")
        for key, maximum in (("systemPrompt", 32000), ("instructions", 8000), ("previousReply", 64000)):
            if key in payload:
                _prompt(payload[key], key, maximum, empty=key != "systemPrompt")
        if "relationship" in payload and payload["relationship"] not in RELATIONSHIPS:
            raise ValueError("invalid relationship")
        if payload["kind"] == "summary" and payload.get("previousReply"):
            raise ValueError("previousReply is only valid for replies")
        return {**payload, "range": selected}

    def start_job(self, payload):
        request = self._validate_job(payload)
        scope = self._capture_scope(request["account"])
        with self.settings_lock:
            settings = self.settings()
            if not settings["ready"]:
                raise AssistantRequestError(409, "assistant-not-configured", "请先保存 AI 助手的模型设置。")
            config = self._connection({}, True)
            # ModelSourceStore represents missing optional values as None;
            # TypeScript ModelConfig uses omitted properties instead of null.
            config = {key: value for key, value in config.items() if value is not None}
            relationship = request.get("relationship", settings["defaultRelationship"])
            prompt = request.get("systemPrompt", settings["summaryPrompt"] if request["kind"] == "summary"
                                 else settings["relationshipPrompts"][relationship])
            revision = self.settings_revision
        with self.lock:
            if self.closed:
                raise AccountUnavailableError()
            if revision != self.settings_revision:
                raise AssistantRequestError(409, "settings-changed", "助手设置已变化，请重新生成。")
            if sum(job["status"] not in TERMINAL for job in self.jobs.values()) >= 3:
                raise AssistantRequestError(429, "assistant-busy", "已有 3 个助手任务，请先等待或取消任务。")
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "account": request["account"], "user": request["user"],
                   "kind": request["kind"], "range": request["range"], "relationship": relationship,
                   "status": "queued", "progress": {"phase": "reading", "completed": 0,
                   "total": 0, "messageCount": 0}, "text": "", "error": None,
                   "_scope": scope, "_cancel": threading.Event(), "_analyzer": None,
                   "_thread": None}
            self.jobs[job_id] = job
            self._trim_locked()
            thread = threading.Thread(target=self._run_job,
                args=(job, request, config, prompt), daemon=True, name="assistant-" + job_id[:8])
            job["_thread"] = thread
            initial = self._public(job)
            thread.start()
            return initial

    def _trim_locked(self):
        while len(self.jobs) > 24:
            candidate = next((key for key, value in self.jobs.items() if value["status"] in TERMINAL), None)
            if candidate is None:
                break
            self.jobs.pop(candidate)

    @staticmethod
    def _public(job):
        return copy.deepcopy({key: value for key, value in job.items() if not key.startswith("_")})

    def _check_active(self, job):
        if job["_cancel"].is_set() or self.closed:
            raise AccountChangedError()
        self._assert_scope(job["_scope"])
        if job["_cancel"].is_set():
            raise AccountChangedError()

    @staticmethod
    def _wire_message(item):
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or
                item.get("side") not in ("self", "other") or not isinstance(item.get("text"), str)):
            raise RuntimeError("invalid history message")
        text = item["text"]
        if item.get("kind", "text") != "text":
            kind = item.get("type") or {"image": "图片"}.get(item.get("kind"), "非文本消息")
            text = "[" + str(kind)[:64] + "；仅可见消息类型，未读取媒体内容]"
        message = {"id": item["id"], "side": item["side"], "text": text}
        stamp = item.get("time")
        if isinstance(stamp, (int, float)) and not isinstance(stamp, bool) and math.isfinite(stamp) and stamp >= 0:
            message["time"] = stamp
        if isinstance(item.get("senderName"), str):
            message["senderName"] = item["senderName"][:256]
        return message

    def _read_messages(self, job, request):
        self._check_active(job)
        source, user = self.backend.source, request["user"]
        recent_reader = getattr(source, "messages", None)
        if request["range"] == "recent" and callable(recent_reader):
            # The source brackets this bounded latest-window read with account
            # validation. Do not scan years of history just to reply to its tail.
            page = recent_reader(user, 80)
            self._check_active(job)
            messages = [self._wire_message(item) for item in page]
            if len({item["id"] for item in messages}) != len(messages):
                raise RuntimeError("duplicate history message")
            if not messages:
                raise AssistantRequestError(422, "empty-conversation", ERROR_MESSAGES["empty-conversation"])
            return messages, len(messages)
        highwater, after = source.history_highwater(user), None
        selected = deque(maxlen=80) if request["range"] == "recent" else []
        seen, scanned = set(), 0
        while highwater is not None:
            self._check_active(job)
            page, cursor = source.history_page(user, highwater, after, page_size=1000)
            self._check_active(job)
            for item in page:
                message = self._wire_message(item)
                if message["id"] in seen:
                    raise RuntimeError("duplicate history message")
                seen.add(message["id"])
                scanned += 1
                if request["range"] == "time":
                    if "time" not in message:
                        continue
                    if not request["fromMs"] <= message["time"] <= request["toMs"]:
                        continue
                selected.append(message)
            with self.lock:
                if not job["_cancel"].is_set():
                    job["status"] = "reading"
                    job["progress"] = {"phase": "reading", "completed": scanned, "total": 0,
                                       "messageCount": len(selected)}
            if cursor is None:
                break
            cursor = tuple(cursor)
            if (after is not None and cursor <= after) or cursor > tuple(highwater):
                raise RuntimeError("invalid history cursor")
            after = cursor
        if not selected:
            raise AssistantRequestError(422, "empty-conversation", ERROR_MESSAGES["empty-conversation"])
        return list(selected), scanned

    def _watch_scope(self, job, finished):
        while not finished.wait(.5):
            try:
                self._check_active(job)
            except Exception:
                self._cancel(job, "account-changed", purge=True)
                return

    def _run_job(self, job, request, config, prompt):
        analyzer, watcher, finished = None, None, threading.Event()
        try:
            messages, scanned = self._read_messages(job, request)
            self._check_active(job)
            with self.lock:
                if job["_cancel"].is_set() or self.closed:
                    return
                analyzer = self.analyzer_factory()
                job["_analyzer"] = analyzer
                job["status"] = "generating"
                job["messageCount"], job["scannedCount"] = len(messages), scanned
                job["progress"] = {"phase": "generate", "completed": 0, "total": 1,
                                   "messageCount": len(messages)}
            watcher = threading.Thread(target=self._watch_scope, args=(job, finished), daemon=True)
            watcher.start()

            def progress(value):
                with self.lock:
                    if job["_cancel"].is_set() or self.closed:
                        return
                    job["progress"] = {"phase": value.get("phase", "generate"),
                        "completed": value.get("completedCalls", 0), "total": value.get("totalCalls", 0),
                        "messageCount": len(messages),
                        "completedMessages": value.get("completedMessages", 0)}

            def delta(text):
                with self.lock:
                    if not job["_cancel"].is_set() and not self.closed and isinstance(text, str):
                        job["partialText"] = (job.get("partialText", "") + text)[:256000]

            self._check_active(job)
            result = analyzer.assistant_generate(config, request["kind"], messages, prompt,
                instructions=request.get("instructions", ""), previous_reply=request.get("previousReply", ""),
                on_progress=progress, on_delta=delta)
            self._check_active(job)
            if not isinstance(result, dict) or not isinstance(result.get("text"), str) or not result["text"].strip():
                raise RuntimeError("empty-response")
            if result.get("messageCount") != len(messages):
                raise RuntimeError("invalid assistant coverage")
            coverage = result.get("coverage")
            if (not isinstance(coverage, list) or [item.get("id") for item in coverage] !=
                    [item["id"] for item in messages] or any(type(item.get("parts")) is not int or
                    item["parts"] < 1 for item in coverage)):
                raise RuntimeError("invalid assistant coverage")
            with self.lock:
                if not job["_cancel"].is_set() and not self.closed:
                    job["status"], job["text"] = "completed", result["text"]
                    job.pop("partialText", None)
                    job["chunkCount"] = result.get("chunkCount", 1)
                    job["progress"]["completed"] = job["progress"]["total"]
                    job["progress"]["completedMessages"] = len(messages)
        except Exception as exc:
            with self.lock:
                if not job["_cancel"].is_set() and not self.closed:
                    code = ("account-changed" if isinstance(exc, (AccountChangedError, AccountUnavailableError))
                            else exc.code if isinstance(exc, AssistantRequestError) else
                            str(exc) if str(exc) in MODEL_CONNECTOR_ERRORS else "assistant-failed")
                    job["status"] = "cancelled" if code == "account-changed" else "failed"
                    job["text"] = ""
                    job.pop("partialText", None)
                    job["error"] = {"code": code, "message": ERROR_MESSAGES.get(code, ERROR_MESSAGES["assistant-failed"])}
        finally:
            finished.set()
            if analyzer is not None:
                analyzer.cancel()
            if watcher is not None:
                watcher.join(timeout=1)
            with self.lock:
                job["_analyzer"] = None

    def get_job(self, account, job_id):
        _account(account)
        if not isinstance(job_id, str) or len(job_id) != 32:
            raise ValueError("invalid assistant job id")
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job["account"] != account:
                raise AssistantRequestError(404, "assistant-job-not-found", "助手任务不存在。")
        try:
            self._assert_scope(job["_scope"])
        except (AccountChangedError, AccountUnavailableError):
            self._cancel_all("account-changed", account=job["account"], purge=True)
            raise AccountChangedError()
        with self.lock:
            return self._public(job)

    def _cancel(self, job, reason="cancelled", *, purge=False):
        with self.lock:
            job["_cancel"].set()
            if job["status"] not in TERMINAL or purge:
                job["status"] = "cancelled"
                job["text"] = ""
                job.pop("partialText", None)
                job["error"] = ({"code": reason, "message": ERROR_MESSAGES.get(reason, "助手任务已取消。")}
                                if reason != "cancelled" else None)
            analyzer = job["_analyzer"]
        if analyzer is not None:
            analyzer.cancel()

    def cancel_job(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"account", "id"}:
            raise ValueError("invalid assistant cancel request")
        account = _account(payload["account"])
        job_id = payload["id"]
        with self.lock:
            job = self.jobs.get(job_id) if isinstance(job_id, str) else None
            if job is None or job["account"] != account:
                raise AssistantRequestError(404, "assistant-job-not-found", "助手任务不存在。")
        self._cancel(job, purge=True)
        with self.lock:
            return self._public(job)

    def _cancel_all(self, reason, *, account=None, purge=False):
        with self.lock:
            jobs = [job for job in self.jobs.values() if account is None or job["account"] == account]
        for job in jobs:
            self._cancel(job, reason, purge=purge)

    def forget_account(self, account):
        self._cancel_all("account-forgotten", account=_account(account), purge=True)
        with self.lock:
            self.jobs = OrderedDict((key, job) for key, job in self.jobs.items() if job["account"] != account)

    def close(self):
        with self.lock:
            self.closed = True
            probes = list(self.probes)
            threads = [job["_thread"] for job in self.jobs.values()]
        self._cancel_all("service-closed", purge=True)
        for analyzer in probes:
            analyzer.cancel()
        deadline = time.monotonic() + 3
        for thread in threads:
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=max(0, deadline - time.monotonic()))
