"""Verify a packaged Tauri assistant with synthetic history and a local provider.

Uses the package's UI, Python, Node, and service modules. No WeChat account,
external API, API credential, or production configuration is used.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path,
                        default=ROOT / "dist/WechatVibe-AI-1.1.0/WechatVibe.exe")
    parser.add_argument("--output", type=Path, default=ROOT / ".local/assistant-verification")
    parser.add_argument("--native-export", action="store_true",
                        help="Pause for the native save dialog and verify the result in the output directory")
    args = parser.parse_args()
    executable = args.exe.resolve()
    client = executable.parent / "client"
    python = client / "runtime/python/python.exe"
    node = client / "runtime/node/node.exe"
    for required in (executable, python, node, client / "bridge/ai_assistant.py",
                     client / "chatui/ai-assistant.js"):
        if not required.is_file():
            parser.error(f"Missing packaged component: {required}")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    fixture_env = {**os.environ, "WECHATVIBE_ASSISTANT_FIXTURE_CLIENT": str(client),
                   "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1",
                   "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", "")}
    with (output / "fixture-errors.log").open("w", encoding="utf-8") as errors:
        fixture = subprocess.Popen(
            [str(python), "tests/fixtures/assistant-http-fixture.py"], cwd=ROOT,
            env=fixture_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=errors, text=True, encoding="utf-8")
        try:
            lines = queue.Queue()
            threading.Thread(target=lambda: lines.put(fixture.stdout.readline()), daemon=True).start()
            try:
                ready = json.loads(lines.get(timeout=40))
            except (queue.Empty, ValueError) as error:
                raise RuntimeError(f"Fixture did not start; see {output / 'fixture-errors.log'}") from error
            if ready.get("status") != "READY":
                raise RuntimeError("Synthetic fixture did not report READY")
            env = {**os.environ, "WECHATVIBE_SMOKE_ASSISTANT_URL": ready["assistantUrl"],
                   "WECHATVIBE_SMOKE_AI_FIXTURE": json.dumps(ready)}
            result = subprocess.run(
                [sys.executable, "scripts/verify-tauri-ui.py", "--exe", str(executable),
                 "--crash-worker", "--ui-dir", str(client / "chatui"),
                 "--output", str(output / "native-ui"),
                 *(["--native-export"] if args.native_export else [])], cwd=ROOT, env=env)
            with urllib.request.urlopen(ready["statsUrl"], timeout=10) as response:
                stats = json.load(response)
            (output / "provider-stats.json").write_text(
                json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return result.returncode
        finally:
            if fixture.poll() is None:
                try:
                    fixture.stdin.write("shutdown\n")
                    fixture.stdin.flush()
                    fixture.wait(timeout=10)
                except (OSError, subprocess.TimeoutExpired):
                    fixture.terminate()
                    fixture.wait(timeout=10)
            fixture.stdin.close()
            fixture.stdout.close()


if __name__ == "__main__":
    raise SystemExit(main())
