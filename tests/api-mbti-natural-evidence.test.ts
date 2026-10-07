import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyApiPortrait, emptyPortraitEvidence, synthesizeApiPortrait, refreshApiPortraitAxes } from "../analysis/api-portrait";
import type { ModelConfig } from "../analysis/model-connectors";
const config: ModelConfig = { protocol: "responses", baseUrl: "https://example.invalid/v1", model: "synthetic", apiKey: "synthetic" };
const ledger = () => ({ ...emptyPortraitEvidence(), targetCount: 1408, batchCount: 2, items: [
  { id: "observe-1", dimension: "communication" as const, text: "讨论方案时先追问概念之间的联系",
    sources: [{ messageId: "m1", quote: "这两个问题是不是有同一种规律？", time: 10, speaker: "target" }] },
  { id: "observe-2", dimension: "patterns" as const, text: "另一次讨论会沿着前提变化探索可能性",
    sources: [{ messageId: "m2", quote: "如果把这个前提换掉，还能推到哪些可能？", time: 20, speaker: "target" }] },
] });
const respond = (value: unknown) => async () => ({ text: JSON.stringify(value) });
const answer = () => ({ portrait: { ...emptyApiPortrait(), mbtiAxes: { EI: null, SN: 35, TF: null, JP: null } },
  support: { SN: ["e1", "e2"] },
  mbtiBasis: { SN: { kind: "pattern", reason: "两次自主讨论都关注概念联系和可能性，暂偏N；未见其它场景，倾向仍有限。" } } });
it("can assess saved ordinary observations without retagging or rereading history", async () => {
  const before = JSON.stringify(ledger());
  const result = await synthesizeApiPortrait(config, ledger(), 32768, respond(answer()));
  assert.equal(result.portrait.mbtiAxes.SN, 35);
  assert.deepEqual(result.mbtiBasis.SN, { status: "supported", kind: "pattern",
    reason: answer().mbtiBasis.SN.reason, evidenceCount: 2 });
  assert.equal(JSON.stringify(ledger()), before);
});
it("does not treat an unexplained generic citation or invented reference as sufficient", async () => {
  for (const response of [{ ...answer(), mbtiBasis: {} },
    { ...answer(), support: { SN: ["e1", "invented"] } },
    { ...answer(), support: { SN: ["e1"] } }]) {
    const result = await synthesizeApiPortrait(config, ledger(), 32768, respond(response));
    assert.equal(result.portrait.mbtiAxes.SN, null);
    assert.equal(result.mbtiBasis.SN.status, "unverified");
  }
});
it("accepts one explicit self-report without requiring the same statement twice", async () => {
  const direct = { ...emptyPortraitEvidence(), targetCount: 120, batchCount: 1, items: [{ id: "direct", dimension: "mbti_EI" as const, text: "明确说与人互动后需要独处恢复精力",
    sources: [{ messageId: "one", quote: "聊完天以后我会独处一阵才能缓过来。", time: 30, speaker: "target" }] }]
  };
  const result = await synthesizeApiPortrait(config, direct, 32768, respond({
    portrait: { ...emptyApiPortrait(), mbtiAxes: { EI: 30, SN: null, TF: null, JP: null } },
    support: { EI: ["e1"] }, mbtiBasis: { EI: { kind: "self-report", reason: "明确描述通过独处恢复精力，暂偏I。" } },
  }));
  assert.equal(result.portrait.mbtiAxes.EI, 30);
  assert.equal(result.mbtiBasis.EI.evidenceCount, 1);
});
it("distinguishes the model's uncertainty from a result rejected for missing provenance", async () => {
  const response = { ...answer(), portrait: emptyApiPortrait(),
    mbtiBasis: { SN: { kind: "insufficient", reason: "仅有两次技术讨论，还不能区别长期的信息偏好。" } } };
  const result = await synthesizeApiPortrait(config, ledger(), 32768, respond(response));
  assert.equal(result.mbtiBasis.SN.status, "insufficient");
  assert.match(result.mbtiBasis.SN.reason, /技术讨论/);
});
it("refreshes an existing all-null portrait from its current evidence only", async () => {
  let calls = 0;
  const old = emptyApiPortrait();
  const result = await refreshApiPortraitAxes(config, old, async (_config, request) => {
    calls++;
    const payload = JSON.parse(request.prompt.slice("INPUT_JSON:\n".length));
    assert.equal(payload.messages, undefined);
    assert.equal(payload.facts.length, 2);
    return { text: JSON.stringify(answer()) };
  }, ledger(), 32768);
  assert.equal(calls, 1);
  assert.equal(result.mbtiAxes.SN, 35);
  assert.equal(old.mbtiAxes.SN, null);
});

