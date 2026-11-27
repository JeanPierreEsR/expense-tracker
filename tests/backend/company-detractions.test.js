// Detracciones (Detractions.gs, owner's plan 2026-11-26, piece 2): a company's income keeps the whole invoice; the part the client
// deposited in the Banco de la Nación moves by itself, through ONE linked transfer, to that account. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
  return rt;
}
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const company = (rt) => rt.rows("Companies")[0].id;
const incomeCat = (rt) => rt.rows("Categories").find((c) => c.type === "income" && c.hidden !== "yes").id;
const balanceOf = (rt, id) => Number(rt.run(`(function () { var pm = getAllRows('Payment Methods').find(function (p) { return p.id === ${JSON.stringify(id)}; });
  return movementsForPaymentMethod_(pm, [{ currency: 'PEN', amount: 0, date: '2000-01-01' }], confirmedEntries_(), buildInboundTransferIds_())
    .reduce(function (n, m) { return n + ((m.entry.currency || 'PEN') === 'PEN' ? m.signed : 0); }, 0); })()`));
const income = (rt, extra) => rt.api("createEntry", Object.assign({ type: "income", date: today(), amount: 10000, currency: "PEN", category_id: incomeCat(rt),
  description: "Factura 001", payment_method_id: pm(rt), paid_by: "me", company_id: company(rt) }, extra));
const linked = (rt, id) => rt.rows("Entries").filter((e) => String(e.detraction_of || "") === id);
const bnId = (rt) => rt.run("String(getSettingsMap().detraction_account_id || '')");
const totals = (rt) => rt.api("getPeriodSummary", { startDate: today().slice(0, 8) + "01", endDate: today() }).totals;

test("an income with a detracción: the bank gets the net, the Banco de la Nación the rest, income counts the whole invoice", () => {
  const rt = companyCopy();
  const bank = pm(rt);
  const before = balanceOf(rt, bank), incomeBefore = totals(rt).income;
  const e = income(rt, { detraction_amount: 400 });
  assert.equal(Number(rt.rows("Entries").find((x) => x.id === e.id).detraction_amount), 400);
  const t = linked(rt, e.id);
  assert.equal(t.length, 1);
  assert.equal(t[0].type, "transfer");
  assert.equal(Number(t[0].amount), 400);
  assert.equal(t[0].payment_method_id, bank);
  assert.equal(t[0].to_payment_method_id, bnId(rt));
  assert.equal(rt.rows("Payment Methods").find((p) => p.id === bnId(rt)).nickname, "Banco de la Nación (detracciones)");
  assert.equal(balanceOf(rt, bank), before + 9600);
  assert.equal(balanceOf(rt, bnId(rt)), 400);
  assert.equal(totals(rt).income, incomeBefore + 10000);
  // a second one reuses the same account
  income(rt, { detraction_amount: 100, amount: 2500 });
  assert.equal(rt.rows("Payment Methods").filter((p) => /Banco de la Naci/.test(p.nickname)).length, 1);
});

test("editing the income moves its transfer; taking the detracción off removes it", () => {
  const rt = companyCopy();
  const e = income(rt, { detraction_amount: 400 });
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { amount: 20000, detraction_amount: 800, date: today() } });
  assert.equal(Number(linked(rt, e.id)[0].amount), 800);
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { description: "Factura 002" } });
  assert.equal(linked(rt, e.id).length, 1, "an edit that does not send it keeps it");
  assert.match(linked(rt, e.id)[0].description, /Factura 002/);
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { detraction_amount: "" } });
  assert.equal(linked(rt, e.id).length, 0);
});

test("deleting the income takes the transfer; deleting the transfer alone clears the income's detracción", () => {
  const rt = companyCopy();
  const a = income(rt, { detraction_amount: 400 });
  rt.api("discardEntry", { id: a.id });
  assert.equal(linked(rt, a.id).length, 0);
  const b = income(rt, { detraction_amount: 400 });
  rt.api("discardEntry", { id: linked(rt, b.id)[0].id });
  assert.equal(String(rt.rows("Entries").find((x) => x.id === b.id).detraction_amount || ""), "");
  const c = income(rt, { detraction_amount: 400 });
  rt.api("deleteEntries", { ids: [c.id] });
  assert.equal(linked(rt, c.id).length, 0, "bulk delete too");
});

test("a waiting income gets its transfer when confirmed", () => {
  const rt = companyCopy();
  const e = rt.api("createEntry", { type: "income", date: today(), amount: 9600, currency: "PEN", category_id: incomeCat(rt), description: "Abono",
    payment_method_id: pm(rt), paid_by: "me", status: "pending", source: "email" });
  rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 10000, detraction_amount: 400, company_id: company(rt), project_id: "" } });
  assert.equal(Number(linked(rt, e.id)[0].amount), 400);
});

test("refused or ignored where it does not apply", () => {
  const rt = companyCopy();
  assert.throws(() => income(rt, { detraction_amount: 10000 }), /detracci/i);
  const personal = income(rt, { company_id: "", detraction_amount: 400 });
  assert.equal(linked(rt, personal.id).length, 0);
  const { rt: plain } = freshApp({ small: true });
  const p = plain.api("createEntry", { type: "income", date: today(), amount: 100, currency: "PEN", category_id: plain.rows("Categories").find((c) => c.type === "income").id,
    payment_method_id: plain.rows("Payment Methods")[0].id, paid_by: "me", detraction_amount: 4 });
  assert.equal(plain.rows("Entries").filter((x) => String(x.detraction_of || "") === p.id).length, 0, "not a company copy");
});

test("a company's usual detracción %", () => {
  const rt = companyCopy();
  rt.api("updateCompany", { id: company(rt), name: "Constructora Andina", detraction_rate: 12 });
  assert.equal(Number(rt.rows("Companies")[0].detraction_rate), 12);
  assert.throws(() => rt.api("updateCompany", { id: company(rt), name: "Constructora Andina", detraction_rate: 150 }));
});

test("an invoice in dollars: out of the bank in dollars, into the Banco de la Nación in soles, as one exchange", () => {
  const rt = companyCopy();
  const e = income(rt, { currency: "USD", amount: 10000, detraction_amount: 400, detraction_pen: 1520.4 });
  const legs = linked(rt, e.id);
  assert.equal(legs.length, 2);
  const out = legs.find((l) => l.currency === "USD"), inn = legs.find((l) => l.currency === "PEN");
  assert.equal(Number(out.amount), 400);
  assert.equal(out.payment_method_id, pm(rt));
  assert.equal(Number(inn.amount), 1520, "whole soles");
  assert.equal(inn.to_payment_method_id, bnId(rt));
  assert.equal(String(out.exchange), "1");
  assert.equal(out.exchange_pair, inn.exchange_pair);
  assert.equal(balanceOf(rt, bnId(rt)), 1520);
  // edited: the same two legs move; back to soles: one plain transfer
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { detraction_amount: 500, detraction_pen: 1900 } });
  assert.deepEqual(linked(rt, e.id).map((l) => Number(l.amount)).sort((a, b) => a - b), [500, 1900]);
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { currency: "PEN", detraction_amount: 400 } });
  assert.equal(linked(rt, e.id).length, 1);
  assert.equal(String(linked(rt, e.id)[0].exchange || ""), "");
  // with no soles typed and no rate on file: refused, nothing kept half-way
  const before = rt.rows("Entries").length;
  assert.throws(() => income(rt, { currency: "EUR", amount: 1000, detraction_amount: 40, date: "2020-01-15" }), /soles/i);
  assert.equal(rt.rows("Entries").length, before, "nothing saved");
});
