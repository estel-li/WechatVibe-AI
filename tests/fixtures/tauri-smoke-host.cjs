/* Data-free UI fixture. Only scripts/verify-tauri-ui.py installs this as a host. */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");

const ui = path.resolve(process.env.WECHATVIBE_SMOKE_UI_DIR);
const appVersion = process.env.WECHATVIBE_APP_VERSION;
const account = "synthetic-ui-verification";
const sessions = [
  { username: "synthetic-a", name: "测试会话 A", preview: "合成消息，仅用于架构验证", unreadCount: 0, isGroup: false },
  { username: "synthetic-b", name: "测试会话 B", preview: "没有读取微信聊天记录", unreadCount: 0, isGroup: false },
];
const messages = user => [{ id: user + "-1", side: "other", kind: "text", text: "合成消息，仅用于架构验证", sender: "测试对象", time: 1_760_000_000_000 }];
let selectedSessions = [], analysisRequests = 0;
const send = (response, data, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__smoke__") return send(response, { synthetic: true, analysisRequests });
  if (url.pathname === "/__smoke__/exit-worker" && request.method === "POST") {
    send(response, { synthetic: true });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    let data = "";
    for await (const chunk of request) data += chunk;
    const body = data ? JSON.parse(data) : {};
    switch (url.pathname) {
      case "/api/health": return send(response, { ok: true, version: "real-ui-1", data: { state: "ready", account }, model: { state: "missing" } });
      case "/api/sessions": return send(response, { account, self: { username: "synthetic-self", name: "测试" }, sessions, messagesReady: true });
      case "/api/conversation-selection":
        if (request.method === "POST") selectedSessions = body.all ? sessions.map(value => value.username) :
          body.selected ? [...new Set([...selectedSessions, body.session])] : selectedSessions.filter(value => value !== body.session);
        return send(response, { account, selectedSessions });
      case "/api/messages/batch": return send(response, { account, windows: body.users.map(user => ({ user, messages: messages(user), hasMoreBefore: false })) });
      case "/api/messages": return send(response, { account, messages: messages(url.searchParams.get("user")), hasMoreBefore: false });
      case "/api/model-source": return send(response, { mode: "local", sourceId: "local:laya", state: "active", api: null });
      case "/api/local-model": return send(response, { state: "missing", source: "none", path: "" });
      case "/api/runtime": return send(response, { requestedProvider: "cpu", modelProvider: null, status: "missing" });
      case "/api/data-root": return send(response, { path: "", state: "unset", accounts: 0 });
      case "/api/accounts": return send(response, { currentAccount: account, accounts: [] });
      case "/api/analysis-overview": return send(response, { account, sessions: [], activeWorkers: 0, totalWorkers: 1 });
      case "/api/analysis-workers": return send(response, { workers: 1, elastic: false, maxWorkers: 1 });
      case "/api/profile": return send(response, { account, profile: null });
      default:
        if (request.method === "POST") analysisRequests++;
        return send(response, { error: "synthetic-verification-denies-analysis" }, 503);
    }
  }
  const filename = path.resolve(ui, decodeURIComponent(url.pathname.slice(1)) || "index.html");
  if (!filename.startsWith(ui + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile())
    return send(response, { error: "not-found" }, 404);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
  response.writeHead(200, { "Content-Type": types[path.extname(filename)] || "application/octet-stream" });
  fs.createReadStream(filename).pipe(response);
});
const ready = new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const input = readline.createInterface({ input: process.stdin });
input.on("line", async line => {
  const { id, cmd } = JSON.parse(line);
  let result;
  switch (cmd) {
    case "start":
      await ready;
      result = { version: "real-ui-1", instanceId: crypto.randomBytes(32).toString("hex"), url: `http://127.0.0.1:${server.address().port}/` };
      break;
    case "model-download-state": result = { phase: "idle" }; break;
    case "check-updates": result = { status: "current", currentVersion: appVersion }; break;
    case "update-state": result = { phase: "idle", currentVersion: appVersion }; break;
    case "report-ui-ready": result = true; break;
    case "shutdown":
      process.stdout.write(JSON.stringify({ id, result: { stopped: true } }) + "\n");
      server.close(() => process.exit(0));
      input.close();
      return;
    default: result = { phase: "blocked" };
  }
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
});
input.on("close", () => server.close(() => process.exit(0)));
