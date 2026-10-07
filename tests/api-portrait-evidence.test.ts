import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { it } from "node:test";
import { checkedPortraitEvidence, emptyPortraitEvidence, extractPortraitObservations,
  fitPortraitFacts, portraitJson, type ApiPortraitEvidenceState, type ApiPortraitMessage,
} from "../analysis/api-portrait-evidence";
import { ModelConnectorError, type GenerationRequest, type ModelConfig } from "../analysis/model-connectors";

const config: ModelConfig = { protocol: "responses", baseUrl: "https://example.invalid/v1",
  model: "synthetic", apiKey: "synthetic-key" };
const root = path.resolve(import.meta.dirname, "..");
const failure = (code: string) => (error: unknown) => error instanceof ModelConnectorError && error.code === code;
const fake = (value: unknown, capture?: (request: GenerationRequest) => void) =>
  async (_config: ModelConfig, request: GenerationRequest) => {
    capture?.(request);
    return { text: JSON.stringify(value) };
  };
const observation = (text: string, id: string, quote: string) => ({
  dimension: "communication", text, sources: [{ id, quote }],
});
const message = (id: string, text: string, extra: Partial<ApiPortraitMessage> = {}): ApiPortraitMessage =>
  ({ id, text, sender: "OTHER", target: true, ...extra });

it("extracts only new raw messages without sending old observations or personality prose", async () => {
  const first = await extractPortraitObservations(config, [message("a", "我今天想独处")], null,
    fake({ observations: [observation("今天想独处", "m1", "今天想独处")] }));
  let request: GenerationRequest | undefined;
  const result = await extractPortraitObservations(config, [message("b", "周末想约大家一起吃饭")], first.evidence,
    fake({ observations: [observation("周末主动邀约", "m1", "想约大家一起吃饭")] }, value => { request = value; }));
  const input = JSON.parse(request!.prompt.split("INPUT_JSON:\n")[1]!);
  assert.deepEqual(Object.keys(input).sort(), ["messages", "subjectKind"]);
  assert.equal(input.messages[0].text, "周末想约大家一起吃饭");
  assert.equal(request!.prompt.includes("今天想独处"), false);
  assert.equal(result.evidence.items.length, 2, "contradictory situations must both survive the ledger merge");
  assert.equal(result.evidence.items[0]!.sources[0]!.messageId, "a");
  assert.equal(result.evidence.items[1]!.sources[0]!.messageId, "b");
});

it("treats no useful observations as a successful completed extraction without retrying", async () => {
  let calls = 0;
  const result = await extractPortraitObservations(config, [message("a", "嗯")], null,
    fake({ observations: [] }, () => { calls++; }));
  assert.equal(calls, 1);
  assert.deepEqual(result.evidence.items, []);
  assert.equal(result.evidence.targetCount, 1);
  assert.equal(result.evidence.batchCount, 1);
});

it("rejects observations attributed to SELF, another speaker, an unknown message or fabricated quotes", async () => {
  const messages = [message("self", "我很喜欢热闹", { sender: "SELF", target: false }),
    message("other-member", "我喜欢组织活动", { target: false, speaker: "other-member" }),
    message("target", "这周末先不约了", { speaker: "member" })];
  for (const [id, quote] of [["m1", "喜欢热闹"], ["m2", "组织活动"], ["m4", "不存在"], ["m3", "总是讨厌聚会"]]) {
    await assert.rejects(() => extractPortraitObservations(config, messages, null,
      fake({ observations: [observation("越界归因", id!, quote!)] })), failure("invalid-output"));
  }
});

it("keeps valid observations and sources when neighboring provider entries are malformed", async () => {
  const messages = [message("self", "我喜欢热闹", { sender: "SELF", target: false }),
    message("other-member", "我喜欢组织活动", { target: false, speaker: "other-member" }),
    message("target", "这周末先不约了", { speaker: "member" })];
  const result = await extractPortraitObservations(config, messages, null, fake({ observations: [
    null, { ...observation("无效维度", "m3", "先不约了"), dimension: "made-up" },
    observation("无依据", "m3", "总是讨厌聚会"),
    { dimension: "interactionPreferences", text: "本次推迟周末安排", sources: [
      { id: "m1", quote: "喜欢热闹" }, { id: "m2", quote: "组织活动" },
      { id: "unknown", quote: "先不约了" }, { id: "m3", quote: "拒绝所有人" },
      { id: "m3", quote: "先不约了" }, null,
    ] },
  ] }));
  assert.equal(result.evidence.items.length, 1);
  assert.deepEqual(result.evidence.items[0]!.sources,
    [{ messageId: "target", quote: "先不约了", time: null, speaker: "member" }]);
  assert.equal(result.evidence.targetCount, 1);
});

