// Decisions on the "C" findings of the 2026-10-21 wording review (owner approved each one; C1 repago and C2's "repartición" were KEPT on purpose).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const strings = read("docs", "strings.js"), gs = read("backend", "Strings.gs"), setup = read("docs", "setup", "index.html");

function entries(src) {
  const out = [];
  for (const line of src.split("\n")) {
    const m = /^\s*"([\w.]+)": \{ en: (.*?), es: (.*?)\s?\},?$/.exec(line);
    if (m) out.push({ key: m[1], en: m[2], es: m[3] });
  }
  return out;
}
const S = entries(strings), G = entries(gs), ALL = [...S, ...G];
const get = (key) => ALL.find((e) => e.key === key);
const setupEs = setup.slice(setup.indexOf("  es: {"), setup.indexOf("}[LANG]"));

test("C1/C2 kept: 'repago' and 'Repartición' stay; only 'cuenta' (the bill) became 'boleta' in the bill-splitting texts", () => {
  assert.match(get("transfer.kind.repayment").es, /Repagos/);
  assert.match(get("bill.apply").es, /repartición/);
  assert.equal(get("bill.title").es, JSON.stringify("🧾 Repartir una boleta por ítems"));
  for (const e of ALL.filter((x) => /^bill\.(title|stale|total|who|err|loading|check|items|tipBase|format|onlyExpense|tooLarge)/.test(x.key) || x.key === "split.openBill")) {
    assert.ok(!/\bcuenta\b/.test(e.es), `${e.key}: ${e.es}`);
  }
});

test("C3: nobody 'sigue' an account any more — the balance is 'llevado'", () => {
  for (const k of ["balances.empty", "balance.stop", "balance.confirmStop", "stmt.noAccounts", "stmt.noteNotTracked", "stmt.choice.startTracking", "loanModal.pmHint"]) assert.ok(!/\bseguir|seguid|seguimiento/i.test(get(k).es), k);
  assert.match(get("balance.stop").es, /Dejar de llevar el saldo/);
  assert.match(get("stmt.choice.startTracking").es, /Empezar a llevar el saldo desde este monto/);
});

test("C4: matching an entry with a programmed item or a statement line is 'emparejar'; 'vincular' stays for trips, Yape/Plin, friends", () => {
  for (const k of ["recModal.linkHint", "recModal.linkEmpty", "recModal.linkSelected"]) assert.match(get(k).es, /empar/i, k);
  assert.ok(!/vincul/i.test(get("recModal.linkSelected").es + get("recModal.linkEmpty").es));
  assert.match(get("recModal.linkSelected").en, /Match selected/);
  assert.match(get("trips.noEntries").es, /vinculados/);
});

test("C5, C9, C6: no 'otra bandeja', no 'gestionado', no 'teléfono' (it is 'celular') in any Spanish text", () => {
  assert.match(get("bankSample.pasteInstead").es, /otra cuenta de correo/);
  for (const e of ALL) {
    assert.ok(!/gestion/i.test(e.es), `${e.key} gestion`);
    assert.ok(!/tel[eé]fono/i.test(e.es), `${e.key} teléfono`);
  }
  assert.ok(!/tel[eé]fono/i.test(setupEs), "installer (es)");
  assert.match(get("privacy.signin").es, /solo en tu celular/);
});

test("C7, C8: the loan form asks '¿Quién le debe a quién?'; Telegram texts say 'mensaje', not 'tarjeta'", () => {
  assert.equal(get("loanModal.direction").es, JSON.stringify("¿Quién le debe a quién?"));
  assert.ok(!/la tarjeta/.test(get("bot.needCategoryFirst").es + get("bot.needPlatformFirst").es));
  assert.match(get("bot.needCategoryFirst").es, /Responde a este mensaje/);
  assert.match(get("bot.tripWillLink").es, /no vincularlo/);
});

test("C11: the small Spanish items", () => {
  assert.match(get("trips.emoji").es, /^"Emoji/);
  assert.match(get("wa.kind.debit_pen").es, /ahorros o débito/);
  assert.match(get("accounts.type.transfer").es, /Transferencia bancaria/);
  assert.match(get("accounts.confirmDelete").es, /no se podrá eliminar/);
  assert.match(get("stmt.choice.complete").es, /Completar transferencia/);
  assert.match(get("export.send").es, /en lugar de guardar/);
  assert.match(get("rec.customInterval").es, /Se repite cada/);
  assert.match(get("tour.flow.body").es, /la imagen/);
  for (const e of ALL) assert.ok(!/excedente/i.test(e.es), `${e.key} excedente`);
  assert.match(get("privacy.never").es, /las personas a quienes pagas/);
});

test("C12: 'gap' no longer means two things; C13: no 'offset'; C14: 'payer', not 'payor/payee'; C16: no local words in English", () => {
  const en = ALL.map((e) => e.en).join("\n") + "\n" + setup.slice(setup.indexOf("  en: {"), setup.indexOf("  es: {"));
  assert.ok(!/\bgaps?\b/i.test(en), "gap");
  assert.ok(!/\boffset\b/i.test(en), "offset");
  assert.ok(!/\bpay(or|ee)s?\b/i.test(en), "payor/payee");
  assert.equal(get("gaps.title").en, JSON.stringify("Unexplained differences"));
  assert.match(get("stmt.noteGap").en, /^"Missing period:/);
  assert.match(get("stmt.noteGap").es, /^"Periodo sin cubrir:/);
  for (const k of ["wa.kind.debit_pen", "wa.kind.debit_usd", "wa.kind.credit", "wa.kind.sueldo", "wa.rail.yape_pen", "wa.rail.yape_usd", "wa.rail.plin_pen"]) {
    assert.ok(!/\bsoles\b|\bdollars\b|Sueldo/.test(get(k).en), k);
  }
  assert.match(get("rec.variableNeedsWords").en, /luz\\" \(electricity\)/);
});

test("C19: error texts say what to do next", () => {
  assert.match(get("error.rateRequired").en, /Add it in More → Exchange rates/);
  assert.match(get("error.rateRequired").es, /Agrégalo en Más → Tipos de cambio/);
  assert.match(get("feature.gmailOff").en, /Turn it on in More → Extra features/);
  assert.match(get("feature.gmailOff").es, /Actívala en Más → Funciones extra/);
  assert.match(get("err.catProtected").en, /built-in category/);
  for (const k of ["err.catInUse", "err.pmInUse"]) assert.ok(!/pickers/.test(get(k).en), k);
});
