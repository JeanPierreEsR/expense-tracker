// Business pack, step 3B (specs/business.md § Step 3): optional IGV per company, the IGV inside an entry, totals without IGV
// on the business screens only, the company's IGV screen and information-only IGV payments. Made-up data on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup(opts = {}) {
  const { rt } = freshApp({ entries: 30 });
  rt.run(`appendRowObject('Categories', { id: 'cat-x', name: 'Materials test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-y', name: 'Fees test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  if (opts.on !== false) rt.api("setBusinessFeatures", { on: true });
  return rt;
}
const company = (rt, over = {}) => rt.api("addCompany", { name: "Studio A", igv_enabled: true, tax_id: "20123456789", ...over });
const project = (rt, company_id, name = "Casa Lima") => rt.api("addProject", { company_id, name });
const base = { date: "2026-10-05", currency: "PEN", paid_by: "me" };
const income = (rt, proj, amount, over = {}) =>
  rt.api("createEntry", { type: "income", ...base, category_id: "cat-y", amount, description: "Fee", project_id: proj.id, ...over });
const cost = (rt, proj, amount, over = {}) =>
  rt.api("createEntry", { type: "expense", ...base, category_id: "cat-x", amount, description: "Plotter", project_id: proj.id, ...over });
const entryRow = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("OFF: IGV is ignored, no IGV tab or column is created and every IGV action refuses", () => {
  const rt = setup({ on: false });
  for (const action of ["getCompanyIgv", "addIgvPayment", "updateIgvPayment", "deleteIgvPayment"]) {
    assert.throws(() => rt.api(action, { id: "x", company_id: "c", amount: 1, date: "2026-10-01" }), /turned off/i, action);
  }
  const e = rt.api("createEntry", { type: "income", ...base, category_id: "cat-y", amount: 100, igv_amount: 15 });
  assert.ok(!e.igv_amount);
  assert.ok(!rt.run(`getHeaders(getSheet('Entries'))`).includes("igv_amount"));
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('IGV Payments')`));
});

test("a company can charge IGV and keep a Tax ID as text; leaving the keys out keeps what is stored", () => {
  const rt = setup();
  const co = company(rt, { tax_id: "  0123456789  " });
  assert.equal(co.igv_enabled, "yes");
  assert.equal(co.tax_id, "0123456789");
  rt.api("updateCompany", { id: co.id, name: "Studio A", emoji: "" });          // an older phone: no IGV keys
  const kept = rt.api("getMeta", {}).companies.find((c) => c.id === co.id);
  assert.equal(kept.igv_enabled, "yes");
  assert.equal(String(kept.tax_id), "0123456789", "the leading zero survived");
  rt.api("updateCompany", { id: co.id, name: "Studio A", igv_enabled: false });
  assert.equal(rt.api("getMeta", {}).companies.find((c) => c.id === co.id).igv_enabled, "");
  const plain = rt.api("addCompany", { name: "Studio B" });
  assert.ok(!plain.igv_enabled, "off by default");
});

test("an entry carries the IGV inside its amount; a figure that cannot be right is refused, a personal entry keeps none", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  const e = income(rt, casa, 1180, { igv_amount: 180 });
  assert.equal(Number(entryRow(rt, e.id).igv_amount), 180);
  assert.equal(Number(entryRow(rt, e.id).amount), 1180, "the amount itself never changes");
  assert.throws(() => income(rt, casa, 100, { igv_amount: 100 }), /less than the amount/i);
  assert.throws(() => income(rt, casa, 100, { igv_amount: 150 }), /less than the amount/i);
  const noIgv = income(rt, casa, 100, { igv_amount: 0 });
  assert.ok(!entryRow(rt, noIgv.id).igv_amount);
  const personal = rt.api("createEntry", { type: "income", ...base, category_id: "cat-y", amount: 100, igv_amount: 15 });
  assert.ok(!entryRow(rt, personal.id).igv_amount, "no company: no IGV");
});

