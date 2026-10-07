const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, tick } = require("./helpers/assistant-ui-harness.cjs");

function completed(body, text = "合成结果") {
  return { id: "synthetic-job", account: body.account, user: body.user, kind: body.kind,
    status: "completed", text, model: "synthetic-model", messageCount: 42, chunkCount: 3,
    progress: { completed: 4, total: 4, messageCount: 42 }, usage: { inputTokens: 1234, outputTokens: 56 } };
}

test("reply styles are manual, preserve relationship prompts, and prioritize the user's instructions", async () => {
  const h = harness(async (_url, body) => completed(body));
  await h.open();
  const initialRequests = h.requests.length;
  h.change("assistantReplyStyle", "warm");
  assert.equal(h.requests.length, initialRequests);
  h.input("assistantReplyInstructions", "礼貌拒绝，别承诺下次");
  h.node("btnAssistantReply").click(); await tick();
  const body = h.requests.at(-1).body;
  assert.equal(body.systemPrompt, "朋友提示");
  assert.match(body.instructions, /温暖真诚/);
  assert.match(body.instructions, /我的表达要求（优先）：礼貌拒绝，别承诺下次/);
  assert.equal("apiKey" in body, false);
  assert.match(h.node("assistantResultMeta").textContent, /语气：温暖真诚/);
  h.change("assistantReplyStyle", "natural");
  h.node("btnAssistantReply").click(); await tick();
  assert.equal(h.requests.at(-1).body.instructions, "礼貌拒绝，别承诺下次");
  h.close();
});

test("summary and reply results survive tab changes, and changing chats clears both", async () => {
  const h = harness(async (_url, body) => completed(body, body.kind === "summary" ? "完整合成总结" : "温暖合成回复"));
  await h.open("summary");
  h.node("btnAssistantSummary").click(); await tick();
  h.node("assistantTabReply").click();
  assert.equal(h.node("assistantResultSection").hidden, true);
  h.node("btnAssistantReply").click(); await tick();
  h.node("assistantTabSummary").click();
  assert.equal(h.node("assistantResultText").textContent, "完整合成总结");
  h.node("assistantTabReply").click();
  assert.equal(h.node("assistantResultText").textContent, "温暖合成回复");
  assert.match(h.node("assistantResultMeta").textContent, /完整覆盖 42 条 \/ 3 个来源片段/);
  assert.match(h.node("assistantResultMeta").textContent, /模型调用 4\/4/);
  assert.match(h.node("assistantResultMeta").textContent, /输入 1,234 \/ 输出 56/);
  h.api.setConversation({ account: "second-account", user: "bob", name: "Bob" });
  h.node("assistantTabSummary").click();
  assert.equal(h.node("assistantResultText").textContent, "");
  assert.equal(h.node("assistantResultMeta").textContent, "");
  h.node("assistantTabReply").click();
  assert.equal(h.node("assistantResultSection").hidden, true);
  assert.equal(h.node("assistantReplyStyle").value, "natural");
  h.close();
});

test("changing the model or clearing its key purges both completed results", async () => {
  const h = harness(async (_url, body) => completed(body, body.kind === "summary" ? "旧模型总结" : "旧模型回复"));
  await h.open("summary");
  h.node("btnAssistantSummary").click(); await tick();
  h.node("assistantTabReply").click();
  h.node("btnAssistantReply").click(); await tick();
  assert.equal(h.node("assistantResultText").textContent, "旧模型回复");
  h.api.modelChanged(); await tick();
  assert.equal(h.node("assistantResultSection").hidden, true);
  assert.equal(h.node("assistantResultText").textContent, "");
  assert.equal(h.node("assistantResultMeta").textContent, "");
  h.node("assistantTabSummary").click();
  assert.equal(h.node("assistantResultSection").hidden, true);
  assert.equal(h.node("assistantResultText").textContent, "");
  h.node("assistantTabReply").click();
  assert.equal(h.node("assistantResultSection").hidden, true);
  assert.equal(h.node("assistantResultText").textContent, "");
  assert.equal(h.requests.filter(request => request.url.includes("jobs")).length, 2);
  h.close();
});

