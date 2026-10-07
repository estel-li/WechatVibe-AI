const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../chatui/ai-assistant.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../chatui/index.html"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const settings = () => ({ preset: "deepseek", protocol: "chat_completions", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", contextTokens: 65536, ready: true, hasKey: true,
  summaryPrompt: "总结给定对话", relationshipPrompts: { friend: "朋友提示", close_friend: "亲密提示", colleague: "同事提示", relative: "亲戚提示", elder: "长辈提示", custom: "自定义提示" }, defaultRelationship: "friend" });

function harness(handler, readSettings = settings) {
  const nodes = new Map(), requests = [], copied = [];
  const document = { activeElement: null, events: {}, addEventListener(type, callback) { (this.events[type] ||= []).push(callback); },
    getElementById(id) { return nodes.get(id); }, querySelectorAll() { return [...nodes.values()].filter(node => node.dataset.assistantTab); },
    execCommand() { copied.push(document.activeElement.value); return true; } };
  class Element {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.id = attrs.id; this.value = attrs.value || "";
      this.hidden = "hidden" in attrs; this.disabled = "disabled" in attrs; this.checked = false; this.children = []; this.events = {}; this.style = {};
      this.textContent = ""; this.dataset = { ...(attrs["data-assistant-tab"] ? { assistantTab: attrs["data-assistant-tab"] } : {}) };
      this.tabIndex = "tabindex" in attrs ? Number(attrs.tabindex) : ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName) ? 0 : -1;
      if (this.id) nodes.set(this.id, this);
    }
    get isConnected() { return !this.removed; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    dispatchEvent(event) { event.target ||= this; for (const callback of this.events[event.type] || []) callback(event); return true; }
    click() { if (!this.disabled) this.dispatchEvent({ type: "click" }); }
    focus() { document.activeElement = this; }
    select() {}
    setSelectionRange() {}
    appendChild(node) { node.parent = this; this.children.push(node); }
    replaceChildren() { this.children = []; }
    remove() { this.removed = true; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest() { return this.hidden ? this : this.parent?.closest() || null; }
    getClientRects() { return this.closest() ? [] : [{}]; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]).filter(node => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(node.tagName) || node.tabIndex === 0); }
  }
  const root = new Element("body"), stack = [root], voidTags = new Set(["link", "meta", "input", "img", "br", "hr"]);
  for (const token of html.matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
    const [, closing, tag, raw] = token;
    if (closing) { const index = stack.findLastIndex(item => item.tagName === tag.toUpperCase()); if (index > 0) stack.length = index; continue; }
    const attrs = Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], match[2] || ""]));
    const node = new Element(tag, attrs); stack.at(-1).appendChild(node); if (!voidTags.has(tag)) stack.push(node);
  }
  for (const node of nodes.values()) if (node.tagName === "SELECT") node.value = node.children.find(child => child.tagName === "OPTION")?.value || "";
  document.body = root; document.createElement = tag => new Element(tag);
  const window = { addEventListener() {}, desktopHost: { async copyDraft(value) { copied.push(value); return true; } } };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ url, body, options });
    const value = url === "/api/assistant/settings" && !body ? readSettings() : await handler(url, body, options);
    return { ok: true, status: 200, json: async () => value };
  };
  const navigator = {};
  vm.runInNewContext(source, { document, window, fetch, navigator, AbortController, setTimeout, clearTimeout,
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } });
  return { document, nodes, requests, copied, window, navigator, api: window.AIAssistant,
    node: id => nodes.get(id), input(id, value) { const node = nodes.get(id); node.value = value; node.dispatchEvent({ type: "input" }); },
    change(id, value) { const node = nodes.get(id); node.value = value; node.dispatchEvent({ type: "change" }); },
    async open(mode = "reply") { window.AIAssistant.setConversation({ account: "test-account", user: "alice", name: "Alice" }); window.AIAssistant.open(mode); await tick(); },
    close() { nodes.get("btnCloseAssistant").click(); } };
}

