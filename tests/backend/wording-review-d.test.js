// Round 3 of the 2026-10-21 wording review: C15 ("account or card" everywhere, including the Telegram keyword), C17 (alert fields only with
// Telegram), C18 (Custom), C20 (installer wording), C21 (small clarity items). Owner approved each one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const strings = read("docs", "strings.js"), gs = read("backend", "Strings.gs"), setup = read("docs", "setup", "index.html"), index = read("docs", "index.html"), app = read("docs", "app.js"), telegram = read("backend", "Telegram.gs");

function entries(src) {
  const out = [];
  for (const line of src.split("\n")) {
    const m = /^\s*"([\w.]+)": \{ en: (.*?), es: (.*?)\s?\},?$/.exec(line);
    if (m) out.push({ key: m[1], en: m[2], es: m[3] });
  }
  return out;
}
const ALL = [...entries(strings), ...entries(gs)];
const get = (key) => ALL.find((e) => e.key === key);
const setupEn = setup.slice(setup.indexOf("  en: {"), setup.indexOf("  es: {"));
const setupEs = setup.slice(setup.indexOf("  es: {"), setup.indexOf("}[LANG]"));

test("C15: it is 'account or card' / 'cuenta o tarjeta' in every form, message and label; no text still says 'payment method'", () => {
  for (const e of ALL) {
    assert.ok(!/payment method/i.test(e.en), `${e.key}: ${e.en}`);
    assert.ok(!/medio[s]? de pago/i.test(e.es), `${e.key}: ${e.es}`);
  }
  assert.match(get("field.paymentMethod").en, /Account or card/);
  assert.match(get("field.paymentMethod").es, /Cuenta o tarjeta/);
  assert.match(get("balance.noAccounts").en, /\+ Add account or card…/);
  assert.match(get("bot.notSetPaymentMethod").en, /reply \\"account Interbank\\"/);
  assert.match(get("bot.notSetPaymentMethod").es, /responde \\"cuenta Interbank\\"/);
});

test("C15: the Telegram parser takes 'account' / 'cuenta' and still takes the old words; 'received in' too", () => {
  assert.match(telegram, /\(\?:account\|cuenta\|payment\\s\*method\|medio\\s\*de\\s\*pago\)/);
  assert.match(telegram, /received\\s\*\(\?:at\|in\)/);
});

test("C17: the alert fields of budgets and trips are hidden when this copy has no Telegram (and kept when the backend does not say)", () => {
  assert.match(index, /<div id="budget-alert-fields">[\s\S]*?budget-thresholds[\s\S]*?<\/div>/);
  assert.match(index, /<div id="trip-alert-fields">[\s\S]*?trip-alerts[\s\S]*?<\/div>/);
  assert.match(app, /capabilities\.telegram === false/);
  assert.match(app, /refreshTelegramFields_\(\);\s*\n\s*if \(typeof refreshExtrasRow_/);
});

test("C18: the fourth frequency is 'Custom' / 'Personalizada'", () => {
  assert.match(get("recModal.other").en, /"Custom"/);
  assert.match(get("recModal.other").es, /"Personalizada"/);
});

test("C20: installer — no 'optional - recommended', no 'prioritize', clearer permission lines, Spanish/English labelled, a guide for the five buttons", () => {
  assert.ok(!/optional - recommended|opcional - recomendado/.test(setup));
  assert.match(setupEn, /\(recommended\)/);
  assert.match(setupEs, /\(recomendado\)/);
  assert.ok(!/prioritize|priorizar/.test(setup));
  assert.match(setupEn, /so use that one/);
  assert.match(setupEn, /This page continues automatically/);
  assert.match(setupEs, /Esta página continúa sola/);
  assert.match(setupEn, /if Google is in Spanish: <b>Configuración avanzada<\/b>/);
  assert.match(setupEs, /si Google está en inglés: <b>Advanced<\/b>/);
  assert.match(setupEn, /it only contacts the app’s own address/);
  assert.match(setupEn, /check for new bank emails regularly/);
  assert.match(setupEn, /<b>Which button\?<\/b>/);
  assert.match(setupEs, /<b>¿Qué botón\?<\/b>/);
  for (const b of ["Try again", "Continue setup", "Sign in again on this phone", "Stuck\\? Stop and try again", "Start over on this phone"]) assert.match(setupEn.slice(setupEn.indexOf("Which button?")), new RegExp(b));
});

test("C21: the statements buttons, trips labels, loans and rates read as proposed", () => {
  assert.match(get("stmt.choice.record").en, /Save as new entry/);
  assert.match(get("stmt.choice.leaveWaiting").es, /Esperar el otro estado de cuenta/);
  assert.match(get("stmt.choice.refundIncome").en, /Record as refund/);
  assert.match(get("stmt.dismiss").en, /Remove from the list/);
  assert.match(get("trips.before").en, /Spent before/);
  assert.match(get("trips.covered").en, /Replaced by a real expense/);
  assert.match(get("transfer.kind.between").en, /Between my accounts/);
  assert.match(get("loanModal.direction").en, /Who owes whom\?/);
  assert.match(get("forgive.title").en, /Forgive the debt/);
  assert.match(get("repay.overpaidRecordedIncome").en, /The payment of \{cur\} \{amount\} was more than the debt/);
  assert.match(get("rates.hint").en, /Tap a rate to change it/);
  for (const k of ["rates.empty", "rateModal.none", "budgetModal.noRate", "trips.noRate"]) assert.ok(!/on file/.test(get(k).en), k);
  assert.match(get("pmm.catSuggestion").en, /percentage points closer/);
  assert.match(get("wa.alias").en, /Name \(optional\)/);
});

test("C22: 'Confirmed' (not 'Actual'/'Real') in labels; 'entry/movimiento' (not 'record/registro') for what the person records; 'Received in'", () => {
  for (const k of ["projections.actual", "drill.actual", "drill.actualSpend"]) {
    assert.match(get(k).en, /Confirmed/i, k);
    assert.match(get(k).es, /Confirmado/i, k);
    assert.ok(!/\bActual\b|\bReal\b|\breal\b/.test(get(k).en + get(k).es), k);
  }
  assert.ok(!/✅ (Actual|Real)/.test(get("scene.proj.s2").en + get("scene.proj.s2").es + get("scene.proj.s3").en + get("scene.proj.s3").es));
  assert.ok(!/\b(past|every|\{n\}) records?\b/i.test(ALL.map((e) => e.en).join("\n")), "records");
  assert.ok(!/\bregistros? (anteriores|la usa|la usan)\b|Cada registro/.test(ALL.map((e) => e.es).join("\n")), "registros");
  assert.match(get("err.catInUse").en, /entries use it/);
  assert.match(get("err.pmInUse").es, /movimientos la usan/);
  assert.match(get("export.fileRecords").en, /row/);
  assert.match(get("entry.receivedAt").en, /received in/);
  assert.ok(!/received at/i.test(ALL.map((e) => e.en).join("\n")), "received at");
});
