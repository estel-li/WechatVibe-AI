const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");
const vm = require("node:vm");

const read = name => readFileSync(path.join(__dirname, "../chatui", name), "utf8");
const adaptersSource = read("message-insight-adapters.js");
const labelsSource = read("message-labels.js");

function element(tag, className = "", textContent = "") {
  return {
    tag, className, textContent, title: "", children: [],
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
  };
}
function harness(pick = () => null) {
  const context = vm.createContext({
    element,
    percent: value => `${value * 100}%`,
    pickKaomoji: pick,
    window: {},
  });
  vm.runInContext(adaptersSource, context);
  vm.runInContext(labelsSource, context);
  return { adapters: context.window.MessageInsightAdapters, labels: context.window.MessageLabels };
}
function classes(node) {
  return [node.className, ...node.children.flatMap(classes)].join(" ");
}
function texts(node) {
  return [node.textContent, ...node.children.map(texts)].join(" ");
}
function find(node, className) {
  if (node.className.split(" ").includes(className)) return node;
  for (const child of node.children) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return null;
}
const localDependencies = {
  rankedEmotionScores: values => (Array.isArray(values) ? values : [])
    .map((item, index) => ({ item, index, probability: Number(item.probability) }))
    .filter(entry => entry.item?.label && Number.isFinite(entry.probability) && entry.probability > 0)
    .sort((left, right) => right.probability - left.probability || left.index - right.index),
  displayedIntent: result => (Array.isArray(result.intent) ? result.intent : [])
    .map(item => ({ label: item.label, probability: item.probability })).slice(0, 3),
  hasIntentContent: () => true,
  isIncompleteFragment: () => false,
};

it("uses one template for local and API: emotion line then intent line", () => {
  const { adapters, labels } = harness();
  const local = labels.create({ element, percent: v => `${v * 100}%`, pickKaomoji: () => null })
    .render(adapters.localView({ emotion: [{ label: "平静", probability: 0.8 }],
      intent: [{ label: "请求帮助", probability: 0.5 }], groundedIntent: null }, "请把文件发给我",
    localDependencies), "m1");
  const api = labels.create({ element, percent: v => `${v * 100}%`, pickKaomoji: () => null })
    .render(adapters.apiView({ id: "m1", status: "ok", emotion: "平静", intent: "请求帮助" }), "m1");
  assert.equal(local.children.length, 1);
  assert.equal(api.children.length, 1);
  assert.equal(local.children[0].className, api.children[0].className);
  assert.match(local.children[0].className, /emotion-line/);
  assert.match(api.children[0].className, /emotion-line/);
  assert.match(local.children[0].className, /intent-score-line/);
  assert.match(api.children[0].className, /intent-score-line/);
});

it("keeps punctuation-only text eligible for an intent label", () => {
  const { adapters } = harness();
  const view = adapters.localView({
    emotion: [{ label: "惊讶", probability: 0.8 }],
    intent: [{ label: "疑问", probability: 0.7 }],
    groundedIntent: null,
  }, "。。", localDependencies);
  // Normalize objects created by the isolated browser VM before strict comparison.
  assert.deepEqual(Array.from(view.intents, item => ({ ...item })), [{ label: "疑问" }]);
});

it("keeps API labels score-free and never forces three entries", () => {
  const { adapters, labels } = harness();
  const row = labels.create({ element, percent: v => `${v * 100}%`, pickKaomoji: () => null })
    .render(adapters.apiView({ id: "m1", status: "ok", emotion: "平静", intent: "请求帮助" }), "m1");
  assert.equal((classes(row).match(/intent-pct/g) || []).length, 0);
  assert.equal(find(row, "intent-line") !== null, true);
  assert.equal(row.children.length, 1);
  assert.equal(row.children[0].children.length, 4);
  assert.doesNotMatch(texts(row), /%|下一步|建议/u);
});

it("keeps API labels visible for short acknowledgements", () => {
  const { adapters, labels } = harness();
  const view = adapters.apiView({ id: "m1", status: "ok", emotion: "自然", intent: "回应" }, "好啊");
  const row = labels.create({ element, percent: () => "", pickKaomoji: () => null }).render(view, "m1");
  assert.equal(view.emotions.length, 1);
  assert.equal(view.intents.length, 1);
  assert.equal(row.children.length, 1);
});