test("assistant starts no service/API calls until explicitly opened and model discovery sends only connection fields", async () => {
  const h = harness(async url => url.endsWith("models") ? { models: [{ id: "model-x" }, { id: "model-y" }] } : {});
  h.api.setConversation({ account: "test-account", user: "alice" });
  assert.equal(h.requests.length, 0);
  await h.open(); h.node("assistantTabSettings").click(); h.node("btnAssistantModels").click(); await tick();
  assert.deepEqual(h.requests.at(-1).body, { protocol: "chat_completions", baseUrl: "https://api.deepseek.com" });
  assert.equal(h.node("assistantModelOptions").children.length, 2);
  assert.match(h.node("assistantConfigStatus").textContent, /2 个模型/); h.close();
});

test("relationship edits persist together with independently configured model and secret input is cleared after saving", async () => {
  let saved;
  const h = harness(async (url, body) => { saved = body; return { ...settings(), ...body, hasKey: true }; });
  await h.open(); h.input("assistantReplyPrompt", "我的朋友提示"); h.change("assistantRelationship", "elder");
  assert.equal(h.node("assistantReplyPrompt").value, "长辈提示");
  h.input("assistantReplyPrompt", "尊重长辈并保持边界"); h.node("assistantTabSettings").click();
  h.input("assistantApiKey", "synthetic-not-a-live-key"); h.node("btnAssistantSave").click(); await tick();
  assert.equal(saved.relationshipPrompts.friend, "我的朋友提示"); assert.equal(saved.relationshipPrompts.elder, "尊重长辈并保持边界");
  assert.equal(saved.defaultRelationship, "elder"); assert.equal(h.node("assistantApiKey").value, "");
  assert.equal("source" in saved, false); h.close();
});

test("reply regeneration captures previous answer and copy/insert use safe text without sending", async () => {
  let count = 0;
  const h = harness(async (url, body) => url.endsWith("jobs") ? { id: `job-${++count}`, account: body.account, user: body.user, kind: body.kind, status: "completed", text: `<img src=x>草稿${count}`, progress: { messageCount: 8 } } : {});
  await h.open(); h.node("chatInput").value = "原草稿"; h.node("btnAssistantReply").click(); await tick();
  assert.equal(h.node("assistantResultText").textContent, "<img src=x>草稿1");
  h.node("btnAssistantRegenerate").click(); await tick();
  assert.equal(h.requests.at(-1).body.previousReply, "<img src=x>草稿1");
  h.node("btnAssistantCopy").click(); await tick(); assert.deepEqual(h.copied, ["<img src=x>草稿2"]);
  assert.equal(h.node("chatInput").value, "原草稿"); h.node("btnAssistantInsert").click();
  assert.equal(h.node("chatInput").value, "<img src=x>草稿2"); assert.equal(h.node("assistantModal").hidden, true);
  assert.equal(h.requests.some(item => /send/.test(item.url)), false);
});

test("account/chat switch cancels even a late job creation response and never displays another conversation's output", async () => {
  let resolve;
  const h = harness(async url => url.endsWith("jobs") ? new Promise(done => { resolve = done; }) : { status: "cancelled" });
  await h.open(); h.node("btnAssistantReply").click(); await tick();
  h.api.setConversation({ account: "second-account", user: "bob", name: "Bob" });
  resolve({ id: "late-job", account: "test-account", user: "alice", kind: "reply", status: "completed", text: "Alice 的私有结果" }); await tick();
  assert.equal(h.node("assistantResultSection").hidden, true); assert.equal(h.node("assistantResultText").textContent, "");
  assert.deepEqual(h.requests.at(-1).body, { account: "test-account", id: "late-job" });
  assert.equal(h.requests.at(-1).url, "/api/assistant/cancel"); h.close();
});

test("closing during job creation keeps request alive until cancellation can identify the server job", async () => {
  let resolve;
  const h = harness(async url => url.endsWith("jobs") ? new Promise(done => { resolve = done; }) : {});
  await h.open(); h.node("btnAssistantReply").click(); await tick();
  const creating = h.requests.at(-1); h.close(); assert.equal(creating.options.signal.aborted, false);
  resolve({ id: "close-job", account: "test-account", user: "alice", kind: "reply", status: "queued" }); await tick();
  assert.equal(h.requests.at(-1).url, "/api/assistant/cancel");
});

