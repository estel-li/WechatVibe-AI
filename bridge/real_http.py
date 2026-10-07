"""Loopback-only HTTP transport for the real-data chat UI."""
from __future__ import annotations

import json
import hmac
import mimetypes
import os
import re
import threading
import time
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from backend_contracts import ForecastRequestError, ROOT
from backend_service import Backend
from wechat_source import WeChatSource
from account_store import AccountConflict, AccountNotFound
from instance_identity import default_port, instance_id
from model_source import ModelSourceUnavailable
from ai_assistant import AssistantRequestError

CHATUI = ROOT / "chatui"
CONTROL_TOKEN_ENV = "WECHATVIBE_CONTROL_TOKEN"
CONTROL_TOKEN_HEADER = "X-WechatVibe-Control-Token"
REQUEST_READ_TIMEOUT = 10
REJECT_DRAIN_LIMIT = 2 * 1024 * 1024


def app_version():
    try:
        value = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version")
        return value if isinstance(value, str) and value else None
    except (OSError, ValueError, AttributeError):
        return None


APP_VERSION = app_version()
JAVASCRIPT_SUFFIXES = {".js", ".mjs"}
JAVASCRIPT_MIME = "text/javascript; charset=utf-8"


def static_content_type(name):
    """Return a stable MIME type for files served to the browser.

    On Windows, ``mimetypes.guess_type`` can inherit a registry mapping that
    incorrectly reports JavaScript as ``text/plain``.  With ``nosniff`` that
    prevents the browser from executing the application bundle, so script
    types must be selected independently of the host registry.
    """
    if Path(name).suffix.lower() in JAVASCRIPT_SUFFIXES:
        return JAVASCRIPT_MIME
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def integer(value, default, maximum):
    if value is None:
        return default
    if (isinstance(value, bool) or not isinstance(value, (int, str)) or
            re.fullmatch(r"[0-9]{1,10}", str(value)) is None):
        raise ValueError("invalid limit")
    result = int(value)
    if not 1 <= result <= maximum:
        raise ValueError("limit out of range")
    return result


