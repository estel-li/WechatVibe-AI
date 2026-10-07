from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import unittest

spec = spec_from_file_location("installer_verifier", Path(__file__).with_name("verify-tauri-installer.py"))
module = module_from_spec(spec)
spec.loader.exec_module(module)


class ExecutableVerificationTests(unittest.TestCase):
    def test_identical_image_and_exact_pinned_nsis_marker_are_accepted(self):
        compiled = b"MZ-header-code-__TAURI_BUNDLE_TYPE_VAR_UNK-resources"
        self.assertTrue(module.executable_matches(compiled, compiled))
        self.assertTrue(module.executable_matches(compiled.replace(b"VAR_UNK", b"VAR_NSS"), compiled))

    def test_code_header_or_other_bundle_changes_are_rejected(self):
        compiled = b"MZ-header-code-__TAURI_BUNDLE_TYPE_VAR_UNK-resources"
        payload = compiled.replace(b"VAR_UNK", b"VAR_NSS")
        for modified in (payload.replace(b"code", b"evil"), payload.replace(b"MZ", b"ZZ"),
                         compiled.replace(b"VAR_UNK", b"VAR_MSI"), payload + b"extra"):
            self.assertFalse(module.executable_matches(modified, compiled))

    def test_ambiguous_multiple_unknown_markers_are_rejected(self):
        compiled = b"__TAURI_BUNDLE_TYPE_VAR_UNK" * 2
        self.assertFalse(module.executable_matches(compiled.replace(b"VAR_UNK", b"VAR_NSS"), compiled))


if __name__ == "__main__":
    unittest.main()
