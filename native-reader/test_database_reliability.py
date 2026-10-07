"""Synthetic reader integrity, pagination and bounded decoding regressions."""
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import zstandard

from wr import database, errors, service, snapshot


def make_shard(shard_id, conversations):
    with closing(sqlite3.connect(":memory:")) as connection, connection:
        connection.execute("CREATE TABLE Name2Id (user_name TEXT)")
        connection.executemany("INSERT INTO Name2Id VALUES (?)", [("self",), ("alice",), ("bob",)])
        for username, rows in conversations.items():
            table = "Msg_" + database.md5_username(username)
            connection.execute(f"CREATE TABLE {table} (local_id INT,server_id INT,sort_seq INT,local_type INT,"
                               "real_sender_id INT,create_time INT,message_content BLOB,compress_content BLOB)")
            connection.executemany(f"INSERT INTO {table} VALUES (?,?,?,1,2,1700000000,?,NULL)",
                                   [(local, server_id, local, f"synthetic {local}".encode()) for local, server_id in rows])
        image = connection.serialize()
    return database.SqliteShard(shard_id, image, "synthetic-account", "self")


class DatabaseReliabilityTests(unittest.TestCase):
    def store(self, *shards):
        store = database.ContactStore("synthetic-account", list(shards))
        self.addCleanup(store.close)
        return store

    def test_cross_shard_server_deduplication_is_scoped_to_conversation(self):
        store = self.store(make_shard("a", {"alice": [(1, 42)]}),
                           make_shard("b", {"bob": [(1, 42)]}))
        self.assertEqual(len(store.latest("alice", 10)), 1)
        self.assertEqual(len(store.latest("bob", 10)), 1)

    def test_duplicate_only_pages_advance_to_remaining_history(self):
        store = self.store(make_shard("a", {"alice": [(1, 99)]}),
                           make_shard("b", {"alice": [(index, 99) for index in range(2, 7)] + [(7, 100)]}))
        store.latest("alice", 20)
        cursor, seen = (1, "a", 1), []
        for _ in range(10):
            rows, following, done = store.page("alice", 1 << 62, cursor, 2)
            seen.extend(row["localId"] for row in rows)
            if done:
                break
            self.assertGreater(following, cursor)
            cursor = following
        else:
            self.fail("pagination did not terminate")
        self.assertEqual(seen, ["7"])

    def test_exact_plain_and_compressed_content_with_bounded_expansion(self):
        text = "  合成消息\n第二行 😀  "
        self.assertEqual(database.extract_text(text, None), text)
        for write_content_size in (True, False):
            compressed = zstandard.ZstdCompressor(write_content_size=write_content_size).compress(text.encode())
            self.assertEqual(database.extract_text(None, compressed), text)
            with patch.object(database, "MAX_TEXT_BYTES", 64):
                compressed = zstandard.ZstdCompressor(write_content_size=write_content_size).compress(b"x" * 128)
                self.assertIsNone(database.extract_text(None, compressed))

    def test_cursor_rejects_ambiguous_and_overflowing_numeric_values(self):
        valid = {"sortSeq": "9223372036854775807", "shardId": "message/a", "localId": "1"}
        self.assertEqual(database.decode_cursor(valid), (2**63 - 1, "message/a", 1))
        for changes in ({"sortSeq": "9223372036854775808"}, {"sortSeq": True}, {"localId": -1},
                        {"sortSeq": 1.5}, {"shardId": None}, {"shardId": "a\n"}, {"extra": 1}):
            with self.subTest(changes=changes), self.assertRaises(errors.ProtocolError):
                database.decode_cursor({**valid, **changes})

    def test_reader_numeric_options_require_integers(self):
        for value in (True, False, 1.5, "1.5", "1e2", -1, 201):
            with self.subTest(value=value), self.assertRaises(errors.ProtocolError):
                service._int_param(value, 100, 1, 200, "limit")
        self.assertEqual(service._int_param("200", 100, 1, 200, "limit"), 200)

    def test_capture_requires_explicit_boolean(self):
        reader = object.__new__(service.NativeService)
        for value in ("false", "true", 1, 0, None):
            with self.subTest(value=value), self.assertRaises(errors.ProtocolError):
                reader.window_method({"capture": value})


class SnapshotReliabilityTests(unittest.TestCase):
    def test_atomic_writers_use_distinct_temporary_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = snapshot.SnapshotStore(temporary)
            path = str(Path(temporary) / "synthetic.meta.json")
            barrier, replace = threading.Barrier(2), os.replace
            arrived = set()
            def simultaneous_replace(source, destination):
                if source not in arrived:
                    arrived.add(source)
                    barrier.wait(timeout=3)
                replace(source, destination)
            with patch.object(snapshot.os, "replace", side_effect=simultaneous_replace), ThreadPoolExecutor(2) as pool:
                futures = [pool.submit(store._write_atomic, path, value) for value in (b"first", b"second")]
                for future in futures:
                    future.result(timeout=4)
            self.assertIn(Path(path).read_bytes(), (b"first", b"second"))
            self.assertEqual([file.name for file in Path(temporary).iterdir()], ["synthetic.meta.json"])

    def test_failed_atomic_write_removes_only_its_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = snapshot.SnapshotStore(temporary)
            path = Path(temporary) / "synthetic.meta.json"
            path.write_bytes(b"original")
            with patch.object(snapshot.os, "replace", side_effect=OSError("synthetic failure")):
                with self.assertRaises(OSError):
                    store._write_atomic(str(path), b"changed")
            self.assertEqual(path.read_bytes(), b"original")
            self.assertEqual([file.name for file in Path(temporary).iterdir()], [path.name])

    def test_ids_reject_trailing_newlines_and_path_traversal(self):
        for value in ("synthetic\n", "../escape", "a/b", "a\\b", ""):
            with self.subTest(value=value), self.assertRaises(errors.ProtocolError):
                snapshot._safe_id(value, "snapshot")


if __name__ == "__main__":
    unittest.main()
