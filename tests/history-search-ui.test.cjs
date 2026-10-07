const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");
const { seed } = require("./helpers/view-state-harness.cjs");
const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
const code = source.slice(source.indexOf("function cancelHistorySearch("), source.indexOf("function renderJob(")) +
  "globalThis.ui = { loadHistorySearchPage, cancelHistorySearch, resetHistorySearch, startHistorySearch };";
function node(tag = "div", className = "", textContent = "") {
  return { tag, className, textContent, children: [], attributes: {}, value: "", hidden: false,
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, contains() { return false; }, focus() {},
    setAttribute(key, value) { this.attributes[key] = String(value); },
  };
}
function harness(reply) {
  const nodes = new Map(), calls = [];
  const byId = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = vm.createContext({ byId, element: node, document: { createTextNode: value => node("#text", "", value) },
    text: (id, value) => { byId(id).textContent = value; }, time: String, AbortController, URLSearchParams,
    api: async (url, options, signal) => { calls.push(url); return reply(url, calls.length, signal); }, toast() {},
  });
  seed(context, { currentAccount: "account-a", currentUser: "peer-a", historySearchQuery: { q: "needle", date: "" } });
  vm.runInContext(code, context);
  return { context, ui: context.ui, byId, calls };
}
const message = id => ({ id, historyCursor: `hit-${id}`, side: "other", time: 1, text: `synthetic needle ${id}` });
const page = (id, hasMore = true) => ({ account: "account-a", user: "peer-a", messages: [message(id)], hasMore, nextCursor: hasMore ? `next-${id}` : null });

it("reuses visited pages, preserves results after failure, and retries the failed page", async () => {
  let fail = false;
  const h = harness((_url, count) => { if (fail) throw new Error("offline"); return page(count); });
  await h.ui.loadHistorySearchPage(0);
  const original = h.byId("historySearchResults").children[0];
  fail = true;
  await h.ui.loadHistorySearchPage(1);
  assert.equal(h.byId("historySearchResults").children[0], original);
  assert.equal(h.byId("btnHistoryNextResults").hidden, false);
  assert.equal(h.byId("btnRetryHistorySearch").hidden, false);
  assert.equal(h.context.chatState.historySearchRetryPage, 1);
  assert.equal(h.byId("historySearchResults").attributes["aria-busy"], "false");
  fail = false;
  await h.ui.loadHistorySearchPage(h.context.chatState.historySearchRetryPage);
  assert.equal(h.context.chatState.historySearchPage, 1);
  await h.ui.loadHistorySearchPage(0);
  assert.equal(h.calls.length, 3);
  assert.equal(h.byId("btnHistoryPrevResults").hidden, true);
  assert.equal(h.byId("btnHistoryNextResults").hidden, false);
});

it("cancels an in-flight page without losing earlier page navigation or accepting its late response", async () => {
  let release;
  const h = harness((_url, count) => count === 1 ? page(1) : new Promise(resolve => { release = resolve; }));
  await h.ui.loadHistorySearchPage(0);
  const pending = h.ui.loadHistorySearchPage(1);
  h.ui.cancelHistorySearch(true);
  release(page(2));
  await pending;
  assert.equal(h.context.chatState.historySearchPage, 0);
  assert.equal(h.context.chatState.historySearchCache.size, 1);
  assert.equal(h.byId("btnHistoryNextResults").hidden, false);
  assert.equal(h.byId("historySearchStatus").textContent, "已取消，可以重新搜索");
});

it("bounds empty-page scanning and exposes a continuation instead of an endless request loop", async () => {
  const h = harness((_url, count) => ({ ...page(count), messages: [] }));
  await h.ui.loadHistorySearchPage(0);
  assert.equal(h.calls.length, 12);
  assert.equal(h.byId("btnHistoryNextResults").hidden, false);
  assert.match(h.byId("historySearchStatus").textContent, /继续搜索/);
  assert.equal(h.context.chatState.historySearchPageStarts[1], "next-12");
});

it("rejects cursor cycles and cross-account responses", async () => {
  const h = harness((_url, count) => ({ ...page(count), messages: [], nextCursor: count % 2 ? "a" : "b" }));
  await h.ui.loadHistorySearchPage(0);
  assert.equal(h.calls.length, 3);
  assert.equal(h.byId("btnRetryHistorySearch").hidden, false);
  const wrong = harness(() => ({ ...page(1), account: "account-b" }));
  await wrong.ui.loadHistorySearchPage(0);
  assert.equal(wrong.context.chatState.historySearchCache.size, 0);
  assert.equal(wrong.byId("btnRetryHistorySearch").hidden, false);
});

it("shows the matched part of long messages using text nodes and clears cache on scope reset", async () => {
  const malicious = `${"x".repeat(600)}<img src=x onerror=alert(1)>needle & literal`;
  const h = harness(() => ({ ...page(1, false), messages: [{ ...message(1), text: malicious }] }));
  await h.ui.loadHistorySearchPage(0);
  const snippet = h.byId("historySearchResults").children[0].children[1];
  assert.equal(snippet.children.find(child => child.tag === "mark").textContent, "needle");
  assert.ok(snippet.children.some(child => child.tag === "#text" && child.textContent.includes("<img")));
  assert.equal(snippet.children.some(child => child.tag === "img"), false);
  h.ui.resetHistorySearch();
  assert.equal(h.context.chatState.historySearchCache.size, 0);
  assert.equal(h.byId("historySearchResults").children.length, 0);
});

it("expires pages and invalidates dependent cursors when new results change the next-page boundary", async () => {
  const h = harness((_url, count) => page(count));
  await h.ui.loadHistorySearchPage(0);
  await h.ui.loadHistorySearchPage(1);
  h.context.chatState.historySearchCache.get(0).savedAt -= 61000;
  await h.ui.loadHistorySearchPage(0);
  assert.equal(h.calls.length, 3);
  assert.equal(h.context.chatState.historySearchCache.has(1), false);
  assert.equal(h.context.chatState.historySearchPageStarts.length, 2);
  assert.equal(h.context.chatState.historySearchPageStarts[1], "next-3");
});

it("bounds cached message pages and rejects invalid page or query input without a request", async () => {
  const h = harness((_url, count) => page(count));
  for (let index = 0; index < 10; index++) await h.ui.loadHistorySearchPage(index);
  assert.equal(h.context.chatState.historySearchCache.size, 8);
  assert.equal(h.context.chatState.historySearchCache.has(0), false);
  assert.equal(h.context.chatState.historySearchCache.has(9), true);
  await h.ui.loadHistorySearchPage(-1);
  await h.ui.loadHistorySearchPage(1.5);
  h.byId("historyKeyword").value = "a".repeat(257);
  h.ui.startHistorySearch();
  assert.equal(h.calls.length, 10);
  assert.match(h.byId("historySearchStatus").textContent, /256/);
});
