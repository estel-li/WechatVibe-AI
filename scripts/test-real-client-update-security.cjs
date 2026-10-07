"use strict";

// Synthetic signed Release, archive and install root. No user data or network.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const source = path.join(__dirname, "real-client-update.cjs");
const extractor = path.join(__dirname, "real-client-update-extract.py");
const builder = path.join(__dirname, "build-update-manifest.cjs");
const releaseBase = "https://github.com/tswawa/WechatVibe/releases";
const version = "1.0.2";
const archiveName = "WechatVibe-tauri2-" + version + "-windows-x64.zip";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function removeTree(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
}

function makeZip(filename) {
  const code = [
    "import json,sys,zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:",
    " z.writestr('tauri2-portable/WechatVibe.exe', b'MZsynthetic')",
    " z.writestr('tauri2-portable/client/package.json', json.dumps({'name':'wechatvibe-tauri2-runtime','desktopFramework':'tauri2','version':'1.0.2'}))",
    " for relative in ('client/scripts/tauri-host.cjs', 'client/runtime/python/python.exe',",
    "                  'client/runtime/node/node.exe', 'client/scripts/start-real-client.py',",
    "                  'client/scripts/real-client-update-helper.cjs',",
    "                  'client/scripts/real-client-update-extract.py',",
    "                  'client/scripts/update-signing.pub', 'client/bridge/chat_server.py',",
    "                  'client/chatui/index.html', 'client/.models/laya/model.onnx'):",
    "  z.writestr('tauri2-portable/' + relative, b'synthetic')",
  ].join("\n");
  execFileSync("python", ["-c", code, filename]);
}