test("updating an entry changes, keeps or clears its IGV; a transfer or a personal entry never keeps one", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  const e = cost(rt, casa, 118, { igv_amount: 18 });
  rt.api("updateEntry", { id: e.id, fields: { description: "Plotter 2" } });
  assert.equal(Number(entryRow(rt, e.id).igv_amount), 18, "an edit that does not touch the link keeps it");
  rt.api("updateEntry", { id: e.id, fields: { project_id: casa.id, company_id: casa.company_id, igv_amount: 20 } });
  assert.equal(Number(entryRow(rt, e.id).igv_amount), 20);
  assert.throws(() => rt.api("updateEntry", { id: e.id, fields: { project_id: casa.id, company_id: casa.company_id, igv_amount: 500 } }), /less than the amount/i);
  rt.api("updateEntry", { id: e.id, fields: { project_id: casa.id, company_id: casa.company_id, igv_amount: "" } });
  assert.ok(!entryRow(rt, e.id).igv_amount, "the form sends blank to switch it off");
  rt.api("updateEntry", { id: e.id, fields: { project_id: casa.id, company_id: casa.company_id, igv_amount: 18 } });
  rt.api("updateEntry", { id: e.id, fields: { project_id: "", company_id: "", igv_amount: 18 } });
  assert.ok(!entryRow(rt, e.id).igv_amount, "moved to personal: no IGV");
  rt.api("updateEntry", { id: e.id, fields: { project_id: casa.id, company_id: casa.company_id, igv_amount: 18 } });
  rt.api("updateEntry", { id: e.id, fields: { type: "transfer" } });
  assert.ok(!entryRow(rt, e.id).igv_amount, "a transfer carries no IGV");
});

test("project and company screens show totals WITHOUT IGV; the entry and every other screen keep the full amount", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  income(rt, casa, 1180, { igv_amount: 180 });
  cost(rt, casa, 236, { igv_amount: 36 });
  cost(rt, casa, 100);                                   // no IGV on this one (a market receipt)
  const p = rt.api("getProjectDetail", { id: casa.id, today: "2026-10-15" });
  const pen = p.currencies.find((c) => c.currency === "PEN");
  assert.equal(pen.income, 1000);
  assert.equal(pen.costs, 300);                          // 200 + 100
  assert.equal(pen.margin, 700);
  assert.deepEqual(pen.igv, { collected: 180, credit: 36, position: 144 });
  assert.equal(p.byCategory.income.PEN[0].amount, 1000);
  assert.equal(p.byCategory.expense.PEN[0].amount, 300);
  const c = rt.api("getCompanyDetail", { id: co.id, today: "2026-10-15" });
  assert.equal(c.currencies.find((x) => x.currency === "PEN").margin, 700);
  assert.equal(c.projects[0].currencies.find((x) => x.currency === "PEN").igv.position, 144);
  const list = rt.api("listCompaniesAndProjects", {});
  assert.equal(list[0].currencies.find((x) => x.currency === "PEN").income, 1000);
  // the entries themselves, and the screens that are not business ones, still see what was paid
  const listed = rt.api("listEntries", { projectId: casa.id });
  assert.deepEqual(listed.map((e) => Number(e.amount)).sort((a, b) => a - b), [100, 236, 1180]);
  // Overview keeps the full amount paid: IGV is not subtracted there (the seeded entries sit in other months, so only ours count)
  const summary = rt.api("getPeriodSummary", { startDate: "2026-10-05", endDate: "2026-10-05" });
  assert.equal(summary.totals.income, 1180);
  assert.equal(summary.totals.expense, 336);
});

test("without any IGV a screen looks exactly as before (no igv key on the currency cards)", () => {
  const rt = setup();
  const casa = project(rt, company(rt, { igv_enabled: false }).id);
  income(rt, casa, 500);
  const pen = rt.api("getProjectDetail", { id: casa.id, today: "2026-10-15" }).currencies.find((c) => c.currency === "PEN");
  assert.equal(pen.igv, undefined);
  assert.equal(pen.income, 500);
});

test("IGV follows the owner's share of a split: a client who repays part of a cost carries that part of its IGV", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  const ana = rt.api("addFriend", { name: "Ana Client", role: "client" });
  const e = cost(rt, casa, 118, { igv_amount: 18 });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: ana.id, amount: 59 }] });   // half is hers
  const pen = rt.api("getProjectDetail", { id: casa.id, today: "2026-10-15" }).currencies.find((c) => c.currency === "PEN");
  assert.equal(pen.costs, 50, "my 59, minus my 9 of the IGV");
  assert.equal(pen.igv.credit, 9);
});

test("each currency keeps its own IGV; nothing is converted", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1180, { igv_amount: 180 });
  income(rt, casa, 590, { igv_amount: 90, currency: "USD" });
  const p = rt.api("getProjectDetail", { id: casa.id, today: "2026-10-15" });
  assert.equal(p.currencies.find((c) => c.currency === "USD").igv.collected, 90);
  assert.equal(p.currencies.find((c) => c.currency === "PEN").igv.collected, 180);
});