it("normalizes harmless typography while persisting the exact original source span", async () => {
  const original = "前缀😀 周末\t  想\n在家～再说 后缀";
  const expected = "😀 周末\t  想\n在家～再说";
  const result = await extractPortraitObservations(config, [message("a", original)], null,
    fake({ observations: [observation("周末想留在家", "m1", "😀 周末 想 在家~再说")] }));
  assert.equal(result.evidence.items[0]!.sources[0]!.quote, expected);
  assert.ok(original.includes(result.evidence.items[0]!.sources[0]!.quote));
  assert.equal(checkedPortraitEvidence(result.evidence).version, 3);
  for (const [text, quote] of [["第一行\r\n第二行\t末尾", "第一行\r\n第二行\t末尾"],
    ["时间\u3000\u3000安排", "时间 安排"], ["回家~休息", "回家～休息"]]) {
    const { evidence } = await extractPortraitObservations(config, [message("a", text!)], null,
      fake({ observations: [observation("合成格式样本", "m1", quote!)] }));
    assert.equal(evidence.items[0]!.sources[0]!.quote, text);
  }
});

it("does not use typography matching to accept paraphrases, changed punctuation or forbidden controls", async () => {
  for (const [text, quote] of [["这次先不去", "我不想去"], ["now here", "nowhere"],
    ["先回家，再说", "先回家再说"], ["前\u000b后", "前 后"], ["前\u000c后", "前 后"],
    ["前\u0000后", "前\u0000后"], ["前\u007f后", "前\u007f后"]]) {
    await assert.rejects(() => extractPortraitObservations(config, [message("a", text!)], null,
      fake({ observations: [observation("无效引文", "m1", quote!)] })), failure("invalid-output"));
  }
});

it("bounds long observation prose and takes the first eight valid distinct sources", async () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(`a${index}`, `合成偏好${index}`));
  const sources = [null, { id: "unknown", quote: "不存在" },
    { id: "m1", quote: "合成偏好0" }, { id: "m1", quote: "合成偏好0" },
    ...messages.slice(1).map((m, index) => ({ id: `m${index + 2}`, quote: m.text }))];
  const { evidence } = await extractPortraitObservations(config, messages, null,
    fake({ observations: [{ dimension: "patterns", text: "😀".repeat(170), sources }] }));
  assert.equal(Array.from(evidence.items[0]!.text).length, 160);
  assert.deepEqual(evidence.items[0]!.sources.map(source => source.messageId),
    messages.slice(0, 8).map(m => m.id));
  assert.equal(evidence.targetCount, 10);
});

it("does not advance or mutate the prior ledger when every nonempty observation is invalid", async () => {
  const first = await extractPortraitObservations(config, [message("a", "第一次的有效信息")], null,
    fake({ observations: [observation("先前有效观察", "m1", "有效信息")] }));
  const saved = JSON.stringify(first.evidence);
  await assert.rejects(() => extractPortraitObservations(config, [message("b", "第二次的新信息")], first.evidence,
    fake({ observations: [observation("伪造观察", "m1", "不存在的原话"), null] })), failure("invalid-output"));
  assert.equal(JSON.stringify(first.evidence), saved);
});

it("owns observation IDs and retains exact original message provenance across segmented input", async () => {
  const messages = [message("segment-a", "今晚有点累", {
    messageId: "real-message", complete: false, time: 123, speaker: "member" }),
  message("segment-b", "明天还是想去见你", {
    messageId: "real-message", complete: true, time: 123, speaker: "member" })];
  const output = { observations: [observation("今晚累", "m1", "有点累"), observation("明天想见面", "m2", "想去见你")] };
  const result = await extractPortraitObservations(config, messages, null, fake(output));
  assert.equal(result.evidence.targetCount, 1, "only a completed target message advances the message count");
  assert.equal(new Set(result.evidence.items.flatMap(item => item.sources.map(source => source.messageId))).size, 1);
  assert.match(result.evidence.items[0]!.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.evidence.items[0]!.sources, [
    { messageId: "real-message", quote: "有点累", time: 123, speaker: "member" },
  ]);
  const duplicate = await extractPortraitObservations(config, messages, result.evidence, fake(output));
  assert.deepEqual(duplicate.evidence.items, result.evidence.items, "the same observation must not multiply evidence records");
});

