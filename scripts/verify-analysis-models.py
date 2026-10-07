"""Verify quick LLM selection with the native UI, real backend and synthetic model."""
from pathlib import Path
import argparse
import json
import os
import queue
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--ui-dir", type=Path, default=ROOT / "chatui", help="source or packaged UI to verify")
    parser.add_argument("--output", type=Path, default=ROOT / ".local/analysis-model-verification")
    args = parser.parse_args()
    executable = args.exe.resolve()
    client = executable.parent / "client"
    python = client / "runtime/python/python.exe"
    node = client / "runtime/node/node.exe"
    for item in (executable, python, node, client / "bridge/backend_service.py"):
        if not item.is_file():
            parser.error(f"Missing packaged component: {item}")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "WECHATVIBE_ANALYSIS_FIXTURE_CLIENT": str(client),
           "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1", "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", "")}
    with (output / "fixture-errors.log").open("w", encoding="utf-8") as errors:
        fixture = subprocess.Popen([str(python), "tests/fixtures/analysis-http-fixture.py"], cwd=ROOT,
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8")
        try:
            ready_lines = queue.Queue()
            threading.Thread(target=lambda: ready_lines.put(fixture.stdout.readline()), daemon=True).start()
            ready = json.loads(ready_lines.get(timeout=40))
            if ready.get("status") != "READY":
                raise RuntimeError("Synthetic analysis fixture did not start")
            env.update(WECHATVIBE_SMOKE_ANALYSIS_URL=ready["analysisUrl"],
                       WECHATVIBE_SMOKE_ANALYSIS_FIXTURE=json.dumps(ready))
            return subprocess.run([sys.executable, "scripts/verify-tauri-ui.py", "--exe", str(executable),
                "--analysis-models", "--ui-dir", str(args.ui_dir.resolve()),
                "--output", str(output / "native-ui")], cwd=ROOT, env=env).returncode
        finally:
            if fixture.poll() is None:
                fixture.stdin.write("shutdown\n"); fixture.stdin.flush()
                try:
                    fixture.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    fixture.terminate(); fixture.wait(timeout=10)
                    raise RuntimeError("Synthetic analysis fixture did not stop cleanly")
            if fixture.returncode != 0:
                raise RuntimeError("Synthetic analysis fixture failed; see fixture-errors.log")
            fixture.stdin.close(); fixture.stdout.close()

if __name__ == "__main__":
    raise SystemExit(main())
