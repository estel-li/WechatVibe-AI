"use strict";
// Compare the old per-call date formatter with the actual UI's shared formatter.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "chatui/app.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("const time ="), source.indexOf("function toast(")) + "\nglobalThis.format = time;", context);
const before = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  const date = new Date(number);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
};
const samples = Array.from({ length: 2000 }, (_, index) => 1_760_000_000_000 + index * 60_000);
for (const sample of samples.slice(0, 20)) assert.equal(context.format(sample), before(sample));
const measure = formatter => {
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const start = performance.now();
    for (const value of samples) formatter(value);
    rounds.push(performance.now() - start);
  }
  return rounds.sort((a, b) => a - b)[1];
};
const oldMs = measure(before), currentMs = measure(context.format);
const result = { synthetic: true, workload: "2000 conversation/message timestamps; median of three rounds",
  runtime: process.version, beforeMs: Number(oldMs.toFixed(2)), afterMs: Number(currentMs.toFixed(2)),
  speedup: Number((oldMs / currentMs).toFixed(2)), localeOutputUnchanged: true };
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
