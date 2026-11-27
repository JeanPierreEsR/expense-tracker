// Business 2, piece 11: sales by stage (Sales.gs): units, their stages, collected + still to collect = price, a returned deposit, the
// Overview's sales cards. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Edificio Prueba"] });
  rt.sheet("Entries").rows.length = 1;   // only this test's own entries
  rt.run("ROWS_MEMO_ = null;");
  return rt;
}
const mon = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 7); };
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const incCat = (rt) => rt.rows("Categories").find((c) => c.type === "income").id;

function building(rt) {
  const project = rt.rows("Projects")[0];
  rt.api("addProjectUnits", { project_id: project.id, names: ["Depa 101", "Depa 102", "Depa 201"] });
  const units = rt.api("listProjectUnits", { project_id: project.id }).units;
  const u101 = units.find((u) => u.name === "Depa 101");
  rt.api("saveUnit", { id: u101.id, buyer_name: "Comprador Prueba", price: 300000, currency: "PEN", status: "Separado" });
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "reservation", amount: 10000, due_date: `${mon(-2)}-10` });
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "down_payment", amount: 50000, due_date: `${mon(0)}-20` });
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "balance", amount: 240000, due_date: `${mon(1)}-15` });
  const income = (amount, date) => rt.api("createEntry", { type: "income", date, amount, currency: "PEN", category_id: incCat(rt), description: "Abono Depa 101",
    payment_method_id: pm(rt), paid_by: "me", company_id: project.company_id, project_id: project.id, unit_id: u101.id });
  return { project, u101, income };
}
const unit = (rt, project, name) => rt.api("listProjectUnits", { project_id: project.id }).units.find((u) => u.name === name);

test("units: a project has its own units; collected + still to collect = price; the stages are paid in order without linking", () => {
  const rt = companyCopy();
  const { project, income } = building(rt);
  income(10000, `${mon(-2)}-11`);
  income(30000, `${mon(-1)}-05`);
  const u = unit(rt, project, "Depa 101");
  assert.equal(u.buyer, "Comprador Prueba");
  assert.equal(u.status, "Separado");
  assert.equal(u.collected, 40000);
  assert.equal(u.remaining, 260000);
  assert.equal(u.collected + u.remaining, u.price);
  const [res, down, bal] = u.stages;
  assert.equal(res.paid, 10000);
  assert.equal(res.state, "settled");
  assert.equal(down.paid, 30000);
  assert.equal(down.remaining, 20000);
  assert.equal(bal.paid, 0);
  assert.equal(u.payments.length, 2);
  // the project's expected-payments list reads the same
  const list = rt.api("listExpectedPayments", { project_id: project.id }).items;
  assert.equal(list.find((x) => x.id === down.id).remaining, 20000);
  // the others are units with nothing yet; units are not tags
  const all = rt.api("listProjectUnits", { project_id: project.id });
  assert.equal(all.units.length, 3);
  assert.ok(!rt.rows("Tags").some((t) => /^Depa /.test(t.name)));
});

test("a returned deposit lowers income in the month it is returned and leaves the month it came in as it was", () => {
  const rt = companyCopy();
  const { project, income } = building(rt);
  const first = income(10000, `${mon(-2)}-11`);
  const monthTotal = (m) => rt.api("getPeriodSummary", { startDate: `${m}-01`, endDate: `${m}-28` }).totals.income;
  const before = monthTotal(mon(-2));
  rt.api("returnUnitDeposit", { entry_id: first.id, amount: 10000, date: `${mon(-1)}-03` });
  assert.equal(monthTotal(mon(-2)), before, "the month it came in does not change");
  assert.equal(monthTotal(mon(-1)), -10000, "the month it went back goes down");
  const u = unit(rt, project, "Depa 101");
  assert.equal(u.collected, 0);
  assert.equal(u.stages[0].paid, 0);
  assert.ok(u.payments.some((p) => p.amount === -10000 && p.refund_of === first.id));
  assert.throws(() => rt.api("returnUnitDeposit", { entry_id: first.id, amount: 1, date: `${mon(-1)}-04` }), /1?0?\.00|máximo|most/);
});

