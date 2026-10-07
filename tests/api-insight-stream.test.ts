import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";
import { analyzeApiInsights, type ApiInsightInput } from "../analysis/api-message-insights";
import { ModelConnectorError, type GenerationRequest, type ModelConfig } from "../analysis/model-connectors";

// Exercise the actual desktop parser with the actual analyzer stream output.
// Provider replies are synthetic; no network, models or user data are accessed.
const source = readFileSync(new URL("../chatui/app.js", import.meta.url), "utf8");
const start = source.indexOf("function parseApiPartialLabels(");
const end = source.indexOf("function apiInsightCandidates(", start);
assert.ok(start >= 0 && end > start);
const ui = vm.createContext({});
vm.runInContext(source.slice(start, end) + "\nglobalThis.parse=parseApiPartialLabels;", ui);
const parse = (raw: string, ids: string[]) => JSON.parse(JSON.stringify(ui.parse(raw, ids))) as
  Record<string, { id: string; affect?: { feeling?: string }; intents?: string[] }>;
const config: ModelConfig = { protocol: "chat_completions", baseUrl: "https://example.invalid/v1",
  model: "synthetic", apiKey: "synthetic" };
const standard = Array.from({ length: 11 }, (_, index) => `real-${index + 1}`);
const item = (id: string | number, index: number) => ({ id,
  emotion: index % 2 ? "感激" : "犹豫", intent: index % 2 ? "致谢" : "婉拒" });
const inputFor = (ids: string[]): ApiInsightInput => ({
  messages: ids.map(id => ({ id, sender: "OTHER", text: "固定合成消息" })), targetIds: ids,
});
const wireIds = (request: GenerationRequest): string[] =>
  JSON.parse(request.prompt.slice("CHAT_BATCH_JSON:\n".length)).targetIds;
const invalidOutput = (error: unknown) => error instanceof ModelConnectorError && error.code === "invalid-output";
type Scene = { parts: string[]; final?: string; reject?: boolean; early?: boolean };

async function exercise(ids: string[], make: (wire: string[]) => Scene) {
  const expected = new Map(ids.map((id, index) => [id, item(id, index)]));
  let received = "";
  let early = 0;
  let reject = false;
  let rejected = false;
  try {
    const response = await analyzeApiInsights(config, inputFor(ids), async (_config, request) => {
      const wire = wireIds(request);
      assert.equal(new Set(wire).size, ids.length);
      assert.ok(wire.every(id => !ids.includes(id)), "short IDs cannot collide with original IDs");
      const scene = make(wire);
      reject = !!scene.reject;
      for (const part of scene.parts) request.onTextDelta!(part);
      early = Object.keys(parse(received, ids)).length;
      if (scene.early) assert.ok(early > 0, "must show a completed record before the provider finishes");
      return { text: scene.final ?? scene.parts.join("") };
    }, delta => {
      received += delta;
      for (const [id, value] of Object.entries(parse(received, ids))) {
        assert.ok(expected.has(id), "an unknown ID cannot become a target");
        assert.equal(value.affect?.feeling, expected.get(id)!.emotion, `emotion was moved to ${id}`);
        assert.equal(value.intents?.[0], expected.get(id)!.intent, `intent was moved to ${id}`);
      }
    });
    assert.deepEqual(response.insights.map(value => value.id), ids);
  } catch (error) {
    if (!invalidOutput(error)) throw error;
    rejected = true;
  }
  assert.equal(rejected, reject);
  return { early, received };
}

it("streams reversed JSON with t1 and t10 character by character onto original message IDs", async () => {
  await exercise(standard, wire => ({
    parts: Array.from(JSON.stringify(wire.map(item).reverse())), early: true,
  }));
});

it("avoids short-alias collisions with original IDs named t1 and t10", async () => {
  await exercise(["t1", "t10", "real-3"], wire => ({
    parts: Array.from(JSON.stringify(wire.map(item).reverse())), early: true,
  }));
});

it("streams Markdown-wrapped JSON before the entire array is complete", async () => {
  await exercise(standard.slice(0, 2), wire => ({
    parts: ["```json\n[", JSON.stringify(item(wire[1]!, 1)), ",",
      JSON.stringify(item(wire[0]!, 0)), "]\n```"], early: true,
  }));
});

it("accepts explicitly echoed original IDs and nested affect/intents while streaming", async () => {
  await exercise(standard.slice(0, 2), () => ({
    parts: Array.from(JSON.stringify(standard.slice(0, 2).map(item).reverse())), early: true,
  }));
  await exercise(standard.slice(0, 2), wire => ({
    parts: Array.from(JSON.stringify(wire.map((id, index) => ({ id, status: "ok",
      affect: { feeling: item(id, index).emotion }, intents: [item(id, index).intent],
      ignored: 'brace } and " quote' })).reverse())), early: true,
  }));
});

it("never mistakes a streamed t10 prefix for t1 in out-of-order legacy text", async () => {
  await exercise(standard, wire => {
    const order = [9, ...wire.map((_, index) => index).filter(index => index !== 9)];
    const text = order.map(index => `编号：${wire[index]}\n情感：${item(wire[index]!, index).emotion}\n意图：${item(wire[index]!, index).intent}\n`).join("");
    return { parts: Array.from(text), early: true };
  });
});