test("invalid time range stays local, valid summary range sends exact milliseconds, changed API settings block generation", async () => {
  const h = harness(async (url, body) => ({ id: "summary", account: body.account, user: body.user, kind: body.kind, status: "completed", text: "总结" }));
  await h.open("summary"); h.change("assistantSummaryRange", "time"); h.node("btnAssistantSummary").click(); await tick();
  assert.match(h.node("assistantJobStatus").textContent, /有效的开始和结束时间/); assert.equal(h.requests.length, 1);
  h.node("assistantSummaryFrom").value = "2026-10-01T08:00"; h.node("assistantSummaryTo").value = "2026-10-02T18:30";
  h.node("btnAssistantSummary").click(); await tick();
  assert.equal(h.requests.at(-1).body.fromMs, new Date("2026-10-01T08:00").getTime()); assert.equal(h.requests.at(-1).body.range, "time");
  h.input("assistantBaseUrl", "https://new-provider.test/v1"); assert.equal(h.node("btnAssistantSummary").disabled, true); h.close();
});

test("Escape closes the modal and restores focus; tab boundaries stay in the visible dialog", async () => {
  const h = harness(async () => ({})); const trigger = h.node("btnAIReply"); trigger.focus(); await h.open();
  h.node("assistantTabReply").focus(); let prevented = 0;
  const key = (value, shiftKey = false) => { const event = { key: value, shiftKey, preventDefault() { prevented++; }, stopImmediatePropagation() {} }; for (const listener of h.document.events.keydown || []) listener(event); };
  h.node("btnCloseAssistant").focus(); key("Tab", true); assert.equal(h.document.activeElement.id, "btnAssistantReply");
  key("Tab"); assert.equal(h.document.activeElement.id, "btnCloseAssistant"); key("Escape");
  assert.equal(h.node("assistantModal").hidden, true); assert.equal(h.document.activeElement, trigger); assert.equal(prevented, 3);
});

test("cleared official key is obvious and blocks generation, while custom services without authentication remain usable", async () => {
  const h = harness(async (url, body) => ({ ...settings(), ...body, hasKey: false }));
  await h.open(); h.node("assistantTabSettings").click(); h.node("assistantClearKey").checked = true;
  h.node("assistantClearKey").dispatchEvent({ type: "input" }); h.node("btnAssistantSave").click(); await tick();
  assert.match(h.node("assistantModelInfo").textContent, /尚未保存 API Key/); assert.equal(h.node("btnAssistantReply").disabled, true);
  h.change("assistantPreset", "custom"); h.input("assistantBaseUrl", "https://custom.example.test/v1");
  h.input("assistantContextTokens", "1000001"); const before = h.requests.length; h.node("btnAssistantSave").click(); await tick();
  assert.equal(h.requests.length, before); assert.match(h.node("assistantConfigStatus").textContent, /4096 至 1,000,000/);
  h.input("assistantContextTokens", "4096"); h.node("btnAssistantSave").click(); await tick();
  assert.equal(h.node("btnAssistantReply").disabled, false); assert.match(h.node("assistantModelInfo").textContent, /未配置 Key/); h.close();
});

test("switching API endpoint, protocol or preset cannot forward a previous unsaved key", async () => {
  const h = harness(async () => ({ models: [] })); await h.open(); h.node("assistantTabSettings").click();
  h.input("assistantApiKey", "synthetic-key-one"); h.input("assistantBaseUrl", "https://custom.example.test/v1");
  assert.equal(h.node("assistantApiKey").value, ""); h.node("btnAssistantModels").click(); await tick();
  assert.equal("apiKey" in h.requests.at(-1).body, false);
  h.input("assistantApiKey", "synthetic-key-two"); h.input("assistantProtocol", "anthropic"); assert.equal(h.node("assistantApiKey").value, "");
  h.input("assistantApiKey", "synthetic-key-three"); h.change("assistantPreset", "deepseek"); assert.equal(h.node("assistantApiKey").value, ""); h.close();
});

