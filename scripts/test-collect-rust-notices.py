"""License collection boundaries, using local synthetic crates only."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("collect_rust_notices", Path(__file__).with_name("collect-rust-notices.py"))
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class RustNoticesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wechatvibe-rust-notices-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.crate = self.root / "crate-1.2.3"
        self.crate.mkdir()
        (self.crate / "Cargo.toml").write_text(
            '[package]\nname="crate"\nversion="1.2.3"\nlicense="MIT"\nrepository="https://github.com/example/crate"\n',
            encoding="utf-8")

    def test_preserves_all_published_license_and_notice_texts(self):
        (self.crate / "LICENSE-MIT").write_text("Original MIT text\nCopyright author\n", encoding="utf-8")
        (self.crate / "NOTICE").write_text("Original upstream notice\n", encoding="utf-8")
        result = collector.package_notice(("crate", "1.2.3"), [self.root])
        self.assertIn("Original MIT text\nCopyright author", result)
        self.assertIn("Original upstream notice", result)
        self.assertIn("Source: https://github.com/example/crate", result)

    def test_never_includes_arbitrary_crate_source_or_secrets(self):
        (self.crate / "LICENSE").write_text("Public license", encoding="utf-8")
        (self.crate / "secrets.json").write_text('"private token"', encoding="utf-8")
        (self.crate / "src.rs").write_text("private fixture content", encoding="utf-8")
        result = collector.package_notice(("crate", "1.2.3"), [self.root])
        self.assertNotIn("private token", result)
        self.assertNotIn("private fixture", result)

    def test_unpinned_upstream_does_not_fall_back_to_latest_branch(self):
        with self.assertRaisesRegex(RuntimeError, "supported pinned source"):
            collector.package_notice(("crate", "1.2.3"), [self.root])
        (self.crate / ".cargo_vcs_info.json").write_text('{"git":{"sha1":"main"}}', encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "exact upstream Git revision"):
            collector.package_notice(("crate", "1.2.3"), [self.root])

    def test_missing_license_fetch_uses_exact_published_git_commit(self):
        revision = "a" * 40
        (self.crate / ".cargo_vcs_info.json").write_text(json.dumps({"git": {"sha1": revision}}), encoding="utf-8")
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"MIT License\nCopyright source author\n"
        with mock.patch.object(collector.urllib.request, "urlopen", return_value=response) as fetch:
            result = collector.package_notice(("crate", "1.2.3"), [self.root])
        self.assertEqual(fetch.call_args.args[0], "https://raw.githubusercontent.com/example/crate/" + revision + "/LICENSE")
        self.assertIn("Copyright source author", result)


if __name__ == "__main__":
    unittest.main()
