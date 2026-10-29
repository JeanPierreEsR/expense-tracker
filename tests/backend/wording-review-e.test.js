// Round 4 of the 2026-10-21 wording review: B1 (access code), B2 ("Needs review"), B6–B17 as approved by the owner.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const strings = read("docs", "strings.js"), gs = read("backend", "Strings.gs"), setup = read("docs", "setup", "index.html"), index = read("docs", "index.html"), app = read("docs", "app.js");

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
const allEn = ALL.map((e) => e.en).join("\n") + "\n" + setupEn;
const allEs = ALL.map((e) => e.es).join("\n") + "\n" + setupEs;

test("B1: the thing you copy and paste is the 'access code' / 'código de acceso' everywhere (no 'my sign-in', 'mi acceso', 'session key')", () => {
  assert.ok(!/\b(my|your) sign-in\b|session key|No sign-in found|not a sign-in/i.test(allEn), (/.{20}(my|your) sign-in.{10}/.exec(allEn) || [""])[0]);
  assert.ok(!/\b(mi|tu|un) acceso\b/i.test(allEs), (/.{20}\b(mi|tu|un) acceso\b.{10}/i.exec(allEs) || [""])[0]);
  assert.equal(get("link.copyBtn").en, JSON.stringify("Copy my access code"));
  assert.equal(get("link.pasteBtn").es, JSON.stringify("Pegar mi código de acceso"));
  assert.match(setupEn, /Copy my access code again/);
  assert.match(setupEs, /Copiar mi código de acceso otra vez/);
  assert.match(get("privacy.signin").en, /Your access code is kept only on your phone/);
});

test("B2: the place for detected entries is always “Needs review” / “Por revisar” (no 'review queue', 'review list', 'lista por revisar')", () => {
  assert.ok(!/review queue|review list|review items/i.test(allEn), (/.{25}review (queue|list|items).{10}/i.exec(allEn) || [""])[0]);
  assert.ok(!/lista por revisar|lista de revisión|cola de revisión/i.test(allEs), (/.{25}lista (por revisar|de revisión).{10}/i.exec(allEs) || [""])[0]);
  assert.match(get("settle.extraSavedIncome").en, /“Needs review”/);
  assert.match(get("bot.overpaidIn").es, /“Por revisar”/);
  assert.match(get("banner.saveFailed").en, /tap to see/);
});

test("B6: the transfer 'To' hint is one idea, and the currency exchange is the LAST choice of Type of transfer (its fields replace the usual ones, only for a new entry)", () => {
  assert.ok(get("transfer.toHint").en.length < 220, "short");
  assert.ok(!/exchange/i.test(get("transfer.toHint").en));
  assert.equal(get("transfer.kind.exchange").en, JSON.stringify("Currency exchange"));
  assert.equal(get("transfer.kind.exchange").es, JSON.stringify("Cambio de moneda"));
  const kinds = [...index.matchAll(/<option value="(\w+)" data-i18n="transfer\.kind\.\w+"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ["between", "repayment", "loan", "exchange"]);
  assert.match(app, /const allowed = !editingEntryId;/);
  assert.equal(get("form.noneFromOutside").en, JSON.stringify("Someone else's account"));
  assert.equal(get("form.noneToOutside").es, JSON.stringify("Cuenta de otra persona"));
});

test("B7: each loan form says what really happens with the due date", () => {
  assert.match(get("loan.dueDateHint").en, /Without a date there is no overdue reminder/);
  assert.match(get("loanModal.dueHint").en, /Pre-filled with 7 days after the loan date/);
  assert.match(get("loanModal.dueHint").es, /Viene con 7 días después/);
  // the claims match the code: the Loans-tab form pre-fills date + 7 and the backend defaults the same; the entry form leaves a blank date blank
  assert.match(app, /defaultDueDate_\(entryDate\)/);
  assert.match(read("backend", "Loans.gs"), /due_date: payload\.due_date \|\| defaultLoanDueDate_\(payload\.date\)/);
  assert.match(read("backend", "Loans.gs"), /due_date: fields\.due_date \|\| ''/);
});

test("B8, B9: 'Choose categories' and 'Switch direction'", () => {
  assert.equal(get("budgetModal.setOne").en, JSON.stringify("Choose categories"));
  assert.equal(get("budgetModal.setOne").es, JSON.stringify("Elegir categorías"));
  assert.match(get("rateModal.invert").en, /Switch direction/);
  assert.match(get("rateModal.invert").es, /Cambiar el sentido/);
});

test("B10: money back on a card is a 'refund' (no 'reversal', no 'negative expense')", () => {
  assert.ok(!/reversal|negative expense/i.test(allEn), (/.{25}(reversal|negative expense).{15}/i.exec(allEn) || [""])[0]);
  assert.ok(!/reversión|reversiones|gasto negativo/i.test(allEs), (/.{25}(reversi|gasto negativo).{15}/i.exec(allEs) || [""])[0]);
  assert.equal(get("stmt.choice.cancelCharge").en, JSON.stringify("Cancel out the charge"));
  assert.equal(get("stmt.choice.cancelCharge").es, JSON.stringify("Anular el cargo"));
  assert.match(get("stmt.group.reversal").en, /Refunds and canceled charges/);
});

test("B11, B12, B13: the long texts are split into short sentences, and statement checks are in plain words", () => {
  assert.match(get("projections.method").en, /Each figure has three parts\. Confirmed:.*Programmed:.*Expected/);
  assert.match(get("projections.seasonHigh").en, /Calculation:/);
  assert.ok(get("tour.statements.body").en.length < 460, "tour statements card");
  assert.ok(get("stmt.balBackward").en.split(". ").length >= 2);
  assert.match(get("sp.runningBreaks").en, /The balance stops adding up at/);
  assert.ok(!/≠/.test(ALL.filter((e) => e.key.startsWith("sp.")).map((e) => e.en + e.es).join("")), "no ≠ in the statement checks");
  assert.match(get("sp.lastRunning").es, /no coincide con el saldo final/);
});

test("B14, B15, B16, B17: currency hint, shared amount, discount buttons, 'What's left' instead of 'Net'", () => {
  assert.ok(!/restores everything exactly/.test(get("welcome.curHint").en));
  assert.ok(!/restores everything exactly/.test(get("welcome.mainHint").en));   // the main currency now has its own row (2026-10-28): the hint moved there
  assert.match(get("welcome.mainHint").es, /Más → Moneda principal/);
  assert.match(get("recurring.suggestShared").en, /large amount is your share; the small grey amount is the total/);
  assert.match(read("docs", "app.js"), /original-amt">\$\{tr\("common.total"\)/);   // the grey "Total" really is what the hint describes
  assert.match(get("bill.discountLine").en, /Discount on this item/);
  assert.match(get("bill.addDiscount").en, /Discount on the whole bill/);
  assert.equal(get("summary.net").en, JSON.stringify("What's left"));
  assert.equal(get("summary.net").es, JSON.stringify("Lo que queda"));
  for (const k of ["scene.flow.s1", "scene.flow.s2", "scene.flow.s3", "scene.flow.s4", "tour.overview.body"]) assert.ok(!/\bNet\b|\bNeto\b/.test(get(k).en + get(k).es), k);
});
