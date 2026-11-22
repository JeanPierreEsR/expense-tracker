// Guided sending of bank e-mail samples: the three kinds (purchase, transfer, deposit) asked one after another
// (backend/BankSamples.gs + docs/bank-sample.js + the pop-up in docs/app.js). Made-up names, addresses and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp, linkTelegram } = require("./helpers");
const BankSample = require("../../docs/bank-sample.js");

const SENDER = "alertas@examplebank.test";
const INSTALL = "0f8c1c5e-3333-4a2b-9c3d-cccccccccccc";
const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const send = (rt, payload) => post(rt, { action: "reportBankSample", payload: { install: INSTALL, label: "Ana", sender: SENDER, subject: "Compra con tarjeta", text: "Compra por S/ 99.50 en Corner Cafe con tarjeta ****9999", language: "es", app: "2026-10-20T00:00:00Z", how: "picked", ...payload } });
const telegramTexts = (rt) => rt.svc.fetchLog.map((f) => JSON.parse(f.options.payload).text).filter(Boolean);
const readDoc = (...parts) => fs.readFileSync(path.join(__dirname, "../../docs", ...parts), "utf8");

test("a sample says which kind it is: kept next to 'how' and named in the owner's heads-up", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  assert.equal(send(rt, { kind: "transfer" }).ok, true);
  assert.equal(send(rt, { kind: "bogus; drop table" }).ok, true);
  assert.equal(send(rt, {}).ok, true);
  const rows = rt.rows("Bank Samples");
  assert.deepEqual(rows.map((r) => r.how), ["picked:transfer", "picked", "picked"]);
  const tg = telegramTexts(rt);
  assert.match(tg[0], /Bank sample from Ana · a transfer|Muestra de banco de Ana · una transferencia/);
  assert.ok(!/bogus/.test(tg.join("\n")), "an unknown kind is not recorded or shown");
  assert.match(tg[2], /Bank sample from Ana\n|Muestra de banco de Ana\n/, "no kind, no dangling separator");
});

test("the phone remembers which kinds were sent per bank address: only ticks, never a miss", () => {
  const A = "alerts@newbank.pe";
  let list = BankSample.rememberSender([], A, 1, "purchase");
  assert.deepEqual(BankSample.kindsSent(list, A), ["purchase"]);
  assert.equal(BankSample.nextKind(BankSample.kindsSent(list, A)), "transfer");
  list = BankSample.rememberSender(list, A, 2, "deposit");
  list = BankSample.rememberSender(list, A, 3, "deposit");   // twice: still one tick
  assert.deepEqual(BankSample.kindsSent(list, A), ["purchase", "deposit"]);
  assert.equal(BankSample.nextKind(BankSample.kindsSent(list, A)), "transfer", "the first one without a tick, in order");
  list = BankSample.rememberSender(list, A, 4, "transfer");
  assert.equal(BankSample.nextKind(BankSample.kindsSent(list, A)), "", "all three ticked");
  list = BankSample.rememberSender(list, A, 5, "nonsense");
  assert.deepEqual(BankSample.kindsSent(list, A), ["purchase", "deposit", "transfer"], "an unknown kind adds nothing");
  assert.deepEqual(BankSample.kindsSent(list, "other@bank.pe"), [], "another address starts empty");
  list = BankSample.markTold(list, [A]);
  assert.equal(BankSample.kindsSent(list, A).length, 3, "being told the bank is ready keeps the ticks");
  const old = [{ s: A, at: 1, told: false }];   // a list saved by an earlier version has no kinds
  assert.deepEqual(BankSample.kindsSent(old, A), []);
  assert.equal(BankSample.rememberSender(old, A, 2, "purchase")[0].kinds[0], "purchase");
});

test("the pop-up lists the three kinds with ticks, lets a missing one be skipped and never shows a cross", () => {
  const app = readDoc("app.js");
  const html = readDoc("index.html");
  const strings = readDoc("strings.js");
  assert.match(app, /bsRenderKinds_/);
  assert.match(app, /kind: bs_\.kind/, "the kind travels with the sample");
  assert.match(html, /id="bs-skip-kind"/);
  assert.match(html, /id="bs-kinds"/);
  for (const k of BankSample.KINDS) assert.match(strings, new RegExp(`"bankSample\\.kindName\\.${k}"`));
  const block = app.slice(app.indexOf("function bsRenderKinds_"), app.indexOf("function openBankSampleModal_"));
  assert.ok(block.length > 200 && !/[✗✕❌×]/.test(block), "a kind without a tick shows an empty circle, never a cross");
});