test("the company's IGV screen: per month and currency, yearly totals, payments are information only", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  income(rt, casa, 1180, { igv_amount: 180, date: "2026-09-10" });
  income(rt, casa, 590, { igv_amount: 90, date: "2026-10-12" });
  cost(rt, casa, 236, { igv_amount: 36, date: "2026-10-03" });
  income(rt, casa, 118, { igv_amount: 18, date: "2025-12-20" });
  const before = rt.rows("Entries").length;
  const pay = rt.api("addIgvPayment", { company_id: co.id, date: "2026-10-18", amount: 100, currency: "PEN", note: "September" });
  assert.equal(rt.rows("Entries").length, before, "a payment to the tax office is not an entry, nor an expense");
  assert.equal(rt.rows("IGV Payments")[0].date, "2026-10-18", "text date, not a Sheets Date");

  const igv = rt.api("getCompanyIgv", { id: co.id, year: "2026" });
  assert.equal(igv.rate, 18);
  assert.equal(igv.company.tax_id, "20123456789");
  assert.deepEqual(igv.months.map((m) => m.month), ["2026-10", "2026-09"], "newest first, only months with IGV");
  assert.deepEqual(igv.months[0].lines, [{ currency: "PEN", collected: 90, credit: 36, position: 54 }]);
  assert.deepEqual(igv.totals, [{ currency: "PEN", collected: 270, credit: 36, position: 234, paid: 100, balance: 134 }]);
  assert.equal(igv.payments.length, 1);
  assert.ok(igv.years.includes("2025") && igv.years.includes("2026"));
  assert.equal(rt.api("getCompanyIgv", { id: co.id, year: "2025" }).totals[0].collected, 18);

  rt.api("updateIgvPayment", { id: pay.id, date: "2026-10-18", amount: 120, currency: "PEN", note: "" });
  assert.equal(rt.api("getCompanyIgv", { id: co.id, year: "2026" }).totals[0].paid, 120);
  assert.throws(() => rt.api("addIgvPayment", { company_id: co.id, date: "2026-10-18", amount: 0 }), /valid amount/i);
  assert.throws(() => rt.api("addIgvPayment", { company_id: co.id, date: "", amount: 5 }), /date/i);
  assert.throws(() => rt.api("addIgvPayment", { company_id: "ghost", date: "2026-10-18", amount: 5 }), /Company not found/i);
  rt.api("deleteIgvPayment", { id: pay.id });
  assert.equal(rt.api("getCompanyIgv", { id: co.id, year: "2026" }).payments.length, 0);
});

test("an entry that is not confirmed or has no IGV never reaches the IGV screen", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  income(rt, casa, 500);
  const igv = rt.api("getCompanyIgv", { id: co.id });
  assert.deepEqual(igv.months, []);
  assert.deepEqual(igv.totals, []);
});

test("an expected payment can say its amount includes IGV; the flag is listed and the income form can read it", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  const x = rt.api("addExpectedPayment", { project_id: casa.id, amount: 1180, currency: "PEN", due_date: "2026-11-15", igv_included: true });
  assert.equal(x.igv_included, true);
  const plain = rt.api("addExpectedPayment", { project_id: casa.id, amount: 100, currency: "PEN", due_date: "2026-11-16" });
  assert.equal(plain.igv_included, false);
  assert.equal(rt.api("listExpectedPayments", { project_id: casa.id, today: "2026-10-15" }).items.find((i) => i.id === x.id).igv_included, true);
});

test("the backup and the CSV carry the new tab and the IGV column; deleting a company removes its payments", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  income(rt, casa, 1180, { igv_amount: 180 });
  assert.ok(rt.run(`EXPORT_BACKUP_TABS_.indexOf('IGV Payments') !== -1`));
  assert.ok(rt.run(`STRUCTURE_SHEETS_['IGV Payments'] === true`));
  const csv = rt.run(`buildEntriesCsv_({}).text`);
  const header = csv.split("\r\n")[0];
  assert.match(header, /Company,Project,IGV included/);
  const igvCol = header.split(",").indexOf("IGV included");
  assert.ok(csv.split("\r\n").some((line) => line.split(",")[igvCol] === "180.00"));
  const lone = rt.api("addCompany", { name: "Lone Co" });
  rt.api("addIgvPayment", { company_id: lone.id, date: "2026-10-01", amount: 10, currency: "PEN" });
  rt.api("deleteCompany", { id: lone.id });
  assert.equal(rt.rows("IGV Payments").length, 0);
});