test("native exports retain Chinese filenames, remove illegal characters, and preserve untrusted text safely", async () => {
  const text = "<script>alert('合成')</script>\n```\n[恶意标题](javascript:alert(1))\n```";
  const saved = [];
  const h = harness(async (_url, body) => completed(body, text));
  await h.open("summary");
  h.api.setConversation({ account: "test-account", user: "alice", name: "中文/群聊:*?<>|\"\\\u0001. " });
  h.window.desktopHost.saveAssistantExport = async value => { saved.push(value); return { status: "saved" }; };
  h.node("btnAssistantSummary").click(); await tick();
  h.node("btnAssistantExportMarkdown").click(); await tick();
  assert.equal(saved.length, 1);
  assert.match(saved[0].filename, /^中文_群聊/);
  assert.match(saved[0].filename, /对话总结-\d{8}-\d{6}\.md$/);
  assert.doesNotMatch(saved[0].filename, /[<>:"/\\|?*\u0000-\u001f]/);
  assert.ok(saved[0].content.includes("````text\n" + text + "\n````"));
  assert.doesNotMatch(saved[0].content, /朋友提示|mock-key|apiKey|test-account|user: alice/);
  assert.match(saved[0].content, /完整覆盖 42 条/);
  assert.equal(h.node("assistantResultText").textContent, text);
  assert.equal(h.node("assistantJobStatus").textContent, "结果已保存到本地。");
  h.node("btnAssistantExportText").click(); await tick();
  assert.ok(saved[1].content.includes(text));
  assert.equal(saved[1].format, "txt");
  assert.equal(h.requests.filter(request => request.url.includes("jobs")).length, 1);
  h.close();
});

test("export cancellation is quiet and late export errors cannot update the new account or start a fallback download", async () => {
  const h = harness(async (_url, body) => completed(body, "私有合成回复"));
  await h.open();
  h.node("btnAssistantReply").click(); await tick();
  h.window.desktopHost.saveAssistantExport = async () => ({ status: "cancelled" });
  h.node("btnAssistantExportText").click(); await tick();
  assert.equal(h.node("assistantJobStatus").textContent, "已取消导出。");
  let reject;
  h.window.desktopHost.saveAssistantExport = () => new Promise((_resolve, fail) => { reject = fail; });
  h.node("btnAssistantExportText").click();
  assert.equal(h.node("btnAssistantExportText").disabled, true);
  h.api.setConversation({ account: "second-account", user: "bob", name: "Bob" });
  reject(new Error("synthetic-key-must-never-leak")); await tick();
  assert.equal(h.node("assistantResultText").textContent, "");
  assert.equal(h.node("assistantJobStatus").textContent, "");
  assert.equal(h.downloads.length, 0);
  h.close();
});

test("browser export downloads a local UTF-8 file without any further request", async () => {
  const revoked = [];
  const h = harness(async (_url, body) => completed(body, "中文💬合成摘要"), undefined, undefined,
    { revokeObjectURL: url => revoked.push(url) });
  await h.open("summary");
  h.node("btnAssistantSummary").click(); await tick();
  const before = h.requests.length;
  h.node("btnAssistantExportText").click(); await tick();
  assert.equal(h.requests.length, before);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].href, "blob:synthetic-export");
  assert.match(h.downloads[0].filename, /\.txt$/);
  assert.match(await h.blobs[0].text(), /中文💬合成摘要/);
  assert.deepEqual(Array.from(new Uint8Array(await h.blobs[0].arrayBuffer()).slice(0, 3)), [239, 187, 191]);
  assert.equal(h.node("assistantJobStatus").textContent, "已开始下载结果文件。");
  assert.equal(h.node("btnAssistantExportText").disabled, false);
  assert.equal(revoked.length, 0);
  h.close();
});