test("native copy is invoked during the click and denied browser clipboard still falls back without changing the draft", async () => {
  const h = harness(async (url, body) => ({ id: "copy", account: body.account, user: body.user, kind: "reply", status: "completed", text: "捕获的回复" }));
  await h.open(); h.node("btnAssistantReply").click(); await tick(); h.node("chatInput").value = "已有草稿";
  let nativeCalls = 0, browserCalls = 0;
  h.window.desktopHost.copyDraft = () => { nativeCalls++; return Promise.reject(new Error("native unavailable")); };
  h.navigator.clipboard = { writeText: async () => { browserCalls++; throw new Error("Permission denied"); } };
  h.node("btnAssistantCopy").click(); assert.equal(nativeCalls, 1); await tick();
  assert.equal(browserCalls, 1); assert.deepEqual(h.copied, ["捕获的回复"]); assert.equal(h.node("chatInput").value, "已有草稿");
  assert.equal(h.node("btnAssistantCopy").disabled, false); h.close();
});

test("late native copy failure after a conversation switch does not create a fallback field or copy stale text", async () => {
  const h = harness(async (url, body) => ({ id: "copy-late", account: body.account, user: body.user, kind: "reply", status: "completed", text: "旧会话回复" }));
  await h.open(); h.node("btnAssistantReply").click(); await tick(); let reject;
  h.window.desktopHost.copyDraft = () => new Promise((_, fail) => { reject = fail; });
  h.node("btnAssistantCopy").click(); h.api.setConversation({ account: "test-account", user: "bob" });
  reject(new Error("native unavailable")); await tick(); assert.deepEqual(h.copied, []); assert.equal(h.node("assistantResultText").textContent, ""); h.close();
});

test("closing during an explicit save rereads the authoritative model on reopen after the save settles", async () => {
  let authoritative = settings(), resolve;
  const h = harness(async () => new Promise(done => { resolve = done; }), () => authoritative);
  await h.open(); h.node("assistantTabSettings").click(); h.input("assistantModel", "new-model");
  h.node("btnAssistantSave").click(); await tick(); const saving = h.requests.at(-1); h.close();
  assert.equal(saving.options.signal.aborted, false); await h.open(); assert.equal(h.node("btnAssistantReply").disabled, true);
  authoritative = { ...settings(), model: "new-model" }; resolve(authoritative); await tick();
  assert.equal(h.node("assistantModel").value, "new-model"); assert.match(h.node("assistantModelInfo").textContent, /new-model/);
  assert.equal(h.requests.filter(item => item.url.endsWith("settings") && !item.body).length, 2);
  assert.equal(h.node("btnAssistantReply").disabled, false); assert.equal(h.node("assistantApiKey").value, ""); h.close();
});

test("general settings can configure the assistant before an account or chat exists, while generation stays guarded", async () => {
  const h = harness(async (url, body) => url.endsWith("models") ? { models: [{ id: "custom-model" }] } : { ...settings(), ...body });
  assert.equal(h.api.open("reply"), false); assert.equal(h.api.open("summary"), false); assert.equal(h.node("assistantModal").hidden, true);
  const trigger = h.node("btnOpenAssistantSettings"); trigger.focus(); trigger.click(); await tick();
  assert.equal(h.node("assistantSettingsPanel").hidden, false); assert.equal(h.node("btnAssistantReply").disabled, true); assert.equal(h.node("btnAssistantSummary").disabled, true);
  h.node("btnAssistantModels").click(); await tick(); assert.equal(h.node("assistantModelOptions").children[0].value, "custom-model");
  h.input("assistantModel", "custom-model"); h.node("btnAssistantSave").click(); await tick();
  assert.equal(h.node("btnAssistantReply").disabled, true); h.node("btnAssistantReply").click(); h.node("btnAssistantSummary").click();
  assert.equal(h.requests.some(item => item.url.includes("/jobs")), false);
  assert.equal(h.requests.every(item => item.url.startsWith("/api/assistant/")), true); h.close(); assert.equal(h.document.activeElement, trigger);
});
