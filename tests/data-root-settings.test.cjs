const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { seed } = require("./helpers/view-state-harness.cjs");

const root = path.join(__dirname, "..");
const script = readFileSync(path.join(root, "chatui/app.js"), "utf8");
const start = script.indexOf("function dataRootControlsBusy(");
const end = script.indexOf("const MODEL_SOURCE_PROTOCOLS", start);
assert.ok(start >= 0 && end > start);
const code = script.slice(start, end) +
  "globalThis.ui = { loadDataRoot, changeDataRoot, browseDataRoot };";
const ready = directory => ({ state: "ready", path: directory, exists: true, accounts: 1 });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(api, chooseDataRoot = async () => null) {
  const nodes = new Map();
  const state = { reads: 0, toasts: [] };
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", disabled: false, title: "", events: {},
      classList: { contains: () => true },
      addEventListener(name, listener) { this.events[name] = listener; },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    api, byId, window: { desktopHost: { chooseDataRoot } },
    text: (id, value) => { byId(id).textContent = value; },
    toast: value => state.toasts.push(value),
    loadSessions: async () => { state.reads++; },
  });
  seed(context, {});
  vm.runInContext(code, context);
  return { ui: context.ui, settings: context.settingsState, byId, state };
}

it("loads a saved discovery hint without reading or starting any conversation", async () => {
  const { ui, byId, state } = harness(async () => ready("F:\\synthetic-a"));
  await ui.loadDataRoot();
  assert.equal(byId("inputDataRoot").value, "F:\\synthetic-a");
  assert.match(byId("dataRootStatus").textContent, /发现 1 个账号目录/);
  assert.equal(state.reads, 0);
});

it("serializes saves and restore-auto and unlocks controls after a successful save", async () => {
  const pending = deferred();
  const calls = [];
  const { ui, byId, state } = harness(async (url, request) => {
    calls.push({ url, request });
    return pending.promise;
  });
  byId("inputDataRoot").value = " F:\\synthetic-a ";
  const first = ui.changeDataRoot();
  await ui.changeDataRoot(true);
  await ui.changeDataRoot();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].request.body), { path: "F:\\synthetic-a" });
  for (const id of ["inputDataRoot", "btnSaveDataRoot", "btnClearDataRoot", "btnBrowseDataRoot"])
    assert.equal(byId(id).disabled, true);
  pending.resolve(ready("F:\\synthetic-a"));
  await first;
  assert.equal(byId("btnSaveDataRoot").disabled, false);
  assert.equal(state.reads, 1);
});

it("a late settings read cannot overwrite a path the user has begun editing", async () => {
  const pending = deferred();
  const { ui, byId } = harness(async () => pending.promise);
  const read = ui.loadDataRoot();
  byId("inputDataRoot").value = "F:\\draft";
  byId("inputDataRoot").events.input();
  pending.resolve(ready("F:\\old"));
  await read;
  assert.equal(byId("inputDataRoot").value, "F:\\draft");
});

it("browse only edits the draft and never saves or switches an account", async () => {
  const { ui, byId, state, settings } = harness(
    async () => { throw new Error("browse must not call the backend"); },
    async () => "F:\\picked");
  await ui.browseDataRoot();
  assert.equal(byId("inputDataRoot").value, "F:\\picked");
  assert.equal(settings.dataRootDraftDirty, true);
  assert.equal(state.reads, 0);
});

it("failed validation keeps the draft and permits retry without refreshing chat", async () => {
  const { ui, byId, state } = harness(async () => { throw new Error("目录内未发现微信数据"); });
  byId("inputDataRoot").value = "F:\\bad";
  await ui.changeDataRoot();
  assert.equal(byId("inputDataRoot").value, "F:\\bad");
  assert.equal(byId("dataRootStatus").textContent, "目录内未发现微信数据");
  assert.equal(byId("btnSaveDataRoot").disabled, false);
  assert.equal(state.reads, 0);
});

it("reopening settings during a pending write reloads its committed result", async () => {
  const pending = deferred();
  const calls = [];
  const { ui, byId, settings, state } = harness(async (url, options) => {
    calls.push(options?.method || "GET");
    return options?.method === "POST" ? pending.promise : ready("F:\\committed");
  });
  byId("inputDataRoot").value = "F:\\committed";
  const write = ui.changeDataRoot();
  ++settings.dataRootRequest; // closeSettingsModal invalidates the old page response.
  await ui.loadDataRoot();
  pending.resolve(ready("F:\\committed"));
  await write;
  await Promise.resolve();
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.equal(byId("inputDataRoot").value, "F:\\committed");
  assert.equal(state.toasts.length, 0);
  assert.equal(state.reads, 1);
});
