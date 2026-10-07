"""Build and verify dist/WechatVibe-tauri2/WechatVibe.exe plus its client sidecars."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from importlib.util import module_from_spec, spec_from_file_location

SPEC = spec_from_file_location("prepare_tauri_runtime", Path(__file__).with_name("prepare-tauri-runtime.py"))
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Tauri runtime preparation script is unavailable")
runtime = module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
ROOT = runtime.ROOT


def tauri_executable() -> Path:
    cargo = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    name = cargo.get("mainBinaryName", "WechatVibe")
    target_root = Path(os.environ.get("CARGO_TARGET_DIR") or ROOT / "src-tauri/target")
    if not target_root.is_absolute():
        target_root = ROOT / target_root
    target = target_root / "release" / (name + ".exe")
    if not target.is_file() or target.stat().st_size == 0:
        raise ValueError(f"Tauri release executable missing: {target}")
    with target.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Tauri release executable is not a Windows PE image")
    return target


def build(args) -> dict:
    cli = ROOT / "node_modules/@tauri-apps/cli/tauri.js"
    if not cli.is_file():
        raise ValueError("Tauri CLI is missing; run npm install first")
    prepared = runtime.prepare(args)
    build_dir = Path(prepared["buildDirectory"])
    client = Path(prepared["client"])
    expected, staged = runtime.manifest_files(build_dir)
    node = Path(args.node_exe or os.environ.get("WECHATVIBE_BUILD_NODE") or shutil.which("node")).resolve()
    # The local CLI entry is the same command as `npx tauri build --no-bundle`.
    subprocess.run([str(node), str(cli), "build", "--no-bundle"], cwd=ROOT, check=True)
    executable = tauri_executable()
    runtime.verify_tree(client, expected)
    runtime.verify_tree(Path(prepared["resources"]), expected)
    if runtime.digest(ROOT / "package.json") != staged["sourcePackageSha256"]:
        raise ValueError("package.json changed while building; create a fresh build")
    assembled = build_dir / "portable"
    assembled.mkdir()
    shutil.copy2(executable, assembled / "WechatVibe.exe")
    shutil.copytree(client, assembled / "client")
    shutil.copy2(ROOT / "scripts/diagnose-startup.bat", assembled / "WechatVibe-diagnose.bat")
    runtime.verify_tree(assembled / "client", expected)
    public = runtime.load_script("stage-real-client.py")
    complete = {name: {"file": path.relative_to(assembled).as_posix(),
                       "bytes": path.stat().st_size, "sha256": runtime.digest(path)}
                for name, path in public.inventory(assembled).items()}
    destination = Path(args.output_dir or ROOT / "dist/WechatVibe-tauri2").absolute()
    runtime.replace_build_tree(assembled, destination, build_dir / "previous-portable", complete)
    result = {**prepared, "portable": str(destination), "executable": str(destination / "WechatVibe.exe"),
              "desktopFramework": "tauri2", "layout": "tauri2-portable",
              "executableSha256": runtime.digest(destination / "WechatVibe.exe"),
              "portableBytes": sum(row["bytes"] for row in complete.values()),
              "files": list(complete.values())}
    (build_dir / "build-verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    # Keep inventories beside the build, outside the installation directory.
    (destination.parent / (destination.name + "-build-verification.json")).write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = runtime.argument_parser()
    parser.description = __doc__
    parser.add_argument("--output-dir", type=Path, help="a writable directory under this project; refuses installation data")
    try:
        result = build(parser.parse_args())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Tauri portable build rejected: {error}\n")
    summary = {name: value for name, value in result.items() if name != "files"}
    print(json.dumps(summary, ensure_ascii=True))


if __name__ == "__main__":
    main()
