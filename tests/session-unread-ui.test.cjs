const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");
const source = readFileSync(path.join(__dirname, "../chatui/app.js"), "utf8");
const code = source.slice(source.indexOf("function getWatermarks("), source.indexOf("const defaults =")) +
  "globalThis.ui = { getWatermarks, markSessionAsRead, getVisibleUnreadCount };";
function harness(raw = "{}") {
  let reads = 0, writes = 0;
  const session = { username: "peer", time: 100, unreadCount: 3, preview: "synthetic" };
  const context = vm.createContext({
    chatState: { currentAccount: "account-a", currentUser: null, sessions: new Map([["peer", session]]) },
    localStorage: {
      getItem(key) { assert.equal(key, "read-watermark:account-a"); reads++; return raw; },
      setItem(key, value) { assert.equal(key, "read-watermark:account-a"); writes++; raw = value; },
    },
  });
  vm.runInContext(code, context);
  return { ui: context.ui, context, session, counts: () => ({ reads, writes }) };
}
it("treats malformed, null and non-object saved watermarks as an empty record", () => {
  for (const raw of ["broken", "null", "[]", '"string"', "3"]) {
    const h = harness(raw);
    assert.equal(h.ui.getVisibleUnreadCount(h.session), 3);
    assert.doesNotThrow(() => h.ui.markSessionAsRead("peer"));
    assert.equal(h.ui.getVisibleUnreadCount(h.session), 0);
  }
});
it("does not rewrite unchanged read state on every live message poll", () => {
  const h = harness();
  h.ui.markSessionAsRead("peer");
  for (let index = 0; index < 30; index++) h.ui.markSessionAsRead("peer");
  assert.equal(h.counts().writes, 1);
  h.session.unreadCount = 5;
  assert.equal(h.ui.getVisibleUnreadCount(h.session), 2);
  h.ui.markSessionAsRead("peer");
  assert.equal(h.counts().writes, 2);
  h.session.preview = "new-synthetic-message";
  assert.equal(h.ui.getVisibleUnreadCount(h.session), 5);
});
it("calculates an entire render from one watermark snapshot without extra storage reads", () => {
  const h = harness();
  const marks = h.ui.getWatermarks();
  for (let index = 0; index < 1000; index++) assert.equal(h.ui.getVisibleUnreadCount({ ...h.session, username: `peer-${index}` }, marks), 3);
  assert.equal(h.counts().reads, 1);
  h.context.chatState.currentUser = "peer";
  assert.equal(h.ui.getVisibleUnreadCount(h.session, marks), 0);
});
it("keeps settings usable when persistent storage rejects a write", () => {
  const warnings = [], settings = { theme: "light" };
  const context = vm.createContext({ settingsState: { settings }, toast: value => warnings.push(value),
    localStorage: { setItem() { throw new Error("QuotaExceededError"); } },
  });
  vm.runInContext(source.slice(source.indexOf("const save ="), source.indexOf("chatState.sessions =")) + "globalThis.saveSettings = save;", context);
  assert.doesNotThrow(() => context.saveSettings());
  assert.equal(settings.theme, "light");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /存储不可用/);
});
