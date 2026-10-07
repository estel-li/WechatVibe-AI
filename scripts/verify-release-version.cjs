"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const packageMetadata = JSON.parse(read("package.json"));
const version = packageMetadata.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Stable release version required");
const lock = JSON.parse(read("package-lock.json"));
const cargo = read("src-tauri/Cargo.toml").match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLock = read("src-tauri/Cargo.lock").match(/\[\[package\]\]\s*name = "wechatvibe-tauri2"\s*version = "([^"]+)"/)?.[1];
for (const [name, actual] of Object.entries({ "package-lock.json": lock.version,
  "package-lock root": lock.packages?.[""]?.version, "Cargo.toml": cargo,
  "Cargo.lock": cargoLock, "tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version })) {
  if (actual !== version) throw new Error(`${name}: version ${actual} differs from ${version}`);
}
const readme = read("README.md");
if (!readme.includes(`当前公开发行版为 **${version}**`) ||
    !readme.includes(`/releases/download/v${version}/WechatVibe-tauri2-${version}-windows-x64.zip`) ||
    !readme.includes(`/releases/download/v${version}/WechatVibe-tauri2-${version}-windows-x64-setup.exe`)) {
  throw new Error("README current release and both download links must match package version");
}
if (!read("CHANGELOG.md").includes(`## ${version} — `) || !fs.existsSync(path.join(root, `docs/releases/${version}.md`))) {
  throw new Error("Current release notes and changelog are required");
}
console.log(`RELEASE_VERSION_VERIFIED (${version}, source + locks + downloads + notes)`);
