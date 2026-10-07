"""Assistant settings, whole-history snapshots and cancellation using synthetic data."""
import hashlib
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

from ai_assistant import (AssistantRequestError, AssistantService, DEFAULT_PROMPTS,
                          DEFAULT_SUMMARY_PROMPT, RELATIONSHIPS)
from backend_contracts import AccountChangedError
from chat_server import classify
from model_source import ModelSourceStore
from wechat_source import WeChatSource


class Source:
    def __init__(self, root):
        self.account, self.workdir = "synthetic-a", str(root)
        self.rows, self.pages, self.page_hook = [], 0, None
        self.users = []

    def identity(self):
        return self.account, self.workdir

    def history_highwater(self, user):
        self.users.append(user)
        return tuple(self.rows[-1]["_sort"]) if self.rows else None

    def history_page(self, user, highwater, after=None, page_size=1000):
        self.pages += 1
        self.users.append(user)
        if self.page_hook:
            self.page_hook(self.pages)
        rows = [item for item in self.rows if tuple(item["_sort"]) <= highwater and
                (after is None or tuple(item["_sort"]) > after)][:page_size]
        return [item for item in rows if item.get("kind") != "system"], (
            tuple(rows[-1]["_sort"]) if rows else None)

    def add(self, count, start=0, kind="text"):
        for index in range(start, start + count):
            self.rows.append({"id": "m" + str(index), "side": "self" if index % 2 else "other",
                              "kind": kind, "text": "synthetic " + str(index),
                              "time": 1700000000000 + index * 1000,
                              "_sort": (index, "message__message_0.db", index),
                              "senderName": "合成朋友"})


class Analyzer:
    def __init__(self):
        self.calls, self.cancelled = [], 0
        self.entered, self.release, self.fail, self.bad_coverage = None, None, None, False

    def assistant_generate(self, config, kind, messages, prompt, **kwargs):
        self.calls.append((config, kind, messages, prompt, kwargs))
        if self.entered:
            self.entered.set()
            self.release.wait(timeout=5)
        if self.fail:
            raise RuntimeError(self.fail)
        kwargs["on_progress"]({"phase": "map", "completedCalls": 2, "totalCalls": 3,
                                "completedMessages": len(messages), "totalMessages": len(messages)})
        kwargs["on_delta"]("部分合成结果")
        return {"text": "最终合成结果", "messageCount": len(messages), "chunkCount": 3,
                "coverage": [{"id": item["id"], "parts": 1} for item in
                             (messages[:-1] if self.bad_coverage else messages)]}

    def model_list(self, protocol, base_url, key):
        self.calls.append((protocol, base_url, key))
        return {"models": [{"id": "synthetic-model"}], "supported": True}

    def model_test(self, protocol, base_url, key, model):
        self.calls.append((protocol, base_url, key, model))
        return {"ok": True, "latencyMs": 3}

    def cancel(self):
        self.cancelled += 1
        if self.release:
            self.release.set()


class AssistantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = Source(self.root)
        self.backend = SimpleNamespace(source=self.source, closing=False)
        self.analyzers, self.next_analyzer = [], None
        self.store = ModelSourceStore(self.root / ".local/real-client-runtime/assistant-model-source.json",
            root=self.root, protect=lambda text: b"protected:" + text[::-1].encode(),
            unprotect=lambda value: value[len(b"protected:"):].decode()[::-1])

        def factory():
            analyzer = self.next_analyzer or Analyzer()
            self.next_analyzer = None
            self.analyzers.append(analyzer)
            return analyzer

        self.service = AssistantService(self.backend, root=self.root, store=self.store,
                                         analyzer_factory=factory)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def configure(self):
        return self.service.save_settings({"apiKey": "synthetic-secret"})

    def start(self, **overrides):
        return self.service.start_job({"account": self.source.account, "user": "friend-a",
                                       "kind": "summary", "range": "all", **overrides})

    def wait(self, job):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            result = self.service.get_job(job["account"], job["id"])
            if result["status"] in ("completed", "failed", "cancelled"):
                return result
            time.sleep(.01)
        self.fail("assistant job did not finish")

    def blocked(self):
        analyzer = Analyzer()
        analyzer.entered, analyzer.release = threading.Event(), threading.Event()
        self.next_analyzer = analyzer
        job = self.start()
        self.assertTrue(analyzer.entered.wait(timeout=2))
        return job, analyzer

    def test_settings_are_side_effect_free_and_independent(self):
        settings = self.service.settings()
        self.assertEqual(settings["model"], "deepseek-flash")
        self.assertEqual(settings["contextTokens"], 1000000)
        self.assertFalse(settings["contextUpgradeAvailable"])
        self.assertFalse(settings["hasKey"])
        self.assertFalse(settings["ready"])
        self.assertEqual(set(settings["relationshipPrompts"]), set(RELATIONSHIPS))
        self.assertEqual(len(set(settings["relationshipPrompts"].values())), 6)
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.analyzers, [])

    def test_save_encrypts_key_and_preserves_blank_on_same_endpoint(self):
        settings = self.configure()
        self.assertTrue(settings["hasKey"])
        self.assertNotIn("apiKey", settings)
        self.assertNotIn("synthetic-secret", self.store.path.read_text())
        self.service.save_settings({"apiKey": "", "model": "another-model"})
        self.assertEqual(self.service._connection({}, True)["apiKey"], "synthetic-secret")
        self.assertFalse((self.store.path.parent / "api-model-source.json").exists())

    def test_key_not_reused_for_another_endpoint(self):
        self.configure()
        self.service.save_settings({"preset": "custom", "baseUrl": "https://other.example/v1"})
        self.assertFalse(self.service.settings()["hasKey"])
        self.assertIsNone(self.service._connection({}, True)["apiKey"])

    def test_official_missing_context_advances_without_rewriting_or_decrypting_profile(self):
        self.store.save_api("chat_completions", "https://api.deepseek.com", "deepseek-flash",
                            "synthetic-secret", context_tokens=None)
        before = self.store.path.read_bytes()
        def never_decrypt(_value):
            self.fail("settings read decrypted a key")
        self.store.unprotect = never_decrypt
        settings = self.service.settings()
        self.assertEqual(settings["contextTokens"], 1000000)
        self.assertFalse(settings["contextUpgradeAvailable"])
        self.assertTrue(settings["hasKey"])
        self.assertEqual(self.store.path.read_bytes(), before)
        self.assertEqual(self.analyzers, [])

    def test_legacy_official_numeric_context_preserved_until_user_explicitly_upgrades(self):
        self.store.save_api("chat_completions", "https://api.deepseek.com/v1", "deepseek-v4-pro",
                            "synthetic-secret", context_tokens=65536)
        before = self.store.path.read_bytes()
        source_id = self.store.saved_selection()["sourceId"]
        settings = self.service.settings()
        self.assertEqual(settings["contextTokens"], 65536)
        self.assertTrue(settings["contextUpgradeAvailable"])
        self.assertEqual(self.store.path.read_bytes(), before)
        self.service.save_settings({"summaryPrompt": "新版总结提示"})
        self.assertEqual(self.service.settings()["contextTokens"], 65536)
        self.assertTrue(self.service.settings()["contextUpgradeAvailable"])
        self.service.save_settings({"contextTokens": 1000000})
        self.assertEqual(self.service.settings()["contextTokens"], 1000000)
        self.assertFalse(self.service.settings()["contextUpgradeAvailable"])
        self.assertEqual(self.service._connection({}, True)["apiKey"], "synthetic-secret")
        self.assertEqual(self.store.saved_selection()["sourceId"], source_id)

    def test_explicit_capacity_custom_hosts_models_and_retired_ids_are_not_upgraded(self):
        variants = [
            ("deepseek", "https://api.deepseek.com", "deepseek-flash", 32768),
            ("deepseek", "https://api.deepseek.com", "deepseek-flash", 131072),
            ("custom", "https://api.deepseek.com", "deepseek-flash", 65536),
            ("deepseek", "https://custom.example/v1", "deepseek-flash", 65536),
            ("deepseek", "https://api.deepseek.com", "custom-model", 65536),
            ("deepseek", "https://api.deepseek.com", "deepseek-chat", 65536),
            ("deepseek", "https://api.deepseek.com", "deepseek-reasoner", 65536),
            ("custom", "http://127.0.0.1:8080/v1", "custom-model", None),
        ]
        for preset, base_url, model, context in variants:
            with self.subTest(preset=preset, base=base_url, model=model, context=context):
                self.service.save_settings({"preset": preset, "baseUrl": base_url, "model": model,
                                            "contextTokens": context})
                before = self.store.path.read_bytes()
                settings = self.service.settings()
                self.assertEqual(settings["contextTokens"], context)
                self.assertFalse(settings["contextUpgradeAvailable"])
                self.assertEqual(self.store.path.read_bytes(), before)

    def test_first_custom_configuration_without_capacity_keeps_previous_safe_default(self):
        settings = self.service.save_settings({"preset": "custom", "baseUrl": "https://custom.example/v1",
                                               "model": "custom-model"})
        self.assertEqual(settings["contextTokens"], 65536)
        self.assertFalse(settings["contextUpgradeAvailable"])

    def test_clear_key_does_not_reuse_old_ciphertext(self):
        self.configure()
        self.service.save_settings({"clearKey": True})
        self.assertFalse(self.service.settings()["hasKey"])
        self.assertIsNone(self.service._connection({}, True)["apiKey"])

    def test_edit_every_relationship_and_summary_prompt_survives_restart(self):
        prompts = {key: "自定义提示 " + key for key in RELATIONSHIPS}
        self.service.save_settings({"summaryPrompt": "我的总结规则", "relationshipPrompts": prompts,
                                    "defaultRelationship": "elder", "apiKey": "synthetic-secret"})
        recreated = AssistantService(self.backend, root=self.root, store=self.store,
                                       analyzer_factory=lambda: self.fail("settings launched a model"))
        self.addCleanup(recreated.close)
        settings = recreated.settings()
        self.assertEqual(settings["relationshipPrompts"], prompts)
        self.assertEqual(settings["summaryPrompt"], "我的总结规则")
        self.assertEqual(settings["defaultRelationship"], "elder")

    def test_invalid_settings_do_not_mutate_existing_key_or_prompts(self):
        self.configure()
        before = self.store.path.read_bytes()
        invalid = [{"relationshipPrompts": {"friend": "x"}}, {"contextTokens": True},
                   {"summaryPrompt": ""}, {"baseUrl": "https://user:pass@example.com"},
                   {"clearKey": True, "apiKey": "new-secret"}, {"apiKey": 2},
                   {"hasKey": True}]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.service.save_settings(payload)
            self.assertEqual(self.store.path.read_bytes(), before)

    def test_explicit_probes_do_not_activate_automatic_analysis_or_save_config(self):
        listed = self.service.list_models({"apiKey": "one-use"})
        tested = self.service.test_model({"apiKey": "one-use"})
        self.assertEqual(listed["models"], [{"id": "synthetic-model"}])
        self.assertTrue(tested["ok"])
        self.assertEqual(self.analyzers[0].calls[0][2], "one-use")
        self.assertEqual(len(self.analyzers), 2)
        self.assertTrue(all(worker.cancelled for worker in self.analyzers))
        self.assertFalse(self.store.path.exists())

    def test_key_free_local_job_omits_null_optional_fields_for_node(self):
        self.service.save_settings({"preset": "custom", "baseUrl": "http://127.0.0.1:8080/v1",
                                    "contextTokens": None})
        self.source.add(2)
        result = self.wait(self.start())
        self.assertEqual(result["status"], "completed")
        config = self.analyzers[0].calls[0][0]
        self.assertNotIn("apiKey", config)
        self.assertNotIn("contextTokens", config)

    def test_whole_conversation_reads_all_pages_and_reports_exact_coverage(self):
        self.configure()
        self.source.add(2605)
        result = self.wait(self.start())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["messageCount"], 2605)
        self.assertEqual(result["scannedCount"], 2605)
        self.assertEqual(len(self.analyzers[0].calls[0][2]), 2605)
        self.assertGreaterEqual(self.source.pages, 3)
        self.assertEqual(self.analyzers[0].calls[0][3], DEFAULT_SUMMARY_PROMPT)
        self.assertEqual(set(self.source.users), {"friend-a"})
        self.assertNotIn("partialText", result)

    def test_snapshot_does_not_include_later_arrivals(self):
        self.configure()
        self.source.add(1005)
        self.source.page_hook = lambda page: self.source.add(5, 1005) if page == 1 else None
        result = self.wait(self.start())
        self.assertEqual(result["messageCount"], 1005)
        self.assertEqual(len(self.source.rows), 1010)

    def test_empty_rendered_page_advances_cursor_instead_of_truncating(self):
        self.configure()
        self.source.add(1000, kind="system")
        self.source.add(7, start=1000)
        result = self.wait(self.start())
        self.assertEqual(result["messageCount"], 7)
        self.assertEqual(result["status"], "completed")

    def test_time_range_is_inclusive_at_both_bounds(self):
        self.configure()
        self.source.add(2005)
        result = self.wait(self.start(range="time", fromMs=1700000999000, toMs=1700001001000))
        self.assertEqual(result["messageCount"], 3)
        self.assertEqual([item["id"] for item in self.analyzers[0].calls[0][2]], ["m999", "m1000", "m1001"])

    def test_empty_or_unmatched_time_range_never_calls_provider(self):
        self.configure()
        self.source.add(5)
        result = self.wait(self.start(range="time", fromMs=0, toMs=1))
        self.assertEqual(result["error"]["code"], "empty-conversation")
        self.assertEqual(self.analyzers, [])
        self.source.rows = []
        self.assertEqual(self.wait(self.start())["error"]["code"], "empty-conversation")

    def test_recent_reply_uses_last80_context_and_relationship_prompt(self):
        self.configure()
        self.source.add(1002)
        result = self.wait(self.start(kind="reply", range="recent", relationship="colleague",
                                      instructions="先确认时间", previousReply="旧的回复"))
        call = self.analyzers[0].calls[0]
        self.assertEqual(result["messageCount"], 80)
        self.assertEqual(call[2][0]["id"], "m922")
        self.assertEqual(call[3], DEFAULT_PROMPTS["colleague"])
        self.assertEqual(call[4]["previous_reply"], "旧的回复")
        self.assertEqual(call[4]["instructions"], "先确认时间")

    def test_custom_reply_prompt_and_regeneration_are_new_explicit_calls(self):
        self.configure()
        self.source.add(3)
        first = self.wait(self.start(kind="reply", range="all", relationship="custom", systemPrompt="请用粤语"))
        second = self.wait(self.start(kind="reply", range="all", relationship="custom", systemPrompt="请用粤语",
                                     previousReply=first["text"]))
        self.assertEqual(second["status"], "completed")
        self.assertEqual(len(self.analyzers), 2)
        self.assertEqual(self.analyzers[1].calls[0][3], "请用粤语")

    def test_recent_native_window_avoids_whole_history_scan(self):
        self.configure()
        self.source.add(3005)
        requested = []
        def recent(user, limit):
            requested.append((user, limit))
            return self.source.rows[-limit:]
        self.source.messages = recent
        result = self.wait(self.start(kind="reply", range="recent"))
        self.assertEqual(result["messageCount"], 80)
        self.assertEqual(requested, [("friend-a", 80)])
        self.assertEqual(self.source.pages, 0)
        self.assertEqual(self.analyzers[0].calls[0][2][0]["id"], "m2925")

    def test_media_is_counted_with_honest_placeholder_without_bytes_or_urls(self):
        self.configure()
        self.source.add(1, kind="image")
        self.source.rows[0]["text"] = "https://private.example/secret-media"
        result = self.wait(self.start())
        text = self.analyzers[0].calls[0][2][0]["text"]
        self.assertEqual(result["messageCount"], 1)
        self.assertIn("未读取媒体内容", text)
        self.assertNotIn("secret-media", text)

    def test_input_validation_rejects_invalid_bounds_relationship_and_unknown_fields(self):
        self.configure()
        for payload in ({"kind": "other"}, {"range": "recent"}, {"range": "time"},
                        {"range": "time", "fromMs": 3, "toMs": 1},
                        {"range": "time", "fromMs": True, "toMs": 1},
                        {"fromMs": 1}, {"relationship": "lover"}, {"member": "somebody"},
                        {"systemPrompt": ""}, {"previousReply": "not reply"}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.start(**payload)
        self.assertEqual(self.analyzers, [])

    def test_account_mismatch_rejected_before_work_and_poll_cannot_read_another_account(self):
        self.configure()
        self.source.add(3)
        with self.assertRaises(AccountChangedError):
            self.start(account="synthetic-b")
        job = self.start()
        self.wait(job)
        with self.assertRaises(AssistantRequestError) as caught:
            self.service.get_job("synthetic-b", job["id"])
        self.assertEqual(caught.exception.status, 404)

    def test_account_change_during_history_does_not_send_wrong_data(self):
        self.configure()
        self.source.add(1005)
        self.source.page_hook = lambda _page: setattr(self.source, "account", "synthetic-b")
        job = self.start()
        job_record = self.service.jobs[job["id"]]
        job_record["_thread"].join(timeout=2)
        self.assertEqual(job_record["status"], "cancelled")
        self.assertEqual(self.analyzers, [])
        with self.assertRaises(AccountChangedError):
            self.service.get_job("synthetic-a", job["id"])

    def test_account_change_automatically_cancels_own_worker_without_polling(self):
        self.configure()
        self.source.add(3)
        job, analyzer = self.blocked()
        self.source.account = "synthetic-b"
        self.assertTrue(analyzer.release.wait(timeout=2))
        self.service.jobs[job["id"]]["_thread"].join(timeout=2)
        record = self.service.jobs[job["id"]]
        self.assertEqual(record["status"], "cancelled")
        self.assertEqual(record["text"], "")
        self.assertGreater(analyzer.cancelled, 0)

    def test_cancel_prevents_late_provider_completion_and_purges_output(self):
        self.configure()
        self.source.add(3)
        job, analyzer = self.blocked()
        cancelled = self.service.cancel_job({"account": job["account"], "id": job["id"]})
        self.assertEqual(cancelled["status"], "cancelled")
        self.service.jobs[job["id"]]["_thread"].join(timeout=2)
        result = self.service.get_job(job["account"], job["id"])
        self.assertEqual(result["text"], "")
        self.assertNotIn("partialText", result)
        self.assertGreater(analyzer.cancelled, 0)

    def test_settings_change_cancels_inflight_generation(self):
        self.configure()
        self.source.add(3)
        job, analyzer = self.blocked()
        self.service.save_settings({"model": "another-model"})
        self.service.jobs[job["id"]]["_thread"].join(timeout=2)
        result = self.service.get_job(job["account"], job["id"])
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(result["error"]["code"], "settings-changed")
        self.assertGreater(analyzer.cancelled, 0)

    def test_forget_account_removes_results_and_close_is_prompt(self):
        self.configure()
        self.source.add(3)
        job, analyzer = self.blocked()
        self.service.forget_account(job["account"])
        with self.assertRaises(AssistantRequestError):
            self.service.get_job(job["account"], job["id"])
        self.assertGreater(analyzer.cancelled, 0)
        start = time.monotonic()
        self.service.close()
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(self.service.jobs, {})

    def test_failures_are_sanitized_and_have_no_automatic_retry(self):
        self.configure()
        self.source.add(3)
        worker = Analyzer()
        worker.fail = "private-key synthetic-secret with user chat"
        self.next_analyzer = worker
        result = self.wait(self.start())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "assistant-failed")
        self.assertNotIn("private-key", json.dumps(result))
        self.assertEqual(len(worker.calls), 1)

    def test_provider_coverage_must_include_every_message(self):
        self.configure()
        self.source.add(3)
        worker = Analyzer()
        worker.bad_coverage = True
        self.next_analyzer = worker
        result = self.wait(self.start())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["text"], "")

    def test_three_active_jobs_limit_and_finished_results_bound(self):
        self.configure()
        self.source.add(2)
        jobs = [self.blocked()[0] for _ in range(3)]
        with self.assertRaises(AssistantRequestError) as caught:
            self.start()
        self.assertEqual(caught.exception.status, 429)
        for job in jobs:
            self.service.cancel_job({"account": job["account"], "id": job["id"]})
        for _index in range(27):
            self.wait(self.start())
        self.assertEqual(len(self.service.jobs), 24)

    def test_real_sqlite_history_adapter_time_range_snapshot_and_nontext(self):
        """Exercise actual shard SQL and rendering, beyond an in-memory history fake."""
        self.configure()
        user = "sqlite-friend"
        table = "Msg_" + hashlib.md5(user.encode()).hexdigest()
        dbpath = self.root / "message__message_0.db"
        with closing(sqlite3.connect(dbpath)) as conn, conn:
            conn.execute("CREATE TABLE Name2Id(user_name TEXT)")
            conn.executemany("INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)", [(1, "me"), (2, user)])
            conn.execute(f"CREATE TABLE {table}(local_id INTEGER,local_type INTEGER,real_sender_id INTEGER,"
                "create_time INTEGER,message_content BLOB,compress_content BLOB,server_id INTEGER,sort_seq INTEGER)")
            conn.executemany(f"INSERT INTO {table} VALUES (?,?,?, ?,?,NULL,?,?)", [
                (index, 3 if index == 1000 else 1, 1 if index % 2 else 2,
                 1700000000 + index, ("sqlite synthetic " + str(index)).encode(), index, index)
                for index in range(1, 2006)])

        class Database:
            account = "synthetic-a"
            workdir = str(self.root)

            @staticmethod
            def _msg_conns(_user):
                return [(sqlite3.connect(dbpath), table)]

            @staticmethod
            def _msg_type_name(local_type):
                return "文本" if local_type == 1 else "图片"

            @staticmethod
            def _friendly_content(raw, _type):
                return raw.decode()

        source = WeChatSource(factory=lambda: Database(), classifier=classify)
        source._contacts = lambda _db: {}
        source.self_user = lambda *_args: "me"
        self.backend.source = source
        result = self.wait(self.start(user=user, range="time", fromMs=1700000999000, toMs=1700001001000))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["messageCount"], 3)
        self.assertEqual(result["scannedCount"], 2005)
        messages = self.analyzers[0].calls[0][2]
        self.assertEqual([item["time"] for item in messages], [1700000999000, 1700001000000, 1700001001000])
        self.assertIn("未读取媒体内容", messages[1]["text"])


if __name__ == "__main__":
    unittest.main()
