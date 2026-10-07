/* Manual conversation helper. Its API settings are independent of automatic analysis. */
(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const modal = byId("assistantModal");
  if (!modal) return;
  const tabs = [...document.querySelectorAll("[data-assistant-tab]")];
  const fields = ["Preset", "Protocol", "BaseUrl", "ApiKey", "ClearKey", "Model", "ContextTokens"];
  let conversation = null, conversationRevision = 0, mode = "summary", config = null;
  let relationship = "friend", prompts = {}, connectionDirty = false, configBusy = false;
  let activeRun = null, result = null, returnFocus = null, configRevision = 0, configError = "", pendingSave = null;
  const requests = new Set();
  const aborted = error => error?.name === "AbortError";
  const safeError = error => String(error?.message || error || "请求失败，请稍后重试").replace(/sk-[\w-]{8,}/g, "[已隐藏 Key]").slice(0, 1000);

  async function request(path, body, controller = new AbortController(), keepAlive = false) {
    if (!keepAlive) requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data?.ok === false && data?.error) throw new Error(data?.message || data?.error?.message || data?.error || `请求失败（${response.status}）`);
      return data;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }

  function rememberPrompt() {
    if (relationship) prompts[relationship] = byId("assistantReplyPrompt").value;
  }
  function updateModelInfo() {
    const requiresKey = config?.preset === "deepseek" && !config.hasKey;
    byId("assistantModelInfo").textContent = !config ? configError || "正在读取模型配置…" : connectionDirty ?
      "模型配置已修改，请先保存配置，再生成。" : requiresKey ? "DeepSeek 官方服务尚未保存 API Key，请在“模型与提示词”中填写并保存。" : config.ready ?
        `当前模型：${config.model} · ${config.baseUrl} · ${config.hasKey ? "已保存 Key" : "未配置 Key（适用于无需认证的自定义服务）"}` : "请在“模型与提示词”中配置 API 和模型后再生成。";
    const ready = Boolean(conversation?.account && conversation?.user && config?.ready && !requiresKey && !connectionDirty && !configBusy && !activeRun);
    byId("btnAssistantSummary").disabled = !ready;
    byId("btnAssistantReply").disabled = !ready;
    byId("btnAssistantRegenerate").disabled = !ready;
    for (const id of ["btnAssistantModels", "btnAssistantTest", "btnAssistantSave"]) byId(id).disabled = configBusy;
    for (const field of fields) byId(`assistant${field}`).disabled = configBusy;
    for (const id of ["assistantSummaryPrompt", "assistantReplyPrompt", "assistantRelationship"]) byId(id).disabled = configBusy;
  }
  function draftConfig() {
    rememberPrompt();
    const value = {
      preset: byId("assistantPreset").value, protocol: byId("assistantProtocol").value,
      baseUrl: byId("assistantBaseUrl").value.trim(), model: byId("assistantModel").value.trim(),
      contextTokens: Number(byId("assistantContextTokens").value),
      summaryPrompt: byId("assistantSummaryPrompt").value, relationshipPrompts: { ...prompts }, defaultRelationship: relationship,
    };
    const apiKey = byId("assistantApiKey").value.trim();
    if (apiKey) value.apiKey = apiKey;
    if (byId("assistantClearKey").checked) value.clearKey = true;
    return value;
  }
  function applyConfig(value) {
    config = value;
    configError = "";
    prompts = { ...value.relationshipPrompts };
    relationship = value.defaultRelationship || "friend";
    byId("assistantRelationship").value = relationship;
    byId("assistantReplyPrompt").value = prompts[relationship] || "";
    byId("assistantPreset").value = value.preset || (value.baseUrl === "https://api.deepseek.com" ? "deepseek" : "custom");
    byId("assistantProtocol").value = value.protocol || "chat_completions";
    byId("assistantBaseUrl").value = value.baseUrl || "https://api.deepseek.com";
    byId("assistantModel").value = value.model || "deepseek-flash";
    byId("assistantContextTokens").value = value.contextTokens || 65536;
    byId("assistantSummaryPrompt").value = value.summaryPrompt || "";
    byId("assistantApiKey").value = "";
    byId("assistantApiKey").placeholder = value.hasKey ? "已保存 Key；留空保留（更换地址时请重新填写）" : "输入 API Key";
    byId("assistantClearKey").checked = false;
    connectionDirty = false;
    updateModelInfo();
  }
  async function loadConfig() {
    if (config || configBusy) return;
    const revision = ++configRevision;
    configError = "";
    configBusy = true; updateModelInfo();
    try {
      // An explicit save can commit after the modal closes. Read its final state before reopening for use.
      if (pendingSave) await pendingSave.catch(() => {});
      if (revision !== configRevision || modal.hidden) return;
      const value = await request("/api/assistant/settings");
      if (revision !== configRevision || modal.hidden) return;
      applyConfig(value);
      if (!value.ready || value.preset === "deepseek" && !value.hasKey) {
        selectTab("settings"); byId("assistantTabSettings").focus();
      }
    } catch (error) {
      if (revision === configRevision && !modal.hidden) {
        configError = aborted(error) ? "读取助手配置超时，请关闭后重试。" : `读取助手配置失败：${safeError(error)}`;
        byId("assistantModelInfo").textContent = configError;
        byId("assistantConfigStatus").textContent = "可填写配置并保存，或关闭后重新打开。";
        selectTab("settings");
      }
    } finally { if (revision === configRevision) { configBusy = false; updateModelInfo(); } }
  }

  const focusables = () => [...modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
    .filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest("[hidden]") && node.getClientRects().length);
  function selectTab(next) {
    if (next !== mode) stopRun();
    rememberPrompt();
    mode = next;
    for (const tab of tabs) {
      const selected = tab.dataset.assistantTab === next;
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
      byId(tab.getAttribute("aria-controls")).hidden = !selected;
    }
    renderResult(); updateModelInfo();
  }
  function open(next) {
    if (!["summary", "reply", "settings"].includes(next) || next !== "settings" && !conversation) return false;
    if (modal.hidden) { returnFocus = document.activeElement; modal.hidden = false; }
    selectTab(next);
    tabs.find(tab => tab.dataset.assistantTab === next)?.focus();
    void loadConfig();
    return true;
  }
  function close() {
    stopRun(); rememberPrompt();
    ++configRevision; configBusy = false;
    if (pendingSave) config = null;
    for (const controller of requests) controller.abort();
    byId("assistantApiKey").value = "";
    if (connectionDirty) byId("assistantConfigStatus").textContent = "模型配置尚未保存。请重新填写 Key 后保存。";
    modal.hidden = true;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function setConversation(value) {
    const next = value?.account && value?.user ? { account: String(value.account), user: String(value.user), name: String(value.name || value.user), isGroup: Boolean(value.isGroup) } : null;
    const changed = next?.account !== conversation?.account || next?.user !== conversation?.user;
    if (changed) { ++conversationRevision; stopRun(); result = null; }
    conversation = next;
    byId("assistantConversation").textContent = next ? `${next.isGroup ? "群聊 · " : ""}${next.name}` : "请选择一个会话";
    byId("btnAISummary").disabled = !next; byId("btnAIReply").disabled = !next;
    if (changed) {
      byId("assistantSummaryInstructions").value = "";
      byId("assistantReplyInstructions").value = "";
      renderResult();
      if (!modal.hidden) byId("assistantModelInfo").textContent = next ? "会话已切换，请确认新会话后重新生成。" : "当前会话已关闭。";
    }
    updateModelInfo();
  }

  function cancelRemote(run) {
    if (!run.id || run.cancelSent) return;
    run.cancelSent = true;
    // This control request deliberately outlives a closed modal or an aborted generation request.
    void fetch("/api/assistant/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: run.account, id: run.id }) }).catch(() => {});
  }
  function stopRun() {
    const run = activeRun;
    if (!run) return;
    activeRun = null; run.stopped = true;
    run.pollController?.abort(); clearTimeout(run.timer); run.wake?.();
    cancelRemote(run);
    if (result?.run === run) {
      result.status = "cancelled"; result.error = "已停止生成"; renderResult();
    }
    updateModelInfo();
  }
  const isCurrent = run => activeRun === run && !run.stopped && conversationRevision === run.revision && !modal.hidden;
  function rangePayload(kind) {
    const prefix = kind === "summary" ? "assistantSummary" : "assistantReply";
    const range = byId(`${prefix}Range`).value;
    if (range !== "time") return { range };
    const fromText = byId(`${prefix}From`).value, toText = byId(`${prefix}To`).value;
    const fromMs = new Date(fromText).getTime(), toMs = new Date(toText).getTime();
    if (!fromText || !toText || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs)
      throw new Error("请填写有效的开始和结束时间，结束时间不能早于开始时间。");
    return { range, fromMs, toMs };
  }
  function renderResult() {
    const show = result && (result.kind === mode);
    byId("assistantResultSection").hidden = !show;
    if (!show) {
      if (!result) { byId("assistantResultText").textContent = ""; byId("assistantJobStatus").textContent = ""; }
      return;
    }
    const completed = result.status === "completed";
    const busy = ["queued", "reading", "generating"].includes(result.status);
    const progress = result.progress || {};
    byId("assistantResultTitle").textContent = result.kind === "summary" ? "对话总结" : "回复草稿";
    const phases = { queued: "任务已创建…", reading: "正在读取所选对话…", generating: "正在生成…", completed: "生成完成", cancelled: "已停止生成", failed: "生成失败" };
    let status = phases[result.status] || "正在处理…";
    if (progress.messageCount != null) status += ` · ${progress.messageCount} 条消息`;
    if (progress.total > 1) status += ` · ${progress.completed || 0}/${progress.total} 段`;
    if (result.error) status += ` · ${safeError(result.error)}`;
    byId("assistantJobStatus").textContent = status;
    byId("assistantResultText").textContent = result.text || result.partialText || "";
    byId("btnAssistantCancel").hidden = !busy;
    byId("assistantProgress").hidden = !busy;
    if (progress.total > 0) { byId("assistantProgress").max = progress.total; byId("assistantProgress").value = progress.completed || 0; }
    else byId("assistantProgress").removeAttribute("value");
    byId("assistantResultActions").hidden = busy;
    byId("btnAssistantCopy").disabled = !completed || !result.text;
    byId("btnAssistantInsert").hidden = result.kind !== "reply";
    byId("btnAssistantInsert").disabled = !completed || !result.text;
    byId("btnAssistantRegenerate").textContent = result.status === "failed" ? "重试" : "重新生成";
  }
  async function generate(kind, regenerate = false) {
    if (!conversation || !config?.ready || config.preset === "deepseek" && !config.hasKey || connectionDirty || configBusy || activeRun) return;
    rememberPrompt();
    let range;
    const systemPrompt = kind === "reply" ? prompts[relationship] : byId("assistantSummaryPrompt").value;
    try {
      range = rangePayload(kind);
      if (!systemPrompt?.trim()) throw new Error(kind === "reply" ? "请填写关系提示词，说明回复的语气和边界。" : "请在“模型与提示词”中填写总结基本提示词。");
    }
    catch (error) {
      result = { kind, status: "failed", error: safeError(error) }; renderResult(); return;
    }
    const previousReply = regenerate && result?.kind === "reply" && result.status === "completed" ? result.text : undefined;
    const run = { revision: conversationRevision, account: conversation.account, stopped: false };
    activeRun = run;
    result = { run, kind, status: "queued", text: "" }; renderResult(); updateModelInfo();
    const payload = { account: conversation.account, user: conversation.user, kind, ...range,
      relationship, systemPrompt,
      instructions: byId(kind === "reply" ? "assistantReplyInstructions" : "assistantSummaryInstructions").value.trim(),
      ...(previousReply ? { previousReply } : {}) };
    try {
      // Keep creation alive until its ID arrives; cancellation can then stop the server task reliably.
      const job = await request("/api/assistant/jobs", payload, new AbortController(), true);
      run.id = job.id;
      if (!run.id) throw new Error("助手没有返回任务编号，请重试。");
      if (!isCurrent(run)) { cancelRemote(run); return; }
      let current = job;
      while (isCurrent(run)) {
        if (current.account !== run.account || current.user !== payload.user || current.kind !== kind)
          throw new Error("生成任务与当前会话不一致，已停止。请重新生成。");
        result = { ...current, run }; renderResult();
        if (["completed", "failed", "cancelled"].includes(current.status)) break;
        await new Promise(resolve => { run.wake = resolve; run.timer = setTimeout(resolve, 700); });
        run.wake = null;
        if (!isCurrent(run)) return;
        run.pollController = new AbortController();
        current = await request(`/api/assistant/jobs?account=${encodeURIComponent(run.account)}&id=${encodeURIComponent(run.id)}`, undefined, run.pollController);
      }
    } catch (error) {
      if (isCurrent(run)) { result = { kind, run, status: "failed", error: aborted(error) ? "请求超时，请重试。" : safeError(error) }; renderResult(); cancelRemote(run); }
    } finally {
      if (activeRun === run) { activeRun = null; updateModelInfo(); }
    }
  }

  async function configAction(action) {
    if (configBusy) return;
    const revision = ++configRevision;
    const completeDraft = draftConfig();
    const connectionKeys = action === "models" ? ["protocol", "baseUrl", "apiKey"] : ["protocol", "baseUrl", "apiKey", "model", "contextTokens"];
    const draft = action === "save" ? completeDraft : Object.fromEntries(
      connectionKeys.filter(key => key in completeDraft).map(key => [key, completeDraft[key]]));
    if (action !== "save" && completeDraft.clearKey) {
      byId("assistantConfigStatus").textContent = "请先保存清除 Key 的操作，再获取模型或测试。"; return;
    }
    if (action !== "models" && (!Number.isInteger(draft.contextTokens) || draft.contextTokens < 4096 || draft.contextTokens > 1000000)) {
      byId("assistantConfigStatus").textContent = "模型上下文长度须为 4096 至 1,000,000 的整数，请按服务支持的容量填写。"; return;
    }
    configBusy = true; updateModelInfo();
    const status = byId("assistantConfigStatus");
    status.textContent = action === "models" ? "正在获取模型列表…" : action === "test" ? "正在测试连接与模型…" : "正在保存…";
    let operation;
    try {
      operation = request(`/api/assistant/${action === "save" ? "settings" : action}`, draft, new AbortController(), action === "save");
      if (action === "save") pendingSave = operation;
      const value = await operation;
      if (revision !== configRevision || modal.hidden) return;
      if (action === "save") { applyConfig(value); status.textContent = "配置与关系提示词已保存。"; }
      else if (action === "models") {
        const options = byId("assistantModelOptions"); options.replaceChildren();
        const ids = (value.models || []).map(model => typeof model === "string" ? model : model.id).filter(Boolean);
        for (const id of ids) { const option = document.createElement("option"); option.value = id; options.appendChild(option); }
        status.textContent = ids.length ? `已获取 ${ids.length} 个模型。可从模型输入框选择，或手动填写。` : "服务未返回模型列表，可手动填写模型名称并测试。";
      } else status.textContent = value.ok ? `连接成功，模型可用${value.latencyMs ? ` · ${Math.round(value.latencyMs)} ms` : ""}。请保存配置后生成。` : `测试失败：${safeError(value.error || value.message)}`;
    } catch (error) {
      if (revision === configRevision && !modal.hidden) status.textContent = aborted(error) ? "请求超时，请重试。" : safeError(error);
    } finally {
      if (pendingSave === operation) pendingSave = null;
      if (revision === configRevision) { configBusy = false; updateModelInfo(); }
    }
  }
  async function copyResult() {
    if (!result?.text || result.status !== "completed") return;
    const text = result.text, revision = conversationRevision, originalResult = result;
    const button = byId("btnAssistantCopy"); button.disabled = true;
    const stillCurrent = () => revision === conversationRevision && result === originalResult && !modal.hidden;
    try {
      let copied = false;
      try { copied = await window.desktopHost?.copyDraft?.(text); } catch { /* Try the browser clipboard below. */ }
      if (!copied && !stillCurrent()) return;
      if (!copied && navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Some WebViews deny browser clipboard permissions. */ }
      }
      if (!copied && !stillCurrent()) return;
      if (!copied) {
        const field = document.createElement("textarea"); field.value = text; field.readOnly = true;
        field.style.position = "fixed"; field.style.left = "-9999px"; field.style.opacity = "0"; modal.appendChild(field);
        const before = document.activeElement; field.focus(); field.select();
        try { copied = document.execCommand("copy"); }
        finally { field.remove(); if (before?.isConnected && !modal.hidden) before.focus({ preventScroll: true }); }
      }
      if (!copied) throw new Error("复制失败，可手动选中结果复制。");
      if (revision === conversationRevision && result === originalResult && !modal.hidden) byId("assistantJobStatus").textContent = "结果已复制。";
    } catch (error) {
      if (revision === conversationRevision && result === originalResult && !modal.hidden) byId("assistantJobStatus").textContent = safeError(error);
    } finally { if (result === originalResult) button.disabled = false; }
  }
  function insertReply() {
    if (result?.kind !== "reply" || result.status !== "completed" || !result.text || !conversation) return;
    const input = byId("chatInput"); input.value = result.text; input.dispatchEvent(new Event("input", { bubbles: true }));
    close(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }

  byId("btnAISummary").addEventListener("click", () => open("summary"));
  byId("btnAIReply").addEventListener("click", () => open("reply"));
  byId("btnOpenAssistantSettings").addEventListener("click", () => open("settings"));
  byId("btnCloseAssistant").addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.assistantTab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab), next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.assistantTab); tabs[next].focus();
    });
  }
  document.addEventListener("keydown", event => {
    if (modal.hidden || event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === "Tab") {
      const nodes = focusables(), index = nodes.indexOf(document.activeElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === nodes.length - 1) {
        event.preventDefault(); (nodes[event.shiftKey ? nodes.length - 1 : 0] || modal).focus();
      }
    }
  }, true);
  document.addEventListener("focusin", event => { if (!modal.hidden && !modal.contains(event.target)) (focusables()[0] || modal).focus(); });
  for (const field of fields) byId(`assistant${field}`).addEventListener("input", () => {
    if (field === "ApiKey" && byId("assistantApiKey").value.trim()) byId("assistantClearKey").checked = false;
    if (field === "ClearKey" && byId("assistantClearKey").checked) byId("assistantApiKey").value = "";
    if (["Protocol", "BaseUrl"].includes(field)) {
      if (byId("assistantProtocol").value !== "chat_completions" || byId("assistantBaseUrl").value.replace(/\/$/, "") !== "https://api.deepseek.com") byId("assistantPreset").value = "custom";
      if (byId("assistantApiKey").value) {
        byId("assistantApiKey").value = "";
        byId("assistantConfigStatus").textContent = "服务地址或协议已更改，请填写对应服务的 API Key。";
      }
      byId("assistantModelOptions").replaceChildren();
    }
    connectionDirty = true; updateModelInfo();
  });
  byId("assistantPreset").addEventListener("change", () => {
    byId("assistantApiKey").value = ""; byId("assistantClearKey").checked = false;
    if (byId("assistantPreset").value === "deepseek") {
      byId("assistantProtocol").value = "chat_completions"; byId("assistantBaseUrl").value = "https://api.deepseek.com";
      byId("assistantModel").value = "deepseek-flash"; byId("assistantContextTokens").value = 65536;
    }
    connectionDirty = true; byId("assistantModelOptions").replaceChildren(); updateModelInfo();
  });
  byId("assistantRelationship").addEventListener("change", () => {
    rememberPrompt(); relationship = byId("assistantRelationship").value; byId("assistantReplyPrompt").value = prompts[relationship] || "";
  });
  for (const prefix of ["assistantSummary", "assistantReply"]) byId(`${prefix}Range`).addEventListener("change", () => { byId(`${prefix}Dates`).hidden = byId(`${prefix}Range`).value !== "time"; });
  byId("btnAssistantSummary").addEventListener("click", () => void generate("summary"));
  byId("btnAssistantReply").addEventListener("click", () => void generate("reply"));
  byId("btnAssistantRegenerate").addEventListener("click", () => void generate(mode, true));
  byId("btnAssistantCancel").addEventListener("click", stopRun);
  byId("btnAssistantCopy").addEventListener("click", () => void copyResult());
  byId("btnAssistantInsert").addEventListener("click", insertReply);
  for (const action of ["models", "test", "save"]) byId(`btnAssistant${action[0].toUpperCase()}${action.slice(1)}`).addEventListener("click", () => void configAction(action));
  window.addEventListener("pagehide", close);
  window.AIAssistant = Object.freeze({ setConversation, open });
})();
