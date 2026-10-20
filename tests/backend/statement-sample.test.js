// "Send this statement" (backend/StatementSamples.gs + docs/statement-sample.js). Made-up names, shops and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");
const StatementSample = require("../../docs/statement-sample.js");

const INSTALL = "0f8c1c5e-4444-4a2b-9c3d-dddddddddddd";
const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ page: 1 + Math.floor(i / 40), cells: [{ x0: 40, str: "12 OCT" }, { x0: 120, str: "COMPRA TIENDA " + i }, { x0: 430, str: "S/ 1,234.50" }] }));
const sampleText = (n) => StatementSample.rowsToText(rowsOf(n), {});
const send = (rt, payload) => post(rt, { action: "reportStatementSample", payload: { install: INSTALL, label: "Ana", bank: "Examplebank savings", kind: "unrecognised", language: "en", app: "0.9.17", text: sampleText(20), ...payload } });
const telegramTexts = (rt) => rt.svc.fetchLog.map((f) => JSON.parse(f.options.payload).text).filter(Boolean);
const friend = (rt) => rt.svc.props.set("FEATURES", "gmail");

// ---- the phone's text and hiding ----
test("rows keep their layout as lettered columns, pages are marked, digits become 9", () => {
  const rows = [
    { page: 1, cells: [{ x0: 40, str: "12 OCT" }, { x0: 120, str: "COMPRA CORNER CAFE" }, { x0: 430, str: "S/ 1,234.50" }] },
    { page: 2, cells: [{ x0: 41, str: "13 OCT" }, { x0: 432, str: "S/ 10.00" }] }
  ];
  const lines = StatementSample.rowsToText(rows, {}).split("\n");
  assert.match(lines[0], /^Columns A, B, C/);
  assert.equal(lines[1], "A: 99 OCT  ¦  B: COMPRA CORNER CAFE  ¦  C: S/ 9,999.99");
  assert.equal(lines[2], "--- next page ---");
  assert.equal(lines[3], "A: 99 OCT  ¦  C: S/ 99.99");   // x 41 and 432 sit in the same columns as 40 and 430
});

test("the cell after a label such as Titular, and names after Name:, are hidden", () => {
  const out = StatementSample.rowsToText([
    { page: 1, cells: [{ x0: 40, str: "Titular:" }, { x0: 120, str: "JUAN PEREZ GOMEZ" }] },
    { page: 1, cells: [{ x0: 40, str: "Nombre: Rosa Quispe" }] },
    { page: 1, cells: [{ x0: 40, str: "Domicilio" }, { x0: 120, str: "Calle Sol 12 Lima" }] }
  ], {});
  assert.ok(!/JUAN|PEREZ|Rosa|Quispe|Calle Sol/i.test(out), out);
  assert.equal((out.match(/\[name\]/g) || []).length, 3);
});

test("words the person adds are hidden everywhere in the statement (a shop, a person)", () => {
  const out = StatementSample.rowsToText(rowsOf(3).map((r, i) => ({ ...r, cells: [r.cells[0], { x0: 120, str: i === 1 ? "PAGO A ANA LOPEZ" : "COMPRA CORNER CAFE" }, r.cells[2]] })), { hide: "Ana Lopez, Corner Cafe" });
  assert.ok(!/ana|lopez|corner/i.test(out.replace("Columns", "")), out);
});

test("a whole statement fits (well above the e-mail limit) but never above the cap", () => {
  const big = StatementSample.rowsToText(rowsOf(4000), {});
  assert.ok(big.length > 20000 && big.length <= StatementSample.MAX_CHARS);
});

// ---- the owner's side ----
test("a statement sample needs no sign-in, is saved in the Statement Samples tab and the owner gets a short Telegram heads-up", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  const res = send(rt, {});
  assert.equal(res.ok, true);
  const rows = Array.from(rt.rows("Statement Samples"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bank, "Examplebank savings");
  assert.equal(rows[0].label, "Ana");
  assert.equal(String(rows[0].part), "1");
  assert.equal(String(rows[0].parts), "1");
  assert.match(String(rows[0].text), /COMPRA TIENDA 9/);
  const tg = telegramTexts(rt).join("\n");
  assert.match(tg, /Statement sample from Ana/);
  assert.match(tg, /Examplebank savings/);
  assert.ok(!/COMPRA TIENDA/.test(tg), "the statement text itself never goes to Telegram");
});

test("a long statement is split at line breaks into parts that each fit a Sheets cell", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  const res = send(rt, { text: sampleText(3000) });
  assert.equal(res.ok, true);
  const rows = Array.from(rt.rows("Statement Samples"));
  assert.ok(rows.length >= 2, "split into several parts");
  rows.forEach((r, i) => {
    assert.equal(String(r.part), String(i + 1));
    assert.equal(String(r.parts), String(rows.length));
    assert.ok(String(r.text).length <= 40000);
    assert.equal(String(r.chars), String(String(r.text).length));
  });
  const joined = rows.map((r) => r.text).join("\n");
  assert.equal((joined.match(/COMPRA TIENDA/g) || []).length, 3000, "nothing was lost");
});

test("the backend hides digits and addresses again even if the phone did not", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  send(rt, { text: "A: Pago de S/ 12.34 a nadie@gmail.test cuenta 0123456789 operación 4455 ".repeat(10) });
  const row = Array.from(rt.rows("Statement Samples"))[0];
  assert.ok(!/[0-8]/.test(String(row.text)));
  assert.ok(!String(row.text).includes("nadie@"));
  assert.ok(!telegramTexts(rt).join("\n").includes("nadie@"));
});

test("a sample can never become a spreadsheet formula, and bad reports store nothing", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  send(rt, { bank: "=HYPERLINK(1)x", label: "=SUM(1)", text: "=SUM(A1:A9) " + "relleno ".repeat(40) });
  const row = Array.from(rt.rows("Statement Samples"))[0];
  assert.ok(!String(row.bank).includes("=") && !String(row.bank).includes("(") && !String(row.label).includes("="));
  for (const bad of [{ install: "nope" }, { bank: "" }, { text: "short" }, { text: "" }]) {
    assert.equal(send(rt, bad).ok, false);
  }
  assert.equal(Array.from(rt.rows("Statement Samples")).length, 1);
});

test("at most three statements per phone per day", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  for (let i = 0; i < 3; i++) assert.equal(send(rt, {}).ok, true);
  const res = send(rt, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "sample_busy");
});

test("a friend's own copy refuses statement samples, and a telegram failure never loses a sample", () => {
  const friendRt = freshApp({ small: true }).rt;
  friend(friendRt);
  const refused = send(friendRt, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "sample_not_collected");
  const { rt } = freshApp({ small: true });   // no Telegram linked: the notice fails, the rows stay
  assert.equal(send(rt, {}).ok, true);
  assert.equal(Array.from(rt.rows("Statement Samples")).length, 1);
});