it("ignores unknown stream IDs and rejects final output that still omits a target", async () => {
  await exercise(standard.slice(0, 2), wire => ({ parts: ["[", JSON.stringify(item("unknown", 1)), ",",
    JSON.stringify(item(wire[1]!, 1)), ",", JSON.stringify(item(wire[0]!, 0)), "]"], early: true }));
  await exercise(standard.slice(0, 2), wire => ({
    parts: Array.from(JSON.stringify([item(wire[0]!, 0), item("unknown", 1)])), reject: true, early: true,
  }));
});

it("holds ID-less legacy replies until final complete validation instead of guessing during the stream", async () => {
  const result = await exercise(standard.slice(0, 2), () => ({
    parts: Array.from("情感：犹豫\n意图：婉拒\n情感：感激\n意图：致谢\n"),
  }));
  assert.equal(result.early, 0);
  assert.equal(Object.keys(parse(result.received, standard.slice(0, 2))).length, 2);
});

it("keeps incomplete ID lines and incomplete JSON Han words pending", async () => {
  for (const fragment of [false, true]) {
    const result = await exercise(standard.slice(0, 2), wire => ({
      parts: fragment ? [`[{"id":"${wire[0]}","emotion":"犹`] : [`编号：${wire[0]!.slice(0, 1)}`, wire[0]!.slice(1)],
      final: JSON.stringify(wire.map(item)),
    }));
    assert.equal(result.early, 0);
  }
});

it("shows the first complete JSON object while the second is still unfinished", async () => {
  const ids = standard.slice(0, 2);
  let firstShown = false;
  await analyzeApiInsights(config, inputFor(ids), async (_config, request) => {
    const wire = wireIds(request);
    request.onTextDelta!("[" + JSON.stringify(item(wire[1]!, 1)) + ',{"id":"');
    assert.equal(firstShown, true);
    return { text: JSON.stringify(wire.map(item).reverse()) };
  }, delta => { if (parse(delta, ids)[ids[1]!]) firstShown = true; });
});

it("rejects ambiguous numeric aliases instead of choosing between two original messages", async () => {
  const ids = ["first-owner", "1"];
  for (const rawId of [1, "1"]) {
    let received = "";
    await assert.rejects(analyzeApiInsights(config, inputFor(ids), async (_config, request) => {
      const wire = wireIds(request);
      assert.equal(wire[0], "t1");
      const ambiguous = item(rawId, 1);
      request.onTextDelta!("[" + JSON.stringify(ambiguous));
      assert.equal(received, "", "ambiguous JSON must not produce even a provisional label");
      return { text: JSON.stringify([ambiguous, ...wire.map(item)]) };
    }, delta => { received += delta; }), invalidOutput);
  }
  await assert.rejects(analyzeApiInsights(config, inputFor(ids), async (_config, request) => {
    const wire = wireIds(request);
    return { text: `编号：1\n情感：感激\n意图：致谢\n编号：${wire[0]}\n情感：犹豫\n意图：婉拒\n编号：${wire[1]}\n情感：感激\n意图：致谢\n` };
  }), invalidOutput);
});

it("accepts an unambiguous numeric alias and still restores the original IDs", async () => {
  for (const number of [true, false]) {
    const result = await analyzeApiInsights(config, inputFor(standard.slice(0, 2)), async (_config, request) => {
      const wire = wireIds(request);
      return { text: JSON.stringify(wire.map((id, index) => item(number ? Number(id.slice(1)) : id.slice(1), index)).reverse()) };
    });
    assert.deepEqual(result.insights.map(value => value.id), standard.slice(0, 2));
  }
});

it("rejects conflicting repeated IDs in both JSON and numbered text, and deduplicates agreement", async () => {
  for (const format of ["json", "text"]) for (const conflict of [false, true]) {
    const run = analyzeApiInsights(config, inputFor(standard.slice(0, 2)), async (_config, request) => {
      const wire = wireIds(request);
      const rows = [item(wire[0]!, 0), item(wire[0]!, conflict ? 1 : 0), item(wire[1]!, 1)];
      return { text: format === "json" ? JSON.stringify(rows) : rows.map(row =>
        `编号：${row.id}\n情感：${row.emotion}\n意图：${row.intent}\n`).join("") };
    });
    if (conflict) await assert.rejects(run, invalidOutput);
    else assert.deepEqual((await run).insights.map(value => value.id), standard.slice(0, 2));
  }
});

it("keeps explicit no-label pairs visible as completed empties without imposing an output cap", async () => {
  const ids = standard.slice(0, 2);
  let received = "";
  const result = await analyzeApiInsights(config, inputFor(ids), async (_config, request) => {
    assert.equal(request.maxOutputTokens, undefined);
    const wire = wireIds(request);
    const text = JSON.stringify(wire.map(id => ({ id, emotion: "无", intent: "无" })));
    request.onTextDelta!(text);
    return { text };
  }, delta => { received += delta; });
  assert.deepEqual(result.insights, ids.map(id => ({ id, status: "ok", intents: [] })));
  assert.deepEqual(parse(received, ids), Object.fromEntries(ids.map(id => [id, { id, status: "ok", intents: [] }])));
});

it("includes the stream adapter in the portable-source allowlist", () => {
  const staging = readFileSync(new URL("../scripts/stage-real-client.py", import.meta.url), "utf8");
  assert.match(staging, /"analysis\/api-insight-stream\.ts"/u);
});
