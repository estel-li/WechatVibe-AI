const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
let connectedBrowser;

(async () => {
  const endpoint = process.env.WECHATVIBE_SMOKE_CDP;
  const output = process.env.WECHATVIBE_SMOKE_OUTPUT;
  const browser = await chromium.connectOverCDP(endpoint);
  connectedBrowser = browser;
  const pages = browser.contexts().flatMap(context => context.pages()).filter(page => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url()));
  assert.equal(pages.length, 1, "Exactly one owned synthetic WebView must be exposed");
  const page = pages[0];
  const fixture = await page.evaluate(() => fetch("/__smoke__").then(response => response.json()));
  assert.equal(fixture.synthetic, true, "Never run this test against real chat data");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForFunction(() => window.desktopHost && document.getElementById("startupOverlay").hidden);
  const record = { synthetic: true, executableSha256: process.env.WECHATVIBE_SMOKE_EXE_SHA256, checks: [] };
  const logo = Buffer.from(await (await fetch(new URL("/assets/wechatvibe-icon.png", page.url()))).arrayBuffer());
  record.logoSha256 = require("node:crypto").createHash("sha256").update(logo).digest("hex");
  if (process.env.WECHATVIBE_EXPECTED_LOGO_SHA256)
    assert.equal(record.logoSha256, process.env.WECHATVIBE_EXPECTED_LOGO_SHA256, "The native app must serve the selected logo");
  const passed = label => { record.checks.push(label); console.log("PASS " + label); };
  const screenshot = async name => {
    await page.waitForTimeout(400);
    return page.screenshot({ path: path.join(output, name + ".png") });
  };
  const metrics = await page.evaluate(() => ({
    frozen: Object.isFrozen(window.desktopHost), platform: window.desktopHost.platform,
    titlebarHeight: document.querySelector(".desktop-titlebar").getBoundingClientRect().height,
    methods: ["copyDraft", "chooseDataRoot", "chooseModelDirectory", "beginUpdate", "rollbackUpdate"].every(method => typeof window.desktopHost[method] === "function"),
    version: document.getElementById("aboutCurrentVersion").textContent,
  }));
  assert.equal(metrics.frozen, true); assert.equal(metrics.platform, "win32");
  assert.equal(metrics.methods, true); assert.equal(metrics.titlebarHeight, 36);
  assert.equal(await page.title(), "知意 AI · WechatVibe AI");
  assert.equal(await page.locator(".startup-brand strong").textContent(), "知意 AI");
  record.brand = { nameZh: "知意 AI", nameEn: "WechatVibe AI", title: await page.title() };
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  const originalUrl = page.url();
  await page.evaluate(() => { window.open("https://example.com/", "_blank"); });
  assert.equal(browser.contexts().flatMap(context => context.pages()).length, 1);
  await page.evaluate(() => { window.location.href = "https://example.com/"; });
  await page.waitForTimeout(100);
  assert.equal(page.url(), originalUrl);
  passed("Renderer has no Node require and native shell blocks external navigation/popups");
  passed("Native desktop bridge, bilingual Zhiyi / WechatVibe AI branding and original 36px titlebar");
  await screenshot("01-chat-empty-dark");
  await page.locator("#btnAddConversation").click();
  await page.locator("#btnAddAllConversations").click();
  await page.locator("#btnCloseSettings").click();
  await page.waitForFunction(() => document.querySelectorAll("#sessionList .session-item").length === 2);
  await page.locator("#sessionList .session-item").nth(1).click();
  assert.equal(await page.locator("#chatTitle").textContent(), "测试会话 B");
  await page.locator("#navPersona").click();
  await page.waitForFunction(() => document.getElementById("personaView").classList.contains("active"));
  await screenshot("02-persona-dark");
  await page.locator("#navChat").click();
  await page.waitForFunction(() => document.getElementById("chatView").classList.contains("active"));
  passed("Conversation selection, sidebar switching, chat and persona navigation");
  const renderer = await page.evaluate(() => {
    const saved = chatState.messages;
    const base = Array.from({ length: 80 }, (_, index) => ({ id: `synthetic-perf-${index}`,
      side: "other", kind: "text", text: `性能验证消息 ${index}`, time: 1_760_000_000_000 + index * 1000 }));
    const original = messageNode;
    let created = 0;
    messageNode = (...args) => { created++; return original(...args); };
    try {
      renderMessages(base);
      const first = new Map([...document.querySelectorAll("#chatMessages .msg-item")].map(node => [node.dataset.messageId, node]));
      created = 0;
      const next = [...base.slice(1), { ...base.at(-1), id: "synthetic-perf-80", text: "新增消息" }];
      const started = performance.now();
      renderMessages(next);
      const durationMs = performance.now() - started;
      const nodes = [...document.querySelectorAll("#chatMessages .msg-item")];
      const retained = nodes.filter(node => first.get(node.dataset.messageId) === node).length;
      const rollingCreated = created;
      created = 0;
      const corrected = next.map((value, index) => index === 20 ? { ...value, text: "修正后的消息" } : value);
      renderMessages(corrected);
      return { total: nodes.length, retained, rollingCreated, correctedCreated: created, durationMs };
    } finally { messageNode = original; renderMessages(saved); }
  });
  assert.equal(renderer.total, 80);
  assert.equal(renderer.retained, 79);
  assert.equal(renderer.rollingCreated, 1);
  assert.equal(renderer.correctedCreated, 1);
  record.rendererPerformance = renderer;
  passed("Rolling message windows retain 79 of 80 DOM rows; corrected text replaces only its row");
  const draft = "WechatVibe Tauri 2 synthetic clipboard verification";
  await page.locator("#chatInput").fill(draft);
  await page.locator("#btnSend").click();
  await page.waitForFunction(() => document.getElementById("toastMsg").textContent === "草稿已复制，未发送到微信");
  const clipboard = execFileSync(process.env.WECHATVIBE_SMOKE_PYTHON, [__dirname + "/verify-tauri-ui.py", "--assert-clipboard", draft], { encoding: "utf8" });
  assert.match(clipboard, /clipboard matched/);
  passed("Trusted UI gesture copies synthetic draft through native clipboard");
  await page.locator("#btnSettings").click();
  await page.waitForFunction(() => document.activeElement.id === "btnCloseSettings");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.locator("#settingsModal").evaluate(node => node.contains(document.activeElement)), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("settingsModal").classList.contains("show"));
  assert.equal(await page.evaluate(() => document.activeElement.id), "btnSettings");
  await page.locator("#btnSettings").click();
  await page.locator("#tabGeneral").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.getElementById("tabAbout").getAttribute("aria-selected") === "true");
  assert.equal(await page.locator("#aboutOwner").textContent(), "estel-li");
  assert.equal(await page.locator("#aboutOwner").getAttribute("href"), "https://github.com/estel-li");
  assert.equal(await page.locator("#aboutRepository").getAttribute("href"), "https://github.com/estel-li/WechatVibe-AI");
  assert.equal(await page.locator("#panelAbout").innerText().then(value => value.includes("tswawa9595")), false);
  await screenshot("06-about-owner-dark");
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => document.getElementById("tabGeneral").getAttribute("aria-selected") === "true");
  passed("Settings trap focus, restore the opener, support Escape and keyboard tabs, and display the owner's About page");
  await page.locator("#selectThemeMode").selectOption("light");
  await page.waitForFunction(() => document.body.classList.contains("theme-light"));
  assert.equal(await page.locator(".desktop-titlebar").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(237, 243, 247)");
  await screenshot("03-settings-light");
  await page.locator("#selectZoomLevel").selectOption("1.25");
  assert.ok(Math.abs(await page.locator(".desktop-titlebar").evaluate(node => node.getBoundingClientRect().height) - 36) < .1);
  await page.locator("#selectZoomLevel").selectOption("1.5");
  await page.setViewportSize({ width: 720, height: 520 });
  const modalBounds = await page.locator(".settings-modal-card").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(modalBounds.x >= 0 && modalBounds.y >= 0 && modalBounds.right <= modalBounds.width + 1 && modalBounds.bottom <= modalBounds.height + 1);
  record.smallViewport = modalBounds;
  await screenshot("07-settings-small-150-percent");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.detach();
  await page.locator("#selectZoomLevel").selectOption("1.0");
  await page.locator("#selectThemeMode").selectOption("dark");
  await page.waitForFunction(() => !document.body.classList.contains("theme-light"));
  passed("Light/dark theme and zoom preserve titlebar geometry");
  await page.locator('.settings-tab-btn[data-tab="about"]').click();
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  assert.equal(await page.locator("#aboutCurrentVersion").textContent(), "v" + expectedVersion);
  await page.locator("#btnAboutVersion").click();
  await page.waitForFunction(() => document.getElementById("updateModal").classList.contains("show"));
  await screenshot("04-about-update");
  await page.locator("#btnCloseUpdate").click();
  await page.locator('.settings-tab-btn[data-tab="general"]').click();
  await page.locator("#selectZoomLevel").selectOption("1.5");
  await page.setViewportSize({ width: 720, height: 520 });
  await page.locator('.settings-tab-btn[data-tab="about"]').click();
  await page.locator("#btnAboutVersion").click();
  const updateBounds = await page.locator(".update-modal-card").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(updateBounds.x >= 0 && updateBounds.y >= 0 && updateBounds.right <= updateBounds.width + 1 && updateBounds.bottom <= updateBounds.height + 1);
  record.smallUpdateViewport = updateBounds;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("updateModal").classList.contains("show"));
  assert.equal(await page.evaluate(() => document.activeElement.id), "btnAboutVersion");
  await page.locator('.settings-tab-btn[data-tab="general"]').click();
  await page.locator("#selectZoomLevel").selectOption("1.0");
  const resetMetrics = await page.context().newCDPSession(page);
  await resetMetrics.send("Emulation.clearDeviceMetricsOverride");
  await resetMetrics.detach();
  await page.locator('.settings-tab-btn[data-tab="about"]').click();
  await page.locator("#btnAboutVersion").click();
  await page.locator("#btnCloseUpdate").click();
  await page.locator('.settings-tab-btn[data-tab="general"]').click();
  passed("Native app version and existing software-update UI");
  if (process.env.WECHATVIBE_SMOKE_DIALOGS === "1") {
    await page.evaluate(() => { window.__smokeDirectoryResults = {}; });
    for (const [selector, command, method] of [["#btnBrowseDataRoot", "desktop_choose_data_root", "chooseDataRoot"], ["#btnChooseLocalModelDir", "desktop_choose_model_directory", "chooseModelDirectory"]]) {
      // Both Tauri's globals and desktopHost are immutable. Capture one genuine
      // button gesture in this fixture to observe the original native Promise.
      await page.evaluate(({ selector, command, method }) => {
        document.querySelector(selector).addEventListener("click", async event => {
          event.stopImmediatePropagation();
          const value = await window.desktopHost[method]();
          window.__smokeDirectoryResults[command] = { resolved: true, value };
        }, { capture: true, once: true });
      }, { selector, command, method });
      await page.locator(selector).click();
      console.log("NATIVE_DIALOG_CANCEL_REQUIRED " + command);
      await page.waitForFunction(command => window.__smokeDirectoryResults[command]?.resolved, command, { timeout: 120000 });
      assert.equal(await page.evaluate(command => window.__smokeDirectoryResults[command].value, command), null);
      passed(command + " opens native picker and cancellation returns null");
    }
  }
  await page.locator("#btnCloseSettings").click();
  await page.locator("#desktopMaximize").click();
  await page.waitForFunction(() => document.getElementById("desktopMaximize").getAttribute("aria-label") === "还原");
  assert.equal((await page.evaluate(() => window.__TAURI__.core.invoke("desktop_window_action", { action: "get-state" }))).maximized, true);
  await page.locator("#desktopMaximize").click();
  await page.waitForFunction(() => document.getElementById("desktopMaximize").getAttribute("aria-label") === "最大化");
  passed("Custom maximize and restore controls operate native window");
  await page.locator('[data-window-action="minimize"]').click({ noWaitAfter: true });
  const minimized = execFileSync(process.env.WECHATVIBE_SMOKE_PYTHON, [__dirname + "/verify-tauri-ui.py", "--assert-minimized"], { encoding: "utf8" });
  assert.match(minimized, /native window minimized/);
  execFileSync(process.env.WECHATVIBE_SMOKE_PYTHON, [__dirname + "/verify-tauri-ui.py", "--focus-instance"], { encoding: "utf8" });
  await page.waitForFunction(() => !document.hidden);
  passed("Custom minimize and second-instance restore/focus operate native window");
  await screenshot("05-chat-restored-dark");
  if (fixture.analysisModels) {
    assert.equal(fixture.remoteCalls, 0);
    await page.setViewportSize({width:1280,height:960});
    await page.locator("#btnSettings").click();
    await page.locator("#tabGeneral").click();
    await page.locator("#selectZoomLevel").selectOption("1.0");
    await page.locator("#btnCloseSettings").click();
    await page.locator("#chatInput").fill("好呀，那周六见！");
    const statsUrl = new URL(fixture.analysisStatsUrl);
    assert.equal(statsUrl.protocol, "http:"); assert.equal(statsUrl.hostname, "127.0.0.1");
    const analysisStats = async () => (await fetch(statsUrl)).json();
    await page.locator('#sessionList .session-item[data-id="synthetic-a"]').click();
    await page.waitForFunction(() => chatState.currentUser === "synthetic-a" && !document.getElementById("selectAnalysisModel").disabled);
    assert.equal(await page.locator("#selectAnalysisModel").inputValue(), "local");
    await page.locator("#selectAnalysisModel").selectOption("api");
    await page.waitForFunction(() => settingsState.modelSourceSnapshot.mode === "api" && document.querySelectorAll("#chatMessages .inline-intent-row").length > 0);
    assert.match(await page.locator("#chatMessages").innerText(), /邀约/);
    assert.match(await page.locator("#analysisModelStatus").textContent(), /synthetic-model/);
    await screenshot("12-quick-llm-intent");
    passed("Chat quick selection activates the saved LLM and displays real HTTP/Python/Node/SDK intent results");
    await page.locator("#navPersona").click();
    await page.waitForFunction(() => document.getElementById("apiPortraitStatus").textContent === "API 画像已更新", null, {timeout:30000});
    assert.match(await page.locator("#portraitSourceBadge").textContent(), /synthetic-model/);
    assert.match(await page.locator("#botSummaryText").textContent(), /已分析1条/);
    await screenshot("13-quick-llm-portrait");
    const initial = await analysisStats();
    assert.ok(initial.insightRequests >= 1 && initial.portraitRequests >= 1); assert.equal(initial.remoteCalls,0);
    passed("The selected LLM also generates the real native portrait with shared scoring and actual message evidence");
    await page.locator("#selectAnalysisModel").selectOption("local");
    await page.waitForFunction(() => settingsState.modelSourceSnapshot.mode === "local" && !document.getElementById("selectAnalysisModel").disabled);
    assert.equal(await page.locator("#portraitSourceBadge").textContent(), "本地 Laya");
    assert.equal(await page.locator("#apiPortraitStatus").isHidden(), true);
    await page.locator("#selectAnalysisModel").selectOption("api");
    await page.waitForFunction(() => settingsState.modelSourceSnapshot.mode === "api" && document.getElementById("apiPortraitStatus").textContent === "API 画像已更新");
    const restored = await analysisStats();
    assert.equal(restored.insightRequests, initial.insightRequests);
    assert.equal(restored.portraitRequests, initial.portraitRequests);
    record.analysisModels = {synthetic:true, remoteCalls:0, insightRequests:initial.insightRequests,
      portraitRequests:initial.portraitRequests, sourceScopedCacheRestored:true};
    passed("Local/LLM round trips synchronize both views and restore cached analysis without new model requests");
    await page.locator("#btnAnalysisModelSettings").click();
    await page.waitForFunction(() => document.getElementById("settingsModal").classList.contains("show"));
    assert.equal(await page.locator("#selectModelSource").inputValue(), "api");
    assert.equal(await page.locator("#apiModelSettings").isVisible(), true);
    for (const [preset, baseUrl] of Object.entries({deepseek:"https://api.deepseek.com", minimax:"https://api.minimax.cn/v1",
      zhipu:"https://open.bigmodel.cn/api/paas/v4", kimi:"https://api.moonshot.cn/v1", siliconflow:"https://api.siliconflow.cn/v1"})) {
      await page.locator("#inputApiKey").fill("synthetic-unsaved-key");
      await page.locator("#selectApiPreset").selectOption(preset);
      assert.equal(await page.locator("#inputApiBaseUrl").inputValue(), baseUrl);
      assert.equal(await page.locator("#selectApiProtocol").inputValue(), "chat_completions");
      assert.equal(await page.locator("#inputApiContextTokens").inputValue(), "1000000");
      assert.equal(await page.locator("#inputApiKey").inputValue(), "");
      assert.equal(await page.locator("#inputApiModelId").inputValue(), "");
    }
    record.analysisModels.servicePresets = ["deepseek", "minimax", "zhipu", "kimi", "siliconflow"];
    record.analysisModels.defaultContextTokens = 1000000;
    passed("All five service presets set official Base URLs and a 1M default while clearing unsaved credentials");
    await page.locator("#btnCloseSettings").click();
    await page.setViewportSize({width:720,height:520});
    const layout = await page.locator(".analysis-model-bar").evaluate(node => ({
      right:node.getBoundingClientRect().right, width:innerWidth,
      overflow:document.documentElement.scrollWidth > innerWidth,
      paneBottom:document.querySelector("#personaView").getBoundingClientRect().bottom,height:innerHeight,
    }));
    assert.ok(layout.right<=layout.width+1 && layout.paneBottom<=layout.height+1); assert.equal(layout.overflow,false);
    passed("Analysis configuration opens from either view and the shared selector fits a small native window");
    await page.setViewportSize({width:1280,height:960});
  }
  if (process.env.WECHATVIBE_SMOKE_AI_FIXTURE) {
    const fixtureInfo = JSON.parse(process.env.WECHATVIBE_SMOKE_AI_FIXTURE);
    assert.equal(fixtureInfo.status, "READY");
    const stats = async () => (await fetch(fixtureInfo.statsUrl)).json();
    const setDelay = async delayMs => fetch(fixtureInfo.assistantUrl + "/__fixture__/delay", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delayMs }) });
    const completed = async () => page.waitForFunction(() =>
      document.getElementById("assistantJobStatus").textContent.startsWith("生成完成"), null, { timeout: 120000 });
    const quickRanges = async kind => {
      for (const [shortcut, hours] of [["LastDay", 24], ["LastWeek", 168], ["LastMonth", null]]) {
        const before = Date.now();
        await page.locator(`#btnAssistant${kind}${shortcut}`).click();
        const after = Date.now();
        const selected = await page.evaluate(kind => ({
          range: document.getElementById(`assistant${kind}Range`).value,
          from: document.getElementById(`assistant${kind}From`).value,
          to: document.getElementById(`assistant${kind}To`).value,
          pressed: [...document.querySelectorAll(`#assistant${kind}Panel .assistant-time-shortcuts button`)]
            .filter(button => button.getAttribute("aria-pressed") === "true").length,
        }), kind);
        assert.equal(selected.range, "time");
        assert.equal(selected.pressed, 1);
        assert.match(selected.from, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/);
        const end = new Date(selected.to).getTime();
        const start = new Date(selected.from).getTime();
        assert.ok(end >= before - 1000 && end <= after, "Quick range uses the click time at second precision");
        if (hours) assert.equal(end - start, hours * 3600000);
        else {
          const date = new Date(end), day = date.getDate();
          date.setDate(1); date.setMonth(date.getMonth() - 1);
          const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
          date.setDate(Math.min(day, lastDay));
          assert.equal(start, date.getTime());
        }
      }
    };
    if (await page.locator("#settingsModal").evaluate(node => node.classList.contains("show"))) await page.locator("#btnCloseSettings").click();
    await page.locator("#sessionList .session-item").first().click();
    assert.equal(await page.locator("#btnToolbarPersona").evaluate(node => node.nextElementSibling.id), "btnAISummary");
    assert.equal(await page.locator("#btnAISummary").evaluate(node => node.nextElementSibling.id), "btnAIReply");
    await page.locator("#btnAISummary").click();
    await page.waitForFunction(() => !document.getElementById("btnAssistantSummary").disabled);
    await quickRanges("Summary");
    const beforeAll = (await stats()).requestCount;
    const truncation = await fetch(fixtureInfo.assistantUrl + "/__fixture__/truncate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }) });
    assert.equal(truncation.status, 200);
    await page.locator("#assistantSummaryRange").selectOption("all");
    await page.locator("#btnAssistantSummary").click(); await completed();
    const allRequests = (await stats()).requests.slice(beforeAll);
    assert.equal(allRequests[0].truncated, true);
    assert.equal(allRequests[1].truncated, false);
    assert.deepEqual(allRequests[1].sourceIds, allRequests[0].sourceIds);
    assert.ok(allRequests[1].maxOutputTokens > allRequests[0].maxOutputTokens);
    const allIds = allRequests.filter(row => !row.truncated && (row.phase === "map" || row.phase === "summary")).flatMap(row => row.sourceIds);
    assert.equal(allIds.length, fixtureInfo.expectedAllCount);
    assert.equal(new Set(allIds).size, fixtureInfo.expectedAllCount);
    assert.match(await page.locator("#assistantJobStatus").textContent(), /1305 条消息/);
    assert.ok(allRequests.some(row => row.hasEarliestMarker));
    await screenshot("08-assistant-all-summary");
    passed("Native AI summary sends all 1305 history messages including unseen earliest records to the real HTTP/Python/Node stack");
    passed("Native first-map output truncation recovers once using the complete original batch without missing or duplicating history");
    const dates = await page.evaluate(({ from, to }) => {
      const local = ms => { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
      return { from: local(from), to: local(to) };
    }, { from: fixtureInfo.fromMs, to: fixtureInfo.toMs });
    await page.locator("#assistantSummaryRange").selectOption("time");
    await page.locator("#assistantSummaryFrom").fill(dates.from);
    await page.locator("#assistantSummaryTo").fill(dates.to);
    const beforeTime = (await stats()).requestCount;
    await page.locator("#btnAssistantSummary").click(); await completed();
    const timeIds = (await stats()).requests.slice(beforeTime).filter(row => row.phase === "map" || row.phase === "summary").flatMap(row => row.sourceIds);
    assert.equal(timeIds.length, fixtureInfo.expectedTimeCount);
    assert.match(await page.locator("#assistantJobStatus").textContent(), /10 条消息/);
    await screenshot("09-assistant-time-summary");
    passed("Native AI summary applies exact inclusive start/end time to 10 selected messages");
    await page.locator("#assistantTabReply").click();
    await quickRanges("Reply");
    passed("Native summary and reply shortcuts select the last day, week and calendar month with second precision");
    await page.locator("#assistantReplyRange").selectOption("recent");
    const beforeRelations = (await stats()).requestCount;
    for (const relationship of ["friend", "close_friend", "colleague", "relative", "elder"]) {
      await page.locator("#assistantRelationship").selectOption(relationship);
      await page.locator("#btnAssistantReply").click(); await completed();
    }
    const relationshipNames = new Set((await stats()).requests.slice(beforeRelations).flatMap(row => row.relationships));
    for (const label of ["普通朋友", "亲密朋友", "同事", "亲戚", "长辈"]) assert.ok(relationshipNames.has(label));
    passed("All five relationship presets reach actual generation with their distinct system prompts");
    await page.locator("#assistantRelationship").selectOption("custom");
    await page.locator("#assistantReplyPrompt").fill("CUSTOM_PROMPT：自定义关系，语气友好，回复简短，不添加承诺。");
    await page.locator("#assistantReplyInstructions").fill("USER_INSTRUCTION：换一种自然的说法。");
    await page.locator("#btnAssistantReply").click(); await completed();
    const firstDraft = await page.locator("#assistantResultText").textContent();
    await page.locator("#btnAssistantRegenerate").click(); await completed();
    const nextDraft = await page.locator("#assistantResultText").textContent();
    assert.notEqual(nextDraft, firstDraft);
    assert.ok((await stats()).requests.some(row => row.regenerated && row.customPrompt && row.instructionsPresent));
    await screenshot("10-assistant-custom-reply");
    await page.locator("#btnAssistantCopy").click();
    await page.waitForFunction(() => document.getElementById("assistantJobStatus").textContent === "结果已复制。");
    execFileSync(process.env.WECHATVIBE_SMOKE_PYTHON, [__dirname + "/verify-tauri-ui.py", "--assert-clipboard", nextDraft], { encoding: "utf8" });
    await page.locator("#btnAssistantInsert").click();
    assert.equal(await page.locator("#chatInput").inputValue(), nextDraft);
    assert.equal(await page.locator("#assistantModal").evaluate(node => node.hidden), true);
    passed("Custom prompt, user instruction and regeneration work; native clipboard and draft insertion never send a WeChat message");
    await setDelay(4000);
    await page.locator("#btnAISummary").click();
    await page.locator("#btnAssistantSummary").click();
    await page.locator("#btnAssistantCancel").waitFor({ state: "visible" });
    await page.locator("#btnAssistantCancel").click();
    await page.waitForFunction(() => document.getElementById("assistantJobStatus").textContent.startsWith("已停止生成"));
    await page.locator("#btnAssistantSummary").click();
    await page.locator("#btnAssistantCancel").waitFor({ state: "visible" });
    await page.evaluate(() => switchSession("synthetic-b"));
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("#assistantResultText").textContent(), "");
    await page.locator("#btnCloseAssistant").click(); await setDelay(0);
    passed("Native cancel and actual app conversation switching discard obsolete AI work/results");
    await page.locator("#btnSettings").click();
    await page.locator("#selectZoomLevel").selectOption("1.5");
    await page.locator("#btnCloseSettings").click();
    await page.setViewportSize({ width: 720, height: 520 });
    await page.locator("#btnAIReply").click();
    await page.waitForFunction(() => !document.getElementById("btnAssistantReply").disabled);
    assert.equal(await page.locator("[data-assistant-tab]").count(), 2);
    assert.equal(await page.locator("#assistantSettingsPanel, #assistantApiKey, #assistantModel").count(), 0);
    const bounds = await page.locator(".assistant-card").evaluate(node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}; });
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#assistantModal").evaluate(node => node.contains(document.activeElement)), true);
    assert.equal(await page.locator("#assistantRelationship option").count(), 6);
    assert.equal(await page.locator("#assistantRelationship").inputValue(), "custom");
    const persistedCustomPrompt = await page.locator("#assistantReplyPrompt").inputValue();
    assert.match(persistedCustomPrompt, /CUSTOM_PROMPT/);
    await page.locator("#btnAssistantSaveReplyPrompt").click();
    await page.waitForFunction(() => document.getElementById("assistantReplyPromptStatus").textContent === "提示词已保存。");
    await page.locator("#assistantTabSummary").click();
    assert.equal(await page.locator("#assistantSummaryPreset option").count(), 7);
    const summaryIds = await page.locator("#assistantSummaryPreset option").evaluateAll(nodes => nodes.map(node => node.value));
    for (const id of summaryIds) {
      await page.locator("#assistantSummaryPreset").selectOption(id);
      assert.ok((await page.locator("#assistantSummaryPrompt").inputValue()).trim().length > 10);
    }
    await page.locator("#assistantSummaryPreset").selectOption("tasks");
    const persistedSummaryPrompt = "VERIFY_PERSISTED_SUMMARY_PROMPT：保留事实、时间与待办，不编造信息。";
    await page.locator("#assistantSummaryPrompt").fill(persistedSummaryPrompt);
    await page.locator("#btnAssistantSaveSummaryPrompt").click();
    await page.waitForFunction(() => document.getElementById("assistantSummaryPromptStatus").textContent === "提示词已保存。");
    const persistedSettings = await (await fetch(fixtureInfo.assistantUrl + "/api/assistant/settings")).json();
    assert.equal(persistedSettings.summaryPreset, "tasks");
    assert.equal(persistedSettings.summaryPrompts.tasks, persistedSummaryPrompt);
    assert.equal(persistedSettings.summaryPrompt, persistedSummaryPrompt);
    assert.equal(persistedSettings.relationshipPrompts.custom, persistedCustomPrompt);
    assert.equal(persistedSettings.defaultRelationship, "custom");
    assert.equal(Object.hasOwn(persistedSettings, "apiKey"), false);
    await screenshot("11-assistant-small-settings");
    await page.locator("#btnAssistantGeneralSettings").click();
    assert.equal(await page.locator("#assistantModal").evaluate(node => node.hidden), true);
    assert.equal(await page.locator("#panelGeneral").evaluate(node => node.classList.contains("active")), true);
    const beforeConfig = await stats();
    await page.locator("#btnFetchApiModels").click();
    await page.waitForFunction(() => document.getElementById("apiModelCount").textContent === "1 个模型可用", null, { timeout: 60000 });
    assert.equal((await stats()).modelLists, beforeConfig.modelLists + 1);
    await page.locator("#btnTestApiModel").click();
    await page.waitForFunction(() => document.getElementById("apiModelTestStatus").textContent.startsWith("连接成功"), null, { timeout: 60000 });
    const probeRequests = (await stats()).requests.slice(beforeConfig.requestCount);
    assert.equal(probeRequests.length, 1); assert.equal(probeRequests[0].phase, "probe");
    assert.deepEqual(probeRequests[0].sourceIds, [], "Connection testing must never include conversation messages");
    await page.locator("#inputApiContextTokens").fill("8192");
    await page.locator("#btnActivateApi").click();
    await page.waitForFunction(() => document.getElementById("modelSourceStatus").textContent === "API 模型已启用");
    const shared = await (await fetch(fixtureInfo.assistantUrl + "/api/model-source")).json();
    const assistantShared = await (await fetch(fixtureInfo.assistantUrl + "/api/assistant/settings")).json();
    assert.equal(assistantShared.model, shared.api.model); assert.equal(assistantShared.contextTokens, 8192);
    assert.equal(assistantShared.baseUrl, shared.api.baseUrl); assert.equal(shared.api.contextTokens, 8192);
    assert.equal((await stats()).remoteCalls, 0);
    passed("Native general settings discover/test/save the single API profile; seven summary and six reply prompts save independently");
    await page.locator("#selectZoomLevel").selectOption("1.0");
    await page.locator("#btnCloseSettings").click();
    const clear = await page.context().newCDPSession(page); await clear.send("Emulation.clearDeviceMetricsOverride"); await clear.detach();
    record.assistant = { allMessages: fixtureInfo.expectedAllCount, timeMessages: fixtureInfo.expectedTimeCount,
      relationshipPresets: 5, customPrompt: true, regeneration: true, clipboard: true, insertDraft: true,
      quickTimeRanges: ["day", "week", "month"],
      truncatedMapRecovery: true,
      summaryPresets: 7, replyPresets: 6, unifiedModelSettings: true, modelDiscovery: true, connectionTestSyntheticOnly: true, promptPersistence: true, cancelAndSwitch: true, smallViewport: bounds };
    passed("Assistant prompt panels and general model settings fit 720x520 at 150 percent zoom with consistent focus");
  }
  const final = await page.evaluate(() => fetch("/__smoke__").then(response => response.json()));
  assert.equal(final.analysisRequests, 0, "Smoke test must never start any analysis");
  assert.deepEqual(errors, []);
  record.analysisRequests = final.analysisRequests;
  record.metrics = metrics;
  record.consoleErrors = errors;
  if (process.env.WECHATVIBE_SMOKE_CRASH === "1") {
    const stopped = await page.evaluate(async () => {
      window.__smokeErrors = [];
      window.addEventListener("wechatvibe-error", event => window.__smokeErrors.push(event.detail));
      return fetch("/__smoke__/exit-worker", { method: "POST" }).then(response => response.json());
    });
    assert.equal(stopped.synthetic, true);
    await page.waitForTimeout(800);
    await page.waitForFunction(() => document.getElementById("toastMsg").textContent.includes("本地桌面服务已退出"));
    const result = await page.evaluate(async () => {
      const start = performance.now();
      try { await window.desktopHost.getModelDownloadState(); return { rejected: false }; }
      catch { return { rejected: true, ms: performance.now() - start }; }
    });
    assert.equal(result.rejected, true);
    assert.ok(result.ms < 3000, "A dead worker must fail promptly instead of waiting 95 seconds");
    record.workerCrash = result;
    passed("Worker crash is reported and future RPC fails promptly; native close will run ownership-checked cleanup");
  }
  fs.writeFileSync(path.join(output, "ui-verification.json"), JSON.stringify(record, null, 2));
  if (process.env.WECHATVIBE_SMOKE_KEEP_OPEN !== "1") {
    try { await page.locator('[data-window-action="close"]').click({ noWaitAfter: true }); }
    catch (error) { if (!/closed|disconnected/i.test(error.message)) throw error; }
  }
  await browser.close().catch(error => { if (!/closed|disconnected/i.test(error.message)) throw error; });
  console.log("TAURI_UI_SMOKE_SUCCESS");
})().catch(async error => {
  console.error(error.stack);
  await connectedBrowser?.close().catch(() => {});
  process.exitCode = 1;
});
