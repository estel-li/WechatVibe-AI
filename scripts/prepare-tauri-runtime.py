"""Prepare an allowlisted Windows Node/Python client for the Tauri resource map.

Fresh stages and replaced build resources remain under .local/tauri-builds for
inspection. Account settings, chat databases and credentials are never inputs.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESOURCE_CLIENT = ROOT / "src-tauri/resources/client"


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), Path(__file__).with_name(name))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"script unavailable: {name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def manifest_files(build_dir: Path) -> tuple[dict[str, dict], dict]:
    runtime = json.loads((build_dir / "runtime-manifest.json").read_text(encoding="utf-8"))
    client = json.loads((build_dir / "client-files.json").read_text(encoding="utf-8"))
    expected = {}
    for row in runtime["files"] + client["files"]:
        relative = row["file"]
        parts = relative.split("/")
        if (not relative or "\\" in relative or ":" in relative or
                any(part in ("", ".", "..") for part in parts)):
            raise ValueError(f"unsafe manifest path: {relative}")
        folded = relative.casefold()
        if folded in expected:
            raise ValueError(f"duplicate manifest path: {relative}")
        expected[folded] = row
    return expected, client


def verify_tree(directory: Path, expected: dict[str, dict]) -> None:
    stager = load_script("stage-real-client.py")
    found = stager.inventory(directory)
    if set(found) != set(expected):
        extra = sorted(set(found) - set(expected))[:5]
        missing = sorted(set(expected) - set(found))[:5]
        raise ValueError(f"package inventory differs; unexpected={extra}, missing={missing}")
    stager.verify_directories(directory, set(expected))
    for name, row in expected.items():
        path = found[name]
        if path.stat().st_size != row["bytes"] or digest(path) != row["sha256"]:
            raise ValueError(f"package hash differs: {row['file']}")


def verify_python_imports(client: Path) -> None:
    """Check the packaged interpreter and native DLLs without opening an account."""
    probe = (
        "import ctypes,sqlite3,ssl,psutil,cryptography,zstandard,win32api,pythoncom,numpy,cv2,comtypes,uiautomation;"
        "from wechatauto.db import WeChatDB;"
        "import sys;sys.path.insert(0,'bridge');"
        "import real_backend,real_http,chat_server,node_analysis"
    )
    completed = subprocess.run(
        [str(client / "runtime/python/python.exe"), "-I", "-B", "-X", "utf8", "-c", probe],
        cwd=client, capture_output=True, text=True, check=False,
    )
    if completed.returncode:
        raise RuntimeError("staged Python runtime or bridge imports failed: " + completed.stderr[-4000:])


def checked_directory(directory: Path, boundary: Path) -> None:
    """Validate each existing component before copying or moving build files."""
    directory, boundary = directory.absolute(), boundary.resolve()
    if not directory.resolve().is_relative_to(boundary):
        raise ValueError(f"build directory leaves project: {directory}")
    for item in (directory, *directory.parents):
        if item == boundary:
            break
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            raise ValueError(f"linked build directory: {item}")
        if item.exists() and not item.is_dir():
            raise ValueError(f"build directory is a file: {item}")


def replace_build_tree(source: Path, destination: Path, backup: Path, expected: dict[str, dict]) -> None:
    checked_directory(destination, ROOT)
    if destination.exists():
        # Running a packaged preview may have generated account data. Preserve it
        # and require another output location instead of replacing that install.
        if any(item.name.casefold() == ".local" for item in destination.rglob("*")):
            raise ValueError(f"output contains installation data; choose --output-dir: {destination}")
        load_script("stage-real-client.py").inventory(destination)
    checked_directory(backup, ROOT)
    if backup.exists():
        raise FileExistsError(f"build backup already exists: {backup}")
    verify_tree(source, expected)
    destination.parent.mkdir(parents=True, exist_ok=True)
    pending = destination.with_name(destination.name + ".pending-" + source.parent.name)
    if pending.exists() or pending.is_symlink():
        raise FileExistsError(f"pending build output already exists: {pending}")
    shutil.copytree(source, pending)
    verify_tree(pending, expected)
    if destination.exists():
        destination.rename(backup)
    try:
        pending.rename(destination)
    except OSError:
        if backup.exists() and not destination.exists():
            backup.rename(destination)
        raise


def prepare(args: argparse.Namespace) -> dict:
    python = Path(args.python_exe or sys.executable).resolve()
    node_value = args.node_exe or os.environ.get("WECHATVIBE_BUILD_NODE") or shutil.which("node")
    if not node_value:
        raise ValueError("Node.js is missing; run npm install after installing Node 24.x")
    node = Path(node_value).resolve()
    if not python.is_file() or not node.is_file():
        raise ValueError("selected Python or Node executable is missing")
    subprocess.run([str(python), str(ROOT / "scripts/collect-rust-notices.py")], cwd=ROOT, check=True)
    build_root = ROOT / ".local/tauri-builds"
    checked_directory(build_root, ROOT)
    build_root.mkdir(parents=True, exist_ok=True)
    build_dir = Path(tempfile.mkdtemp(prefix="build-", dir=build_root))
    client = build_dir / "client"
    environment = os.environ.copy()
    environment["WECHATVIBE_BUILD_NODE"] = str(node)
    if args.node_license:
        environment["WECHATVIBE_NODE_LICENSE"] = str(Path(args.node_license).resolve())
    print(f"Clean Tauri runtime stage: {build_dir}", flush=True)
    subprocess.run([str(python), str(ROOT / "scripts/stage-real-runtime.py"), "--output", str(client)],
                   cwd=ROOT, env=environment, check=True)
    models = None
    if args.with_model or args.models_dir:
        models = Path(args.models_dir or os.environ.get("LAYA_MODEL_DIR") or ROOT / ".models/laya").resolve()
        if not models.is_dir():
            raise ValueError(f"Laya model is missing; run npm run setup:models: {models}")
    staged = load_script("stage-real-client.py").stage_public(ROOT, models, client)
    expected, _ = manifest_files(build_dir)
    verify_tree(client, expected)
    verify_python_imports(client)
    print("Staged Python native dependencies and bridge imports verified", flush=True)
    replace_build_tree(client, RESOURCE_CLIENT, build_dir / "previous-resources", expected)
    result = {"buildDirectory": str(build_dir), "client": str(client),
              "resources": str(RESOURCE_CLIENT), "version": staged["sourceVersion"],
              "verifiedFiles": len(expected), "withModel": models is not None,
              "userDataCopied": False}
    (build_dir / "prepare-verification.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-exe", type=Path, help="Python 3.14 with dependencies from python-requirements.lock.txt")
    parser.add_argument("--node-exe", type=Path, help="Node 24.11.1 or later in the 24.x line")
    parser.add_argument("--node-license", type=Path, help="the LICENSE for the selected Node version")
    parser.add_argument("--with-model", action="store_true", help="include the pinned local Laya model")
    parser.add_argument("--models-dir", type=Path, help="include the pinned Laya model from this directory")
    return parser


def main() -> None:
    parser = argument_parser()
    try:
        result = prepare(parser.parse_args())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Tauri runtime preparation rejected: {error}\n")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