test("the Overview's sales cards add up the units, and list what is due in the next 30 days and what is overdue", () => {
  const rt = companyCopy();
  const { project, income } = building(rt);
  income(10000, `${mon(-2)}-11`);
  const card = rt.api("getPeriodSummary", { startDate: `${mon(0)}-01`, endDate: `${mon(0)}-28` }).company.sales;
  assert.equal(card.units, 3);
  const pen = card.money.find((m) => m.currency === "PEN");
  assert.equal(pen.price, 300000);
  assert.equal(pen.collected, 10000);
  assert.equal(pen.remaining, 290000);
  assert.ok(card.statuses.some((s) => s.status === "Separado" && s.count === 1));
  const u = unit(rt, project, "Depa 101");
  assert.equal(u.collected, pen.collected);
  const dueSoon = [...card.overdue.items, ...card.next30.items];
  assert.ok(dueSoon.some((x) => x.unit === "Depa 101" && x.stage === "down_payment"));
  assert.ok(!dueSoon.some((x) => x.stage === "reservation"), "a settled stage is not expected any more");
});

test("not a company copy: refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("listProjectUnits", { project_id: "x" }));
});

// Testers 2.68.2 (Nico): the same stage saved twice made two identical rows and doubled the expected collections.
test("the same stage saved twice (same unit, stage, date, amount) is one row", () => {
  const rt = companyCopy();
  const { u101 } = building(rt);
  const before = rt.rows("Expected Payments").length;
  const again = rt.api("saveUnitStage", { unit_id: u101.id, stage: "down_payment", amount: 50000, due_date: `${mon(0)}-20` });
  assert.equal(again.repeat, true);
  assert.equal(rt.rows("Expected Payments").length, before, "no second row");
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "down_payment", amount: 20000, due_date: `${mon(2)}-20` });
  assert.equal(rt.rows("Expected Payments").length, before + 1, "a different stage payment is still added");
});

// Owner, 2026-11-24 (testers 2.68.2, Lucía): sale stages still to collect show in Projections as expected income.
test("open sale stages count in Projections in their due month, under their stage's income category", () => {
  const rt = companyCopy();
  const { u101 } = building(rt);   // down payment 50,000 due this month, balance 240,000 next month, reservation overdue
  const catOf = (key) => rt.rows("Categories").find((c) => c.key === key);
  const row = (anchorDate, key) => rt.api("listCategoryProjections", { displayPeriodType: "month", anchorDate }).categories.find((c) => c.category_id === catOf(key).id);
  const thisMonth = row(`${mon(0)}-15`, "down_payments");
  assert.ok(Math.abs(thisMonth.programmedRemainingPen - 50000) < 0.01, "the down payment due this month");
  const overdue = row(`${mon(0)}-15`, "reservation_deposits");
  assert.ok(Math.abs(overdue.programmedRemainingPen - 10000) < 0.01, "an overdue stage counts in the current month");
  const next = row(`${mon(1)}-15`, "sale_balances");
  assert.ok(Math.abs(next.programmedRemainingPen - 240000) < 0.01, "the balance next month");
  assert.ok(u101);
});

