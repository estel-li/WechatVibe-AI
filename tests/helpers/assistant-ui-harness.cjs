const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../chatui/ai-assistant.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../../chatui/index.html"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const settings = () => ({ preset: "deepseek", protocol: "chat_completions", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", contextTokens: 65536, ready: true, hasKey: true,
  summaryPrompt: "总结给定对话", relationshipPrompts: { friend: "朋友提示", close_friend: "亲密提示", colleague: "同事提示", relative: "亲戚提示", elder: "长辈提示", custom: "自定义提示" }, defaultRelationship: "friend" });

function harness(handler, readSettings = settings, clock, runtime = {}) {
  const nodes = new Map(), requests = [], copied = [], downloads = [], blobs = [];
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
    click() { if (!this.disabled) { if (this.tagName === "A") downloads.push({ href: this.href, filename: this.download }); this.dispatchEvent({ type: "click" }); } }
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
  const HarnessDate = clock ? class extends Date { static now() { return clock.now(); } } : Date;
  vm.runInNewContext(source, { document, window, fetch, navigator, Date: HarnessDate, AbortController, setTimeout, clearTimeout, Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return "blob:synthetic-export"; }, revokeObjectURL: runtime.revokeObjectURL || (() => {}) },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } });
  return { document, nodes, requests, copied, downloads, blobs, window, navigator, api: window.AIAssistant,
    node: id => nodes.get(id), input(id, value) { const node = nodes.get(id); node.value = value; node.dispatchEvent({ type: "input" }); },
    change(id, value) { const node = nodes.get(id); node.value = value; node.dispatchEvent({ type: "change" }); },
    async open(mode = "reply") { window.AIAssistant.setConversation({ account: "test-account", user: "alice", name: "Alice" }); window.AIAssistant.open(mode); await tick(); },
    close() { nodes.get("btnCloseAssistant").click(); } };
}

module.exports = { harness, tick, settings };
