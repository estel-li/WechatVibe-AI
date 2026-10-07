"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { createHost, validateLaunchResult, serve } = require("./tauri-host.cjs");

const launch = { version: "real-ui-1", url: "http://127.0.0.1:34567",
  instanceId: "a".repeat(64), created: true };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(root, overrides = {}) {
  const calls = { launcher: [], monitors: 0, drains: 0, close: 0, modelCancel: 0, events: [] };
  let recover;
  class FakeModel {
    constructor(options) { this.options = options; this.state = { phase: "idle" }; }
    getState() { return this.state; }
    async start() {
      this.state = { phase: "downloading" };
      this.options.onState(this.state);
      await delay(75);
      this.state = { phase: "ready" };
      this.options.onState(this.state);
      return this.state;
    }
    cancel() { calls.modelCancel++; }
  }
  const options = {
    root, env: { WECHATVIBE_APP_VERSION: "1.0.2", WECHATVIBE_PARENT_PID: "12345", WECHATVIBE_APP_PACKAGED: "1" },
    emit: (event, detail) => calls.events.push({ event, detail }),
    runLauncher: async (args, flags) => {
      calls.launcher.push({ args, flags });
      return args.includes("--no-open") ? { ...launch } : { stopped: true };
    },
    ModelDownload: FakeModel,
    createNetwork: () => ({ fetchImpl() { throw new Error("no live network in tests"); },
      enableSavedLoopbackFallback: async () => false, close: async () => { calls.close++; } }),
    monitorBridge: ({ onRecovered }) => {
      calls.monitors++;
      recover = onRecovered;
      return async () => { await delay(10); calls.drains++; };
    },
    createUpdateController: ({ parentPid, onState }) => {
      assert.equal(parentPid, 12345);
      let state = { phase: "idle" };
      return { getState: () => state,
        check: async () => { state = { phase: "available" }; onState(state); return state; },
        begin: async () => {
          state = { phase: "downloading" }; onState(state);
          await delay(75); state = { phase: "ready" }; onState(state); return state;
        }, rollback: async () => { state = { phase: "failed" }; return state; } };
    },
    ...overrides,
  };
  return { calls, options, host: createHost(options), recover: () => recover() };
}