def user_value(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or any(ord(char) < 32 for char in value):
        raise ValueError("invalid user")
    return value


def request_id_value(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(ord(char) < 32 for char in value):
        raise ValueError("invalid requestId")
    return value


def make_handler(backend, accounts=None, control_token=None):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            # A client that stops partway through a request must not retain a
            # request lease (and block account cleanup/shutdown) indefinitely.
            self.connection.settimeout(REQUEST_READ_TIMEOUT)
            self._body_consumed = False

        def log_message(self, *_args):
            pass

        def trusted_request(self):
            port = self.server.server_port
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            origins = {f"http://{host}" for host in hosts}
            origin = self.headers.get("Origin")
            return (len(self.headers.get_all("Host", [])) == 1 and
                    len(self.headers.get_all("Origin", [])) <= 1 and
                    self.headers.get("Host") in hosts and
                    (origin is None or origin in origins) and
                    self.path.startswith("/") and not self.path.startswith("//"))

        def discard_body(self):
            """Drain a bounded rejected body before closing the HTTP/1.0 socket.

            Closing with unread bytes resets the connection on Windows, hiding
            the useful JSON error from clients still transmitting a larger body.
            Ambiguous framing is never consumed and oversized inputs remain bounded.
            """
            if self._body_consumed:
                return
            self._body_consumed = True
            lengths = self.headers.get_all("Content-Length", [])
            if (len(lengths) != 1 or self.headers.get_all("Transfer-Encoding") or
                    re.fullmatch(r"[0-9]{1,10}", lengths[0]) is None):
                return
            try:
                self.read_body(min(int(lengths[0]), REJECT_DRAIN_LIMIT), discard=True)
            except (TimeoutError, OSError):
                self.close_connection = True

        def read_body(self, length, *, discard=False):
            remaining, chunks = length, []
            deadline = time.monotonic() + REQUEST_READ_TIMEOUT
            try:
                while remaining:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        raise TimeoutError("request body deadline exceeded")
                    self.connection.settimeout(timeout)
                    # read1 returns after one underlying read; read(length)
                    # internally loops and lets a trickling sender renew its
                    # socket timeout forever without completing the request.
                    chunk = self.rfile.read1(min(remaining, 65536))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    if not discard:
                        chunks.append(chunk)
            finally:
                self.connection.settimeout(REQUEST_READ_TIMEOUT)
            return b"" if discard else b"".join(chunks)

        def reject(self, status, body):
            self.discard_body()
            return self.send(status, body)

        def json_body(self, maximum):
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get_all("Transfer-Encoding"):
                raise ValueError("invalid body framing")
            try:
                length = integer(lengths[0], None, maximum)
            except ValueError:
                self.discard_body()
                raise
            try:
                raw = self.read_body(length)
            except (TimeoutError, OSError) as exc:
                self._body_consumed = True
                raise ValueError("incomplete request body") from exc
            self._body_consumed = True
            if len(raw) != length:
                raise ValueError("incomplete request body")
            return json.loads(raw.decode("utf-8"))

        def send(self, status, body, content_type="application/json; charset=utf-8"):
            payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
                # Switching chats cancels obsolete requests. There is no client left to
                # receive a second 503 response; retain the successfully read result.
                self.close_connection = True

        def query(self, path):
            query = parse_qs(path.query, keep_blank_values=True, max_num_fields=64)
            if any(len(values) != 1 for values in query.values()):
                raise ValueError("duplicate query parameter")
            return {key: values[0] for key, values in query.items()}

        def do_GET(self):
            lease = getattr(backend, "request_lease", None)
            reader_scope = getattr(getattr(backend, "source", None), "request_scope", None)
            try:
                with lease() if callable(lease) else nullcontext():
                    with reader_scope() if callable(reader_scope) else nullcontext():
                        return self._do_GET()
            except RuntimeError:
                return self.send(503, {"error": "bridge-closing"})

        def _do_GET(self):
            if not self.trusted_request():
                return self.send(403, {"error": "forbidden"})
            parsed = urlsplit(self.path)
            try:
                query = self.query(parsed)
                if parsed.path == "/api/assistant/settings":
                    return self.send(200, backend.assistant_service().settings())
                if parsed.path == "/api/assistant/jobs":
                    return self.send(200, backend.assistant_service().get_job(
                        user_value(query.get("account")), request_id_value(query.get("id"))))
                if parsed.path == "/api/health":
                    return self.send(200, {**backend.health(), "instanceId": instance_id(ROOT),
                                           "appVersion": APP_VERSION})
                if parsed.path == "/api/runtime":
                    return self.send(200, backend.runtime())
                if parsed.path == "/api/local-model":
                    return self.send(200, backend.local_model_status())
                if parsed.path == "/api/data-root":
                    return self.send(200, backend.data_root_status())
                if parsed.path == "/api/model-source":
                    try:
                        return self.send(200, backend.model_source())
                    except Exception:
                        return self.send(503, {"error": "model source unavailable"})
                if parsed.path == "/api/model-insights":
                    raw_ids = query.get("ids")
                    ids = None
                    if raw_ids is not None:
                        ids = json.loads(raw_ids)
                        if not isinstance(ids, list):
                            raise ValueError("invalid API insight ids")
                    return self.send(200, backend.model_insights(user_value(query.get("user")), ids))
                if parsed.path == "/api/model-portrait":
                    member = query.get("member")
                    return self.send(200, backend.model_portrait(user_value(query.get("user")),
                                                                 user_value(member) if member else None))
                if parsed.path == "/api/analysis-cache":
                    return self.send(200, backend.analysis_cache_status())
                if parsed.path == "/api/sessions":
                    data = backend.source.sessions()
                    if accounts is not None:
                        accounts.observe(data)
                    return self.send(200, data)
                if parsed.path == "/api/conversation-selection":
                    return self.send(200, backend.conversation_selection())
                if parsed.path == "/api/analysis-workers":
                    return self.send(200, backend.worker_status())
                if parsed.path == "/api/analysis-overview":
                    return self.send(200, backend.analysis_overview())
                if parsed.path == "/api/analysis-performance":
                    return self.send(200, backend.analysis_performance())
                if parsed.path == "/api/accounts" and accounts is not None:
                    return self.send(200, accounts.list())
                if parsed.path == "/api/messages":
                    return self.send(200, backend.messages(user_value(query.get("user")), integer(query.get("limit"), 80, 500)))
                if parsed.path == "/api/history":
                    return self.send(200, backend.history(
                        user_value(query.get("account")), user_value(query.get("user")),
                        before=query.get("before"), around=query.get("around"),
                        limit=integer(query.get("limit"), 80, 200)))
                if parsed.path == "/api/history/search":
                    return self.send(200, backend.history_search(
                        user_value(query.get("account")), user_value(query.get("user")),
                        query=query.get("q"), day=query.get("date"),
                        before=query.get("before"), limit=integer(query.get("limit"), 50, 100)))
                if parsed.path == "/api/analysis":
                    # Background readers pass focus=0 so they cannot move the queue's focus
                    # away from the conversation the user is looking at.
                    return self.send(200, backend.analysis(user_value(query.get("user")),
                                                           focus=query.get("focus") != "0"))
                if parsed.path == "/api/profile":
                    member = query.get("member")
                    return self.send(200, backend.profile(user_value(query.get("user")),
                        user_value(member) if member else None, retry=query.get("retry") == "1"))
                if parsed.path == "/api/media":
                    image = backend.source.media(user_value(query.get("user")), user_value(query.get("id")))
                    return self.send(200, image[0], image[1]) if image else self.send(404, {
                        "error": "media unavailable",
                        "reason": getattr(getattr(backend.source, "media_reason", None), "value", None)})
                if parsed.path.startswith("/api/"):
                    return self.send(404, {"error": "not found"})
                target = (CHATUI / (parsed.path.lstrip("/") or "index.html")).resolve()
                if not target.is_relative_to(CHATUI.resolve()) or not target.is_file():
                    return self.send(404, {"error": "not found"})
                mime = static_content_type(target.name)
                return self.send(200, target.read_bytes(), mime)
            except AssistantRequestError as exc:
                return self.send(exc.status, {"error": exc.code, "message": exc.message})
            except ValueError as exc:
                if parsed.path.startswith("/api/assistant/"):
                    return self.send(400, {"error": "invalid-assistant-request", "message": "AI 助手请求格式不正确"})
                return self.send(400, {"error": str(exc)})
            except Exception as exc:
                if parsed.path.startswith("/api/assistant/"):
                    return self.send(503, {"error": "assistant-unavailable", "message": "AI 助手暂不可用，请重试"})
                return self.send(503, {"error": type(exc).__name__, "message": "本地服务暂不可用，请稍后重试"})

        def do_POST(self):
            lease = getattr(backend, "request_lease", None)
            reader_scope = getattr(getattr(backend, "source", None), "request_scope", None)
            try:
                with lease() if callable(lease) else nullcontext():
                    with reader_scope() if callable(reader_scope) else nullcontext():
                        return self._do_POST()
            except RuntimeError:
                return self.send(503, {"error": "bridge-closing"})

        def _do_POST(self):
            if not self.trusted_request():
                return self.reject(403, {"error": "forbidden"})
            endpoint = urlsplit(self.path).path
            if endpoint == "/api/control/shutdown":
                supplied = self.headers.get(CONTROL_TOKEN_HEADER, "")
                if (self.client_address[0] != "127.0.0.1" or
                        not isinstance(control_token, str) or
                        re.fullmatch(r"[0-9a-f]{64}", control_token) is None or
                        not hmac.compare_digest(supplied, control_token)):
                    return self.reject(403, {"error": "forbidden"})
                if self.path != endpoint or self.headers.get("Content-Length") != "0":
                    return self.reject(400, {"error": "invalid control request"})
                self.send(202, {"stopping": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            model_endpoints = ("/api/model-source/list", "/api/model-source/test",
                               "/api/model-source/activate", "/api/model-source/clear-key")
            assistant_endpoints = ("/api/assistant/settings", "/api/assistant/models",
                                   "/api/assistant/test", "/api/assistant/jobs", "/api/assistant/cancel")
            if endpoint not in ("/api/analyze", "/api/predict-reply", "/api/messages/batch",
                                 "/api/runtime", "/api/local-model", "/api/model-insights",
                                 "/api/model-portrait", "/api/analysis-cache/clear",
                                 "/api/analysis-cache/resume", "/api/conversation-selection",
                                 "/api/data-root", "/api/data-root/clear",
                                 "/api/analysis-workers",
                                 *model_endpoints, *assistant_endpoints):
                return self.reject(404, {"error": "not found"})
            content_type = [part.strip().lower() for part in self.headers.get("Content-Type", "").split(";")]
            if content_type[0] != "application/json" or any(part != "charset=utf-8" for part in content_type[1:]):
                return self.reject(415, {"error": "application/json required"})
            echo = {}
            try:
                request = self.json_body(1048576 if endpoint == "/api/assistant/settings" else
                                         262144 if endpoint in assistant_endpoints else 65536)
                if not isinstance(request, dict) or "texts" in request:
                    raise ValueError("invalid request")
                if endpoint in assistant_endpoints:
                    service = backend.assistant_service()
                    if endpoint == "/api/assistant/settings":
                        return self.send(200, service.save_settings(request))
                    if endpoint == "/api/assistant/models":
                        return self.send(200, service.list_models(request))
                    if endpoint == "/api/assistant/test":
                        return self.send(200, service.test_model(request))
                    if endpoint == "/api/assistant/cancel":
                        return self.send(200, service.cancel_job(request))
                    return self.send(202, service.start_job(request))
                if endpoint in model_endpoints:
                    try:
                        if endpoint == "/api/model-source/list":
                            return self.send(200, backend.model_source_list(request))
                        if endpoint == "/api/model-source/test":
                            return self.send(200, backend.model_source_test(request))
                        if endpoint == "/api/model-source/activate":
                            return self.send(200, backend.model_source_activate(request))
                        return self.send(200, backend.model_source_clear_key(request))
                    except ValueError:
                        return self.send(400, {"error": "invalid model source request"})
                    except ModelSourceUnavailable as exc:
                        return self.send(503, {"error": str(exc)})
                    except Exception:
                        return self.send(503, {"error": "model source unavailable"})
                if endpoint == "/api/analysis-workers":
                    workers = request.get("workers")
                    if workers is not None and (type(workers) is not int or not 1 <= workers <= 4):
                        raise ValueError("invalid worker count")
                    elastic = request.get("elastic")
                    if elastic is not None and type(elastic) is not bool:
                        raise ValueError("invalid elastic flag")
                    return self.send(200, backend.set_worker_settings(workers, elastic))
                if endpoint == "/api/conversation-selection":
                    if set(request) == {"expectedAccount", "all"} and request["all"] is True:
                        return self.send(200, backend.set_conversation_all_selected(
                            user_value(request["expectedAccount"])))
                    if set(request) != {"expectedAccount", "session", "selected"} or type(request["selected"]) is not bool:
                        raise ValueError("invalid conversation selection")
                    return self.send(200, backend.set_conversation_selected(
                        user_value(request["expectedAccount"]), user_value(request["session"]),
                        request["selected"]))
                if endpoint == "/api/runtime":
                    if set(request) != {"provider"} or request["provider"] not in ("cpu", "gpu"):
                        raise ValueError("invalid provider")
                    return self.send(200, backend.configure_runtime(request["provider"]))
                if endpoint == "/api/local-model":
                    value = request.get("path")
                    if set(request) != {"path"} or not isinstance(value, str) or not 1 <= len(value) <= 4096 or any(ord(char) < 32 for char in value):
                        raise ValueError("invalid model path")
                    return self.send(200, backend.configure_local_model(value))
                if endpoint == "/api/data-root":
                    if set(request) != {"path"}:
                        raise ValueError("invalid data root request")
                    return self.send(200, backend.configure_data_root(request["path"]))
                if endpoint == "/api/data-root/clear":
                    if request:
                        raise ValueError("invalid data root request")
                    return self.send(200, backend.clear_data_root())
                if endpoint == "/api/model-insights":
                    account = user_value(request.get("account"))
                    user = user_value(request.get("user"))
                    # API insight experiments send the bounded sample as one provider
                    # request. Keep this transport cap aligned with the analyzer's
                    # per-request target cap instead of silently forcing two-target
                    # batches.
                    limit = integer(request.get("limit"), 500, 500)
                    around = request.get("around")
                    return self.send(202, backend.start_model_insights(
                        account, user, limit, request.get("targetIds"), around))
                if endpoint == "/api/model-portrait":
                    if set(request) not in ({"account", "user"},
                                            {"account", "user", "member"},
                                            {"account", "user", "refreshAxes"},
                                            {"account", "user", "member", "refreshAxes"}):
                        raise ValueError("invalid portrait request")
                    member = request.get("member")
                    refresh_axes = request.get("refreshAxes", False)
                    if type(refresh_axes) is not bool:
                        raise ValueError("invalid portrait request")
                    return self.send(202, backend.start_model_portrait(
                        user_value(request.get("account")), user_value(request.get("user")),
                        user_value(member) if member is not None else None,
                        refresh_axes=refresh_axes))
                if endpoint in ("/api/analysis-cache/clear", "/api/analysis-cache/resume"):
                    if set(request) != {"account", "sourceId"}:
                        raise ValueError("invalid cache request")
                    account = user_value(request.get("account"))
                    source_id = user_value(request.get("sourceId"))
                    result = (backend.analysis_cache_clear(account, source_id)
                              if endpoint.endswith("/clear") else
                              backend.analysis_cache_resume(account, source_id))
                    return self.send(200, result)
                if endpoint == "/api/messages/batch":
                    account = user_value(request.get("account"))
                    users = request.get("users")
                    if not isinstance(users, list) or not 1 <= len(users) <= 64:
                        raise ValueError("invalid users")
                    users = [user_value(user) for user in users]
                    if len(set(users)) != len(users):
                        raise ValueError("duplicate users")
                    return self.send(200, backend.message_windows(account, users))
                if endpoint == "/api/predict-reply":
                    echo = {key: request[key] for key in ("user", "account", "requestId")
                            if isinstance(request.get(key), str)}
                    user = user_value(request.get("user"))
                    account = user_value(request.get("account"))
                    request_id = request_id_value(request.get("requestId"))
                    draft = request.get("draft", "")
                    if not isinstance(draft, str) or len(draft) > 2000:
                        raise ValueError("invalid draft")
                    expected = request.get("expectedLastMessageId")
                    if expected is not None:
                        expected = user_value(expected)
                    member = request.get("member")
                    if member is not None:
                        member = user_value(member)
                    return self.send(200, backend.predict_reply(user, account, request_id, draft, expected, member))
                user = user_value(request.get("user"))
                expected_account = user_value(request.get("account"))
                mode = request.get("mode")
                if mode not in ("recent", "history", "incremental"):
                    raise ValueError("invalid mode")
                limit = (None if mode == "incremental" else
                         "all" if mode == "history" and request.get("limit") == "all" else
                         integer(request.get("limit"), 80 if mode == "recent" else 500,
                                 80 if mode == "recent" else 5000))
                return self.send(202, {"job": backend.start(user, mode, limit,
                                                             expected_account=expected_account)})
            except AssistantRequestError as exc:
                return self.send(exc.status, {"error": exc.code, "message": exc.message})
            except ForecastRequestError as exc:
                return self.send(exc.status, {**echo, "error": exc.code, "message": exc.message})
            except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
                if endpoint.startswith("/api/assistant/"):
                    return self.send(400, {"error": "invalid-assistant-request", "message": "AI 助手请求格式不正确"})
                return self.send(400, {**echo, "error": str(exc)})
            except Exception as exc:
                if endpoint.startswith("/api/assistant/"):
                    return self.send(503, {"error": "assistant-unavailable", "message": "AI 助手暂不可用，请重试"})
                return self.send(503, {**echo, "error": type(exc).__name__, "message": "本地服务暂不可用，请稍后重试"})

        def do_DELETE(self):
            if not self.trusted_request():
                return self.send(403, {"error": "forbidden"})
            path = urlsplit(self.path).path
            prefix = "/api/accounts/"
            if accounts is None or not path.startswith(prefix):
                return self.send(404, {"error": "not found"})
            try:
                result = accounts.delete(path[len(prefix):])
                try:
                    return self.send(200, result)
                finally:
                    if result.get("exitApp"):
                        threading.Thread(target=self.server.shutdown, daemon=True).start()
            except AccountConflict as exc:
                return self.send(409, {"error": "account-busy", "message": str(exc)})
            except AccountNotFound as exc:
                return self.send(404, {"error": "account-not-found", "message": str(exc)})
            except ValueError:
                return self.send(400, {"error": "invalid-account"})
            except OSError:
                return self.send(409, {"error": "account-busy", "message": "账号缓存正在使用，请稍后重试"})
            except Exception:
                return self.send(503, {"error": "account-unavailable", "message": "暂时无法清理账号数据，请稍后重试"})

    return Handler


def main(classifier):
    from account_api import AccountAPI
    from data_root_source import DataRootSource
    control_token = os.environ.pop(CONTROL_TOKEN_ENV, None)
    data_root_store = DataRootSource(ROOT)
    data_root_store.apply()
    backend = Backend(WeChatSource(classifier=classifier), data_root_store=data_root_store)
    port = integer(os.environ.get("CHATUI_PORT"), default_port(ROOT), 65535)
    accounts = AccountAPI(backend, ROOT / ".local" / "real-client-data")
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(backend, accounts, control_token))
    print(f"chatui server on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        backend.shutdown()
    return 0