// Owner, 2026-11-27 (option B): a unit belongs to its project, so two buildings each have their "Depa 101".
test("two projects each have a Depa 101; an entry's unit must be of its project; a used unit cannot be removed", () => {
  const rt = companyCopy();
  const co = rt.rows("Companies")[0].id;
  const a = rt.rows("Projects")[0];
  const b = rt.api("addProject", { company_id: co, name: "Edificio Dos" });
  const bp = b.project || b;
  rt.api("addProjectUnits", { project_id: a.id, names: ["Depa 101", "Depa 102"] });
  const again = rt.api("addProjectUnits", { project_id: bp.id, names: ["Depa 101", "depa 101", "Depa 301"] });
  assert.deepEqual([again.added, again.skipped], [2, 1], "same name in another project is fine; twice in one is not");
  const ua = unit(rt, a, "Depa 101"), ub = unit(rt, bp, "Depa 101");
  assert.notEqual(ua.id, ub.id);
  const base = { type: "income", date: `${mon(0)}-02`, currency: "PEN", category_id: incCat(rt), payment_method_id: pm(rt), paid_by: "me", company_id: co };
  rt.api("createEntry", Object.assign({}, base, { amount: 100, project_id: a.id, unit_id: ua.id }));
  rt.api("createEntry", Object.assign({}, base, { amount: 7, project_id: bp.id, unit_id: ub.id }));
  assert.equal(unit(rt, a, "Depa 101").collected, 100);
  assert.equal(unit(rt, bp, "Depa 101").collected, 7, "each building counts its own");
  assert.throws(() => rt.api("createEntry", Object.assign({}, base, { amount: 1, project_id: a.id, unit_id: ub.id })), /project|proyecto/i);
  // an entry moved to the other project loses a unit of the old one
  const e = rt.api("createEntry", Object.assign({}, base, { amount: 5, project_id: a.id, unit_id: ua.id }));
  const id = (e.entry || e).id;
  rt.api("updateEntry", { id, fields: { project_id: bp.id, company_id: co } });
  assert.equal(rt.rows("Entries").find((x) => x.id === id).unit_id, "");
  assert.throws(() => rt.api("removeProjectUnit", { id: ua.id }), /movimiento|entr/i);
  rt.api("removeProjectUnit", { id: unit(rt, a, "Depa 102").id });
  assert.equal(unit(rt, a, "Depa 102"), undefined);
  // renamed inside its project, never onto another unit's name there
  assert.throws(() => rt.api("saveUnit", { id: unit(rt, bp, "Depa 301").id, name: "depa 101" }), /101/);
  rt.api("saveUnit", { id: unit(rt, bp, "Depa 301").id, name: "Depa 302" });
  assert.ok(unit(rt, bp, "Depa 302"), "renamed");
});

test("a copy whose units were tags is converted once: names, entries, stages; the unit tags go", () => {
  const rt = companyCopy();
  const project = rt.rows("Projects")[0];
  // the old shape, as piece 5 / 11 wrote it
  rt.api("addTagsBulk", { names: ["Depa 101", "Depa 102", "Suelto 9"] });
  const tags = Object.fromEntries(rt.rows("Tags").map((t) => [t.name, t.id]));
  const uid = "old-unit-101";
  rt.run(`ensureBusinessSheets_(); appendRowObject('Units', ${JSON.stringify({ id: uid, tag_id: tags["Depa 101"], project_id: project.id, buyer_id: "", price: 1000, currency: "PEN", status: "Separado", note: "" })});
    appendRowObject('Units', ${JSON.stringify({ id: "old-unit-102", tag_id: tags["Depa 102"], project_id: project.id, buyer_id: "", price: "", currency: "PEN", status: "", note: "" })});`);
  const inc = rt.api("createEntry", { type: "income", date: `${mon(0)}-02`, amount: 300, currency: "PEN", category_id: incCat(rt), payment_method_id: pm(rt), paid_by: "me",
    company_id: project.company_id, project_id: project.id, tag_ids: [tags["Depa 101"], tags["Suelto 9"]] });
  const incId = (inc.entry || inc).id;
  rt.run(`ensureSalesColumns_(); ensureBusinessColumn_('Expected Payments', 'unit_tag_id', true);`);
  const ep = rt.api("addExpectedPayment", { project_id: project.id, amount: 500, currency: "PEN", due_date: `${mon(1)}-10`, note: "x" });
  rt.run(`updateRowFields_('Expected Payments', ${JSON.stringify(ep.id)}, { unit_tag_id: ${JSON.stringify(tags["Depa 101"])}, stage: 'down_payment' }); ROWS_MEMO_ = null;`);
  rt.run("setSetting_('units_model', '')");

  const u = unit(rt, project, "Depa 101");   // listProjectUnits converts first
  assert.equal(u.id, uid);
  assert.equal(u.collected, 300, "its tagged income is now its own");
  assert.equal(u.stages.length, 1, "its stage too");
  assert.equal(rt.rows("Entries").find((e) => e.id === incId).unit_id, uid);
  const left = rt.rows("Tags").map((t) => t.name);
  assert.ok(!left.includes("Depa 101") && !left.includes("Depa 102"), "the unit tags go");
  assert.ok(left.includes("Suelto 9"), "an ordinary tag stays, and stays on the entry");
  assert.ok(rt.rows("Entry Tags").some((et) => et.entry_id === incId && et.tag_id === tags["Suelto 9"]));
  assert.equal(rt.rows("Settings").find((r) => r.key === "units_model").value, "2");
  assert.equal(rt.api("getMeta", {}).units.filter((x) => x.project_id === project.id).length, 2);
});
