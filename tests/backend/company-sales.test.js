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
  rt.api("addTagsBulk", { names: ["Depa 101", "Depa 102", "Depa 201"] });
  const tags = rt.rows("Tags").filter((t) => /^Depa /.test(t.name));
  rt.api("addProjectUnits", { project_id: project.id, tag_ids: tags.map((t) => t.id) });
  const units = rt.api("listProjectUnits", { project_id: project.id }).units;
  const u101 = units.find((u) => u.name === "Depa 101");
  rt.api("saveUnit", { id: u101.id, buyer_name: "Comprador Prueba", price: 300000, currency: "PEN", status: "Separado" });
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "reservation", amount: 10000, due_date: `${mon(-2)}-10` });
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "down_payment", amount: 50000, due_date: `${mon(0)}-20` });
  rt.api("saveUnitStage", { unit_id: u101.id, stage: "balance", amount: 240000, due_date: `${mon(1)}-15` });
  const tag101 = tags.find((t) => t.name === "Depa 101").id;
  const income = (amount, date) => rt.api("createEntry", { type: "income", date, amount, currency: "PEN", category_id: incCat(rt), description: "Abono Depa 101",
    payment_method_id: pm(rt), paid_by: "me", company_id: project.company_id, project_id: project.id, tag_ids: [tag101] });
  return { project, u101, tag101, income };
}
const unit = (rt, project, name) => rt.api("listProjectUnits", { project_id: project.id }).units.find((u) => u.name === name);

test("units: a project takes tags as units; collected + still to collect = price; the stages are paid in order without linking", () => {
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
  // the other tags are units with nothing yet; a tag already taken is not offered again
  const all = rt.api("listProjectUnits", { project_id: project.id });
  assert.equal(all.units.length, 3);
  assert.ok(!all.unassigned_tags.some((t) => /^Depa /.test(t.name)));
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