it("keeps local ordering but renders only plain labels", () => {
  const { adapters, labels } = harness();
  const row = labels.create({ element, percent: v => `${v * 100}%`, pickKaomoji: () => null })
    .render(adapters.localView({ emotion: [{ label: "平静", probability: 0.75 }],
      intent: [{ label: "状态报告", probability: 0.4 }], groundedIntent: { label: "status_report", evidenceKind: "progress_statement" } },
    "文件已上传。", { ...localDependencies, displayedIntent: () => [
      { label: "状态报告", probability: null }, { label: "抱怨", probability: 0.4 }] }), "m1");
  assert.doesNotMatch(texts(row), /75%|40%/u);
  assert.equal(find(row, "grounded"), null);
  assert.equal(find(row, "intent-pct"), null);
  assert.match(texts(row), /平静/u);
  assert.match(texts(row), /状态报告/u);
});

it("turns insufficient or empty API payloads into no rows without fabricating", () => {
  const { adapters, labels } = harness();
  for (const result of [{ id: "m1", status: "insufficient" }, null]) {
    const view = adapters.apiView(result);
    assert.equal(view.emotions.length, 0);
    assert.equal(view.intents.length, 0);
    assert.equal(labels.create({ element, percent: () => "", pickKaomoji: () => null })
      .render(view, "m1").children.length, 0);
  }
});

it("outputs label text as text content, not markup", () => {
  const { adapters, labels } = harness();
  const view = adapters.apiView({ id: "m1", status: "ok", emotion: "<b>x</b>", intent: "a<script>" });
  const row = labels.create({ element, percent: () => "", pickKaomoji: () => null }).render(view, "m1");
  assert.equal(find(row, "intent-name").textContent, "<b>x</b>");
  assert.equal(row.children[0].children[1].children[0].tag, "span");
});

it("never renders a kaomoji in message labels", () => {
  const seen = [];
  const { adapters, labels } = harness();
  const view = adapters.localView({ emotion: [{ label: "平静", probability: 0.9 }, { label: "开心", probability: 0.2 }],
    intent: [], groundedIntent: null }, "你好", localDependencies);
  const renderer = labels.create({ element, percent: () => "", pickKaomoji: (item, id) => {
    seen.push([item.label, id]); return "(face)";
  } });
  const row = renderer.render(view, "m1");
  const second = renderer.render(view, "m1");
  assert.deepEqual(seen, []);
  assert.equal(texts(row), texts(second));
  assert.equal(find(row, "kaomoji-mood"), null);
});

it("keeps legacy-schema intent hidden while retaining its emotion row", () => {
  const { adapters } = harness();
  const view = adapters.localView({ labelSchema: "legacy", emotion: [{ label: "平静", probability: .7 }],
    intent: [{ label: "旧意图", probability: .9 }] }, "合成文本", { ...localDependencies, labelSchema: "generic-v9" });
  assert.equal(view.emotions.length, 1);
  assert.equal(view.intents.length, 0);
});

it("keeps API labels as plain text without calling the face picker", () => {
  const { adapters, labels } = harness();
  const seen = [];
  const renderer = labels.create({ element, percent: () => "", pickKaomoji: (item, id) => {
    seen.push([item.label, id]); return "";
  } });
  const view = adapters.apiView({ id: "m2", status: "ok", emotion: "犹豫", intent: "拖延决定" });
  renderer.render(view, "m2"); renderer.render(view, "m2");
  assert.deepEqual(seen, []);
});

it("leaves frozen input results untouched", () => {
  const frozen = Object.freeze({ emotion: Object.freeze([Object.freeze({ label: "平静", probability: 0.8 })]),
    intent: Object.freeze([Object.freeze({ label: "确认", probability: 0.5 })]), groundedIntent: null });
  const { adapters, labels } = harness();
  const before = JSON.stringify(frozen);
  const view = adapters.localView(frozen, "收到", localDependencies);
  labels.create({ element, percent: () => "", pickKaomoji: () => null }).render(view, "m1");
  assert.equal(JSON.stringify(frozen), before);
});