it("does not let one acknowledgement observation support all axes or a self-report claim waive generic evidence", async () => {
  const evidence = ledger();
  evidence.items = [{ id: "ack", dimension: "communication", text: "确认收到",
    sources: [{ messageId: "a", quote: "好的收到", time: 1, speaker: "target" },
      { messageId: "b", quote: "嗯嗯好", time: 2, speaker: "target" }] }];
  const inferred = { portrait: { ...emptyApiPortrait(), mbtiAxes: { EI: 68, SN: 66, TF: 64, JP: 70 } },
    support: Object.fromEntries(["EI", "SN", "TF", "JP"].map(axis => [axis, ["e1"]])),
    mbtiBasis: Object.fromEntries(["EI", "SN", "TF", "JP"].map(axis => [axis, { kind: "pattern", reason: "多次确认回复" }])) };
  const result = await synthesizeApiPortrait(config, evidence, 32768, respond(inferred));
  assert.deepEqual(result.portrait.mbtiAxes, emptyApiPortrait().mbtiAxes);
  evidence.items[0]!.sources = evidence.items[0]!.sources.slice(0, 1);
  inferred.mbtiBasis.EI = { kind: "self-report", reason: "自述" };
  const claimed = await synthesizeApiPortrait(config, evidence, 32768, respond(inferred));
  assert.equal(claimed.portrait.mbtiAxes.EI, null);
});

it("accepts harmless nesting of the axis explanation and preserves existing interaction scores on reassessment", async () => {
  const full = answer();
  const nested = { portrait: { ...full.portrait, mbtiBasis: full.mbtiBasis }, support: full.support };
  const synthesis = await synthesizeApiPortrait(config, ledger(), 32768, respond(nested));
  assert.equal(synthesis.portrait.mbtiAxes.SN, 35);
  const old = { ...emptyApiPortrait(), affinity: 82, traits: { ...emptyApiPortrait().traits, care: 80 } };
  const refreshed = await refreshApiPortraitAxes(config, old,
    respond({ ...nested, portrait: { ...nested.portrait, affinity: null, traits: emptyApiPortrait().traits } }), ledger(), 32768);
  assert.equal(refreshed.affinity, 82);
  assert.equal(refreshed.traits.care, 80);
  assert.equal(refreshed.mbtiAxes.SN, 35);
});

it("does not count one compressed generic fact as two separately assessed observations", async () => {
  const evidence = { ...emptyPortraitEvidence(), targetCount: 1408, batchCount: 3,
    items: Array.from({ length: 12 }, (_, index) => ({ id: `observe-${index}`, dimension: "communication" as const,
      text: `第${index}次确认收到安排，讨论见面时间、地点和需要带的东西，${"表达简短确认。".repeat(5)}`,
      sources: [{ messageId: `source-${index}`, quote: `第${index}次好的收到，时间地点记下了`, time: index, speaker: "target" }] })) };
  let compressed = false;
  const result = await synthesizeApiPortrait(config, evidence, 4096, async (_config, request) => {
    const data = JSON.parse(request.prompt.slice("INPUT_JSON:\n".length));
    if (request.system.startsWith("压缩")) {
      compressed = true;
      return { text: JSON.stringify({ observations: [{ dimension: "communication", text: "反复确认安排",
        evidenceIds: data.facts.map((item: { id: string }) => item.id) }] }) };
    }
    const one = [data.facts[0].id];
    return { text: JSON.stringify({ portrait: { ...emptyApiPortrait(), mbtiAxes: { EI: 68, SN: 66, TF: 64, JP: 70 } },
      support: Object.fromEntries(["EI", "SN", "TF", "JP"].map(axis => [axis, one])),
      mbtiBasis: Object.fromEntries(["EI", "SN", "TF", "JP"].map(axis => [axis, { kind: "pattern", reason: "反复确认安排" }])) }) };
  });
  assert.equal(compressed, true);
  assert.deepEqual(result.portrait.mbtiAxes, emptyApiPortrait().mbtiAxes);
});