async function main() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wechatvibe-tauri-host-")));
  try {
    const root = path.join(parent, "WechatVibe", "client");
    fs.mkdirSync(root, { recursive: true });
    for (const bad of [{ ...launch, url: "http://localhost:34567" }, { ...launch, url: "http://127.0.0.1:65536" },
      { ...launch, instanceId: "other" }, { ...launch, created: "true" }, { ...launch, version: "legacy" }]) {
      assert.throws(() => validateLaunchResult(bad));
    }
    const f = fixture(root);
    await assert.rejects(f.host.dispatch("model-download-state"), /未就绪/);
    assert.deepEqual(await Promise.all([f.host.dispatch("start"), f.host.dispatch("start")]), [launch, launch]);
    assert.equal(f.calls.launcher.length, 1, "concurrent starts reuse the same launcher invocation");
    assert.equal(f.calls.monitors, 1);
    assert.deepEqual(await f.host.dispatch("model-download-state"), { phase: "idle" });
    assert.deepEqual(await f.host.dispatch("model-download"), { phase: "downloading" });
    assert.equal(f.calls.events.at(-1).event, "wechatvibe-model-download-state");
    assert.deepEqual(await f.host.dispatch("check-updates"), { phase: "available" });
    assert.deepEqual(await f.host.dispatch("begin-update"), { phase: "downloading" }, "downloads do not hold an RPC request open");
    f.recover();
    assert.equal(f.calls.events.at(-1).event, "wechatvibe-service-restored");
    assert.equal(await f.host.dispatch("report-ui-ready"), true);
    await assert.rejects(f.host.dispatch("unknown"), /未知/);
    assert.deepEqual(await Promise.all([f.host.dispatch("shutdown"), f.host.dispatch("shutdown")]), [{ stopped: true }, { stopped: true }]);
    assert.equal(f.calls.launcher.length, 2, "one owned shutdown after draining pending recovery/downloads");
    assert.equal(f.calls.drains, 1);
    assert.equal(f.calls.close, 1);

    const development = fixture(root, { env: { WECHATVIBE_APP_VERSION: "1.0.2", WECHATVIBE_PARENT_PID: "12345",
      WECHATVIBE_APP_PACKAGED: "0" } });
    await development.host.dispatch("start");
    assert.deepEqual(await development.host.dispatch("check-updates"), { phase: "available" });
    const developmentEvents = development.calls.events.length;
    assert.deepEqual(await development.host.dispatch("begin-update"), { phase: "blocked" });
    assert.deepEqual(await development.host.dispatch("rollback-update"), { phase: "blocked" });
    assert.equal(development.calls.events.length, developmentEvents, "development updates do not stage/download/apply");
    await development.host.dispatch("shutdown");

    const reused = fixture(root, { runLauncher: async args => {
      reused.calls.launcher.push(args);
      return args.includes("--no-open") ? { ...launch, created: false } : { stopped: true };
    } });
    await reused.host.dispatch("start");
    await reused.host.dispatch("shutdown", { startupFailed: true });
    assert.equal(reused.calls.launcher.length, 1, "a failed UI does not stop a reused bridge");

    const failed = fixture(root, { createNetwork: () => { throw new Error("synthetic setup failure"); } });
    await assert.rejects(failed.host.dispatch("start"), /setup failure/);
    assert.equal(failed.calls.launcher.length, 2, "service setup failure reclaims a bridge it created");
    const failedReuse = fixture(root, { runLauncher: async () => ({ ...launch, created: false }),
      createNetwork: () => { throw new Error("synthetic setup failure"); } });
    await assert.rejects(failedReuse.host.dispatch("start"), /setup failure/);
    assert.equal(failedReuse.calls.launcher.length, 0, "reused service is preserved on startup failure");

    const workDir = path.join(parent, ".wechatvibe-update-test");
    fs.mkdirSync(workDir);
    const marker = path.join(workDir, "ui-ready-11111111-1111-4111-8111-111111111111.json");
    const validation = fixture(root, { env: { WECHATVIBE_APP_VERSION: "1.0.2", WECHATVIBE_UPDATE_VALIDATE: "1",
      WECHATVIBE_UPDATE_READY_FILE: marker, WECHATVIBE_UPDATE_READY_NONCE: "b".repeat(64) } });
    await validation.host.dispatch("start");
    assert.equal(validation.calls.monitors, 0);
    assert.equal(await validation.host.dispatch("report-ui-ready"), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { nonce: "b".repeat(64),
      expectedVersion: "1.0.2", instanceId: launch.instanceId });
    await validation.host.dispatch("shutdown");
    assert.equal(validation.calls.launcher.length, 1, "update helper controls the validation bridge");

    const finalMarker = path.join(workDir, "ui-final-ready-22222222-2222-4222-8222-222222222222.json");
    fs.writeFileSync(path.join(workDir, "journal.json"), JSON.stringify({ phase: "succeeded", guiStarted: true,
      expectedVersion: "1.0.2", installRoot: path.dirname(root) }));
    const final = fixture(root, { env: { WECHATVIBE_APP_VERSION: "1.0.2", WECHATVIBE_PARENT_PID: "12345",
      WECHATVIBE_UPDATE_FINAL_READY_FILE: finalMarker, WECHATVIBE_UPDATE_FINAL_READY_NONCE: "c".repeat(64) } });
    await final.host.dispatch("start");
    assert.equal(await final.host.dispatch("report-ui-ready"), true);
    await final.host.dispatch("shutdown");

    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    output.on("data", bytes => lines.push(...bytes.toString().trim().split("\n").map(line => JSON.parse(line))));
    const rpc = fixture(root);
    serve(input, output, rpc.options);
    input.write('{"id":1,"cmd":"start"}\n');
    input.write('not-json\n');
    input.write('{"id":2,"cmd":"invalid"}\n');
    await delay(20);
    assert.deepEqual(lines.find(line => line.id === 1).result, launch);
    assert.equal(typeof lines.find(line => line.id === null).error.message, "string");
    assert.equal(typeof lines.find(line => line.id === 2).error.message, "string");
    input.end();
    await delay(30);
    assert.equal(rpc.calls.launcher.length, 2, "closed RPC input reclaims the owned bridge");

    const realProtocol = spawnSync(process.execPath, [path.join(__dirname, "tauri-host.cjs")], {
      input: '{"id":7,"cmd":"shutdown"}\n', encoding: "utf8", windowsHide: true, timeout: 5000,
      env: { ...process.env, WECHATVIBE_APP_VERSION: "1.0.2", WECHATVIBE_CLIENT_ROOT: root },
    });
    assert.equal(realProtocol.status, 0, realProtocol.stderr);
    assert.deepEqual(JSON.parse(realProtocol.stdout.trim()), { id: 7, result: { stopped: false, alreadyStopped: true } });
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  process.stdout.write("Tauri host RPC, lifecycle, async tasks and readiness checks passed\n");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
