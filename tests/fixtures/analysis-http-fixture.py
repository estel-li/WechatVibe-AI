"""Real analysis services and SDK, with synthetic history and a loopback-only model."""
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
import importlib.util
import json
import os
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
CLIENT = Path(os.environ.get("WECHATVIBE_ANALYSIS_FIXTURE_CLIENT", ROOT)).resolve()
sys.path.insert(0, str(CLIENT / "bridge"))
spec = importlib.util.spec_from_file_location("existing_analysis_fixture", ROOT / "bridge/test_api_insights_http.py")
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
from model_source import ModelSourceStore
from real_backend import Backend, ResultStore
from real_http import make_handler

parent = ROOT / ".local/analysis-http-fixtures"
parent.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix="fixture-", dir=parent))
assert work.resolve().is_relative_to((ROOT / ".local").resolve())

class Source(fixtures.Source):
    def identity(self):
        return "synthetic-ui-verification", str(self.root)

source = Source(work)
for index, row in enumerate(source.rows):
    row["senderId"] = "synthetic-a" if row["side"] == "other" else "synthetic-self"
    row["time"] = 1_760_000_000_000 + index * 60000
fixtures.FakeProvider.prompts = []
fixtures.FakeProvider.portrait_phases = []
fixtures.FakeProvider.on_classification = None
provider = ThreadingHTTPServer(("127.0.0.1", 0), fixtures.FakeProvider)
provider.daemon_threads = True
threading.Thread(target=provider.serve_forever, daemon=True).start()
store = ModelSourceStore(work / "model-source.json", root=work,
    protect=lambda value: b"sealed-synthetic:" + value.encode(),
    unprotect=lambda value: value.removeprefix(b"sealed-synthetic:").decode())
store.save_api("chat_completions", f"http://127.0.0.1:{provider.server_port}/v1",
               "synthetic-model", "synthetic-key", context_tokens=32768)
store.save_local()
backend = Backend(source, model_source_store=store,
    store_factory=lambda account, _: ResultStore(work / f"{account}.sqlite3"))
base_handler = make_handler(backend)

class Handler(base_handler):
    def _do_GET(self):
        if urlsplit(self.path).path == "/__fixture__/stats":
            if not self.trusted_request():
                return self.send(403, {"error": "forbidden"})
            return self.send(200, {"synthetic": True, "remoteCalls": 0,
                "insightRequests": sum(p.startswith("CHAT_BATCH_JSON:") for p in fixtures.FakeProvider.prompts),
                "portraitRequests": len(fixtures.FakeProvider.portrait_phases),
                "source": backend.model_source()})
        return super()._do_GET()

app = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
app.daemon_threads = True
threading.Thread(target=app.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{app.server_port}"
print(json.dumps({"status": "READY", "analysisUrl": base, "statsUrl": base + "/__fixture__/stats",
    "messages": [{k: v for k, v in row.items() if k != "_sort"} for row in source.rows]}), flush=True)
try:
    for line in sys.stdin:
        if line.strip() == "shutdown":
            break
finally:
    app.shutdown(); app.server_close()
    backend.shutdown()
    provider.shutdown(); provider.server_close()
