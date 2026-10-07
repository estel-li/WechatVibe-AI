const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../chatui/app.js"), "utf8");
const code = source.slice(source.indexOf("const time ="), source.indexOf("function toast("));
test("the shared date formatter retains locale output and rejects invalid epochs", () => {
  const context = vm.createContext({});
  vm.runInContext(code + "\nglobalThis.format = time;", context);
  for (const value of [0, -1, NaN, Infinity, "not a date"]) assert.equal(context.format(value), "");
  for (const epoch of [1700000000000, 1725000000000, 1760000000000, "1760000000000"])
    assert.equal(context.format(epoch), new Date(Number(epoch)).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
});
