"""Collect the locked Windows Rust dependency license texts for distribution.

Use installed crate license files and exact upstream Git commits for crates
whose published archives omit their license text. No account files are inputs.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "licenses/rust-runtime-notices.txt"
PACKAGE = re.compile(r"([A-Za-z0-9_-]+) v([^ ]+)")
LICENSE_NAMES = ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE-MIT", "LICENSE-MIT.txt",
                 "LICENSE-APACHE", "LICENSE-APACHE.txt", "COPYING", "COPYING.txt",
                 "LICENCE", "LICENCE.txt", "LICENCE.md", "LICENSE_1_0.txt", "LICENSE-MPL-2.0")


def license_files(folder: Path) -> list[Path]:
    result = [item for item in folder.iterdir()
              if item.is_file() and item.name.casefold().startswith(("license", "copying", "notice"))]
    for subdir in (folder / "licenses", folder / "license"):
        if subdir.is_dir():
            result.extend(item for item in subdir.rglob("*") if item.is_file())
    return sorted(set(result))


def upstream_license(folder: Path, package: dict, name: str, version: str) -> tuple[str, str]:
    vcs_file = folder / ".cargo_vcs_info.json"
    repository = package.get("repository", "").rstrip("/")
    if repository.endswith(".git"):
        repository = repository[:-4]
    if not vcs_file.is_file() or not re.fullmatch(r"https://github.com/[\w.-]+/[\w.-]+", repository):
        raise RuntimeError(f"crate lacks license text and a supported pinned source: {name} {version}")
    vcs = json.loads(vcs_file.read_text(encoding="utf-8"))
    revision = vcs.get("git", {}).get("sha1", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError(f"crate lacks exact upstream Git revision: {name} {version}")
    base = repository.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/" + revision + "/"
    prefix = vcs.get("path_in_vcs", "").strip("/")
    if package.get("license") == "MPL-2.0":
        # selectors retains the MPL notice in each source file but its published
        # crate and upstream monorepo omit the standalone license document.
        # Preserve the canonical steward's text and an exact source location.
        license_url = "https://www.mozilla.org/media/MPL/2.0/index.txt"
        with urllib.request.urlopen(license_url, timeout=15) as response:
            text = response.read(2 * 1024 * 1024).decode("utf-8")
        source_url = repository + "/tree/" + revision + ("/" + prefix if prefix else "")
        return license_url, "Source Code Form: " + source_url + "\n\n" + text
    names = list(LICENSE_NAMES)
    if prefix and ".." not in prefix.split("/"):
        names += [prefix + "/" + item for item in LICENSE_NAMES]
    for filename in names:
        url = base + filename
        try:
            with urllib.request.urlopen(url, timeout=15) as response:
                data = response.read(2 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                continue
            raise RuntimeError(f"upstream license request failed: {name} {version}: HTTP {error.code}") from error
        if len(data) > 2 * 1024 * 1024:
            raise RuntimeError(f"upstream license is unexpectedly large: {name} {version}")
        text = data.decode("utf-8")
        if not text.strip() or "<!doctype html" in text.casefold():
            raise RuntimeError(f"upstream license is not plain text: {name} {version}")
        return url, text
    raise RuntimeError(f"no license text found at pinned upstream revision: {name} {version}")


def package_notice(item: tuple[str, str], roots: list[Path]) -> str:
    name, version = item
    folder = next((root / (name + "-" + version) for root in roots
                   if (root / (name + "-" + version) / "Cargo.toml").is_file()), None)
    if folder is None:
        raise RuntimeError(f"locked Windows crate is not in Cargo cache: {name} {version}")
    package = tomllib.loads((folder / "Cargo.toml").read_text(encoding="utf-8"))["package"]
    lines = ["=" * 78, f"{name} {version}", "License: " + package.get("license", "license-file"),
             "Source: " + package.get("repository", package.get("homepage", "https://crates.io/crates/" + name))]
    files = license_files(folder)
    license_file = package.get("license-file")
    if isinstance(license_file, str):
        candidate = (folder / license_file).resolve()
        if candidate.is_relative_to(folder) and candidate.is_file() and candidate not in files:
            files.append(candidate)
    if files:
        for path in files:
            lines += ["", "--- " + path.relative_to(folder).as_posix() + " ---",
                      path.read_text(encoding="utf-8-sig", errors="strict").rstrip()]
    else:
        url, text = upstream_license(folder, package, name, version)
        lines += ["", "License source: " + url, text.rstrip()]
    return "\n".join(lines) + "\n"


def collect() -> dict:
    cargo_hash = hashlib.sha256((ROOT / "src-tauri/Cargo.lock").read_bytes()).hexdigest()
    if OUTPUT.is_file():
        previous = OUTPUT.read_text(encoding="utf-8")
        if f"Cargo.lock SHA-256: {cargo_hash}\n" in previous[:1000]:
            package_count = len(re.findall(r"(?m)^={78}\n[A-Za-z0-9_-]+ [0-9]+\.[0-9]+\.[^\s]+$", previous))
            return {"rustPackages": package_count, "notices": str(OUTPUT),
                    "bytes": OUTPUT.stat().st_size, "cargoLockSha256": cargo_hash, "reused": True}
    command = ["cargo", "tree", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
               "--target", "x86_64-pc-windows-msvc", "--edges", "normal,build", "--prefix", "none", "--format", "{p}"]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=True)
    packages = {match.groups() for row in completed.stdout.splitlines()
                if (match := PACKAGE.match(row))}
    # The root crate uses this project's LICENSE, not a registry package.
    identity = tomllib.loads((ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))["package"]
    packages.discard((identity["name"], identity["version"]))
    registry = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/src"
    roots = sorted(item for item in registry.iterdir() if item.is_dir())
    ordered = sorted(packages)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        notices = list(pool.map(lambda item: package_notice(item, roots), ordered))
    header = ("WechatVibe Tauri 2 — Rust Windows dependency notices\n"
              "Includes normal and build dependencies for x86_64-pc-windows-msvc.\n"
              "Individual components retain their upstream licenses and notices below.\n"
              f"Cargo.lock SHA-256: {cargo_hash}\n\n")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(header + "\n".join(notices), encoding="utf-8")
    return {"rustPackages": len(ordered), "notices": str(OUTPUT), "bytes": OUTPUT.stat().st_size,
            "cargoLockSha256": cargo_hash}


if __name__ == "__main__":
    print(json.dumps(collect(), ensure_ascii=True))
