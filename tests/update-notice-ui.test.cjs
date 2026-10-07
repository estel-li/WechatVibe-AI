const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = readFileSync(path.join(root, "chatui/app.js"), "utf8");
const html = readFileSync(path.join(root, "chatui/index.html"), "utf8").replace(/\r/gu, "");
const css = readFileSync(path.join(root, "chatui/style.css"), "utf8");

function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
const updateCode = section("function unlockStartupUi()", "function completeStartup()") +
  section("const OFFICIAL_RELEASES_URL", 'byId("btnAddConversation")') +
  section('document.querySelectorAll(".settings-tab-btn")', 'byId("btnEmoji")');

function makeNode(id = "") {
  const node = {
    id, hidden: false, disabled: false, textContent: "", title: "", className: "",
    value: "", href: "", dataset: {}, style: {}, attributes: {}, events: {},
    focused: false, isConnected: true,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, listener) { (this.events[type] ||= []).push(listener); },
    click() { for (const listener of this.events.click || []) listener({ target: this }); },
    focus() { this.focused = true; },
  };
  node.classList = {
    add(name) {
      const names = node.className.split(/\s+/u).filter(Boolean);
      if (!names.includes(name)) names.push(name);
      node.className = names.join(" ");
    },
    remove(name) {
      node.className = node.className.split(/\s+/u).filter(part => part && part !== name).join(" ");
    },
    toggle(name, force) {
      const has = node.className.split(/\s+/u).includes(name);
      const on = force === undefined ? !has : !!force;
      if (on) node.classList.add(name);
      else node.classList.remove(name);
    },
    contains(name) { return node.className.split(/\s+/u).includes(name); },
  };
  return node;
}
function hasClass(node, name) {
  return node.className.split(/\s+/u).includes(name);
}

function harness(options = {}) {
  const calls = { checks: 0, downloads: 0, fetches: 0 };
  const timers = [];
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };
  const generalTab = makeNode("tabGeneral");
  generalTab.className = "settings-tab-btn active";
  generalTab.dataset.tab = "general";
  const aboutTab = makeNode("tabAbout");
  aboutTab.className = "settings-tab-btn";
  aboutTab.dataset.tab = "about";
  const panelGeneral = makeNode("panelGeneral");
  panelGeneral.className = "settings-panel active";
  const panelAbout = makeNode("panelAbout");
  panelAbout.className = "settings-panel";
  const desktopHost = options.noHost ? undefined : {
    getAppVersion: async () => "1.2.3",
    beginUpdate: async () => { calls.downloads++; return false; },
  };
  if (desktopHost && !options.omitCheck) desktopHost.checkForUpdates = async () => {
    calls.checks++;
    if (options.failCheck) throw new Error("synthetic update check failure");
    return options.result || { phase: "current" };
  };
  const context = vm.createContext({
    URL, byId,
    text: (id, value) => { byId(id).textContent = value == null ? "" : String(value); },
    setTimeout(fn, delay) { timers.push({ fn, delay, kind: "timeout" }); return timers.length; },
    setInterval(fn, delay) { timers.push({ fn, delay, kind: "interval" }); return timers.length; },
    clearTimeout() {}, clearInterval() {},
    loadRuntime() {}, loadModelSource() {}, loadLocalModel() {}, loadDataRoot() {},
    showLocalModelDownload() {},
    fetch() { calls.fetches++; throw new Error("update check must not use the network"); },
    document: {
      activeElement: null,
      addEventListener() {},
      querySelector(selector) {
        return selector === '.settings-tab-btn[data-tab="about"]' ? aboutTab : null;
      },
      querySelectorAll(selector) {
        if (selector === ".settings-tab-btn") return [generalTab, aboutTab];
        if (selector === ".settings-panel") return [panelGeneral, panelAbout];
        return [];
      },
    },
    window: { desktopHost, addEventListener() {} },
  });
  vm.runInContext(updateCode, context);
  async function settle() {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  }
  return {
    calls, timers, byId, context, generalTab, aboutTab, panelGeneral, panelAbout, settle,
    notice: byId("btnUpdateNotice"),
    apply: next => context.applyUpdateState(next),
    unlock: () => context.unlockStartupUi(),
    async fireStartupCheck() {
      const due = timers.filter(timer => timer.kind === "timeout" && timer.delay === 10_000);
      assert.equal(due.length, 1);
      due[0].fn();
      await settle();
    },
  };
}

it("places a compact update notice above the settings button", () => {
  const rail = html.slice(html.indexOf('<aside class="nav-rail">'), html.indexOf("</aside>"));
  const notice = rail.indexOf('id="btnUpdateNotice"');
  const settings = rail.indexOf('id="btnSettings"');
  assert.ok(notice >= 0 && settings > notice);
  assert.match(rail.slice(notice, settings), /hidden[\s\S]*更新/);
  assert.match(css, /\.nav-update-notice \{/);
  assert.match(css, /body\.theme-light \.nav-update-notice \{/);
  assert.match(source, /void startInitialLoad\(\);\r?\n\s*scheduleBackgroundUpdateChecks\(\);/);
});

it("hides the notice until an update is available, ready, or in progress", async () => {
  const ui = harness();
  await ui.settle();
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.notice.textContent, "更新");

  ui.apply({ phase: "available", latestVersion: "1.2.4" });
  assert.equal(ui.notice.hidden, false);
  assert.equal(ui.notice.textContent, "更新");
  assert.equal(ui.notice.title, "更新 v1.2.4");
  assert.equal(ui.notice.getAttribute("aria-label"), "更新 v1.2.4");

  ui.apply({ phase: "ready", latestVersion: "1.2.4" });
  assert.equal(ui.notice.hidden, false);
  ui.apply({ phase: "downloading", latestVersion: "1.2.4" });
  assert.equal(ui.notice.hidden, false);
  ui.apply({ phase: "current" });
  assert.equal(ui.notice.hidden, true);
  ui.apply({ phase: "server-error" });
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.calls.downloads, 0);
  assert.equal(ui.calls.fetches, 0);
});

