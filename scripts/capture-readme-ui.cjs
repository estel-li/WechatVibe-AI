/* Capture the actual isolated native UI with a fictional fixture story, never user data. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
let connectedBrowser;
let failureDiagnostics;

(async () => {
  assert.equal(process.env.WECHATVIBE_README_SCREENSHOTS, "1", "README capture requires its explicit synthetic demo mode");
  const endpoint = process.env.WECHATVIBE_SMOKE_CDP;
  assert.match(endpoint || "", /^http:\/\/127\.0\.0\.1:\d+$/);
  const output = path.resolve(process.env.WECHATVIBE_SMOKE_OUTPUT || path.join(__dirname, "../docs/assets/readme"));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP(endpoint);
  connectedBrowser = browser;
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url()));
  assert.equal(pages.length, 1, "Exactly one owned loopback native page is required");
  const page = pages[0];
  const stats = () => page.evaluate(() => fetch("/__smoke__").then(response => response.json()));
  const fixture = await stats();
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.readmeDemo, true, "Ordinary smoke fixtures and real clients cannot be used for README screenshots");
  assert.equal(fixture.remoteCalls, 0);
  const errors = [], externalRequests = [], failedRequests = [], nativeIpcRequests = [];
  const resourceName = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return value; } };
  failureDiagnostics = { output, page, errors, externalRequests, failedRequests };
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push({ message: message.text(), location: resourceName(message.location().url) }); });
  page.on("requestfailed", request => failedRequests.push({ url: resourceName(request.url()), resourceType: request.resourceType(), error: request.failure()?.errorText }));
  await page.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.protocol === "http:" && url.host === "ipc.localhost" && !url.username && !url.password) {
      // WebView2's Tauri transport resolves this private hostname to the native invoke handler.
      nativeIpcRequests.push(url.pathname);
      return route.continue();
    }
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return route.continue();
    externalRequests.push({ url: url.origin + url.pathname, resourceType: route.request().resourceType() });
    return route.abort("blockedbyclient");
  });
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.waitForFunction(() => window.desktopHost && document.getElementById("startupOverlay").hidden);
  assert.equal(await page.title(), "知意 AI · WechatVibe AI");
  assert.equal(await page.evaluate(() => typeof window.__TAURI__?.core?.invoke), "function");
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  const record = { synthetic: true, readmeDemo: true, native: true,
    brand: { nameZh: "知意 AI", nameEn: "WechatVibe AI" },
    executableSha256: process.env.WECHATVIBE_SMOKE_EXE_SHA256,
    viewport: { width: 1280, height: 960 }, theme: "dark", zoom: "1.0", shots: [], checks: [],
    note: "Contacts, dialogue, analysis labels, portraits and AI output are fictional demonstration data rendered by the real Tauri UI." };
  const passed = message => { record.checks.push(message); console.log("PASS " + message); };
  const settle = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].filter(image => image.getClientRects().length && image.src)
        .map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
          image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 2000);
        })));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForTimeout(180);
  };
  const capture = async (name, purpose) => {
    await settle();
    if (errors.length || externalRequests.length) console.error("README_CAPTURE_RESOURCE_DIAGNOSTICS " + JSON.stringify({ stage: name, errors, externalRequests, failedRequests }));
    assert.deepEqual(errors, [], `UI errors before ${name}`);
    assert.deepEqual(externalRequests, [], "The fixture must not request remote images, APIs or services");
    const file = path.join(output, name + ".png");
    await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
    assert.ok(fs.statSync(file).size > 15000, `Screenshot ${name} is unexpectedly empty`);
    record.shots.push({ file: name + ".png", purpose });
    console.log("CAPTURED " + name);
  };
  const openSettings = async () => {
    if (!await page.locator("#settingsModal").evaluate(node => node.classList.contains("show"))) await page.locator("#btnSettings").click();
    await page.locator("#tabGeneral").click();
  };
  const closeSettings = async () => {
    if (await page.locator("#settingsModal").evaluate(node => node.classList.contains("show"))) await page.locator("#btnCloseSettings").click();
  };
  const setScroll = async (selector, top = 0) => page.locator(selector).evaluate((node, value) => { node.scrollTop = value; }, top);
  const sessionSelector = user => {
    assert.match(user, /^[a-zA-Z0-9@_.-]+$/, "Fixture usernames must be safe known IDs");
    return `#sessionList .session-item[data-id="${user}"]`;
  };
  const selectChat = async user => {
    await closeSettings();
    if (await page.locator("#assistantModal").evaluate(node => !node.hidden)) await page.locator("#btnCloseAssistant").click();
    await page.locator("#navChat").click();
    await page.locator(sessionSelector(user)).click();
    await page.waitForFunction(id => chatState.currentUser === id && document.querySelectorAll("#chatMessages .msg-item").length >= 3, user);
  };

  await openSettings();
  await page.locator("#selectThemeMode").selectOption("dark");
  await page.locator("#selectZoomLevel").selectOption("1.0");
  await page.waitForFunction(() => !document.body.classList.contains("theme-light") && Number(document.documentElement.style.zoom) === 1);
  await closeSettings();
  await page.locator("#btnAddConversation").click();
  await page.locator("#btnAddAllConversations").click();
  await page.waitForFunction(() => document.querySelectorAll("#sessionList .session-item").length >= 4);
  assert.ok(await page.locator("#conversationManagerList .conversation-manager-row").count() >= 4);
  await page.locator("#conversationManager").scrollIntoViewIfNeeded();
  await capture("conversations-demo", "Choose fictional conversations through the real conversation manager");
  await closeSettings();

  const sessionData = await page.evaluate(() => fetch("/api/sessions").then(response => response.json()));
  const personUser = fixture.personUser || sessionData.sessions.find(session => !session.isGroup)?.username;
  const groupUser = fixture.groupUser || sessionData.sessions.find(session => session.isGroup)?.username;
  assert.ok(personUser && groupUser, "The demo needs a fictional person and group");
  await selectChat(personUser);
  await page.locator("#chatInput").fill("周六下午两点我可以参加，地点还是上次那家书店吗？");
  assert.ok((await page.locator("#chatMessages").innerText()).length > 120);
  await setScroll("#chatMessages", 999999);
  await capture("chat-demo", "Fictional dialogue, emotional/intent labels and a copy-only reply draft");

  await page.locator("#navPersona").click();
  await page.waitForFunction(() => document.getElementById("personaView").classList.contains("active") &&
    document.getElementById("heroName").textContent !== "待读取" && document.getElementById("botSummaryText").textContent.trim().length > 30);
  assert.ok(await page.locator("#mbtiScalesList .mbti-scale-row").count() >= 4);
  await setScroll(".persona-dashboard");
  await capture("profile-demo", "Fictional personal portrait, MBTI tendency and interaction style");
  await selectChat(groupUser);
  await page.locator("#navPersona").click();
  await page.waitForFunction(() => document.getElementById("personaView").classList.contains("active") &&
    document.querySelector("#groupMemberTabs .member-picker-trigger") && document.getElementById("botSummaryText").textContent.trim().length > 30);
  await setScroll(".persona-dashboard");
  await page.locator("#groupMemberTabs .member-picker-trigger").click();
  assert.ok(await page.locator("#groupMemberTabs .member-option").count() >= 3);
  await page.locator("#groupMemberTabs .member-picker-trigger").click();
  await capture("group-profile-demo", "Fictional group portrait with unobstructed activity metrics and the actual member-selection control");

  await openSettings();
  await page.locator("#selectModelSource").selectOption("local");
  await page.waitForFunction(() => !document.getElementById("localModelSettings").hidden &&
    !/检测中|待读取/.test(document.getElementById("localModelStatus").textContent));
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById("workerLimitValue").textContent.trim()), null, { timeout: 30000 });
  await setScroll(".settings-content");
  await capture("local-model-demo", "Real local-model controls displaying synthetic ready/runtime information");
  await page.locator("#selectModelSource").selectOption("api");
  await page.locator("#selectApiProtocol").selectOption("chat_completions");
  await page.locator("#inputApiBaseUrl").fill("https://api.deepseek.com");
  await page.locator("#inputApiModelId").fill("deepseek-flash");
  await page.locator("#inputApiContextTokens").fill("1000000");
  assert.equal(await page.locator("#inputApiKey").inputValue(), "");
  await page.locator("#btnFetchApiModels").click();
  await page.waitForFunction(() => document.getElementById("selectApiModel").options.length > 1 && !document.getElementById("selectApiModel").disabled);
  await page.locator("#selectApiModel").selectOption("deepseek-flash");
  await page.locator("#btnTestApiModel").click();
  await page.waitForFunction(() => /连接成功|测试通过|测试成功/.test(document.getElementById("apiModelTestStatus").textContent), null, { timeout: 20000 });
  await page.locator("#apiModelSettings").scrollIntoViewIfNeeded();
  await capture("api-settings-demo", "Actual protocol, model discovery and API test controls connected only to the synthetic fixture");
  await page.locator("#btnManageAnalysisCache").click();
  await page.waitForFunction(() => document.querySelectorAll("#analysisCacheList .analysis-cache-card").length >= 2);
  await page.locator("#analysisCacheManager").scrollIntoViewIfNeeded();
  await capture("cache-demo", "Actual model-source cache manager with fictional local/API cache counts");
  passed("All seven original screenshots use real native interface routes and fictional rich data");

  await selectChat(personUser);
  await page.locator("#btnAISummary").click();
  await page.waitForFunction(() => !document.getElementById("btnAssistantSummary").disabled);
  const complete = () => page.waitForFunction(() => document.getElementById("assistantJobStatus").textContent.startsWith("生成完成"), null, { timeout: 20000 });
  await page.locator("#assistantSummaryRange").selectOption("all");
  await page.locator("#assistantSummaryInstructions").fill("梳理读书会的时间、地点、分工和未确认的事项。");
  await page.locator("#btnAssistantSummary").click(); await complete();
  assert.ok((await page.locator("#assistantResultText").textContent()).length > 100);
  await page.locator("#assistantResultSection").scrollIntoViewIfNeeded();
  await page.locator("#assistantResultActions").scrollIntoViewIfNeeded();
  await capture("ai-summary-demo", "Manual AI summary of the fictional complete conversation");
  const dates = await page.evaluate(({ from, to }) => {
    const local = ms => { const date = new Date(ms); const pad = value => String(value).padStart(2, "0");
      const text = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      return date.getSeconds() === 0 ? text.slice(0, 16) : text; };
    return { from: local(from), to: local(to) };
  }, { from: fixture.storyFromMs || Date.now() - 7 * 86400000, to: fixture.storyToMs || Date.now() });
  await page.locator("#assistantSummaryRange").selectOption("time");
  await page.locator("#assistantSummaryFrom").fill(dates.from);
  await page.locator("#assistantSummaryTo").fill(dates.to);
  await page.locator("#btnAssistantSummary").click(); await complete();
  await page.locator("#assistantResultSection").scrollIntoViewIfNeeded();
  await page.locator("#assistantResultActions").scrollIntoViewIfNeeded();
  await capture("ai-time-summary-demo", "Summary of a chosen fictional date range with the actual time controls");
  await page.locator("#assistantTabReply").click();
  await page.locator("#assistantRelationship").selectOption("friend");
  await page.locator("#assistantReplyInstructions").fill("我想确认周六下午两点的安排，语气自然友好，不催促对方。");
  await page.locator("#btnAssistantReply").click(); await complete();
  assert.ok((await page.locator("#assistantResultText").textContent()).length > 25);
  assert.equal(await page.locator("#btnAssistantInsert").textContent(), "放入回复草稿");
  await page.locator("#assistantResultSection").scrollIntoViewIfNeeded();
  await page.locator("#assistantResultActions").scrollIntoViewIfNeeded();
  await capture("ai-reply-demo", "Contextual reply draft with relationship, instructions, regenerate/copy/insert controls and no send action");
  await page.locator("#assistantTabSummary").click();
  await page.locator("#assistantSummaryPreset").selectOption("tasks");
  assert.equal(await page.locator("#assistantSummaryPreset option").count(), 7);
  assert.equal(await page.locator("#assistantRelationship option").count(), 6);
  await setScroll(".assistant-body");
  await page.locator("#btnAssistantSaveSummaryPrompt").scrollIntoViewIfNeeded();
  await capture("ai-assistant-settings-demo", "Actual summary prompt presets and editable prompt; model settings live in general settings");
  await page.locator("#btnCloseAssistant").click();
  passed("Four additional assistant screenshots show actual complete/time summaries, reply drafts and separate prompt presets");

  const final = await stats();
  assert.equal(final.synthetic, true); assert.equal(final.readmeDemo, true); assert.equal(final.remoteCalls, 0);
  assert.equal(record.shots.length, 11); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  record.remoteCalls = 0; record.consoleErrors = errors; record.externalRequests = externalRequests;
  record.nativeIpcRequests = nativeIpcRequests;
  record.fixture = { account: sessionData.account, personUser, groupUser, sessionCount: sessionData.sessions.length };
  fs.writeFileSync(path.join(output, "ui-verification.json"), JSON.stringify(record, null, 2));
  if (process.env.WECHATVIBE_SMOKE_KEEP_OPEN !== "1") {
    try { await page.locator('[data-window-action="close"]').click({ noWaitAfter: true }); }
    catch (error) { if (!/closed|disconnected/i.test(error.message)) throw error; }
  }
  await browser.close().catch(error => { if (!/closed|disconnected/i.test(error.message)) throw error; });
  console.log("README_NATIVE_SCREENSHOTS_SUCCESS");
})().catch(async error => {
  console.error(error.stack);
  if (failureDiagnostics) {
    const { output, page, ...diagnostics } = failureDiagnostics;
    console.error("README_CAPTURE_FAILURE " + JSON.stringify(diagnostics));
    fs.writeFileSync(path.join(output, "capture-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    await page.screenshot({ path: path.join(output, "capture-failed.png"), fullPage: false }).catch(() => {});
  }
  await connectedBrowser?.close().catch(() => {});
  process.exitCode = 1;
});
