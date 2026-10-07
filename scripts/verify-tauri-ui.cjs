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
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  const originalUrl = page.url();
  await page.evaluate(() => { window.open("https://example.com/", "_blank"); });
  assert.equal(browser.contexts().flatMap(context => context.pages()).length, 1);
  await page.evaluate(() => { window.location.href = "https://example.com/"; });
  await page.waitForTimeout(100);
  assert.equal(page.url(), originalUrl);
  passed("Renderer has no Node require and native shell blocks external navigation/popups");
  passed("Native desktop bridge and original 36px titlebar");
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
  assert.equal(await page.locator("#aboutOwner").textContent(), "老李");
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
  assert.equal(await page.locator("#aboutCurrentVersion").textContent(), "v1.2.4");
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
