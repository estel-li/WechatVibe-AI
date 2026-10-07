const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");
const { seed } = require("./helpers/view-state-harness.cjs");

const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
const html = readFileSync(path.join(__dirname, "../chatui/index.html"), "utf8");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
const code = section("function renderSessions()", "async function preloadSessionWindows(") +
  section("function showChatEmptyState()", "async function loadSessions(") +
  section('byId("btnAddConversation").addEventListener', 'byId("conversationSearch").addEventListener') +
  "globalThis.ui = { renderSessions, showChatEmptyState, closeConversationManager, " +
  "updateAddConversationButton, toggleConversationSelected };";

function node(tag = "div", className = "", textContent = "") {
  const item = { tag, className, textContent, value: "", dataset: {}, children: [],
    listeners: {}, parent: null, hidden: false, disabled: false, attributes: {},
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key]; },
    append(...children) { for (const child of children) this.appendChild(child); },
    appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; },
    prepend(child) { child.remove(); child.parent = this; this.children.unshift(child); },
    insertBefore(child, before) {
      child.remove(); child.parent = this;
      const index = this.children.indexOf(before);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    querySelector(selector) {
      for (const child of this.children) {
        if (selector.startsWith(".") && child.classList.contains(selector.slice(1))) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    click() { if (!this.disabled) for (const listener of this.listeners.click || []) listener({ target: this }); },
    focus() { this.focused = true; },
  };
  item.classList = {
    contains: name => item.className.split(/\s+/).includes(name),
    add: name => { if (!item.classList.contains(name)) item.className = `${item.className} ${name}`.trim(); },
    remove: name => { item.className = item.className.split(/\s+/).filter(value => value !== name).join(" "); },
    toggle: (name, enabled) => { item.classList[enabled ? "add" : "remove"](name); },
  };
  Object.defineProperty(item, "lastElementChild", { get: () => item.children.at(-1) });
  return item;
}

function harness({ selected = [], messagesReady = true, sourceMode = "api" } = {}) {
  const nodes = new Map();
  const byId = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const posts = [], preloads = [], switches = [];
  const sessions = new Map([
    ["first", { username: "first", name: "合成甲", preview: "第一段", time: 1 }],
    ["second", { username: "second", name: "合成乙", preview: "第二段", time: 2 }],
  ]);
  byId("conversationManager").hidden = true;
  byId("btnAddConversation").disabled = true;
  byId("settingsModal").appendChild(node("div", "settings-modal-card"));
  byId("btnSettings").addEventListener("click", () => byId("settingsModal").classList.add("show"));
  const generalTab = node("button");
  const context = vm.createContext({
    byId, element: node,
    document: { createTextNode: value => node("#text", "", value), querySelector: () => generalTab },
    text: (id, value) => { byId(id).textContent = value; },
    status: (container, value) => container.replaceChildren(node("div", "ui-state", value)),
    avatar: () => node("div", "avatar-frame"),
    time: value => String(value), getWatermarks: () => ({}), getVisibleUnreadCount: session => session.unreadCount || 0, markSessionAsRead() {},
    switchSession: user => { switches.push(user); },
    preloadSessionWindows: async (_account, values) => { preloads.push([...values.keys()]); },
    clearUnselectedConversation() { throw new Error("An existing selected conversation must be preserved"); },
    api: async (url, options) => {
      assert.equal(url, "/api/conversation-selection");
      const payload = JSON.parse(options.body);
      posts.push(payload);
      const next = new Set(context.chatState.selectedConversations);
      if (payload.selected) next.add(payload.session); else next.delete(payload.session);
      return { account: payload.expectedAccount, selectedSessions: [...next] };
    },
  });
  seed(context, {
    currentAccount: "synthetic-account", selectionLoadedAccount: "synthetic-account",
    selectedConversations: new Set(selected), sessions, currentUser: selected[0] || null,
    messageSourceReady: messagesReady, conversationSelectionBusy: false, sessionRequest: 1,
    modelSourceSnapshot: { mode: sourceMode, sourceId: sourceMode === "api" ? "synthetic-api" : "local" },
  });
  vm.runInContext(code, context);
  return { context, ui: context.ui, byId, posts, preloads, switches };
}

function assertManagerOpen(h) {
  assert.equal(h.byId("conversationManager").hidden, false);
  assert.equal(h.byId("settingsModal").classList.contains("show"), true);
  assert.equal(h.byId("conversationSearch").focused, true);
  assert.equal(h.byId("conversationManagerList").children.length, 2);
}

it("keeps a permanent add entry and opens the selector with no selected conversations", () => {
  assert.match(html, /<button\b[^>]*id="btnAddConversation"[^>]*disabled/);
  const h = harness();
  h.ui.renderSessions();
  assert.equal(h.byId("btnAddConversation").disabled, false);
  h.byId("sessionList").children[0].children.at(-1).click();
  assertManagerOpen(h);
  assert.equal(h.posts.length, 0);
  assert.equal(h.preloads.length, 0);
});

it("opens the same selector after the first conversation is added without changing the active view or selection", () => {
  for (const sourceMode of ["api", "local"]) {
    const h = harness({ selected: ["first"], sourceMode });
    h.ui.renderSessions();
    const existingRow = h.byId("sessionList").children[0];
    const sourceSnapshot = h.context.settingsState.modelSourceSnapshot;
    h.byId("btnAddConversation").click();
    assertManagerOpen(h);
    h.ui.closeConversationManager();
    h.byId("btnAddConversation").click();
    assertManagerOpen(h);
    h.ui.renderSessions();
    assert.equal(h.byId("sessionList").children[0], existingRow);
    assert.equal(h.context.chatState.currentUser, "first");
    assert.deepEqual([...h.context.chatState.selectedConversations], ["first"]);
    assert.equal(h.context.settingsState.modelSourceSnapshot, sourceSnapshot);
    assert.equal(h.byId("conversationManagerList").children[0].children.at(-1).textContent, "从列表移除");
    assert.equal(h.posts.length, 0);
    assert.equal(h.preloads.length, 0);
  }
});

it("keeps the directory usable when messages are not ready and when the directory is empty", () => {
  const h = harness({ messagesReady: false });
  h.ui.renderSessions();
  assert.equal(h.byId("btnAddConversation").disabled, false);
  h.byId("btnAddConversation").click();
  assertManagerOpen(h);
  h.context.chatState.sessions.clear();
  h.ui.renderSessions();
  assert.equal(h.byId("btnAddConversation").disabled, false);
  assert.equal(h.preloads.length, 0);
});

it("disables the add entry while the current account's selection is not loaded", () => {
  const h = harness({ selected: ["first"] });
  h.context.chatState.currentAccount = "another-account";
  h.ui.renderSessions();
  assert.equal(h.byId("btnAddConversation").disabled, true);
  h.byId("btnAddConversation").click();
  assert.equal(h.byId("conversationManager").hidden, true);
  h.context.chatState.currentAccount = null;
  h.context.chatState.selectionLoadedAccount = null;
  h.ui.updateAddConversationButton();
  assert.equal(h.byId("btnAddConversation").disabled, true);
});

it("provides selector access from a filtered empty list and from the idle chat pane", () => {
  const h = harness({ selected: ["first"] });
  h.byId("searchInput").value = "没有这样的名字";
  h.ui.renderSessions();
  const empty = h.byId("sessionList").children[0];
  assert.equal(empty.children[0].textContent, "没有匹配的会话");
  empty.children.at(-1).click();
  assertManagerOpen(h);
  h.ui.closeConversationManager();
  h.ui.showChatEmptyState();
  h.byId("chatMessages").children[0].children.at(-1).click();
  assertManagerOpen(h);
  assert.deepEqual([...h.context.chatState.selectedConversations], ["first"]);
});

it("adds and removes a second conversation through the existing account-scoped selection endpoint", async () => {
  const h = harness({ selected: ["first"] });
  h.ui.renderSessions();
  h.byId("btnAddConversation").click();
  await h.ui.toggleConversationSelected("second");
  assert.deepEqual([...h.context.chatState.selectedConversations], ["first", "second"]);
  assert.deepEqual(h.byId("sessionList").children.map(row => row.dataset.id), ["first", "second"]);
  assert.deepEqual(h.posts[0], { expectedAccount: "synthetic-account", session: "second", selected: true });
  assert.deepEqual(h.preloads, [["second"]]);
  assert.equal(h.switches.length, 0);
  await h.ui.toggleConversationSelected("second");
  assert.deepEqual([...h.context.chatState.selectedConversations], ["first"]);
  assert.equal(h.context.chatState.currentUser, "first");
  assert.equal(h.byId("btnAddConversation").disabled, false);
});

it("exposes one keyboard entry and keeps filtered rows reusable without losing the active chat", () => {
  const h = harness({ selected: ["first", "second"] });
  h.context.chatState.sessions.get("second").unreadCount = 3;
  h.ui.renderSessions();
  const rows = h.byId("sessionList").children;
  assert.equal(rows[0].tag, "button");
  assert.deepEqual(rows.map(row => row.tabIndex), [0, -1]);
  assert.equal(rows[0].getAttribute("aria-pressed"), "true");
  assert.equal(rows[1].getAttribute("aria-label"), "合成乙，3 条未读");
  const unreadRow = rows[1];
  h.context.chatState.sessionFilter = "unread";
  h.ui.renderSessions();
  assert.deepEqual(h.byId("sessionList").children.map(row => row.dataset.id), ["second"]);
  assert.equal(h.byId("sessionList").children[0], unreadRow);
  assert.equal(unreadRow.tabIndex, 0);
  assert.equal(h.context.chatState.currentUser, "first");
  h.context.chatState.sessions.get("second").unreadCount = 0;
  h.ui.renderSessions();
  assert.equal(h.byId("sessionList").children[0].children[0].textContent, "没有未读会话");
  h.byId("sessionList").children[0].children.at(-1).click();
  assert.equal(h.context.chatState.sessionFilter, "all");
});
