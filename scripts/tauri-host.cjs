"use strict";

// Node owns the existing Python/TypeScript services. The Tauri process owns all
// native UI and accepts only JSON messages from this private stdio channel.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { monitorBridge } = require("./real-client-recovery.cjs");
const { ModelDownload } = require("./real-client-model.cjs");
const { createUpdateController } = require("./real-client-update-controller.cjs");
const { checkForUpdates, downloadAndStageUpdate, errorStatus } = require("./real-client-update.cjs");
const { createUpdateProxyFetch } = require("./real-client-update-proxy.cjs");

function validateLaunchResult(value) {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value?.url || "");
  if (value?.version !== "real-ui-1" || !match || Number(match[1]) < 1 || Number(match[1]) > 65535 ||
      !/^[a-f0-9]{64}$/.test(value.instanceId || "") || typeof value.created !== "boolean") {
    throw new Error("本地分析服务返回了无效的启动状态");
  }
  return { ...value };
}

function createHost(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.root || env.WECHATVIBE_CLIENT_ROOT || path.join(__dirname, ".."));
  const bundledPython = path.join(root, "runtime", "python", "python.exe");
  const projectPython = path.join(root, ".venv", "Scripts", "python.exe");
  const python = env.WECHATVIBE_PYTHON || (fs.existsSync(bundledPython) ? bundledPython :
    fs.existsSync(projectPython) ? projectPython : "python");
  const bundledNode = path.join(root, "runtime", "node", "node.exe");
  const node = env.WECHATVIBE_NODE || (fs.existsSync(bundledNode) ? bundledNode : process.execPath);
  const serviceEnvironment = { ...env, WECHATVIBE_CLIENT_ROOT: root,
    WECHATVIBE_PYTHON: python, WECHATVIBE_NODE: node,
    PATH: path.dirname(node) + path.delimiter + (env.PATH || "") };
  const version = env.WECHATVIBE_APP_VERSION || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const emit = options.emit || (() => {});
  const validation = env.WECHATVIBE_UPDATE_VALIDATE === "1";
  const finalReady = !validation && typeof env.WECHATVIBE_UPDATE_FINAL_READY_FILE === "string" &&
    typeof env.WECHATVIBE_UPDATE_FINAL_READY_NONCE === "string";
  const background = new Set();
  const updateAbort = new AbortController();
  let launchResult = null;
  let startPromise = null;
  let shutdownPromise = null;
  let stopMonitor = null;
  let model = null;
  let controller = null;
  let network = null;
  let readyTimer = null;
  let closing = false;
  let handoff = "none";
  let created = false;
  let fallbackActive = false;

  function runLauncher(args, { startup = false } = {}) {
    if (options.runLauncher) return options.runLauncher(args, { startup });
    const environment = { ...serviceEnvironment };
    if (startup) delete environment.CHATUI_PORT;
    else if (launchResult) environment.CHATUI_PORT = String(new URL(launchResult.url).port);
    return new Promise((resolve, reject) => {
      execFile(python, [path.join(root, "scripts", "start-real-client.py"), ...args], {
        cwd: root, windowsHide: true, timeout: startup ? 60000 : 85000, maxBuffer: 65536,
        env: environment,
      }, (error, stdout) => {
        if (startup && /"created"\s*:\s*true/.test(String(stdout || ""))) created = true;
        if (error) return reject(new Error(startup ? "本地分析服务未就绪，请检查运行文件是否完整" :
          "本地分析服务未能安全关闭，请检查此安装目录的后台进程"));
        try { resolve(JSON.parse(stdout)); }
        catch (_) { reject(new Error("本地分析服务状态异常")); }
      });
    });
  }

  function startMonitor() {
    if (closing || validation || stopMonitor || !launchResult) return;
    stopMonitor = (options.monitorBridge || monitorBridge)({ root, url: launchResult.url, env: serviceEnvironment,
      instanceId: launchResult.instanceId, isOpen: () => !closing,
      onRecovered: () => emit("wechatvibe-service-restored", null) });
  }

  async function checkUpdates(currentVersion) {
    const settings = { fetchImpl: network.fetchImpl, signal: updateAbort.signal };
    const first = await checkForUpdates(currentVersion, settings);
    if (["offline", "timeout"].includes(first.status) && !updateAbort.signal.aborted &&
        !fallbackActive && await network.enableSavedLoopbackFallback()) {
      fallbackActive = true;
      return checkForUpdates(currentVersion, settings);
    }
    return first;
  }

  async function stageUpdate(currentVersion, installRoot, onProgress) {
    const settings = { fetchImpl: network.fetchImpl, signal: updateAbort.signal,
      pythonExe: python, extractorPath: path.join(root, "scripts", "real-client-update-extract.py") };
    try { return await downloadAndStageUpdate(currentVersion, installRoot, onProgress, settings); }
    catch (error) {
      if (!updateAbort.signal.aborted && !fallbackActive && ["offline", "timeout"].includes(errorStatus(error)) &&
          await network.enableSavedLoopbackFallback()) {
        fallbackActive = true;
        return downloadAndStageUpdate(currentVersion, installRoot, onProgress, settings);
      }
      throw error;
    }
  }

  function track(task) {
    const promise = Promise.resolve(task).catch(error => emit("wechatvibe-error", { message: error.message }))
      .finally(() => background.delete(promise));
    background.add(promise);
  }

  async function start() {
    if (closing) throw new Error("客户端正在退出");
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        const rawResult = await runLauncher(["--no-open", "--json"], { startup: true });
        created = rawResult?.created === true;
        launchResult = validateLaunchResult(rawResult);
        network = (options.createNetwork || createUpdateProxyFetch)();
        model = new (options.ModelDownload || ModelDownload)({ root, python, fetchImpl: network.fetchImpl,
          enableFallback: () => network.enableSavedLoopbackFallback(),
          onState: state => emit("wechatvibe-model-download-state", state) });
        if (!validation) {
          const parentPid = Number(env.WECHATVIBE_PARENT_PID || process.ppid);
          controller = (options.createUpdateController || createUpdateController)({
            app: { getVersion: () => version, isPackaged: env.WECHATVIBE_APP_PACKAGED === "1" },
            root, port: Number(new URL(launchResult.url).port), instanceId: launchResult.instanceId,
            parentPid: Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : process.pid,
            checkImpl: checkUpdates, stageImpl: stageUpdate,
            onState: state => emit("wechatvibe-update-state", state),
            pauseRecovery: async () => {
              handoff = "preparing";
              closing = true;
              model.cancel();
              const drain = stopMonitor?.();
              stopMonitor = null;
              await drain;
            },
            resumeRecovery: () => { handoff = "none"; closing = !!shutdownPromise; startMonitor(); },
            quit: () => { handoff = "ready"; emit("quit", { reason: "update" }); },
          });
          startMonitor();
        }
        if (validation || finalReady) {
          readyTimer = setTimeout(() => emit("quit", { reason: "update-readiness-timeout" }), validation ? 60000 : 90000);
          readyTimer.unref();
        }
        return { ...launchResult };
      } catch (error) {
        // A service reused by a failed launch belongs to the already open client.
        if (created) {
          try { await runLauncher(["--stop-owned-bridge", "--json"]); }
          catch (cleanupError) { emit("wechatvibe-error", { message: cleanupError.message }); }
        }
        throw error;
      }
    })();
    return startPromise;
  }

  async function reportUiReady() {
    if (!validation && !finalReady) return true;
    if (!launchResult || closing) return false;
    const file = validation ? env.WECHATVIBE_UPDATE_READY_FILE : env.WECHATVIBE_UPDATE_FINAL_READY_FILE;
    const nonce = validation ? env.WECHATVIBE_UPDATE_READY_NONCE : env.WECHATVIBE_UPDATE_FINAL_READY_NONCE;
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file ||
        typeof nonce !== "string" || !/^[a-f0-9]{32,64}$/.test(nonce)) return false;
    try {
      const installRoot = path.resolve(root, "..");
      const workDir = path.dirname(file);
      if (path.dirname(workDir).toLowerCase() !== path.dirname(installRoot).toLowerCase() ||
          !path.basename(workDir).startsWith(".wechatvibe-update-") ||
          !/^ui-(?:final-)?ready-[a-f0-9-]{20,80}\.json$/.test(path.basename(file)) ||
          fs.lstatSync(workDir).isSymbolicLink() ||
          fs.realpathSync.native(workDir).toLowerCase() !== workDir.toLowerCase()) return false;
      fs.writeFileSync(file, JSON.stringify({ nonce, expectedVersion: version,
        instanceId: launchResult.instanceId }), { flag: "wx", mode: 0o600 });
      if (validation) return true;
      const deadline = Date.now() + 60000;
      while (!closing && Date.now() < deadline) {
        try {
          const journalFile = path.join(workDir, "journal.json");
          const stat = fs.statSync(journalFile);
          if (stat.isFile() && stat.size < 32768) {
            const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
            if (journal.phase === "succeeded" && journal.guiStarted === true &&
                journal.expectedVersion === version &&
                path.resolve(journal.installRoot).toLowerCase() === installRoot.toLowerCase()) {
              clearTimeout(readyTimer);
              readyTimer = null;
              return true;
            }
            if (["failed", "rolled_back"].includes(journal.phase)) return false;
          }
        } catch (_) { /* The helper atomically replaces its journal. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (_) { /* An unsafe/mismatched marker must not release chat loading. */ }
    return false;
  }

  async function shutdown(args = {}) {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      clearTimeout(readyTimer);
      model?.cancel();
      updateAbort.abort();
      await Promise.resolve(stopMonitor?.()).catch(() => {});
      stopMonitor = null;
      await Promise.allSettled([...background]);
      let result = { stopped: false, alreadyStopped: true };
      if (launchResult && !validation && handoff !== "ready" && !(args.startupFailed && !created)) {
        result = await runLauncher(["--stop-owned-bridge", "--json"]);
        if (result?.stopped !== true && result?.alreadyStopped !== true) {
          throw new Error("本地分析服务未能安全关闭，请检查此安装目录的后台进程");
        }
      }
      await network?.close();
      return result;
    })();
    return shutdownPromise;
  }

  async function dispatch(cmd, args = {}) {
    if (cmd === "start") return start();
    if (cmd === "shutdown") return shutdown(args);
    if (cmd === "report-ui-ready") return reportUiReady();
    if (!launchResult || closing) throw new Error("本地分析服务尚未就绪");
    switch (cmd) {
      case "model-download-state": return model.getState();
      case "model-download":
        if (validation) return { phase: "blocked" };
        track(model.start());
        return model.getState();
      case "check-updates": return controller ? controller.check() : { status: "blocked" };
      case "update-state": return controller?.getState() || { phase: "idle", currentVersion: version };
      case "begin-update":
      case "rollback-update":
        if (!controller || env.WECHATVIBE_APP_PACKAGED !== "1") return { phase: "blocked" };
        track(cmd === "begin-update" ? controller.begin() : controller.rollback());
        return controller.getState();
      default: throw new Error("未知的桌面服务命令");
    }
  }
  return { dispatch };
}

function serve(input = process.stdin, output = process.stdout, options = {}) {
  const write = value => output.write(JSON.stringify(value) + "\n");
  const host = createHost({ ...options, emit: (event, detail) => write({ event, detail }) });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  reader.on("line", line => {
    let request;
    try {
      if (Buffer.byteLength(line) > 65536) throw new Error("桌面服务请求过大");
      request = JSON.parse(line);
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          !(typeof request.id === "string" || Number.isSafeInteger(request.id)) ||
          typeof request.cmd !== "string" || request.cmd.length > 80 ||
          (request.args !== undefined && (!request.args || typeof request.args !== "object" || Array.isArray(request.args)))) {
        throw new Error("桌面服务请求格式无效");
      }
    } catch (error) { write({ id: request?.id ?? null, error: { message: error.message } }); return; }
    Promise.resolve(host.dispatch(request.cmd, request.args)).then(result => write({ id: request.id, result }),
      error => write({ id: request.id, error: { message: error.message } }));
  });
  const close = () => host.dispatch("shutdown").catch(error => process.stderr.write(error.message + "\n"));
  reader.once("close", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  return { host, reader };
}

if (require.main === module) serve();
module.exports = { createHost, validateLaunchResult, serve };