it("opens the about tab and the update modal from the notice", async () => {
  const ui = harness();
  await ui.settle();
  ui.apply({ phase: "available", latestVersion: "9.9.9" });
  ui.notice.click();
  await ui.settle();
  assert.equal(hasClass(ui.byId("settingsModal"), "show"), true);
  assert.equal(hasClass(ui.aboutTab, "active"), true);
  assert.equal(hasClass(ui.generalTab, "active"), false);
  assert.equal(hasClass(ui.panelAbout, "active"), true);
  assert.equal(hasClass(ui.panelGeneral, "active"), false);
  assert.equal(hasClass(ui.byId("updateModal"), "show"), true);
  assert.equal(ui.calls.checks, 0);
  assert.equal(ui.calls.downloads, 0);
  assert.equal(ui.calls.fetches, 0);
});

it("runs one startup check after the UI is ready, without network or a download", async () => {
  const ui = harness();
  await ui.settle();
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.calls.checks, 0);
  ui.unlock();
  ui.unlock();
  assert.equal(ui.timers.filter(timer => timer.kind === "timeout").length, 1);
  assert.equal(ui.calls.checks, 0);
  await ui.fireStartupCheck();
  assert.equal(ui.calls.checks, 1);
  assert.equal(ui.calls.downloads, 0);
  assert.equal(ui.calls.fetches, 0);
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.byId("updateStatus").textContent, "已是最新版本");
  const interval = ui.timers.filter(timer => timer.kind === "interval");
  assert.equal(interval.length, 1);
  assert.equal(interval[0].delay, 6 * 60 * 60 * 1000);
  assert.equal(ui.calls.checks, 1);
  ui.byId("btnAboutVersion").click();
  await ui.settle();
  assert.equal(ui.calls.checks, 1);
});

it("shows nothing when the background check fails, and a manual check still reports it", async () => {
  const ui = harness({ failCheck: true });
  await ui.settle();
  ui.unlock();
  await ui.fireStartupCheck();
  assert.equal(ui.calls.checks, 1);
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.byId("updateStatus").textContent, "准备检查更新");
  assert.equal(ui.calls.downloads, 0);
  assert.equal(ui.calls.fetches, 0);
  ui.byId("btnAboutVersion").click();
  await ui.settle();
  assert.equal(ui.calls.checks, 2);
  assert.equal(ui.byId("updateStatus").textContent, "暂时无法检查更新");
  assert.equal(ui.notice.hidden, true);

  const manual = harness({ failCheck: true });
  await manual.settle();
  await manual.context.checkForUpdates();
  await manual.settle();
  assert.equal(manual.byId("updateStatus").textContent, "暂时无法检查更新");
  assert.equal(manual.notice.hidden, true);
  assert.equal(manual.calls.downloads, 0);
});

for (const status of ["offline", "server-error"]) {
  it(`ignores a quiet ${status} result and still checks when the update modal opens`, async () => {
    const ui = harness({ result: { status } });
    await ui.settle();
    ui.unlock();
    await ui.fireStartupCheck();
    assert.equal(ui.calls.checks, 1);
    assert.equal(ui.notice.hidden, true);
    assert.equal(ui.byId("updateStatus").textContent, "准备检查更新");
    assert.equal(ui.calls.downloads, 0);
    assert.equal(ui.calls.fetches, 0);

    ui.byId("btnAboutVersion").click();
    await ui.settle();
    assert.equal(ui.calls.checks, 2);
    assert.equal(ui.notice.hidden, true);
    assert.equal(ui.byId("updateStatus").textContent, status === "offline" ? "网络不可用，请重试" : "暂时无法检查更新");
    assert.equal(ui.calls.downloads, 0);
    assert.equal(ui.calls.fetches, 0);
  });
}

it("shows the notice when a background check resolves available", async () => {
  const ui = harness({ result: { status: "available", latestVersion: "1.2.4" } });
  await ui.settle();
  ui.unlock();
  await ui.fireStartupCheck();
  assert.equal(ui.calls.checks, 1);
  assert.equal(ui.notice.hidden, false);
  assert.equal(ui.notice.textContent, "更新");
  assert.equal(ui.notice.title, "更新 v1.2.4");
  assert.equal(ui.byId("updateStatus").textContent, "发现新版本 v1.2.4");
  assert.equal(ui.calls.downloads, 0);
  assert.equal(ui.calls.fetches, 0);
});

it("does not schedule a check when the desktop host cannot check", async () => {
  const ui = harness({ omitCheck: true });
  await ui.settle();
  assert.equal(ui.notice.hidden, true);
  ui.unlock();
  assert.equal(ui.timers.length, 0);
  assert.equal(ui.calls.checks, 0);
  assert.equal(ui.calls.fetches, 0);
});
