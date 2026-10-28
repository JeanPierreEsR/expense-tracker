// Bank labels (ticks only, never a cross) and the "how many phones asked" line in the owner's Telegram heads-up.
// Made-up names, addresses and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, linkTelegram } = require("./helpers");
const StatementParsers = require("../../docs/statement-parsers.js");

const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");

// ---- the list of banks with a statement reader cannot drift from the readers ----
test("every statement layout parseStatement reads has its bank in STATEMENT_BANK_BY_KIND", () => {
  const src = docs("statement-parsers.js");
  const body = src.slice(src.indexOf("function parseStatement"), src.indexOf("return { groupRows"));
  const kinds = [...body.matchAll(/kind === '(\w+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 10, "found the readers: " + kinds.join(","));
  for (const k of kinds) assert.ok(StatementParsers.STATEMENT_BANK_BY_KIND[k], `reader "${k}" needs a bank in STATEMENT_BANK_BY_KIND`);
  for (const k of Object.keys(StatementParsers.STATEMENT_BANK_BY_KIND)) assert.ok(kinds.includes(k), `"${k}" in STATEMENT_BANK_BY_KIND has no reader`);
});

test("the banks with a statement reader that are in the welcome list are spelled the way the list spells them", () => {
  const rt = freshApp({ small: true }).rt;
  const cat = rt.api("getMeta").bankCatalog;
  const names = cat.main.concat(cat.other).map((b) => b.name);
  // Diners and SIP are not in the catalog (a person adds them as their own bank); the ticks match them by name all the same.
  for (const b of ["BCP", "Interbank", "Banco Falabella", "Banco Ripley"]) {
    assert.ok(names.includes(b), `${b} is not in the bank catalog`);
    assert.ok(StatementParsers.statementBanks().includes(b), `${b} has no statement reader listed`);
  }
});

// ---- the screen: ticks only ----
test("the bank lists never show a cross or 'not yet' next to a bank, only ticks", () => {
  const app = docs("app.js");
  const fn = app.slice(app.indexOf("function bankTicks_"), app.indexOf("function fillBankNote_"));
  assert.match(fn, /bankTick\.emails/);
  assert.match(fn, /bankTick\.statements/);
  assert.doesNotMatch(fn, /✗|✕|✖|notReadable|notYet/);
  const strings = docs("strings.js");
  for (const key of ["bankTick.emails", "bankTick.statements", "bankNote.text"]) {
    const m = strings.match(new RegExp(`"${key}": \\{ en: "([^"]+)", es: "([^"]+)"`));
    assert.ok(m && m[1] && m[2] && m[1] !== m[2], `${key} needs English and Spanish`);
    if (key.startsWith("bankTick")) assert.match(m[1] + m[2], /✓/);
  }
  // the note that appears after someone registers a bank we cannot read is encouraging, not a refusal
  const note = strings.match(/"bankNote\.text": \{ en: "([^"]+)"/)[1];
  assert.doesNotMatch(note, /can't read|cannot read/i);
  assert.match(note, /works fully/);
});

// ---- the owner's heads-up counts different phones ----
const SENDER = "alertas@examplebank.test";
const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const telegramTexts = (rt) => rt.svc.fetchLog.map((f) => JSON.parse(f.options.payload).text).filter(Boolean);
const emailSample = (rt, install, sender) => post(rt, { action: "reportBankSample", payload: { install, label: "Ana", sender: sender || SENDER, subject: "Compra con tarjeta", text: "Compra por S/ 99.50 en Corner Cafe con tarjeta terminada en 1234", how: "pasted", language: "es", app: "1.0.0" } });
const INSTALL_A = "0f8c1c5e-3333-4a2b-9c3d-aaaaaaaaaaaa";
const INSTALL_B = "0f8c1c5e-3333-4a2b-9c3d-bbbbbbbbbbbb";

test("e-mail sample alert: first phone, then a second different phone; the same phone twice counts once", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  assert.equal(emailSample(rt, INSTALL_A).ok, true);
  assert.match(telegramTexts(rt).join("\n"), /First phone asking for this sender/);
  assert.equal(emailSample(rt, INSTALL_A).ok, true);
  assert.ok(!/different phones have now sent/.test(telegramTexts(rt).join("\n")), "the same phone is not a second phone");
  assert.equal(emailSample(rt, INSTALL_B).ok, true);
  assert.match(telegramTexts(rt).pop(), /2 different phones have now sent this sender/);
});

test("e-mail sample alert: a sender is counted on its own, and says when the app already has a rule for it", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  emailSample(rt, INSTALL_A);
  emailSample(rt, INSTALL_B, "otro@examplebank.test");
  assert.match(telegramTexts(rt).pop(), /First phone asking/);
  assert.ok(!/already has a rule/.test(telegramTexts(rt).join("\n")), "an unknown sender has no rule");
  emailSample(rt, INSTALL_B, "notificaciones@notificacionesbcp.com.pe");   // a sender that has a rule
  assert.match(telegramTexts(rt).pop(), /already has a rule for this sender/);
});

const stmtSample = (rt, install, bank) => post(rt, { action: "reportStatementSample", payload: { install, label: "Ana", bank, kind: "unrecognised", language: "en", app: "1.0.0", text: "ESTADO DE CUENTA\n" + "COMPRA TIENDA 12 S/ 99.00\n".repeat(20) } });

test("statement sample alert counts different phones per bank, ignoring capitals", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  assert.equal(stmtSample(rt, INSTALL_A, "Examplebank savings").ok, true);
  assert.match(telegramTexts(rt).pop(), /First phone sending a statement from this bank/);
  assert.equal(stmtSample(rt, INSTALL_B, "examplebank SAVINGS").ok, true);
  assert.match(telegramTexts(rt).pop(), /2 different phones have now sent a statement from this bank/);
  assert.equal(stmtSample(rt, INSTALL_A, "Otherbank").ok, true);
  assert.match(telegramTexts(rt).pop(), /First phone sending a statement/);
});

test("the demand lines exist in English and Spanish", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "Strings.gs"), "utf8");
  for (const key of ["bankSample.demandFirst", "bankSample.demandMany", "bankSample.demandSupported", "statementSample.demandFirst", "statementSample.demandMany"]) {
    const m = src.match(new RegExp(`"${key}": \\{ en: "([^"]+)", es: "([^"]+)"`));
    assert.ok(m && m[1] && m[2] && m[1] !== m[2], `${key} needs English and Spanish`);
  }
});
