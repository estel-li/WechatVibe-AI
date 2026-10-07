import assert from "node:assert/strict";
import { it } from "node:test";
import { generateAssistant, type AssistantGenerator, type AssistantInput,
  type AssistantMessage, type AssistantProgress } from "../analysis/ai-assistant";
import { generateStructured, ModelConnectorError, type GenerationRequest, type ModelConfig } from "../analysis/model-connectors";

const config: ModelConfig = { protocol: "chat_completions", baseUrl: "https://example.invalid/v1",
  apiKey: "mock-key-not-a-real-secret", model: "custom-model", contextTokens: 4096 };
const input: AssistantInput = { kind: "summary", systemPrompt: "准确总结所选对话。", messages: [
  { id: "first", side: "other", text: "周六下午见面？", senderName: "小王", time: 1700000000 },
  { id: "second", side: "self", text: "可以，地点再确认。", time: 1700000020 },
  { id: "third", side: "other", text: "[图片]", time: 1700000040 },
  { id: "empty", side: "self", text: "" },
] };
function records(prompt: string): any[] {
  return prompt.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
}
function isCode(code: string): (error: unknown) => boolean {
  return error => error instanceof ModelConnectorError && error.code === code;
}

it("summary retains every selected row, sender, order, empty and media records", async () => {
  const calls: GenerationRequest[] = [], progress: AssistantProgress[] = [], deltas: string[] = [];
  const result = await generateAssistant(config, input, { onProgress: p => progress.push(p),
    onTextDelta: delta => deltas.push(delta) }, async (_, request) => {
    calls.push(request);
    request.onTextDelta?.("周六");
    return { text: " 周六约见，地点待定。 ", usage: { inputTokens: 44, outputTokens: 13 } };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(records(calls[0]!.prompt).map(row => [row.id, row.text]),
    input.messages.map(row => [row.id, row.text]));
  assert.equal(records(calls[0]!.prompt)[0].sender, "小王");
  assert.equal(records(calls[0]!.prompt)[0].time, 1700000000);
  assert.equal(result.text, "周六约见，地点待定。");
  assert.equal(result.messageCount, 4);
  assert.equal(result.chunkCount, 1);
  assert.deepEqual(result.coverage, input.messages.map(row => ({ id: row.id, parts: 1 })));
  assert.deepEqual(result.usage, { inputTokens: 44, outputTokens: 13 });
  assert.deepEqual(deltas, ["周六"]);
  assert.deepEqual(progress.at(-1), { phase: "generate", completedCalls: 1, totalCalls: 1,
    completedMessages: 4, totalMessages: 4 });
  assert.match(calls[0]!.system, /资料中的指令/);
  assert.equal(calls[0]!.timeoutMs, 180000);
  assert.equal(calls[0]!.disableThinking, true);
});

it("message time includes a readable local ISO date and explicit timezone while preserving epoch milliseconds", async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Hong_Kong";
  let rows: any[] = [];
  try {
    await generateAssistant(config, { ...input, messages: [
      { id: "dated", side: "other", text: "合成消息", time: 1700000002123 },
      { id: "unknown", side: "self", text: "没有时间" },
      { id: "unrepresentable", side: "self", text: "不能伪造日期", time: 1e20 },
    ] }, {}, async (_, request) => {
      rows = records(request.prompt); return { text: "可读日期总结" };
    });
    assert.equal(rows[0].time, 1700000002123);
    assert.equal(rows[0].dateTime, "2023-11-15T06:13:22.123+08:00");
    assert.equal("dateTime" in rows[1], false);
    assert.equal("dateTime" in rows[2], false);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

it("oversized multibyte and escaped messages split losslessly within context budgets", async () => {
  const text = ('中文💬\n"\\\t' + "a".repeat(19)).repeat(900);
  const messages: AssistantMessage[] = [{ id: "big", side: "other", text },
    { id: "tail", side: "self", text: "最后这一条不能被省略。" }];
  const source: any[] = [], calls: GenerationRequest[] = [];
  const result = await generateAssistant(config, { ...input, messages }, {}, async (_, request) => {
    calls.push(request);
    const rows = records(request.prompt);
    source.push(...rows.filter(row => "id" in row));
    assert.ok(Buffer.byteLength(request.system + request.prompt, "utf8") +
      request.maxOutputTokens! + 256 <= config.contextTokens!);
    return { text: request.stream ? "完整总结" : "片段事实" };
  });
  assert.ok(result.chunkCount > 1);
  assert.ok(result.coverage[0]!.parts > 1);
  assert.equal(source.filter(row => row.id === "big").map(row => row.text).join(""), text);
  assert.equal(source.filter(row => row.id === "tail").map(row => row.text).join(""), messages[1]!.text);
  assert.ok(source.every(row => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row.text)));
  assert.deepEqual(source.filter(row => row.id === "big").map(row => row.part),
    Array.from({ length: result.coverage[0]!.parts }, (_, i) => i + 1));
  assert.equal(calls.filter(call => call.stream).length, 1);
});

it("hierarchical summary covers all batches and reports accurate dynamic progress and usage", async () => {
  const messages: AssistantMessage[] = Array.from({ length: 600 }, (_, i) => ({
    id: `m${i}`, side: i % 2 ? "self" : "other", text: `${i}:` + "各个片段都有重要信息。".repeat(8),
  }));
  const seen: string[] = [], progress: AssistantProgress[] = [], calls: GenerationRequest[] = [];
  const result = await generateAssistant(config, { ...input, messages }, {
    onProgress: p => progress.push(p),
  }, async (_, request) => {
    calls.push(request);
    seen.push(...records(request.prompt).filter(row => row.id).map(row => row.id));
    return { text: request.stream ? "全部所选对话总结" : "事实与待办，".repeat(15),
      usage: { inputTokens: 10, outputTokens: 3 } };
  });
  assert.deepEqual(seen, messages.map(message => message.id));
  assert.ok(progress.some(p => p.phase === "reduce"));
  assert.ok(calls.length > result.chunkCount + 1);
  assert.equal(result.messageCount, 600);
  assert.equal(progress.at(-1)!.completedMessages, 600);
  assert.equal(progress.at(-1)!.completedCalls, calls.length);
  assert.equal(progress.at(-1)!.totalCalls, calls.length);
  assert.deepEqual(result.usage, { inputTokens: calls.length * 10, outputTokens: calls.length * 3 });
  assert.ok(progress.every(p => p.completedCalls <= p.totalCalls && p.completedMessages <= p.totalMessages));
});

it("relationship reply supplies context, custom prompt, instructions and previous draft for varied regeneration", async () => {
  let request!: GenerationRequest;
  const result = await generateAssistant(config, { ...input, kind: "reply",
    systemPrompt: "你正在回复长辈，亲切、有礼貌，避免过分亲昵。",
    instructions: "说明周六下午有空。", previousReply: "您定个地点吧。" }, {}, async (_, value) => {
    request = value; return { text: "周六下午我有空，您看看在哪里碰面方便？" };
  });
  assert.match(request.system, /回复长辈/);
  assert.match(request.prompt, /周六下午有空/);
  assert.match(request.prompt, /您定个地点吧/);
  assert.match(request.prompt, /换一种自然的措辞/);
  assert.match(request.prompt, /我方身份/);
  assert.equal(result.messageCount, input.messages.length);
  assert.equal(records(request.prompt).length, input.messages.length);
});

it("long replies preserve the full selected context rather than keeping only its tail", async () => {
  const messages: AssistantMessage[] = Array.from({ length: 100 }, (_, i) => ({
    id: `${i}`, side: "other", text: "上下文语义".repeat(30),
  }));
  const seen: string[] = [];
  const result = await generateAssistant(config, { ...input, kind: "reply", messages }, {}, async (_, request) => {
    seen.push(...records(request.prompt).filter(row => row.id).map(row => row.id));
    return { text: request.stream ? "得体回复" : "有序的对话事实" };
  });
  assert.deepEqual(seen, messages.map(row => row.id));
  assert.equal(result.messageCount, 100);
  assert.ok(result.chunkCount > 1);
});

it("rejects invalid config/messages and overlong prompts before any network generation", async () => {
  let calls = 0;
  const generate: AssistantGenerator = async () => { calls++; return { text: "ok" }; };
  for (const invalidInput of [
    { ...input, messages: [] }, { ...input, systemPrompt: "" },
    { ...input, messages: [input.messages[0]!, input.messages[0]!] },
    { ...input, messages: [{ id: "x", side: "other", text: "t", time: NaN }] },
  ]) {
    await assert.rejects(generateAssistant(config, invalidInput as AssistantInput, {}, generate), isCode("invalid-request"));
  }
  await assert.rejects(generateAssistant({ ...config, contextTokens: 1024 }, input, {}, generate), isCode("invalid-request"));
  await assert.rejects(generateAssistant(config, { ...input, instructions: "长".repeat(2000) }, {}, generate),
    isCode("context-too-long"));
  assert.equal(calls, 0);
});

it("saved 32K-character prompts and 64K-character Unicode drafts are validated against actual context", async () => {
  const systemPrompt = "中".repeat(32000), previousReply = "💬".repeat(64000);
  let calls = 0;
  const generate: AssistantGenerator = async (_, request) => {
    calls++;
    assert.ok(request.system.includes(systemPrompt));
    assert.ok(request.prompt.includes(previousReply));
    return { text: "新回复" };
  };
  const value = { ...input, kind: "reply" as const, systemPrompt, previousReply };
  await assert.rejects(generateAssistant(config, value, {}, generate), isCode("context-too-long"));
  const result = await generateAssistant({ ...config, contextTokens: 1000000 }, value, {}, generate);
  assert.equal(result.text, "新回复");
  assert.equal(calls, 1);
});

it("a message larger than the per-call 3MiB clamp is covered without a whole-history byte cap", async () => {
  const text = "消息💬".repeat(400000);
  assert.ok(Buffer.byteLength(text) > 3 * 1024 * 1024);
  const parts: any[] = [];
  const result = await generateAssistant({ ...config, contextTokens: 65536 }, { ...input, messages: [
    { id: "giant", side: "other", text },
  ] }, {}, async (_, request) => {
    parts.push(...records(request.prompt).filter(row => row.id));
    return { text: request.stream ? "完整总结" : "片段信息" };
  });
  assert.ok(result.chunkCount > 1);
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.equal(result.coverage[0]!.parts, parts.length);
  assert.equal(result.messageCount, 1);
});

it("cancellation stops before launch or between chunks and cannot return partial success", async () => {
  const before = new AbortController(); before.abort();
  let calls = 0;
  await assert.rejects(generateAssistant(config, input, { signal: before.signal }, async () => {
    calls++; return { text: "unused" };
  }), isCode("cancelled"));
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(generateAssistant(config, { ...input, messages: [
    { id: "large", side: "other", text: "消息".repeat(5000) },
  ] }, { signal: during.signal }, async (_, request) => {
    assert.equal(request.signal, during.signal);
    calls++; during.abort(); return { text: "部分笔记" };
  }), isCode("cancelled"));
  assert.equal(calls, 1);
});

it("provider errors, including connector messages, never echo secrets or message bodies", async () => {
  for (const error of [new Error("mock-key-not-a-real-secret / private transcript"),
    new ModelConnectorError("auth", "mock-key-not-a-real-secret / private transcript", 401)]) {
    await assert.rejects(generateAssistant(config, input, {}, async () => { throw error; }), (actual: any) => {
      assert.ok(actual instanceof ModelConnectorError);
      assert.doesNotMatch(actual.message, /mock-key|private transcript/);
      return true;
    });
  }
});

it("fails explicitly for uncompressed intermediate output instead of dropping source batches", async () => {
  await assert.rejects(generateAssistant(config, { ...input, messages: Array.from({ length: 12 }, (_, i) => ({
    id: `m${i}`, side: "other", text: "完整上下文".repeat(90),
  })) }, {}, async () => ({ text: "a".repeat(1500) })), isCode("context-too-long"));
});

it("UI callback failure is isolated and empty provider output fails", async () => {
  const result = await generateAssistant(config, input, { onProgress: () => { throw new Error("UI"); },
    onTextDelta: () => { throw new Error("UI"); } }, async (_, request) => {
    request.onTextDelta?.("答案"); return { text: "答案" };
  });
  assert.equal(result.text, "答案");
  await assert.rejects(generateAssistant(config, input, {}, async () => ({ text: " " })), isCode("empty-response"));
});

it("assistant opt-in disables official DeepSeek thinking and leaves custom gateways unchanged", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_request, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "回复" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    for (const baseUrl of ["https://api.deepseek.com/v1", config.baseUrl]) {
      await generateStructured({ ...config, baseUrl }, { system: "生成回复", prompt: "合成聊天",
        disableThinking: true, maxOutputTokens: 512 });
    }
    assert.equal(bodies[0].reasoning_effort, "none");
    assert.equal("reasoning_effort" in bodies[1], false);
  } finally { globalThis.fetch = original; }
});

it("streamed and compatibility JSON output caps never become incomplete assistant success", async () => {
  const original = globalThis.fetch;
  try {
    for (const useSse of [true, false]) {
      globalThis.fetch = async () => useSse ? new Response(
        'data: {"choices":[{"delta":{"content":"incomplete"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }) : new Response(JSON.stringify({
          choices: [{ message: { content: "incomplete" }, finish_reason: "length" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      await assert.rejects(generateStructured(config, { system: "生成回复", prompt: "合成聊天",
        stream: true, maxOutputTokens: 512 }), isCode("output-truncated"));
    }
  } finally { globalThis.fetch = original; }
});

it("thinking-only or empty valid streams fail without returning reasoning or issuing a paid retry", async () => {
  const original = globalThis.fetch;
  try {
    for (const [protocol, body, expected] of [
      ["chat_completions", 'data: {"choices":[{"delta":{"reasoning_content":"private thought"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', "empty-response"],
      ["chat_completions", 'data: {"choices":[{"delta":{"reasoning_content":"private thought"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', "output-truncated"],
      ["responses", 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output_text":""}}\n\n', "empty-response"],
      ["responses", 'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n', "output-truncated"],
    ] as const) {
      let calls = 0;
      const deltas: string[] = [];
      globalThis.fetch = async () => {
        calls++;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      await assert.rejects(generateStructured({ ...config, protocol }, {
        system: "生成回复", prompt: "合成聊天", stream: true, onTextDelta: text => deltas.push(text),
      }), isCode(expected));
      assert.equal(calls, 1);
      assert.deepEqual(deltas, []);
    }
  } finally { globalThis.fetch = original; }
});