it("does not infer on background-only input and rejects changing the ledger's subject kind", async () => {
  let calls = 0;
  const generate = fake({ observations: [] }, () => { calls++; });
  const result = await extractPortraitObservations(config, [message("a", "背景", { target: false })], null, generate);
  assert.equal(calls, 0);
  assert.equal(result.evidence.targetCount, 0);
  await assert.rejects(() => extractPortraitObservations(config, [message("b", "你好")],
    emptyPortraitEvidence("group"), generate, "person"), failure("invalid-request"));
});

it("accepts one unambiguous JSON answer with fences or surrounding explanation, but rejects competing answers", () => {
  const answer = { observations: [{ text: '原句包含 } 和 "引号"' }] };
  assert.deepEqual(portraitJson(`说明：\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``), answer);
  assert.deepEqual(portraitJson(`<think>省略推理</think>${JSON.stringify(answer)}`), answer);
  assert.throws(() => portraitJson('{"observations":[]} {"observations":[]}'), failure("invalid-output"));
  assert.throws(() => portraitJson('{"observations":['), failure("invalid-output"));
});

it("rejects invalid message batches before any paid generation", async () => {
  let calls = 0;
  const generate = fake({ observations: [] }, () => { calls++; });
  for (const messages of [[], [message("a", "字".repeat(1001))], [message("a", "同ID"), message("a", "同ID")],
    [message("a", "SELF不能为目标", { sender: "SELF" })]]) {
    await assert.rejects(() => extractPortraitObservations(config, messages, null, generate), failure("invalid-request"));
  }
  assert.equal(calls, 0);
});

it("rejects a v2 ledger before generation instead of silently reusing its general observations", async () => {
  let calls = 0;
  const old = { ...emptyPortraitEvidence(), version: 2 };
  assert.throws(() => checkedPortraitEvidence(old), failure("invalid-request"));
  await assert.rejects(() => extractPortraitObservations(config, [message("a", "合成消息")],
    old as unknown as ApiPortraitEvidenceState, fake({ observations: [] }, () => { calls++; })),
  failure("invalid-request"));
  assert.equal(calls, 0);
});

it("reduces only synthesis input while retaining persisted source evidence and valid references", async () => {
  const evidence: ApiPortraitEvidenceState = { ...emptyPortraitEvidence(), targetCount: 20, batchCount: 1,
    items: Array.from({ length: 12 }, (_, index) => ({ id: `stored-${index}`, dimension: "communication",
      text: `观察${index}。${"具体情境".repeat(20)}`, sources: [
        { messageId: `message-${index}`, quote: `原文${index}${"片段".repeat(40)}`, time: index, speaker: "member" },
      ] })) };
  const original = JSON.stringify(evidence);
  let calls = 0;
  const facts = await fitPortraitFacts(config, evidence, 4096, async (_config, request) => {
    calls++;
    const input = JSON.parse(request.prompt.split("INPUT_JSON:\n")[1]!);
    return { text: JSON.stringify({ observations: [{ dimension: "communication", text: "存在多种不同情境",
      evidenceIds: input.facts.map((fact: { id: string }) => fact.id) }] }) };
  });
  assert.ok(calls > 0);
  assert.equal(JSON.stringify(evidence), original, "context fitting must not truncate or overwrite durable evidence");
  assert.deepEqual(new Set(facts.flatMap(fact => fact.originals)), new Set(evidence.items.map(item => item.id)));
  await assert.rejects(() => fitPortraitFacts(config, evidence, 4096,
    fake({ observations: [{ dimension: "communication", text: "伪造", evidenceIds: ["unknown"] }] })), failure("invalid-output"));
});

it("round-trips the real Python ledger validator and TypeScript validator on shared synthetic fixtures", async () => {
  const { evidence } = await extractPortraitObservations(config, [message("a", "周六我来确认", { speaker: "person", time: 10 })],
    null, fake({ observations: [observation("主动确认安排", "m1", "我来确认")] }));
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const badSource = clone(evidence); badSource.items[0]!.sources = [];
  const duplicate = clone(evidence); duplicate.items.push(clone(duplicate.items[0]!));
  const controls = clone(evidence); controls.items[0]!.sources[0]!.quote = "原文\u0000不应包含控制符";
  const multiline = clone(evidence); multiline.items[0]!.sources[0]!.quote = "原文\r\n可以包含\t换行和缩进";
  const blankId = clone(evidence); blankId.items[0]!.sources[0]!.messageId = "   ";
  const unicodeId = clone(evidence); unicodeId.items[0]!.sources[0]!.messageId = "😀".repeat(150);
  const badTime = clone(evidence); badTime.items[0]!.sources[0]!.time = Number.MAX_SAFE_INTEGER + 1;
  const missing = clone(evidence) as unknown as Record<string, unknown>; delete missing.subjectKind;
  const axisLedgers = (["mbti_EI", "mbti_SN", "mbti_TF", "mbti_JP"] as const).map(dimension => {
    const ledger = clone(evidence);
    ledger.items[0]!.dimension = dimension;
    return ledger;
  });
  const fixtures: unknown[] = [evidence, emptyPortraitEvidence(), emptyPortraitEvidence("group"),
    badSource, duplicate, controls, missing, { ...evidence, targetCount: -1 },
    { version: 1, items: [], legacyPortrait: null }, blankId, unicodeId,
    { ...evidence, targetCount: Number.MAX_SAFE_INTEGER + 1 }, badTime,
    { ...evidence, version: 2 }, ...axisLedgers, multiline];
  const script = ["import json,sys", "sys.path.insert(0,'bridge')",
    "from portrait_contracts import valid_portrait_evidence,empty_portrait_evidence",
    "fixtures=json.load(sys.stdin)",
    "print(json.dumps({'valid':[valid_portrait_evidence(x) for x in fixtures], 'empty':empty_portrait_evidence(), 'ledger':fixtures[0]}))",
  ].join("\n");
  const python = spawnSync(process.env.WECHATVIBE_PYTHON || "python", ["-X", "utf8", "-B", "-c", script],
    { cwd: root, input: JSON.stringify(fixtures), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(python.error, undefined, python.error?.message);
  assert.equal(python.status, 0, python.stderr);
  const result = JSON.parse(python.stdout);
  const checked = fixtures.map(value => { try { checkedPortraitEvidence(value); return true; } catch { return false; } });
  assert.deepEqual(result.valid, checked);
  assert.deepEqual(result.valid, [true, true, true, false, false, false, false, false, false,
    false, true, false, false, false, true, true, true, true, true]);
  assert.equal(evidence.version, 3);
  assert.deepEqual(checkedPortraitEvidence(result.empty), emptyPortraitEvidence());
  assert.deepEqual(checkedPortraitEvidence(result.ledger), evidence);
});

it("restores a contradictory observation omitted by context reduction without altering the ledger", async () => {
  const evidence: ApiPortraitEvidenceState = { ...emptyPortraitEvidence(), targetCount: 12, batchCount: 1,
    items: Array.from({ length: 12 }, (_, index) => ({ id: `fact-${index}`, dimension: "communication",
      text: index === 4 ? "反例哨兵：这次明确拒绝，不应忽略" : `情境${index}：${"主动确认下次见面时间".repeat(10)}`,
      sources: [{ messageId: `msg-${index}`, quote: "这次的具体发言".repeat(10), time: index, speaker: "person" }],
    })) };
  const before = JSON.stringify(evidence);
  let omissions = 0;
  const facts = await fitPortraitFacts(config, evidence, 4096, async (_config, request) => {
    const input = JSON.parse(request.prompt.split("INPUT_JSON:\n")[1]!);
    const kept = input.facts.filter((fact: { text: string }) => !fact.text.includes("反例哨兵"));
    omissions += input.facts.length - kept.length;
    assert.ok(kept.length);
    return { text: JSON.stringify({ observations: [{ dimension: "communication", text: "多次确认见面",
      evidenceIds: kept.map((fact: { id: string }) => fact.id) }] }) };
  });
  assert.ok(omissions > 0, "the fake reducer must actually attempt to omit the counterexample");
  assert.equal(facts.some(fact => fact.text.includes("反例哨兵")), true);
  assert.deepEqual(new Set(facts.flatMap(fact => fact.originals)), new Set(evidence.items.map(item => item.id)));
  assert.equal(JSON.stringify(evidence), before);
});
