"""Synthetic tests for the clean portable staging and package boundary."""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage = load("stage_real_client", "stage-real-client.py")
builder = load("build_portable_clean", "prepare-tauri-runtime.py")


class CleanPortableBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wechatvibe-clean-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.models = self.root / "external-models"
        self.build = self.root / "build"
        self.client = self.build / "client"
        self.source.mkdir()
        self.models.mkdir()
        self.build.mkdir()
        self.put(self.source / "package.json", b'{"name":"wechatvibe","version":"1.0.2-preview.2"}')
        self.put(self.source / "chatui/index.html", b"<html>reviewed</html>")
        self.put(self.source / "scripts/real-client-update-helper.cjs", b"helper")
        self.put(self.source / "scripts/real-client-update-extract.py", b"extractor")
        self.put(self.source / "scripts/update-signing.pub", b"public key")
        self.put(self.source / "bridge/chat_server.py", b"server")
        self.put(self.source / "bridge/conversation_selection.py", b"selection")
        self.put(self.source / "bridge/unreviewed.py", b"unreviewed")
        self.put(self.source / "chat.db", b"private")
        self.put(self.models / "model.onnx", b"model")
        self.put(self.client / "runtime/python/python.exe", b"python")
        self.put(self.client / "node_modules/dep/index.js", b"node dependency")
        runtime_rows = [self.row(self.client, item) for item in (
            "runtime/python/python.exe", "node_modules/dep/index.js")]
        self.put(self.build / "runtime-manifest.json", json.dumps({"files": runtime_rows}).encode())
        patches = (
            mock.patch.object(stage, "PUBLIC_FILES", ("chatui/index.html",)),
            mock.patch.object(stage, "SCRIPTS", ("real-client-update-helper.cjs",
                                                    "real-client-update-extract.py",
                                                    "update-signing.pub")),
            mock.patch.object(stage, "BRIDGE", ("chat_server.py", "conversation_selection.py")),
            mock.patch.object(stage, "NATIVE_READER", ()),
            mock.patch.object(stage, "LAYA", ()),
            mock.patch.object(stage, "MODEL_FILES", ("model.onnx",)),
            mock.patch.object(stage, "MODEL_PINS", {
                "model.onnx": (5, stage.digest(self.models / "model.onnx")),
            }),
        )
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def put(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    @staticmethod
    def row(root: Path, relative: str) -> dict:
        path = root / relative
        return {"file": relative, "bytes": path.stat().st_size,
                "sha256": stage.digest(path)}

    def test_new_stage_copies_only_allowlist_and_rejects_reuse(self):
        result = stage.stage_public(self.source, self.models, self.client)
        self.assertEqual(result["sourceVersion"], "1.0.2-preview.2")
        self.assertTrue((self.client / "scripts/real-client-update-helper.cjs").is_file())
        self.assertTrue((self.client / "scripts/real-client-update-extract.py").is_file())
        self.assertTrue((self.client / "scripts/update-signing.pub").is_file())
        self.assertEqual((self.client / "bridge/conversation_selection.py").read_bytes(), b"selection")
        self.assertFalse((self.client / "bridge/unreviewed.py").exists())
        self.assertFalse((self.client / "chat.db").exists())
        metadata = json.loads((self.client / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["name"], "wechatvibe-tauri2-runtime")
        self.assertEqual(metadata["desktopFramework"], "tauri2")
        with self.assertRaisesRegex(ValueError, "already has a manifest"):
            stage.stage_public(self.source, self.models, self.client)

    def test_standard_variant_omits_models_and_source_private_data(self):
        self.put(self.source / ".local/accounts/secret.json", b"private")
        self.put(self.source / ".env", b"private")
        stage.stage_public(self.source, None, self.client)
        self.assertFalse((self.client / ".models").exists())
        self.assertFalse((self.client / ".local").exists())
        self.assertFalse((self.client / ".env").exists())

    def test_replacing_a_running_portable_install_preserves_account_data(self):
        stage.stage_public(self.source, None, self.client)
        expected, _ = builder.manifest_files(self.build)
        destination = self.root / "dist/WechatVibe-tauri2"
        self.put(destination / ".local/accounts/keep.json", b"keep account")
        with mock.patch.object(builder, "ROOT", self.root):
            with self.assertRaisesRegex(ValueError, "installation data"):
                builder.replace_build_tree(self.client, destination, self.build / "previous", expected)
        self.assertEqual((destination / ".local/accounts/keep.json").read_bytes(), b"keep account")

    def test_replacing_build_resources_retains_previous_tree_and_verifies_copy(self):
        stage.stage_public(self.source, None, self.client)
        expected, _ = builder.manifest_files(self.build)
        destination = self.root / "src-tauri/resources/client"
        self.put(destination / "old-build.txt", b"old")
        backup = self.build / "previous-resources"
        with mock.patch.object(builder, "ROOT", self.root):
            builder.replace_build_tree(self.client, destination, backup, expected)
        builder.verify_tree(destination, expected)
        self.assertEqual((backup / "old-build.txt").read_bytes(), b"old")

    def test_manifest_path_must_not_escape_the_client(self):
        for name in ("../secrets.txt", "/absolute", "C:/secrets.txt", "a\\b", "a//b"):
            self.put(self.build / "runtime-manifest.json", json.dumps({"files": [
                {"file": name, "bytes": 0, "sha256": "0" * 64}
            ]}).encode())
            self.put(self.build / "client-files.json", b'{"files": []}')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "unsafe manifest path"):
                builder.manifest_files(self.build)

    def test_unexpected_staged_file_and_directory_are_rejected(self):
        self.put(self.client / "stale.txt", b"old build")
        with self.assertRaisesRegex(ValueError, "unexpected or missing content"):
            stage.stage_public(self.source, self.models, self.client)
        (self.client / "stale.txt").unlink()
        (self.client / "unexpected-empty-dir").mkdir()
        with self.assertRaisesRegex(ValueError, "unexpected or missing directories"):
            stage.stage_public(self.source, self.models, self.client)

    def test_changed_runtime_and_model_are_rejected_before_copy(self):
        (self.client / "runtime/python/python.exe").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "hash differs"):
            stage.stage_public(self.source, self.models, self.client)
        (self.client / "runtime/python/python.exe").write_bytes(b"python")
        (self.models / "model.onnx").write_bytes(b"wrong")
        with self.assertRaisesRegex(ValueError, "pinned model hash differs"):
            stage.stage_public(self.source, self.models, self.client)

    def test_package_hash_and_exact_inventory(self):
        stage.stage_public(self.source, self.models, self.client)
        expected, _ = builder.manifest_files(self.build)
        packaged = self.build / "portable/client"
        shutil.copytree(self.client, packaged)
        builder.verify_tree(packaged, expected)
        self.put(packaged / "logs/private.log", b"private")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            builder.verify_tree(packaged, expected)
        (packaged / "logs/private.log").unlink()
        (packaged / "logs").rmdir()
        (packaged / "scripts/update-signing.pub").write_bytes(b"different")
        with self.assertRaisesRegex(ValueError, "hash differs"):
            builder.verify_tree(packaged, expected)

    def test_root_allowlist_keeps_update_files(self):
        for name in ("real-client-update.cjs", "real-client-update-controller.cjs",
                     "real-client-update-helper.cjs", "real-client-update-extract.py",
                     "update-signing.pub"):
            self.assertIn(name, load("stage_real_client_check", "stage-real-client.py").SCRIPTS)
            self.assertTrue((builder.ROOT / "scripts" / name).is_file())

    def test_real_selection_backend_is_in_stage_allowlist(self):
        actual_stage = load("stage_selection_check", "stage-real-client.py")
        self.assertIn("conversation_selection.py", actual_stage.BRIDGE)
        self.assertTrue((builder.ROOT / "bridge/conversation_selection.py").is_file())

    def test_runtime_stage_refuses_nonempty_directory_without_replacing_it(self):
        stale = self.root / "stale-stage"
        self.put(stale / "keep.txt", b"keep")
        run = subprocess.run([sys.executable, str(builder.ROOT / "scripts/stage-real-runtime.py"),
                              "--output", str(stale)], capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("runtime stage must be new and empty", run.stderr)
        self.assertEqual((stale / "keep.txt").read_bytes(), b"keep")



if __name__ == "__main__":
    unittest.main()
