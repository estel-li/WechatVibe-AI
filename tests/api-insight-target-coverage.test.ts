import assert from "node:assert/strict";
import { it } from "node:test";
import { analyzeApiInsights } from "../analysis/api-message-insights";
import { ModelConnectorError, type ModelConfig } from "../analysis/model-connectors";
const config: ModelConfig = { protocol: "chat_completions", baseUrl: "https://example.invalid/v1", model: "fake", apiKey: "fake" };
const input = { messages: [
  { id: "a", sender: "OTHER" as const, text: "改天吧" },
  { id: "b", sender: "OTHER" as const, text: "谢谢关心" },
], targetIds: ["a", "b"] };
const fake = (text: string) => async () => ({ text });
it("does not manufacture empty successes for targets omitted from JSON or text", async () => {
  for (const reply of [JSON.stringify({ items: [{ id: "a", emotion: "犹豫", intent: "婉拒" }] }),
    "情感：犹豫\n意图：婉拒\n", "编号：a\n情感：犹豫\n意图：婉拒\n", "{}"]) {
    await assert.rejects(analyzeApiInsights(config, input, fake(reply)),
      (error: unknown) => error instanceof ModelConnectorError && error.code === "invalid-output");
  }
});
it("uses explicit IDs even when the model returns text blocks out of order", async () => {
  const reply = "编号：b\n情感：感激\n意图：致谢\n编号：a\n情感：犹豫\n意图：婉拒\n";
  const result = await analyzeApiInsights(config, input, fake(reply));
  assert.deepEqual(result.insights.map(x => [x.id, x.status === "ok" ? x.intents : []]),
    [["a", ["婉拒"]], ["b", ["致谢"]]]);
});
it("distinguishes explicitly absent tags from missing output", async () => {
  for (const reply of ["编号：a\n情感：无\n意图：无\n编号：b\n情感：无\n意图：无\n",
    JSON.stringify({ items: [{ id: "a", intents: [] }, { id: "b", emotion: "无", intent: "无" }] })]) {
    const result = await analyzeApiInsights(config, input, fake(reply));
    assert.deepEqual(result.insights, [{ id: "a", status: "ok", intents: [] }, { id: "b", status: "ok", intents: [] }]);
  }
});
it("never reassigns an unrelated structured ID to a missing target", async () => {
  await assert.rejects(analyzeApiInsights(config, input, fake(JSON.stringify({ items: [
    { id: "a", emotion: "犹豫", intent: "婉拒" }, { id: "outsider", emotion: "感激", intent: "致谢" },
  ] }))));
});
