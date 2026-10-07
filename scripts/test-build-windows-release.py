"""Small synthetic tests for the unsigned Windows release archive builder."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPT = Path(__file__).with_name("build-windows-release.py")
SPEC = importlib.util.spec_from_file_location("build_windows_release", SCRIPT)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class BuildReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wechatvibe-build-zip-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "tauri2-portable"
        self.add_file("WechatVibe.exe", b"MZsynthetic")
        for name in builder.REQUIRED_FILES:
            if name != "WechatVibe.exe":
                self.add_file(name)
        self.add_file("client/package.json", json.dumps({
            "name": "wechatvibe-tauri2-runtime", "version": "1.0.2",
            "desktopFramework": "tauri2",
        }).encode("utf-8"))
        self.add_file("client/scripts/update-signing.pub",
                      b"-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----\n")
        self.add_file("client/.models/laya/model.onnx", b"synthetic model")

    def add_file(self, relative: str, payload: bytes = b"synthetic") -> Path:
        target = self.source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        return target

    def test_build_is_deterministic_and_extractable(self):
        self.add_file("client/chatui/assets/wechatvibe-icon.png", b"synthetic image")
        first = builder.build_release(self.source, self.root / "first", "1.0.2")
        second = builder.build_release(self.source, self.root / "second", "1.0.2")
        self.assertEqual(first.name, "WechatVibe-tauri2-1.0.2-windows-x64.zip")
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            names = archive.namelist()
            self.assertEqual(names[0], "tauri2-portable/")
            self.assertTrue(all(name.startswith("tauri2-portable/") for name in names))
            self.assertFalse(any(name.startswith("tauri2-portable/client/.models/")
                                 for name in names))
            self.assertEqual(len(names), len(set(names)))
            self.assertTrue(all(info.date_time == builder.ZIP_TIME for info in archive.infolist()))
            self.assertIsNone(archive.testzip())
            self.assertEqual(len(builder.extractor.inspect(archive)), len(names))
        candidate = builder.extractor.extract(first, first.parent, "1.0.2")
        self.assertFalse((candidate / "client/.models").exists())

    def test_full_variant_has_distinct_name_and_includes_model(self):
        archive_path = builder.build_release(self.source, self.root / "full", "1.0.2",
                                             with_model=True)
        self.assertEqual(archive_path.name, "WechatVibe-tauri2-1.0.2-windows-x64-full.zip")
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.read(
                "tauri2-portable/client/.models/laya/model.onnx"), b"synthetic model")

    def test_version_and_required_artifacts(self):
        for version in ("1.0.2-preview.1", "v1.0.2", "01.0.2", "1.0.2+build", "1.0.2.3", "1.٠.2"):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "stable SemVer"):
                builder.build_release(self.source, self.root / "out", version)
        with self.assertRaisesRegex(ValueError, "version does not match"):
            builder.build_release(self.source, self.root / "out", "1.0.3")
        (self.source / "client/scripts/tauri-host.cjs").unlink()
        with self.assertRaisesRegex(ValueError, "missing or empty"):
            builder.build_release(self.source, self.root / "out", "1.0.2")
        self.assertFalse((self.root / "out").exists())

    def test_electron_identity_is_rejected(self):
        self.add_file("client/package.json", json.dumps({
            "name": "wechatvibe-runtime", "version": "1.0.2",
        }).encode("utf-8"))
        with self.assertRaisesRegex(ValueError, "version does not match"):
            builder.build_release(self.source, self.root / "old-host", "1.0.2")

    def test_hardened_extractor_required_file_is_needed(self):
        self.assertEqual(builder.REQUIRED_FILES, builder.extractor.REQUIRED_FILES)
        missing = self.source / "client/scripts/real-client-update-helper.cjs"
        missing.unlink()
        with self.assertRaisesRegex(ValueError, "missing or empty: client/scripts/real-client-update-helper.cjs"):
            builder.build_release(self.source, self.root / "out", "1.0.2")
        self.assertFalse((self.root / "out").exists())

    def test_reviewed_synthetic_assistant_documentation_is_packaged_but_other_images_are_rejected(self):
        reviewed = "client/docs/verification/assistant-long-history/06-about-owner-dark.png"
        self.add_file(reviewed, b"reviewed synthetic fixture image")
        archive_path = builder.build_release(self.source, self.root / "reviewed-docs", "1.0.2")
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.read("tauri2-portable/" + reviewed), b"reviewed synthetic fixture image")
        self.add_file("client/docs/verification/assistant-long-history/other-chat.png", b"unreviewed image")
        with self.assertRaisesRegex(ValueError, "unreviewed image"):
            builder.build_release(self.source, self.root / "unreviewed-docs", "1.0.2")

    def test_private_and_unreviewed_files_are_rejected(self):
        private_paths = (
            ".local/history.json", "client/account-cache/state.json",
            "client/chats/history.txt", "client/history.db",
            "client/history.sqlite-wal", "client/history.db-journal",
            "client/private.pem",
            "client/auth.json", "client/auth.bin",
            "client/token.dat", "client/api_key.txt",
            "client/id_ed25519.pub",
            "client/.env.production", "client/logs/app.log",
            "client/node_modules/other/lib/cache/state.js",
            "client/app.log.1", "client/screenshot.png",
            "client/IMG_0001.jpg", "client/chatui/assets/IMG_0001.jpg",
        )
        for index, relative in enumerate(private_paths):
            with self.subTest(relative=relative):
                path = self.add_file(relative)
                try:
                    with self.assertRaisesRegex(ValueError, "forbidden"):
                        builder.build_release(self.source, self.root / f"out-{index}", "1.0.2")
                    self.assertFalse((self.root / f"out-{index}").exists())
                finally:
                    path.unlink()

    def test_undici_runtime_cache_modules_are_allowed(self):
        self.add_file("client/node_modules/undici/lib/cache/memory-cache-store.js")
        self.add_file("client/node_modules/undici/lib/web/cache/cachestorage.js")
        archive = builder.build_release(self.source, self.root / "undici", "1.0.2")
        with zipfile.ZipFile(archive) as release:
            self.assertIn("tauri2-portable/client/node_modules/undici/lib/cache/memory-cache-store.js",
                          release.namelist())

    def test_sdk_message_code_is_allowed_but_private_data_is_not(self):
        code = "client/node_modules/@anthropic-ai/sdk/resources/messages/index.js"
        self.add_file(code)
        archive = builder.build_release(self.source, self.root / "sdk-code", "1.0.2")
        with zipfile.ZipFile(archive) as release:
            self.assertIn("tauri2-portable/" + code, release.namelist())
        private = self.add_file("client/node_modules/@anthropic-ai/sdk/"
                                "resources/messages/private.txt")
        with self.assertRaisesRegex(ValueError, "forbidden"):
            builder.build_release(self.source, self.root / "sdk-private", "1.0.2")
        private.unlink()

    def test_symlink_and_output_containment(self):
        with self.assertRaisesRegex(ValueError, "output directory cannot"):
            builder.build_release(self.source, self.source / "release", "1.0.2")
        target = self.root / "outside.txt"
        target.write_bytes(b"outside")
        link = self.source / "client/link.txt"
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable on this host")
        with self.assertRaisesRegex(ValueError, "symlink or reparse"):
            builder.build_release(self.source, self.root / "out", "1.0.2")

    def test_only_public_signing_key_is_allowed(self):
        public_key = self.add_file("client/scripts/update-signing.pub", b"secret data")
        with self.assertRaisesRegex(ValueError, "public signing key is invalid"):
            builder.build_release(self.source, self.root / "invalid-key", "1.0.2")
        public_key.write_bytes(b"-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----\n")
        archive = builder.build_release(self.source, self.root / "valid-key", "1.0.2")
        self.assertTrue(archive.is_file())

    def test_reparse_flag_is_rejected_even_when_symlink_creation_is_unavailable(self):
        fake = SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=builder.REPARSE_POINT)
        with self.assertRaisesRegex(ValueError, "symlink or reparse"):
            builder._check_stat(self.source / "junction", fake, directory=False)

    def test_limits_and_atomic_no_overwrite(self):
        with mock.patch.object(builder, "MAX_MEMBERS", 4):
            with self.assertRaisesRegex(ValueError, "member count"):
                builder.build_release(self.source, self.root / "too-many", "1.0.2")
        with mock.patch.object(builder, "MAX_EXPANDED_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "expanded size"):
                builder.build_release(self.source, self.root / "too-large", "1.0.2")
        with mock.patch.object(builder, "MAX_ARCHIVE_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "compressed archive"):
                builder.build_release(self.source, self.root / "compressed", "1.0.2")
        self.assertEqual(list((self.root / "compressed").iterdir()), [])
        target = self.root / "existing" / "WechatVibe-tauri2-1.0.2-windows-x64.zip"
        target.parent.mkdir()
        target.write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            builder.build_release(self.source, target.parent, "1.0.2")
        self.assertEqual(target.read_bytes(), b"keep")
        with mock.patch.object(builder.os, "link", side_effect=OSError("link unavailable")):
            with self.assertRaisesRegex(OSError, "link unavailable"):
                builder.build_release(self.source, self.root / "atomic", "1.0.2")
        self.assertEqual(list((self.root / "atomic").iterdir()), [])

    def test_extractor_ratio_limit_is_applied(self):
        self.add_file("client/zeroes.dat", b"\0" * (2 * 1024 * 1024))
        with self.assertRaisesRegex(ValueError, "compression ratio"):
            builder.build_release(self.source, self.root / "bomb", "1.0.2")
        self.assertEqual(list((self.root / "bomb").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
