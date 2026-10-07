const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, tick, settings } = require("./helpers/assistant-ui-harness.cjs");

test("assistant reads the shared profile only on open and exposes no second model form", async () => {
  const h = harness(async () => ({}));
  h.api.setConversation({ account: "test-account", user: "alice" }); assert.equal(h.requests.length, 0);
  await h.open(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body, undefined);
  for (const id of ["assistantTabSettings", "assistantApiKey", "assistantBaseUrl", "assistantModel", "assistantSettingsPanel"])
    assert.equal(h.nodes.has(id), false);
  assert.match(h.node("assistantModelInfo").textContent, /共用通用设置/); h.close();
});


test("reply presets save their own prompts without sending any model or secret fields", async () => {
  let saved;
  const h = harness(async (url, body) => { saved = body; return { ...settings(), ...body }; });
  await h.open(); h.input("assistantReplyPrompt", "我的朋友提示"); h.change("assistantRelationship", "elder");
  assert.equal(h.node("assistantReplyPrompt").value, "长辈提示");
  h.input("assistantReplyPrompt", "尊重长辈并保持边界"); h.node("btnAssistantSaveReplyPrompt").click(); await tick();
  assert.equal(saved.relationshipPrompts.friend, "我的朋友提示"); assert.equal(saved.relationshipPrompts.elder, "尊重长辈并保持边界");
  assert.deepEqual(Object.keys(saved).sort(), ["defaultRelationship", "relationshipPrompts"]);
  assert.equal(saved.defaultRelationship, "elder"); h.close();
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

test("invalid time range stays local, valid summary range sends exact milliseconds, shared model changes reload the confirmed configuration", async () => {
  const h = harness(async (url, body) => ({ id: "summary", account: body.account, user: body.user, kind: body.kind, status: "completed", text: "总结" }));
  await h.open("summary"); h.change("assistantSummaryRange", "time"); h.node("btnAssistantSummary").click(); await tick();
  assert.match(h.node("assistantJobStatus").textContent, /有效的开始和结束时间/); assert.equal(h.requests.length, 1);
  h.node("assistantSummaryFrom").value = "2026-10-01T08:00"; h.node("assistantSummaryTo").value = "2026-10-02T18:30";
  h.node("btnAssistantSummary").click(); await tick();
  assert.equal(h.requests.at(-1).body.fromMs, new Date("2026-10-01T08:00").getTime()); assert.equal(h.requests.at(-1).body.range, "time");
  h.api.modelChanged(); assert.equal(h.node("btnAssistantSummary").disabled, true); await tick();
  assert.equal(h.node("btnAssistantSummary").disabled, false); h.close();
});

test("Escape closes the modal and restores focus; tab boundaries stay in the visible dialog", async () => {
  const h = harness(async () => ({})); const trigger = h.node("btnAIReply"); trigger.focus(); await h.open();
  h.node("assistantTabReply").focus(); let prevented = 0;
  const key = (value, shiftKey = false) => { const event = { key: value, shiftKey, preventDefault() { prevented++; }, stopImmediatePropagation() {} }; for (const listener of h.document.events.keydown || []) listener(event); };
  h.node("btnCloseAssistant").focus(); key("Tab", true); assert.equal(h.document.activeElement.id, "btnAssistantReply");
  key("Tab"); assert.equal(h.document.activeElement.id, "btnCloseAssistant"); key("Escape");
  assert.equal(h.node("assistantModal").hidden, true); assert.equal(h.document.activeElement, trigger); assert.equal(prevented, 3);
});

test("missing general-settings credentials block official generation, while a local API can be unauthenticated", async () => {
  const h = harness(async () => ({}), () => ({ ...settings(), hasKey: false }));
  await h.open(); assert.match(h.node("assistantModelInfo").textContent, /通用设置.*API Key/);
  h.node("btnAssistantReply").click(); assert.equal(h.requests.length, 1); h.close();
  const local = harness(async () => ({}), () => ({ ...settings(), preset: "custom", hasKey: false }));
  await local.open(); assert.equal(local.node("btnAssistantReply").disabled, false); local.close();
});


test("each summary preset has an editable prompt and saves separately from reply prompts", async () => {
  let saved;
  const h = harness(async (url, body) => { saved = body; return { ...settings(), ...body }; });
  await h.open("summary"); assert.equal(h.node("assistantSummaryPreset").children.length, 7);
  h.input("assistantSummaryPrompt", "保留我修改过的完整总结"); h.change("assistantSummaryPreset", "tasks");
  assert.match(h.node("assistantSummaryPrompt").value, /负责人.*截止时间/);
  h.input("assistantSummaryPrompt", "只整理已经确认的待办"); h.change("assistantSummaryPreset", "general");
  assert.equal(h.node("assistantSummaryPrompt").value, "保留我修改过的完整总结");
  h.node("btnAssistantSaveSummaryPrompt").click(); await tick();
  assert.equal(saved.summaryPrompts.tasks, "只整理已经确认的待办");
  assert.equal(saved.summaryPrompt, "保留我修改过的完整总结");
  assert.deepEqual(Object.keys(saved).sort(), ["summaryPreset", "summaryPrompt", "summaryPrompts"]); h.close();
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

test("closing during a prompt save awaits its completion before reopening the shared model", async () => {
  let authoritative = settings(), resolve;
  const h = harness(async () => new Promise(done => { resolve = done; }), () => authoritative);
  await h.open(); h.node("btnAssistantSaveReplyPrompt").click(); await tick(); const saving = h.requests.at(-1); h.close();
  assert.equal(saving.options.signal.aborted, false); await h.open(); assert.equal(h.node("btnAssistantReply").disabled, true);
  authoritative = { ...settings(), model: "new-model" }; resolve(authoritative); await tick();
  assert.match(h.node("assistantModelInfo").textContent, /new-model/);
  assert.equal(h.requests.filter(item => item.url.endsWith("settings") && !item.body).length, 2);
  assert.equal(h.node("btnAssistantReply").disabled, false); h.close();
});


test("assistant links to the single general settings form and generation requires a selected chat", async () => {
  const h = harness(async () => ({}));
  assert.equal(h.api.open("reply"), false); assert.equal(h.api.open("settings"), false);
  let opened = 0; h.window.openAIModelSettings = () => { opened++; };
  await h.open(); h.node("btnAssistantGeneralSettings").click();
  assert.equal(opened, 1); assert.equal(h.node("assistantModal").hidden, true);
  assert.equal(h.requests.some(item => item.url.includes("/jobs")), false);
});


test("day and week shortcuts use rolling hours, click-time seconds and the existing exact time request format", async () => {
  let now = new Date(2026, 9, 7, 12, 34, 56, 987).getTime();
  const h = harness(async (url, body) => ({ id: "quick", account: body.account, user: body.user, kind: body.kind, status: "completed", text: "时间段结果" }), settings, { now: () => now });
  await h.open("summary"); h.node("btnAssistantSummaryLastDay").click();
  assert.equal(h.requests.length, 1, "Choosing a range alone must not generate or make provider calls");
  assert.equal(h.node("assistantSummaryRange").value, "time"); assert.equal(h.node("assistantSummaryDates").hidden, false);
  assert.match(h.node("assistantSummaryTo").value, /T12:34:56$/); assert.equal(h.node("assistantSummaryTo").getAttribute("step"), "1");
  h.node("btnAssistantSummary").click(); await tick(); let payload = h.requests.at(-1).body;
  assert.equal(payload.range, "time"); assert.equal(payload.toMs, Math.floor(now / 1000) * 1000); assert.equal(payload.toMs - payload.fromMs, 24 * 3600000);
  now += 61000; h.node("btnAssistantSummaryLastWeek").click(); h.node("btnAssistantSummary").click(); await tick(); payload = h.requests.at(-1).body;
  assert.equal(payload.toMs, Math.floor(now / 1000) * 1000); assert.equal(payload.toMs - payload.fromMs, 7 * 24 * 3600000);
  assert.equal(h.node("btnAssistantSummaryLastDay").getAttribute("aria-pressed"), "false"); assert.equal(h.node("btnAssistantSummaryLastWeek").getAttribute("aria-pressed"), "true");
  h.input("assistantSummaryFrom", "2026-10-01T08:02:03"); h.node("btnAssistantSummary").click(); await tick();
  assert.equal(h.requests.at(-1).body.fromMs, new Date("2026-10-01T08:02:03").getTime());
  assert.equal(h.node("btnAssistantSummaryLastWeek").getAttribute("aria-pressed"), "false"); h.close();
});

test("month shortcuts clamp month ends for ordinary, leap and year-boundary dates and work for replies too", async () => {
  let now;
  const h = harness(async (url, body) => ({ id: "month", account: body.account, user: body.user, kind: body.kind, status: "completed", text: "回复" }), settings, { now: () => now });
  await h.open("reply");
  for (const [year, month, day, fromYear, fromMonth, fromDay] of [[2025, 2, 31, 2025, 1, 28], [2024, 2, 31, 2024, 1, 29], [2026, 0, 31, 2025, 11, 31]]) {
    now = new Date(year, month, day, 18, 45, 12, 321).getTime(); h.node("btnAssistantReplyLastMonth").click();
    assert.equal(h.node("assistantReplyRange").value, "time"); assert.equal(h.node("assistantReplyDates").hidden, false);
    h.node("btnAssistantReply").click(); await tick(); const payload = h.requests.at(-1).body;
    assert.equal(payload.kind, "reply"); assert.equal(payload.fromMs, new Date(fromYear, fromMonth, fromDay, 18, 45, 12).getTime());
    assert.equal(payload.toMs, new Date(year, month, day, 18, 45, 12).getTime());
  }
  h.node("assistantTabSummary").click(); h.node("btnAssistantSummaryLastMonth").click(); h.node("btnAssistantSummary").click(); await tick();
  assert.equal(h.requests.at(-1).body.fromMs, new Date(2025, 11, 31, 18, 45, 12).getTime()); h.close();
});

test("all preset prompts reach generation unchanged and shared model refresh preserves draft prompts", async () => {
  let current = settings();
  const h = harness(async (url, body) => ({ id: "preset", account: body.account, user: body.user, kind: body.kind, status: "completed", text: "结果" }), () => current);
  await h.open("summary");
  for (const option of h.node("assistantSummaryPreset").children) {
    h.change("assistantSummaryPreset", option.value); const prompt = h.node("assistantSummaryPrompt").value;
    assert.ok(prompt.trim().length > 0); h.node("btnAssistantSummary").click(); await tick();
    assert.equal(h.requests.at(-1).body.systemPrompt, prompt);
  }
  h.input("assistantSummaryPrompt", "尚未保存的总结要求"); current = { ...settings(), model: "shared-model-two" };
  h.api.modelChanged(); await tick(); assert.match(h.node("assistantModelInfo").textContent, /shared-model-two/);
  assert.equal(h.node("assistantSummaryPrompt").value, "尚未保存的总结要求"); h.close();
});

