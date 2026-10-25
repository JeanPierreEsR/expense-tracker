// Mac helper reads the Statement Samples tab (backend/StatementSamples.gs listStatementSamples_). Made-up text only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const KEY = "h".repeat(32);
const INSTALL = "0f8c1c5e-1111-4a2b-9c3d-aaaaaaaaaaaa";
const sample = (rt, bank) =>
  post(rt, { action: "reportStatementSample", payload: { install: INSTALL, label: "Ana", bank, kind: "unrecognised", language: "en", app: "0.46.0", text: "Made-up statement line 12345\n".repeat(20) } });
const list = (rt, payload = {}, key = KEY) => post(rt, { helperKey: key, action: "listStatementSamples", payload });

test("the helper key reads the samples in pages, from where it left off", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("HELPER_KEY", KEY);
  for (let i = 0; i < 3; i++) assert.equal(sample(rt, "Bank " + i).ok, true);
  const first = list(rt);
  assert.equal(first.ok, true);
  assert.equal(first.data.rows.length, 3);
  assert.equal(first.data.done, true);
  assert.equal(first.data.rows[0].bank, "Bank 0");
  assert.equal(first.data.rows[0].row, 2);
  assert.match(first.data.rows[0].text, /99999/, "digits were already turned into 9");
  const again = list(rt, { afterRow: first.data.next });
  assert.deepEqual(again.data, { rows: [], next: first.data.next, done: true });
  sample(rt, "Bank 3");
  const newer = list(rt, { afterRow: first.data.next });
  assert.deepEqual(newer.data.rows.map((r) => r.bank), ["Bank 3"]);
});

test("without the tab, or with a wrong key, nothing is returned", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("HELPER_KEY", KEY);
  assert.deepEqual(list(rt).data, { rows: [], next: 1, done: true });
  assert.equal(list(rt, {}, "wrong").ok, false);
});
