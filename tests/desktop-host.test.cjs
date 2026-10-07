const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../chatui/desktop-host.js"), "utf8");

class Element {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => this.classes.add(value)),
      toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value),
    };
    this.hidden = true;
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  contains(target) { return this.children?.includes(target) === true; }
  closest(selector) {
    if (selector === "a[href]") return this.href ? this : this.anchor || null;
    return this.dataset?.windowAction ? this : this.button || null;
  }
}

function harness(options = {}) {
  const calls = [], events = [], listeners = new Map(), unlistened = [], errors = [];
  const document = new Element();
  document.documentElement = new Element();
  const controls = new Element(), dragArea = new Element(), maximize = new Element();
  const elements = { desktopWindowControls: controls, desktopDragArea: dragArea, desktopMaximize: maximize };
  document.getElementById = id => elements[id] || null;
  const window = new Element();
  window.top = options.iframe ? {} : window;
  window.dispatchEvent = event => { events.push(event); };
  window.__WECHATVIBE_DESKTOP__ = options.config;
  const navigator = { userActivation: { isActive: options.active !== false } };
  if (!options.browser) {
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
        if (options.invoke) return options.invoke(command, args);
        if (command === "desktop_window_action") return { maximized: args.action === "toggle-maximize" };
        return true;
      } },
      event: { listen: (name, callback) => {
        listeners.set(name, callback);
        const unlisten = () => unlistened.push(name);
        return options.listen ? options.listen(name, unlisten) : Promise.resolve(unlisten);
      } },
    };
  }
  class Event { constructor(type) { this.type = type; } }
  class CustomEvent extends Event { constructor(type, init) { super(type); this.detail = init.detail; } }
  vm.runInNewContext(source, { window, document, navigator, Element, Event, CustomEvent, URL,
    console: { error: (...args) => errors.push(args) }, setTimeout, clearTimeout });
  return { window, document, navigator, controls, dragArea, maximize, calls, events, listeners, unlistened, errors,
    emit(name, payload) { listeners.get(name)({ payload }); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

const ordinaryCalls = calls => calls.filter(call => call.command !== "desktop_window_action");

test("native service failures are forwarded to the UI as text and malformed payloads are ignored", async () => {
  const h = harness();
  await h.settle();
  h.emit("wechatvibe-error", { message: "本地桌面服务已退出" });
  h.emit("wechatvibe-error", null);
  h.emit("wechatvibe-error", { message: 42 });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, "wechatvibe-error");
  assert.equal(h.events[0].detail.message, "本地桌面服务已退出");
});

test("browser preview and subframes do not expose native commands or native titlebar", () => {
  for (const options of [{ browser: true }, { iframe: true }]) {
    const h = harness(options);
    assert.equal(h.window.desktopHost, undefined);
    assert.equal(h.controls.hidden, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.listeners.size, 0);
  }
});

test("desktopHost preserves every preload method and sends the agreed Tauri command arguments", async () => {
  const h = harness({ config: { updateFinalReadyMode: true } });
  const host = h.window.desktopHost;
  assert.equal(Object.isFrozen(host), true);
  assert.equal(Object.getOwnPropertyDescriptor(h.window, "desktopHost").writable, false);
  assert.equal(host.platform, "win32");
  assert.equal(host.setTheme("light"), true);
  await host.copyDraft("你好\n新的一行");
  for (const method of ["exitApp", "getAppVersion", "getModelDownloadState", "downloadLayaModel",
    "chooseModelDirectory", "chooseDataRoot", "checkForUpdates", "getUpdateState", "beginUpdate", "rollbackUpdate", "reportUiReady"])
    await host[method]();
  assert.deepEqual(ordinaryCalls(h.calls), [
    { command: "desktop_set_theme", args: { theme: "light" } },
    { command: "desktop_copy_draft", args: { value: "你好\n新的一行" } },
    ...["desktop_exit_app", "desktop_get_app_version", "desktop_get_model_download_state",
      "desktop_download_laya_model", "desktop_choose_model_directory", "desktop_choose_data_root",
      "desktop_check_for_updates", "desktop_get_update_state", "desktop_begin_update",
      "desktop_rollback_update", "desktop_report_ui_ready"].map(command => ({ command, args: {} })),
  ]);
});

test("invalid drafts and inactive user gestures never reach clipboard, directory pickers, or update actions", async () => {
  const h = harness(), host = h.window.desktopHost;
  assert.equal(host.setTheme("invalid"), false);
  for (const draft of ["", "   ", 42, "a".repeat(1_000_001)]) assert.equal(await host.copyDraft(draft), false);
  h.navigator.userActivation.isActive = false;
  assert.equal(await host.copyDraft("有效草稿"), false);
  assert.equal(await host.chooseDataRoot(), null);
  assert.equal(await host.chooseModelDirectory(), null);
  for (const method of ["downloadLayaModel", "beginUpdate", "rollbackUpdate"])
    assert.equal((await host[method]()).phase, "blocked");
  assert.deepEqual(ordinaryCalls(h.calls), []);
});

test("methods continue to enforce the main-frame boundary after the host has been exposed", async () => {
  const h = harness({ config: { updateValidationMode: true } }), host = h.window.desktopHost;
  h.window.top = {};
  assert.equal(host.setTheme("dark"), false);
  assert.equal(await host.copyDraft("草稿"), false);
  assert.equal(await host.exitApp(), false);
  assert.equal(await host.getAppVersion(), null);
  assert.equal(await host.reportUiReady(), false);
  assert.equal(await host.chooseDataRoot(), null);
  assert.equal(await host.chooseModelDirectory(), null);
  assert.equal((await host.checkForUpdates()).status, "blocked");
  for (const method of ["getModelDownloadState", "getUpdateState", "downloadLayaModel", "beginUpdate", "rollbackUpdate"])
    assert.equal((await host[method]()).phase, "blocked");
  assert.deepEqual(ordinaryCalls(h.calls), []);
});

test("native progress and recovery events are translated to the existing application DOM events", () => {
  const h = harness();
  const update = { phase: "downloading", progress: 40 };
  const model = { phase: "ready", directory: "D:\\模型" };
  h.emit("wechatvibe-service-restored", null);
  h.emit("wechatvibe-update-state", update);
  h.emit("wechatvibe-model-download-state", model);
  for (const payload of [null, 7, "invalid", []]) h.emit("wechatvibe-update-state", payload);
  assert.deepEqual(h.events.map(event => event.type), ["wechatvibe-service-restored", "wechatvibe-update-state", "wechatvibe-model-download-state"]);
  assert.equal(h.events[1].detail, update);
  assert.equal(h.events[2].detail, model);
});

test("update readiness waits until all native event listeners are registered", async () => {
  const pending = [];
  const h = harness({ config: { updateValidationMode: true, updateFinalReadyMode: true },
    listen: (_name, unlisten) => new Promise(resolve => pending.push(() => resolve(unlisten))) });
  assert.equal(h.window.desktopHost.updateValidationMode, true);
  assert.equal(h.window.desktopHost.updateFinalReadyMode, false);
  const ready = h.window.desktopHost.reportUiReady();
  await h.settle();
  assert.equal(ordinaryCalls(h.calls).length, 0);
  pending.splice(0).forEach(resolve => resolve());
  assert.equal(await ready, true);
  assert.equal(ordinaryCalls(h.calls)[0].command, "desktop_report_ui_ready");
});

test("normal launches do not submit update-readiness handshakes", async () => {
  const h = harness();
  assert.equal(await h.window.desktopHost.reportUiReady(), false);
  assert.equal(ordinaryCalls(h.calls).length, 0);
});

test("only trusted user clicks on approved upstream and maintainer links open externally", async () => {
  const h = harness();
  const clicked = href => {
    const anchor = new Element();
    anchor.href = href;
    return { target: anchor, button: 0, isTrusted: true, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  };
  for (const href of ["https://example.com/", "https://github.com/tswawa/WechatVibe?download=1",
    "https://github.com/estel-li/WechatVibe-AI?download=1", "https://github.com/estel-li/other-repo",
    "https://user:pass@github.com/tswawa", "javascript:alert(1)", "not a URL"]) {
    const event = clicked(href);
    h.document.listeners.get("click")(event);
    assert.equal(event.prevented, false);
  }
  for (const overrides of [{ isTrusted: false }, { button: 1 }])
    h.document.listeners.get("click")(Object.assign(clicked("https://github.com/tswawa"), overrides));
  h.navigator.userActivation.isActive = false;
  h.document.listeners.get("click")(clicked("https://github.com/tswawa"));
  assert.equal(ordinaryCalls(h.calls).length, 0);
  h.navigator.userActivation.isActive = true;
  const targets = ["https://github.com/tswawa", "https://github.com/estel-li",
    "https://github.com/estel-li/WechatVibe-AI", "https://github.com/estel-li/WechatVibe-AI/releases"];
  for (const target of targets) {
    const allowed = clicked(target);
    h.document.listeners.get("click")(allowed);
    assert.equal(allowed.prevented, true);
    assert.equal(allowed.stopped, true);
  }
  assert.deepEqual(ordinaryCalls(h.calls), targets.map(target => ({ command: "desktop_open_doc", args: {
    target, trusted: true, active: true } })));
});

test("titlebar controls route trusted clicks and mirror maximize/restore state", async () => {
  const h = harness();
  assert.equal(h.controls.hidden, false);
  assert.equal(h.document.documentElement.classes.has("tauri-desktop-host"), true);
  await h.settle();
  h.maximize.dataset = { windowAction: "toggle-maximize" };
  h.controls.children = [h.maximize];
  const child = new Element();
  child.button = h.maximize;
  h.controls.listeners.get("click")({ isTrusted: false, button: 0, target: child });
  assert.equal(h.calls.length, 1);
  h.controls.listeners.get("click")({ isTrusted: true, button: 0, target: child });
  await h.settle();
  assert.equal(h.calls[1].args.action, "toggle-maximize");
  assert.equal(h.maximize.attributes.get("aria-label"), "还原");
  assert.equal(h.maximize.classes.has("is-maximized"), true);
  h.emit("wechatvibe-window-state", { maximized: false });
  assert.equal(h.maximize.attributes.get("aria-label"), "最大化");
  assert.equal(h.maximize.classes.has("is-maximized"), false);
  h.dragArea.listeners.get("mousedown")({ isTrusted: true, button: 0, detail: 1 });
  h.dragArea.listeners.get("mousedown")({ isTrusted: true, button: 0, detail: 2 });
  h.dragArea.listeners.get("dblclick")({ isTrusted: true, button: 0 });
  assert.deepEqual(h.calls.slice(2).map(call => call.args.action), ["start-dragging", "toggle-maximize"]);
});

test("unloading releases registered listeners and ignores late events", async () => {
  const h = harness();
  await h.settle();
  h.window.listeners.get("pagehide")();
  assert.deepEqual(h.unlistened, [...h.listeners.keys()]);
  h.emit("wechatvibe-service-restored", null);
  assert.equal(h.events.length, 0);
});

test("listeners that finish registering after unload are immediately released", async () => {
  const pending = [];
  const h = harness({ listen: (_name, unlisten) => new Promise(resolve => pending.push(() => resolve(unlisten))) });
  h.window.listeners.get("pagehide")();
  pending.forEach(resolve => resolve());
  await h.settle();
  assert.deepEqual(h.unlistened, [...h.listeners.keys()]);
});

test("the native compatibility bridge loads before the unchanged application script", () => {
  const html = fs.readFileSync(path.join(__dirname, "../chatui/index.html"), "utf8");
  assert.ok(html.indexOf('src="desktop-host.js"') < html.indexOf('src="app.js"'));
  assert.match(html, /data-window-action="minimize"/);
  assert.match(html, /data-window-action="toggle-maximize"/);
  assert.match(html, /data-window-action="close"/);
});
