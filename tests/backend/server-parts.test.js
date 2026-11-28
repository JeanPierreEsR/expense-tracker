// Where a request's server time goes (2026-11-28): the reply carries `serverParts`, [label, ms] longest first, at most 20, with each
// whole-sheet read and each part of the start; labels are tab and step names only. A request that read nothing has none.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload) => {
  rt.ctx.__body = JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload: payload || {} });
  return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
};

test("the start's reply says where its server time went: steps, getMeta parts and sheet reads", () => {
  const { rt } = freshApp({ small: true });
  const res = post(rt, "getStartupBundle");
  assert.equal(res.ok, true);
  const parts = res.serverParts;
  assert.ok(Array.isArray(parts) && parts.length > 0 && parts.length <= 20);
  const labels = parts.map((p) => p[0]);
  assert.ok(labels.includes("step getMeta"), labels.join(", "));
  assert.ok(labels.some((l) => /^read Entries/.test(l)), "the Entries read is timed");
  parts.forEach((p) => assert.ok(typeof p[1] === "number" && p[1] >= 0));
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i - 1][1] >= parts[i][1], "longest first");
  assert.ok(!labels.some((l) => /\d{4}|@/.test(l.replace(/×\d+$/, ""))), "labels are names, no data");
});

test("a sheet read twice shows once, with its total and how many times", () => {
  const { rt } = freshApp({ small: true });
  rt.run("PERF_PARTS_ = []; perfPart_('read Entries', 5); perfPart_('read Entries', 7); perfPart_('step x', 1);");
  assert.deepEqual(JSON.parse(JSON.stringify(rt.run("perfPartsForResponse_()"))), [["read Entries ×2", 12], ["step x", 1]]);
  rt.run("PERF_PARTS_ = null");
});
