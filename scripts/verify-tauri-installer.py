"""Extract a built NSIS installer without installing it and verify its payload.

The extracted app is retained under .local/installer-checks for desktop smoke
tests. This command does not run the installer or write a Windows installation.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("prepare_tauri_runtime", Path(__file__).with_name("prepare-tauri-runtime.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Tauri runtime verification module unavailable")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
ROOT = runtime.ROOT


def executable_matches(payload: bytes, compiled: bytes) -> bool:
    if payload == compiled:
        return True
    # The pinned Tauri bundler writes NSS into the installer input and restores
    # UNK in target/release after bundling. Accept that exact three-byte patch,
    # while requiring every other byte (including the PE header) to match.
    unknown = b"__TAURI_BUNDLE_TYPE_VAR_UNK"
    nsis = b"__TAURI_BUNDLE_TYPE_VAR_NSS"
    return compiled.count(unknown) == 1 and payload == compiled.replace(unknown, nsis, 1)


def verify(installer: Path, build_dir: Path, executable: Path, seven_zip: Path | None = None) -> dict:
    installer, build_dir, executable = installer.resolve(), build_dir.resolve(), executable.resolve()
    if not installer.is_file() or not executable.is_file():
        raise FileNotFoundError("built installer or release executable is missing")
    extractor = seven_zip or shutil.which("7z") or Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "7-Zip/7z.exe"
    extractor = Path(extractor).resolve()
    if not extractor.is_file():
        raise FileNotFoundError("7-Zip is required to inspect an NSIS payload; use --seven-zip")
    check_root = ROOT / ".local/installer-checks"
    runtime.checked_directory(check_root, ROOT)
    check_root.mkdir(parents=True, exist_ok=True)
    check_dir = Path(tempfile.mkdtemp(prefix="check-", dir=check_root))
    extracted = check_dir / "extracted"
    extracted.mkdir()
    subprocess.run([str(extractor), "x", str(installer), "-o" + str(extracted), "-y"],
                   cwd=ROOT, capture_output=True, text=True, check=True)
    candidates = [path for path in extracted.rglob("WechatVibe.exe")
                  if path.is_file() and (path.parent / "client/package.json").is_file()]
    if len(candidates) != 1:
        raise ValueError(f"NSIS payload lacks a unique app plus client directory: {len(candidates)}")
    app = candidates[0]
    expected, client = runtime.manifest_files(build_dir)
    runtime.verify_tree(app.parent / "client", expected)
    if not executable_matches(app.read_bytes(), executable.read_bytes()):
        raise ValueError("NSIS app differs from the compiled Tauri release executable")
    result = {"installer": str(installer), "installerSha256": runtime.digest(installer),
              "installerBytes": installer.stat().st_size, "app": str(app), "client": str(app.parent / "client"),
              "verifiedRuntimeFiles": len(expected), "version": client["sourceVersion"],
              "executableSha256": runtime.digest(app), "installed": False,
              "compiledExecutableSha256": runtime.digest(executable),
              "nsisBundleTypePatched": runtime.digest(app) != runtime.digest(executable),
              "payloadVerified": True}
    (check_dir / "installer-verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--build-dir", type=Path, required=True, help="the prepare build directory with runtime/client manifests")
    parser.add_argument("--exe", type=Path, default=ROOT / "src-tauri/target/release/WechatVibe.exe")
    parser.add_argument("--seven-zip", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.installer, args.build_dir, args.exe, args.seven_zip)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"NSIS payload verification rejected: {error}\n")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
