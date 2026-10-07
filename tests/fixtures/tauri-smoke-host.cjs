/* Data-free UI fixture. Only scripts/verify-tauri-ui.py installs this as a host. */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");

const ui = path.resolve(process.env.WECHATVIBE_SMOKE_UI_DIR);
const appVersion = process.env.WECHATVIBE_APP_VERSION;
const account = "synthetic-ui-verification";
const readmeDemo = process.env.WECHATVIBE_README_SCREENSHOTS === "1";
const demo = readmeDemo ? createReadmeDemo() : null;
const sessions = demo?.sessions || [
  { username: "synthetic-a", name: "测试会话 A", preview: "合成消息，仅用于架构验证", unreadCount: 0, isGroup: false },
  { username: "synthetic-b", name: "测试会话 B", preview: "没有读取微信聊天记录", unreadCount: 0, isGroup: false },
];
const messages = user => demo ? demo.messages(user) : [{ id: user + "-1", side: "other", kind: "text", text: "合成消息，仅用于架构验证", sender: "测试对象", time: 1_760_000_000_000 }];
let selectedSessions = demo ? ["synthetic-a", "synthetic-b", "synthetic-group@chatroom", "synthetic-family@chatroom"] : [], analysisRequests = 0;
const send = (response, data, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__smoke__") return send(response, { synthetic: true, analysisRequests,
    ...(demo ? { readmeDemo: true, remoteCalls: 0, personUser: "synthetic-a", groupUser: "synthetic-group@chatroom",
      storyFromMs: Date.parse("2026-10-07T09:00:00+08:00"), storyToMs: Date.parse("2026-10-07T10:00:00+08:00"),
      expectedSessionCount: sessions.length, historyCount: demo.history("synthetic-a").length } : {}) });
  if (url.pathname === "/__smoke__/exit-worker" && request.method === "POST") {
    send(response, { synthetic: true });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    let data = "";
    for await (const chunk of request) data += chunk;
    if (demo) {
      let body;
      try { body = data ? JSON.parse(data) : {}; }
      catch { return send(response, { error: "invalid-synthetic-request" }, 400); }
      const result = demo.handle(url, request.method, body);
      return send(response, result.data, result.status || 200);
    }
    if (url.pathname.startsWith("/api/assistant/") && process.env.WECHATVIBE_SMOKE_ASSISTANT_URL) {
      const target = new URL(process.env.WECHATVIBE_SMOKE_ASSISTANT_URL);
      if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password)
        return send(response, { error: "invalid-synthetic-assistant" }, 503);
      target.pathname = url.pathname; target.search = url.search;
      try {
        const actual = await fetch(target, { method: request.method,
          headers: { "Content-Type": "application/json" },
          ...(request.method === "POST" ? { body: data } : {}) });
        return send(response, await actual.json(), actual.status);
      } catch { return send(response, { error: "synthetic-assistant-unavailable" }, 503); }
    }
    const body = data ? JSON.parse(data) : {};
    switch (url.pathname) {
      case "/api/health": return send(response, { ok: true, version: "real-ui-1", data: { state: "ready", account }, model: { state: "missing" } });
      case "/api/sessions": return send(response, { account, self: { username: "synthetic-self", name: "测试" }, sessions, messagesReady: true });
      case "/api/conversation-selection":
        if (request.method === "POST") selectedSessions = body.all ? sessions.map(value => value.username) :
          body.selected ? [...new Set([...selectedSessions, body.session])] : selectedSessions.filter(value => value !== body.session);
        return send(response, { account, selectedSessions });
      case "/api/messages/batch": return send(response, { account, windows: body.users.map(user => ({ user, messages: messages(user), hasMoreBefore: false })) });
      case "/api/messages": return send(response, { account, messages: messages(url.searchParams.get("user")), hasMoreBefore: false });
      case "/api/model-source": return send(response, { mode: "local", sourceId: "local:laya", state: "active", api: null });
      case "/api/local-model": return send(response, { state: "missing", source: "none", path: "" });
      case "/api/runtime": return send(response, { requestedProvider: "cpu", modelProvider: null, status: "missing" });
      case "/api/data-root": return send(response, { path: "", state: "unset", accounts: 0 });
      case "/api/accounts": return send(response, { currentAccount: account, accounts: [] });
      case "/api/analysis-overview": return send(response, { account, sessions: [], activeWorkers: 0, totalWorkers: 1 });
      case "/api/analysis-workers": return send(response, { workers: 1, elastic: false, maxWorkers: 1 });
      case "/api/profile": return send(response, { account, profile: null });
      default:
        if (request.method === "POST") analysisRequests++;
        return send(response, { error: "synthetic-verification-denies-analysis" }, 503);
    }
  }
  const filename = path.resolve(ui, decodeURIComponent(url.pathname.slice(1)) || "index.html");
  if (!filename.startsWith(ui + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile())
    return send(response, { error: "not-found" }, 404);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
  response.writeHead(200, { "Content-Type": types[path.extname(filename)] || "application/octet-stream" });
  fs.createReadStream(filename).pipe(response);
});
const ready = new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const input = readline.createInterface({ input: process.stdin });
input.on("line", async line => {
  const { id, cmd } = JSON.parse(line);
  let result;
  switch (cmd) {
    case "start":
      await ready;
      result = { version: "real-ui-1", instanceId: crypto.randomBytes(32).toString("hex"), url: `http://127.0.0.1:${server.address().port}/` };
      break;
    case "model-download-state": result = { phase: "idle" }; break;
    case "check-updates": result = { status: "current", currentVersion: appVersion }; break;
    case "update-state": result = { phase: "idle", currentVersion: appVersion }; break;
    case "report-ui-ready": result = true; break;
    case "shutdown":
      process.stdout.write(JSON.stringify({ id, result: { stopped: true } }) + "\n");
      server.close(() => process.exit(0));
      input.close();
      return;
    default: result = { phase: "blocked" };
  }
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
});
input.on("close", () => server.close(() => process.exit(0)));

