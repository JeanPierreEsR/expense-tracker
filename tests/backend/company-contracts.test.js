// Construction contracts (Contracts.gs, owner's plan 2026-11-26, piece 3): advance, valuations that take it back and keep a guarantee,
// the guarantee given back. Every payment is an ordinary expense of the project (the advance counts the day it is paid). Made-up data.
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
const project = (rt) => rt.rows("Projects")[0].id;
const labor = (rt) => rt.rows("Categories").find((c) => c.name === "Labor").id;
const pay = (rt, amount, cp) => rt.api("createEntry", { type: "expense", date: today(), amount, currency: "PEN", category_id: labor(rt), description: "Pago",
  payment_method_id: rt.rows("Payment Methods")[0].id, paid_by: "me", project_id: project(rt), contract_payment: cp });
const view = (rt) => rt.api("listProjectContracts", { project_id: project(rt) }).contracts[0];

test("advance, a valuation that takes it back and keeps the guarantee, the guarantee given back", () => {
  const rt = companyCopy();
  const c = rt.api("saveContract", { project_id: project(rt), supplier_name: "Encofrados Lima", description: "Encofrado", amount: 100000, currency: "PEN", advance_pct: 20, retention_pct: 5 });
  assert.equal(rt.rows("Friends").find((f) => f.name === "Encofrados Lima").role, "supplier");
  pay(rt, 20000, { contract_id: c.id, kind: "advance" });
  let v = view(rt);
  assert.equal(v.advance_left, 20000);
  assert.equal(v.paid, 20000);
  pay(rt, 22500, { contract_id: c.id, kind: "valuation", gross: 30000, advance_amortized: 6000, retention_held: 1500 });
  v = view(rt);
  assert.equal(v.valued, 30000);
  assert.equal(v.advance_left, 14000);
  assert.equal(v.retention_left, 1500);
  assert.equal(v.paid, 42500);
  assert.equal(v.to_pay, 57500);
  pay(rt, 1500, { contract_id: c.id, kind: "retention_return" });
  v = view(rt);
  assert.equal(v.retention_left, 0);
  assert.equal(v.payments.length, 3);
  // the meta carries them for the "+" form
  assert.equal(rt.api("getMeta", {}).contracts.length, 1);
});

test("a valuation whose amount is not the net is refused; a payment on another project or currency too", () => {
  const rt = companyCopy();
  const c = rt.api("saveContract", { project_id: project(rt), supplier_name: "Gasfitería Sur", amount: 5000, currency: "PEN", advance_pct: 0, retention_pct: 10 });
  assert.throws(() => pay(rt, 999, { contract_id: c.id, kind: "valuation", gross: 1000, advance_amortized: 0, retention_held: 100 }), /valoriza|valuation/i);
  assert.throws(() => rt.api("createEntry", { type: "expense", date: today(), amount: 900, currency: "USD", category_id: labor(rt), paid_by: "me",
    payment_method_id: rt.rows("Payment Methods")[0].id, project_id: project(rt), contract_payment: { contract_id: c.id, kind: "valuation", gross: 1000, retention_held: 100 } }), /moneda|currency/i);
});

test("an edit can change or remove the link; a deleted expense stops counting; a contract with payments is kept", () => {
  const rt = companyCopy();
  const c = rt.api("saveContract", { project_id: project(rt), supplier_name: "Eléctricas Norte", amount: 8000, currency: "PEN", advance_pct: 25, retention_pct: 0 });
  const e = pay(rt, 2000, { contract_id: c.id, kind: "advance" });
  assert.throws(() => rt.api("deleteContract", { id: c.id }), /pagos|payments/i);
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { contract_payment: null } });
  assert.equal(view(rt).paid, 0);
  rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { contract_payment: { contract_id: c.id, kind: "advance" } } });
  assert.equal(view(rt).advance_left, 2000);
  rt.api("discardEntry", { id: e.id });
  assert.equal(view(rt).paid, 0, "a deleted expense stops counting");
  rt.api("deleteContract", { id: c.id });
  assert.equal(rt.rows("Contracts").length, 0);
});

test("not a company copy: refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("saveContract", { project_id: "x", supplier_name: "A", amount: 10 }));
});

test("Overview's What is owed counts the guarantee still to give back", () => {
  const rt = companyCopy();
  const c = rt.api("saveContract", { project_id: project(rt), supplier_name: "Encofrados Lima", amount: 100000, currency: "PEN", advance_pct: 0, retention_pct: 5 });
  pay(rt, 28500, { contract_id: c.id, kind: "valuation", gross: 30000, advance_amortized: 0, retention_held: 1500 });
  const co = rt.api("getPeriodSummary", { startDate: today().slice(0, 8) + "01", endDate: today() }).company;
  const row = co.owed.find((o) => /Encofrados Lima/.test(o.name));
  assert.equal(row.lines[0].amount, 1500);
  assert.ok(co.owedTotals.some((t) => t.currency === "PEN" && t.amount >= 1500));
});

// testers 2.80.0 (Elena): a refused contract payment leaves nothing saved; the contract's figures have ceilings.
test("a valuation that does not add up is refused before the expense is written", () => {
  const rt = companyCopy();
  const c = rt.api("saveContract", { project_id: project(rt), supplier_name: "Encofrados Lima", amount: 100000, currency: "PEN", advance_pct: 20, retention_pct: 5 });
  const before = rt.rows("Entries").length;
  assert.throws(() => pay(rt, 22000, { contract_id: c.id, kind: "valuation", gross: 30000, advance_amortized: 0, retention_held: 1500 }), /valuation minus/);
  assert.equal(rt.rows("Entries").length, before, "no expense left behind");
  const e = pay(rt, 28500, { contract_id: c.id, kind: "valuation", gross: 30000, advance_amortized: 0, retention_held: 1500 });
  // an edit that breaks the link is refused and changes nothing
  assert.throws(() => rt.api("saveEntryAll", { kind: "update", id: e.id, fields: { amount: 28000 } }), /valuation minus/);
  assert.equal(Number(rt.rows("Entries").find((x) => x.id === e.id).amount), 28500);
});

test("ceilings: advance, advance taken back, valued, guarantee kept and given back", () => {
  const rt = companyCopy();
  const c = rt.api("saveContract", { project_id: project(rt), supplier_name: "Encofrados Lima", amount: 100000, currency: "PEN", advance_pct: 20, retention_pct: 5 });
  assert.throws(() => pay(rt, 25000, { contract_id: c.id, kind: "advance" }), /advance/);
  pay(rt, 20000, { contract_id: c.id, kind: "advance" });
  assert.throws(() => pay(rt, 1, { contract_id: c.id, kind: "advance" }), /advance/);
  assert.throws(() => pay(rt, 4000, { contract_id: c.id, kind: "valuation", gross: 30000, advance_amortized: 25000, retention_held: 1000 }), /still to take back/);
  assert.throws(() => pay(rt, 10000, { contract_id: c.id, kind: "valuation", gross: 110000, advance_amortized: 20000, retention_held: 80000 }), /contract amount/);
  pay(rt, 22500, { contract_id: c.id, kind: "valuation", gross: 30000, advance_amortized: 6000, retention_held: 1500 });
  assert.throws(() => pay(rt, 2000, { contract_id: c.id, kind: "retention_return" }), /guarantee kept/);
  pay(rt, 1500, { contract_id: c.id, kind: "retention_return" });
  const v = view(rt);
  assert.equal(v.retention_left, 0);
  assert.equal(v.advance_left, 14000);
});
