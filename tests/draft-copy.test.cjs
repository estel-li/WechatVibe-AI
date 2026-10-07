const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../chatui/app.js"), "utf8");
const code = source.slice(source.indexOf("let draftCopyPending = false;"), source.indexOf('byId("searchInput").addEventListener'));

function harness(native) {
  const messages = [], fallbacks = [], nativeValues = [];
  const document = { body: { appendChild: node => { fallbacks.push(node); } }, activeElement: null,
    createElement: () => ({ style: {}, focus() { document.activeElement = this; }, select() {}, remove() { this.removed = true; } }),
    execCommand: () => { messages.push({ copied: document.activeElement.value }); return true; } };
  const input = { value: "原始草稿", selectionStart: 1, selectionEnd: 2,
    focus() { document.activeElement = this; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  const button = { textContent: "复制草稿", disabled: false, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; } };
  document.activeElement = input;
  const context = vm.createContext({ document, navigator: {}, toast: value => messages.push(value),
    byId: key => key === "chatInput" ? input : button,
    window: { desktopHost: { copyDraft: value => { nativeValues.push(value); return native(value); } } } });
  vm.runInContext(code + "\nglobalThis.copy = copyDraft;", context);
  return { copy: context.copy, input, button, document, messages, fallbacks, nativeValues };
}

test("an in-flight copy is serialized and fallback copies the captured draft without stealing the edited input's focus", async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const operation = h.copy();
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.attributes["aria-busy"], "true");
  h.input.value = "等待过程中编辑的新草稿";
  await h.copy();
  assert.deepEqual(h.nativeValues, ["原始草稿"]);
  resolve(false);
  await operation;
  assert.equal(h.messages[0].copied, "原始草稿");
  assert.equal(h.input.value, "等待过程中编辑的新草稿");
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.fallbacks[0].removed, true);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, "复制草稿");
  assert.equal(h.button.attributes["aria-busy"], undefined);
});

test("native success needs no temporary DOM and an empty draft never touches the clipboard", async () => {
  const h = harness(async () => true);
  await h.copy();
  assert.equal(h.fallbacks.length, 0);
  assert.equal(h.messages[0], "草稿已复制，未发送到微信");
  h.input.value = "   ";
  await h.copy();
  assert.equal(h.nativeValues.length, 1);
});