function fixture(archiveBytes, privateKey) {
  const manifest = {
    schema: 1, product: "WechatVibe-tauri2", version, platform: "win32", arch: "x64",
    layout: "tauri2-portable", dataSchema: "real-client-v1",
    archive: { name: archiveName, size: archiveBytes.length, sha256: sha256(archiveBytes) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const signature = crypto.sign(null, manifestBytes, privateKey);
  const sums = Buffer.from([
    sha256(archiveBytes) + "  " + archiveName,
    sha256(manifestBytes) + "  update-manifest-tauri2.json",
    sha256(signature) + "  update-manifest-tauri2.sig",
  ].join("\n") + "\n");
  const bodies = new Map([
    ["update-manifest-tauri2.json", manifestBytes], ["update-manifest-tauri2.sig", signature],
    [archiveName, archiveBytes], ["SHA256SUMS-tauri2.txt", sums],
  ]);
  const tag = "v" + version;
  const assets = [...bodies].map(([name, bytes]) => ({
    name, size: bytes.length, state: "uploaded", digest: "sha256:" + sha256(bytes),
    browser_download_url: releaseBase + "/download/" + tag + "/" + name,
  }));
  const release = { tag_name: tag, html_url: releaseBase + "/tag/" + tag,
    draft: false, prerelease: false, assets };
  return { manifest, manifestBytes, signature, bodies, release };
}

function fakeFetch(data, changeResponse) {
  return async (url, options) => {
    if (url === "https://api.github.com/repos/tswawa/WechatVibe/releases/latest") {
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify(data.release));
    }
    assert.equal(options.redirect, "manual");
    const name = url.split("/").at(-1);
    if (changeResponse) {
      const changed = changeResponse(name, url);
      if (changed) return changed;
    }
    const bytes = data.bodies.get(name);
    assert.ok(bytes, "unexpected asset request");
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wechatvibe-update-test-"));
  try {
    // Loading an isolated copy exercises the real discovery path with a synthetic key.
    const moduleDir = path.join(temp, "module");
    fs.mkdirSync(moduleDir);
    fs.copyFileSync(source, path.join(moduleDir, "real-client-update.cjs"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(path.join(moduleDir, "update-signing.pub"),
      publicKey.export({ type: "spki", format: "pem" }));
    const updater = require(path.join(moduleDir, "real-client-update.cjs"));
    const zipPath = path.join(temp, archiveName);
    makeZip(zipPath);
    const zip = fs.readFileSync(zipPath);
    const data = fixture(zip, privateKey);
    const installRoot = path.join(temp, "installed");
    fs.mkdirSync(installRoot);

    assert.equal((await updater.checkForUpdates("1.0.1",
      { fetchImpl: fakeFetch(data) })).status, "available");
    assert.deepEqual(updater.verifySignedManifest(data.manifestBytes, data.signature,
      version, data.release.assets.find(item => item.name === archiveName), publicKey), data.manifest);
    for (const legacyFields of [{ product: "WechatVibe" }, { layout: "win-unpacked" }]) {
      const legacy = Buffer.from(JSON.stringify({ ...data.manifest, ...legacyFields }));
      const signedLegacy = crypto.sign(null, legacy, privateKey);
      assert.throws(() => updater.verifySignedManifest(legacy, signedLegacy, version,
        data.release.assets.find(item => item.name === archiveName), publicKey), /does not match release/);
    }
    assert.equal((await updater.checkForUpdates("1.0.1",
      { fetchImpl: fakeFetch(data, name => name === "update-manifest-tauri2.json" ?
        new Response(null, { status: 302, headers: { location: "https://evil.example/manifest" } }) : null) }
    )).status, "invalid-release");

    const damaged = fixture(zip, privateKey);
    damaged.signature = Buffer.alloc(64);
    damaged.bodies.set("update-manifest-tauri2.sig", damaged.signature);
    damaged.release.assets.find(item => item.name === "update-manifest-tauri2.sig").digest =
      "sha256:" + sha256(damaged.signature);
    damaged.bodies.set("SHA256SUMS-tauri2.txt", Buffer.from([
      sha256(zip) + "  " + archiveName,
      sha256(damaged.manifestBytes) + "  update-manifest-tauri2.json",
      sha256(damaged.signature) + "  update-manifest-tauri2.sig",
    ].join("\n") + "\n"));
    const sumsAsset = damaged.release.assets.find(item => item.name === "SHA256SUMS-tauri2.txt");
    sumsAsset.size = damaged.bodies.get("SHA256SUMS-tauri2.txt").length;
    sumsAsset.digest = "sha256:" + sha256(damaged.bodies.get("SHA256SUMS-tauri2.txt"));
    assert.equal((await updater.checkForUpdates("1.0.1",
      { fetchImpl: fakeFetch(damaged) })).status, "invalid-release");

    const phases = [];
    const staged = await updater.downloadAndStageUpdate("1.0.1", installRoot,
      progress => phases.push(progress.phase),
      { fetchImpl: fakeFetch(data), pythonExe: "python", extractorPath: extractor });
    assert.equal(staged.expectedVersion, version);
    assert.equal(path.dirname(staged.workDir), temp);
    assert.equal(staged.candidatePath, path.join(staged.workDir, "tauri2-portable"));
    assert.ok(fs.statSync(path.join(staged.candidatePath, "WechatVibe.exe")).isFile());
    assert.deepEqual([...new Set(phases)], ["downloading", "verifying", "extracting"]);
    removeTree(staged.workDir);
    assert.deepEqual(fs.readdirSync(temp).filter(name => name.startsWith(".wechatvibe-update-")), [],
      "staged workDir=" + staged.workDir);

    await assert.rejects(updater.downloadAndStageUpdate("1.0.1", installRoot, null,
      { fetchImpl: fakeFetch(data, name => name === archiveName ?
        new Response(Buffer.from("tampered")) : null),
        pythonExe: "python", extractorPath: extractor }), /archive digest or size mismatch/);
    assert.deepEqual(fs.readdirSync(temp).filter(name => name.startsWith(".wechatvibe-update-")), []);
    assert.ok(fs.statSync(installRoot).isDirectory());

    const built = require(builder);
    assert.equal((await built.buildManifest(version, zipPath)).archive.sha256, sha256(zip));
    assert.equal(built.stableVersion("1.0.2-preview.1"), false);
    const noKeyEnv = { ...process.env };
    delete noKeyEnv.WECHATVIBE_UPDATE_SIGNING_KEY_FILE;
    const unsigned = spawnSync(process.execPath, [builder, "--version", version,
      "--archive", zipPath, "--output-dir", temp], { env: noKeyEnv, encoding: "utf8" });
    assert.equal(unsigned.status, 1);
    assert.match(unsigned.stderr, /WECHATVIBE_UPDATE_SIGNING_KEY_FILE is required/);
    assert.equal(fs.existsSync(path.join(temp, "update-manifest-tauri2.sig")), false);
    process.stdout.write("real-client signed update checks passed\n");
  } finally {
    removeTree(temp);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