function createReadmeDemo() {
  // This opt-in fixture renders the production UI with invented conversations.
  // It has no reader, model process or network connector, and stores no API key.
  const emptyAvatar = { avatar: "", avatarCandidates: [] };
  const demoSessions = [
    { username: "synthetic-a", name: "林若晴", preview: "那周六两点在书店门口碰面？我有点期待了。", unreadCount: 2, isGroup: false },
    { username: "synthetic-b", name: "许安", preview: "我先把体验稿发你，明天一起确认。", unreadCount: 0, isGroup: false },
    { username: "synthetic-group@chatroom", name: "山海计划·周末小组", preview: "周六两点见，记得带上喜欢的书。", unreadCount: 5, isGroup: true },
    { username: "synthetic-family@chatroom", name: "家人的小客厅", preview: "周末回来吃饭，我们给你留了汤。", unreadCount: 0, isGroup: true },
    { username: "synthetic-c", name: "周屿", preview: "这周的小目标完成啦，周末一起散步。", unreadCount: 0, isGroup: false },
    { username: "synthetic-d", name: "温知夏", preview: "新书很好看，下次借给你。", unreadCount: 0, isGroup: false },
    { username: "synthetic-e", name: "产品设计讨论", preview: "收到，我们下午继续讨论交互细节。", unreadCount: 0, isGroup: false },
  ].map((item, index) => ({ ...item, ...emptyAvatar, time: Date.parse("2026-10-07T09:43:00+08:00") - index * 600000 }));
  const contacts = new Map(demoSessions.map(item => [item.username, item]));
  const groupMembers = [
    { id: "synthetic-a", name: "林若晴" }, { id: "synthetic-b", name: "许安" },
    { id: "synthetic-c", name: "周屿" }, { id: "synthetic-d", name: "温知夏" },
    { id: "synthetic-self", name: "我" }, { id: "synthetic-f", name: "陆遥" },
    { id: "synthetic-g", name: "沈一诺" },
  ].map(item => ({ ...item, ...emptyAvatar }));
  const personalStory = [
    ["other", "这周终于忙完了，周末想找个安静的地方读书，你有推荐吗？", "期待", "ask_question"],
    ["self", "河边那家书店很舒服，二楼能看到树。要不要一起去？", "开心", "invite"],
    ["other", "好呀！我一直想去，刚好可以带上那本没读完的小说。", "开心", "agree"],
    ["self", "那我们慢慢读，读累了再去附近散步。", "轻松", "plan"],
    ["other", "听起来很治愈。最近有点累，想把节奏放慢一点。", "疲惫", "share_feeling"],
    ["self", "不用安排太满，周末就留点时间给自己。", "关心", "give_comfort"],
    ["other", "谢谢你，总能把事情说得很轻松。", "温暖", "thank"],
    ["self", "我们先把见面的时间定下来，其他的随心就好。", "平静", "plan"],
    ["other", "早呀，我看了周末天气，周六会有阳光。", "开心", "share_news"],
    ["self", "太好了，书店下午人少些，我们两点见怎么样？", "期待", "invite"],
    ["other", "两点刚好，我上午可以先把手头的事收尾。", "轻松", "agree"],
    ["self", "我带相机，你带书，我们顺便记录一下周末。", "期待", "plan"],
    ["other", "好喜欢这个安排，比赶着打卡自在多了。", "开心", "praise"],
    ["self", "对了，你喜欢喝什么？我提前看看店里的菜单。", "关心", "ask_question"],
    ["other", "一杯热拿铁就好，不用特意准备，我们慢慢来。", "温暖", "inform"],
    ["other", "那周六两点在书店门口碰面？我有点期待了。", "期待", "invite"],
  ];
  const histories = new Map();
  function makeMessage(user, index, side, text, time, emotion = "平静", intent = "inform", senderId) {
    const sender = senderId || (side === "self" ? "synthetic-self" : user);
    return { id: `${user}-demo-${index}`, side, kind: "text", text, time,
      senderId: sender, senderName: sender === "synthetic-self" ? "我" :
        contacts.get(sender)?.name || groupMembers.find(item => item.id === sender)?.name || "家人",
      senderAvatar: "", senderAvatarCandidates: [], _demoEmotion: emotion, _demoIntent: intent };
  }
  for (const session of demoSessions) {
    const total = session.username === "synthetic-a" ? 1305 : session.isGroup ? 1848 : 368;
    const rows = Array.from({ length: total - (session.username === "synthetic-a" ? personalStory.length : 5) }, (_, index) => makeMessage(
      session.username, index, index % 2 ? "self" : "other", "周末的读书、散步和生活小事，我们慢慢聊。",
      Date.parse("2026-10-06T08:00:00+08:00") + index * 20000));
    const story = session.username === "synthetic-a" ? personalStory : session.isGroup ? [
      ["other", "这周末的读书小聚，我们就定在河边书店吧。", "期待", "plan"],
      ["other", "我可以提前过去占位置，大家带一本想分享的书。", "开心", "offer_help"],
      ["self", "我来整理一下时间和路线，晚上发到群里。", "平静", "plan"],
      ["other", "天气很好，读完书还可以沿河走一走。", "开心", "suggest_action"],
      ["other", "周六两点见，记得带上喜欢的书。", "期待", "invite"],
    ] : [
      ["other", "今天的体验稿我又整理了一版，你有空帮我看看吗？", "认真", "seek_help"],
      ["self", "可以，我下午看完，重点确认流程和文字表达。", "平静", "offer_help"],
      ["other", "谢谢，按钮文案和反馈状态是这次最想确认的。", "感谢", "thank"],
      ["self", "我会把建议集中写出来，明天一起过一遍。", "认真", "plan"],
      ["other", "我先把体验稿发你，明天一起确认。", "轻松", "plan"],
    ];
    rows.splice(total - story.length);
    story.forEach((entry, index) => rows.push(makeMessage(session.username, rows.length,
      entry[0], entry[1], Date.parse(index < 8 ? "2026-10-06T19:15:00+08:00" : "2026-10-07T09:15:00+08:00") +
      (index < 8 ? index : index - 8) * 240000, entry[2], entry[3], session.isGroup ?
        entry[0] === "self" ? "synthetic-self" : groupMembers.filter(item => item.id !== "synthetic-self")[index % 6].id : undefined)));
    histories.set(session.username, rows);
  }
  const history = user => histories.get(user) || [];
  const visibleMessages = user => history(user).slice(user === "synthetic-a" ? -16 : -5)
    .map(({ _demoEmotion, _demoIntent, ...item }) => item);
  const resultFor = item => ({ state: "done", labelSchema: "generic-v9", messageId: item.id,
    emotion: [{ label: item._demoEmotion, probability: .92 }],
    intent: [{ label: item._demoIntent, rawLabel: item._demoIntent, probability: .94 }],
    intentBroad: [{ label: "交流", rawLabel: "general_exchange", probability: .9 }], score: .58 });
  const analysis = user => ({ account, analysisVersion: "synthetic-readme-v1", modelState: "ready", modelProvider: "cpu",
    results: Object.fromEntries(history(user).slice(-80).map(item => [item.id, resultFor(item)])),
    job: { id: "demo-analysis", status: "done", processed: history(user).length, total: history(user).length,
      checkpointComplete: true, phase: "incremental", analysisUnit: "batch" },
    affinity: user.includes("@chatroom") ? null : 78, affinityCount: 642,
    mood: { label: "期待", rawLabel: "excitement", kaomoji: "(๑˃̵ᴗ˂̵)و", sampleCount: 642, scope: "analyzed-history" },
    analysisUnit: "batch", performance: { messagesPerSecond: 14.6, totalMs: 89400 } });
  function profile(user, member) {
    const group = user.includes("@chatroom"), total = history(user).length;
    const person = member ? groupMembers.find(item => item.id === member) : contacts.get(user);
    const target = group && !member ? total : member ? 214 : Math.floor(total / 2);
    const values = group ? [76, 69, 82, 71, 86, 66] : [74, 68, 84, 72, 88, 76];
    const traitNames = [["socialEnergy", "表达活力"], ["humor", "幽默表达"], ["composure", "情绪平和"],
      ["initiative", "话题主动"], ["care", "关怀支持"], ["affection", "亲近表达"]];
    return { account, username: member || user, name: person?.name || user, ...emptyAvatar,
      isGroup: group, members: group ? groupMembers : [],
      stats: { messageCount: target, textCount: target, analyzedCount: target, participantCount: group ? 7 : 1 },
      affinity: group ? null : 78, mood: analysis(user).mood, mbti: "ENFJ",
      mbtiInference: { type: "ENFJ", eligibleMessages: target, minMessages: 100, minAxisMargin: .2,
        axes: { EI: { leftShare: .73, rightShare: .27, evidenceCount: 182 },
          SN: { leftShare: .35, rightShare: .65, evidenceCount: 167 },
          TF: { leftShare: .24, rightShare: .76, evidenceCount: 194 },
          JP: { leftShare: .69, rightShare: .31, evidenceCount: 173 } }, sources: [] },
      traits: traitNames.map(([key, label], index) => ({ key, label, val: values[index] })), traitsBasis: "chat-behaviour",
      keywords: ["周末", "读书", "一起", "散步", "书店", "分享"].map((word, index) => ({ word, count: 63 - index * 7 })),
      summary: group ? "群聊以读书与周末活动为主，成员愿意分享和协作。约定表达清楚，讨论氛围轻松，常通过具体安排把想法推进成行动。" :
        "倾向主动分享生活与感受，表达温和，愿意回应关心与邀请。聊天中重视相处的节奏和共同体验，安排事情时会照顾双方的时间与感受。",
      suggestions: [], dataStatus: "analyzed", job: { status: "done", checkpointComplete: true }, analysisUnit: "batch" };
  }
  let modelMode = "local";
  const publicApi = { protocol: "chat_completions", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", contextTokens: 1000000, hasKey: true };
  const prompts = {
    friend: "语气自然友好，尊重彼此边界，结合最后的表达给出简洁、可直接发送的回复。",
    close_friend: "语气熟悉、真诚、有温度，先接住对方情绪，再回应具体事情，不默认恋爱关系。",
    colleague: "礼貌、清晰、专业但不生硬，先回应工作事项，确认行动和时间，不替我作未确认的承诺。",
    relative: "语气亲切有礼，照顾家庭关系和双方感受，保持合理边界。",
    elder: "尊重、耐心、亲切，用清楚朴实的语言回应关心和问题，保持自己的意愿。",
    custom: "结合给定上下文和我的表达习惯，按照补充的关系、语气和要求生成自然得体的回复。",
  };
  let assistantSettings = { ...publicApi, preset: "deepseek", ready: true, contextUpgradeAvailable: false,
    summaryPrompt: "整理全部所选对话的主要话题、关键约定和待办，保留时间与条件，不编造事实。",
    relationshipPrompts: prompts, defaultRelationship: "friend" };
  const assistantJobs = new Map();
  const sourceSnapshot = () => ({ mode: modelMode, sourceId: modelMode === "api" ? "demo-deepseek" : "local:laya", status: "active", api: { ...publicApi } });
  function startAssistant(body) {
    const rows = history(body.user).filter(item => body.range !== "time" || body.fromMs <= item.time && item.time <= body.toMs);
    const selected = body.range === "recent" ? rows.slice(-80) : rows;
    const reply = body.previousReply ? "好呀，那就周六两点见！我带上相机，我们一起慢慢读书，再去河边走走。" :
      "好呀，周六两点在书店门口见。我带相机，你带书，我们慢慢读，读累了就去河边散散步。期待见到你～";
    const summary = body.range === "time" ?
      "10 月 7 日上午的对话总结\n\n约定：周六下午两点，在河边书店门口碰面。\n准备：我带相机，若晴带小说；饮品选热拿铁。\n安排：先读书，天气合适时沿河散步。\n待办：确认营业时间与路线，结束时间尚未约定。" :
      "和林若晴的聊天总结\n\n话题：工作后的疲惫、放慢生活节奏，以及周末读书。\n约定：周六下午两点，在河边书店门口碰面。\n准备：若晴带小说，我带相机；读累后可以散步。\n沟通：双方回应自然，愿意分享感受，照顾彼此节奏。\n待办：确认营业时间与路线，散步时长尚未确定。";
    const id = crypto.randomBytes(16).toString("hex");
    const job = { id, account, user: body.user, kind: body.kind, range: body.range,
      relationship: body.relationship || "friend", status: "queued", text: "", error: null,
      progress: { phase: "reading", completed: 0, total: selected.length, messageCount: selected.length },
      messageCount: selected.length, scannedCount: rows.length, chunkCount: 1 };
    assistantJobs.set(id, job);
    setTimeout(() => { if (job.status === "queued") job.status = "reading"; }, 80);
    setTimeout(() => { if (job.status !== "cancelled") { job.status = "generating";
      job.progress = { phase: "generate", completed: 0, total: 1, messageCount: selected.length }; } }, 250);
    setTimeout(() => { if (job.status !== "cancelled") { job.status = selected.length ? "completed" : "failed";
      job.text = selected.length ? body.kind === "reply" ? reply : summary : "";
      job.error = selected.length ? null : { code: "empty-conversation", message: "演示范围没有消息。" };
      job.progress.completed = 1; } }, 650);
    return job;
  }
  const ok = data => ({ data });
  return { sessions: demoSessions, messages: visibleMessages, history,
    handle(url, method, body) {
      const user = body.user || url.searchParams.get("user") || "synthetic-a";
      switch (url.pathname) {
        case "/api/health": return ok({ ok: true, version: "real-ui-1", data: { state: "ready", account }, model: { state: "ready", provider: "cpu" } });
        case "/api/sessions": return ok({ account, self: { username: "synthetic-self", name: "知意演示 · 合成账号", ...emptyAvatar }, sessions: demoSessions, messagesReady: true });
        case "/api/conversation-selection":
          if (method === "POST") selectedSessions = body.all ? demoSessions.map(item => item.username) : body.selected ?
            [...new Set([...selectedSessions, body.session])] : selectedSessions.filter(item => item !== body.session);
          return ok({ account, initialized: true, selectedSessions });
        case "/api/messages/batch": return ok({ account, windows: (body.users || []).map(user => ({ user, messages: visibleMessages(user), hasMoreBefore: false })) });
        case "/api/messages": return ok({ account, messages: visibleMessages(user), hasMoreBefore: false });
        case "/api/analysis": return ok(analysis(user));
        case "/api/analyze": return ok({ job: analysis(user).job });
        case "/api/profile": return ok(profile(user, url.searchParams.get("member")));
        case "/api/model-source": return ok(sourceSnapshot());
        case "/api/model-source/list": return ok({ protocol: "chat_completions", baseUrl: publicApi.baseUrl, supported: true,
          models: [{ id: "deepseek-flash", contextTokens: 1000000 }, { id: "deepseek-v4-pro", contextTokens: 1000000 }] });
        case "/api/model-source/test": return ok({ ok: true, latencyMs: 186 });
        case "/api/model-source/activate": modelMode = body.mode === "local" ? "local" : "api"; return ok(sourceSnapshot());
        case "/api/model-source/clear-key": publicApi.hasKey = false; return ok(sourceSnapshot());
        case "/api/local-model": return ok({ state: "ready", source: "downloaded", path: "C:\\知意AI演示\\client\\.local\\models\\laya" });
        case "/api/runtime": return ok({ requestedProvider: "cpu", modelProvider: "cpu", status: "ready" });
        case "/api/data-root": return ok({ path: "", state: "unset", accounts: 1 });
        case "/api/accounts": return ok({ currentAccount: account, accounts: [{ account, name: "知意演示 · 合成账号", isCurrent: true, messageCount: 5217, cacheBytes: 17825792 }] });
        case "/api/analysis-overview": return ok({ account, conversations: selectedSessions.length, complete: selectedSessions.length, scanned: selectedSessions.length, analyzed: 5217, textTotal: 5217, running: null });
        case "/api/analysis-workers": return ok({ workers: 1, elastic: false, maxWorkers: 4, limit: 1 });
        case "/api/analysis-cache": return ok({ account, sources: [
          { sourceId: "local:laya", kind: "local", label: "本地 Laya", messageCount: 5217, portraitCount: 11, suspended: false },
          { sourceId: "demo-deepseek", kind: "api", label: "deepseek-flash", protocol: "chat_completions", messageCount: 862, portraitCount: 4, suspended: false }] });
        case "/api/analysis-cache/clear": return ok({ account, sourceId: body.sourceId, messageCount: 0, portraitCount: 0, suspended: true });
        case "/api/analysis-cache/resume": return ok({ account, sourceId: body.sourceId, suspended: false });
        case "/api/assistant/settings":
          if (method === "POST") { const { apiKey, clearKey, ...fields } = body;
            assistantSettings = { ...assistantSettings, ...fields, hasKey: clearKey ? false : assistantSettings.hasKey || !!apiKey }; }
          return ok(assistantSettings);
        case "/api/assistant/models": return ok({ protocol: "chat_completions", baseUrl: assistantSettings.baseUrl, supported: true,
          models: [{ id: "deepseek-flash", contextTokens: 1000000 }, { id: "deepseek-v4-pro", contextTokens: 1000000 }] });
        case "/api/assistant/test": return ok({ ok: true, latencyMs: 172 });
        case "/api/assistant/jobs":
          if (method === "POST") return ok(startAssistant(body));
          if (url.searchParams.get("account") !== account) return { status: 404, data: { error: "synthetic-job-not-found" } };
          return assistantJobs.has(url.searchParams.get("id")) ? ok(assistantJobs.get(url.searchParams.get("id"))) :
            { status: 404, data: { error: "synthetic-job-not-found" } };
        case "/api/assistant/cancel": {
          const job = body.account === account && assistantJobs.get(body.id);
          if (!job) return { status: 404, data: { error: "synthetic-job-not-found" } };
          job.status = "cancelled"; job.text = ""; return ok(job);
        }
        default: return { status: 503, data: { error: "readme-synthetic-endpoint-only" } };
      }
    },
  };
}
