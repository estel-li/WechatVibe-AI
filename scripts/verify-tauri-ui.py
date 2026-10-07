"""Run the real Tauri/WebView shell against isolated, data-free UI fixtures.

Requires Playwright for Node and an already-built Windows executable. No WeChat
database, API key, remote analysis provider, or production settings are touched.
Use --native-dialogs and cancel the two pickers with Windows Computer Use.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent


def clipboard_text():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    for _ in range(20):
        if user32.OpenClipboard(None):
            break
        time.sleep(.05)
    else:
        raise AssertionError("Unable to read clipboard for verification")
    try:
        handle = user32.GetClipboardData(13)
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return None
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def restore_clipboard(value):
    if value is None:
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalFree.argtypes = [wintypes.HANDLE]
    text = ctypes.create_unicode_buffer(value)
    handle = kernel32.GlobalAlloc(0x42, ctypes.sizeof(text))
    pointer = kernel32.GlobalLock(handle)
    if not pointer:
        raise RuntimeError("Unable to allocate clipboard restoration buffer")
    ctypes.memmove(pointer, text, ctypes.sizeof(text))
    kernel32.GlobalUnlock(handle)
    for _ in range(20):
        if user32.OpenClipboard(None):
            break
        time.sleep(.05)
    else:
        kernel32.GlobalFree(handle)
        raise RuntimeError("Unable to restore previous clipboard text")
    try:
        user32.EmptyClipboard()
        if not user32.SetClipboardData(13, handle):
            kernel32.GlobalFree(handle)
            raise RuntimeError("Unable to restore previous clipboard text")
    finally:
        user32.CloseClipboard()


def assert_clipboard(expected):
    if clipboard_text() != expected:
        raise AssertionError("Native clipboard did not match synthetic draft")
    print("clipboard matched")


def assert_minimized():
    """Read the owned test window state; do not automate any other app."""
    pid = int(os.environ["WECHATVIBE_SMOKE_APP_PID"])
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    minimized = []

    @callback_type
    def observe(window, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value == pid and user32.IsIconic(window):
            minimized.append(window)
        return True

    user32.EnumWindows(observe, 0)
    if not minimized:
        raise AssertionError("Owned native test window did not minimize")
    print("native window minimized")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, default=ROOT / "src-tauri/target/debug/WechatVibe.exe")
    parser.add_argument("--node", default="node")
    parser.add_argument("--playwright-root", type=Path, help="node_modules directory containing playwright")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/verification")
    parser.add_argument("--native-dialogs", action="store_true")
    parser.add_argument("--crash-worker", action="store_true", help="Verify native fallback shutdown after an isolated Node worker crash")
    parser.add_argument("--keep-open", action="store_true", help="Keep isolated app open for native Computer Use verification")
    parser.add_argument("--native-wait", type=int, default=900, help="Seconds to allow manual native verification with --keep-open")
    parser.add_argument("--assert-clipboard", help=argparse.SUPPRESS)
    parser.add_argument("--assert-minimized", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--focus-instance", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.assert_clipboard is not None:
        assert_clipboard(args.assert_clipboard)
        return 0
    if args.assert_minimized:
        assert_minimized()
        return 0
    if args.focus_instance:
        result = subprocess.run([os.environ["WECHATVIBE_SMOKE_APP_EXE"]], env=os.environ,
                                cwd=os.environ["WECHATVIBE_CLIENT_ROOT"], timeout=15)
        if result.returncode:
            raise AssertionError("Second instance did not exit cleanly")
        print("second instance focused owned window")
        return 0
    executable = args.exe.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()
    temporary = tempfile.TemporaryDirectory(prefix="wechatvibe-tauri-ui-")
    fixture = Path(temporary.name).resolve()
    (fixture / "scripts").mkdir()
    (fixture / "chatui").mkdir()
    (fixture / ".local/models").mkdir(parents=True)
    shutil.copyfile(ROOT / "tests/fixtures/tauri-smoke-host.cjs", fixture / "scripts/tauri-host.cjs")
    (fixture / "scripts/start-real-client.py").write_text(
        "import sys,json\nfrom pathlib import Path\n"
        "assert sys.argv[1:] == ['--stop-owned-bridge','--json']\n"
        "Path('cleanup-called').write_text('synthetic')\n"
        "print(json.dumps({'stopped':True}))\n", encoding="utf-8")
    (fixture / "chatui/index.html").write_text("<!-- Original UI served by isolated smoke host -->\n", encoding="utf-8")
    environment = {**os.environ, "WECHATVIBE_CLIENT_ROOT": str(fixture), "WECHATVIBE_NODE": args.node,
                   "WECHATVIBE_PYTHON": sys.executable, "WECHATVIBE_SMOKE_UI_DIR": str(ROOT / "chatui"),
                   "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": f"--remote-debugging-port={port}",
                   "WECHATVIBE_SMOKE_CDP": f"http://127.0.0.1:{port}", "WECHATVIBE_SMOKE_OUTPUT": str(output),
                   "WECHATVIBE_SMOKE_PYTHON": sys.executable,
                   "WECHATVIBE_SMOKE_EXE_SHA256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                   "WECHATVIBE_SMOKE_DIALOGS": "1" if args.native_dialogs else "0",
                   "WECHATVIBE_SMOKE_CRASH": "1" if args.crash_worker else "0",
                   "WECHATVIBE_SMOKE_KEEP_OPEN": "1" if args.keep_open else "0"}
    if args.playwright_root:
        environment["NODE_PATH"] = str(args.playwright_root.resolve())
    for name in ["WECHATVIBE_UPDATE_VALIDATE", "WECHATVIBE_UPDATE_READY_FILE", "WECHATVIBE_UPDATE_READY_NONCE",
                 "WECHATVIBE_UPDATE_FINAL_READY_FILE", "WECHATVIBE_UPDATE_FINAL_READY_NONCE"]:
        environment.pop(name, None)
    previous_clipboard = clipboard_text()
    app = subprocess.Popen([str(executable)], cwd=fixture, env=environment)
    environment["WECHATVIBE_SMOKE_APP_PID"] = str(app.pid)
    environment["WECHATVIBE_SMOKE_APP_EXE"] = str(executable)
    print(json.dumps({"synthetic": True, "appPid": app.pid, "cdpPort": port, "fixtureRoot": str(fixture)}), flush=True)
    try:
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            if app.poll() is not None:
                raise RuntimeError(f"Tauri exited before exposing its WebView (code {app.returncode})")
            try:
                with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                    targets = json.load(response)
                if any(value.get("url", "").startswith("http://127.0.0.1:") for value in targets):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        else:
            raise RuntimeError("WebView2 did not expose its isolated CDP port")
        result = subprocess.run([args.node, str(ROOT / "scripts/verify-tauri-ui.cjs")], env=environment, cwd=ROOT, timeout=300)
        if result.returncode:
            raise RuntimeError("Tauri UI smoke test failed")
        if args.keep_open:
            print("NATIVE_VERIFICATION_APP_READY", flush=True)
            app.wait(timeout=args.native_wait)
        else:
            app.wait(timeout=30)
        if app.returncode != 0:
            raise AssertionError(f"Native app exit code was {app.returncode}")
        if args.crash_worker and not (fixture / "cleanup-called").exists():
            raise AssertionError("Native worker-crash cleanup did not call the owned bridge launcher")
        report_path = output / "ui-verification.json"
        record = json.loads(report_path.read_text(encoding="utf-8"))
        record["nativeExitCode"] = app.returncode
        report_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0
    finally:
        # Restore first: WebView cache handles can briefly outlive the app.
        restore_clipboard(previous_clipboard)
        if app.poll() is None:
            app.terminate()
            app.wait(timeout=10)
        for attempt in range(40):
            try:
                temporary.cleanup()
                break
            except OSError as error:
                if attempt == 39 or error.winerror not in (5, 32, 145):
                    raise
                time.sleep(.25)


if __name__ == "__main__":
    raise SystemExit(main())
