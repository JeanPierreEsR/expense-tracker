// Business pack, step 4 (specs/business.md § Step 4): opening figures typed "as of" a date, and the rule that entries dated on or
// before that date stop counting on the business screens. Made-up data on the fake Google layer.
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
const company = (rt, over = {}) => rt.api("addCompany", { name: "Studio A", igv_enabled: true, ...over });
const project = (rt, company_id, name = "Casa Lima") => rt.api("addProject", { company_id, name });
const base = { currency: "PEN", paid_by: "me" };
const income = (rt, proj, amount, date, over = {}) =>
  rt.api("createEntry", { type: "income", ...base, date, category_id: "cat-y", amount, description: "Fee", project_id: proj.id, ...over });
const cost = (rt, proj, amount, date, over = {}) =>
  rt.api("createEntry", { type: "expense", ...base, date, category_id: "cat-x", amount, description: "Plotter", project_id: proj.id, ...over });
const card = (detail, cur = "PEN") => detail.currencies.find((c) => c.currency === cur);
const opening = (rt, proj, over = {}) =>
  rt.api("saveBusinessOpening", { project_id: proj.id, currency: "PEN", as_of: "2026-06-30", income: 10000, igv_collected: 1800, costs: 4000, igv_credit: 720, ...over });

test("OFF: every opening action refuses and no opening tab is created", () => {
  const rt = setup({ on: false });
  for (const action of ["saveBusinessOpening", "deleteBusinessOpening", "getOpeningImpact"]) {
    assert.throws(() => rt.api(action, { id: "x", project_id: "p", as_of: "2026-06-30" }), /turned off/i, action);
  }
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Business Openings')`));
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Accountant Figures')`));
});

test("typed figures join 'All time'; entries on or before the date stop counting, later ones count", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 500, "2026-05-10");          // before the opening: already inside it
  cost(rt, casa, 200, "2026-06-30");            // ON the date: also inside it
  income(rt, casa, 1000, "2026-07-01");         // after: counts
  cost(rt, casa, 300, "2026-08-15");
  const saved = opening(rt, casa);
  assert.equal(saved.ignored, 2, "the answer says how many entries stopped counting");
  const all = card(rt.api("getProjectDetail", { id: casa.id }));
  assert.equal(all.income, 11000);               // 10,000 typed + 1,000
  assert.equal(all.costs, 4300);                 // 4,000 typed + 300
  assert.equal(all.margin, 6700);
  assert.deepEqual(all.igv, { collected: 1800, credit: 720, position: 1080 });
  assert.equal(rt.api("getProjectDetail", { id: casa.id }).openings.length, 1);
});

test("the typed figures count only in a period that contains their date", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-07-01");
  cost(rt, casa, 300, "2026-08-15");
  opening(rt, casa);
  const after = card(rt.api("getProjectDetail", { id: casa.id, startDate: "2026-07-01", endDate: "2026-12-31" }));
  assert.equal(after.income, 1000, "a period that starts after the date does not include the lump");
  assert.equal(after.costs, 300);
  const around = card(rt.api("getProjectDetail", { id: casa.id, startDate: "2026-01-01", endDate: "2026-12-31" }));
  assert.equal(around.income, 11000, "a period that contains the date does");
  const before = rt.api("getProjectDetail", { id: casa.id, startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.equal(card(before), undefined, "a period that ends before the date has neither the lump nor the (excluded) entries");
});

test("an opening only affects its own currency and its own project", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  const otra = project(rt, co.id, "Otra");
  income(rt, casa, 100, "2026-05-01");
  income(rt, casa, 50, "2026-05-02", { currency: "USD" });
  income(rt, otra, 70, "2026-05-03");
  opening(rt, casa);
  const d = rt.api("getProjectDetail", { id: casa.id });
  assert.equal(card(d, "USD").income, 50, "the dollar entry is not covered by a soles opening");
  assert.equal(card(rt.api("getProjectDetail", { id: otra.id })).income, 70, "another project is untouched");
  assert.equal(card(d, "PEN").income, 10000);
});

test("saving again replaces the opening for that project and currency; another currency is its own opening", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  const first = opening(rt, casa);
  const second = opening(rt, casa, { income: 12000, as_of: "2026-07-31" });
  assert.equal(second.opening.id, first.opening.id);
  assert.equal(rt.rows("Business Openings").length, 1);
  assert.equal(rt.rows("Business Openings")[0].as_of, "2026-07-31", "a text date, not a Sheets Date");
  rt.api("saveBusinessOpening", { project_id: casa.id, currency: "USD", as_of: "2026-06-30", income: 5 });
  assert.equal(rt.rows("Business Openings").length, 2);
});

test("a company-level opening covers entries with a company and no project; the company screen adds up everything", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  rt.api("createEntry", { type: "expense", ...base, date: "2026-05-05", category_id: "cat-x", amount: 90, description: "Rent", company_id: co.id });
  rt.api("createEntry", { type: "expense", ...base, date: "2026-09-05", category_id: "cat-x", amount: 40, description: "Rent", company_id: co.id });
  income(rt, casa, 1000, "2026-09-01");
  rt.api("saveBusinessOpening", { company_id: co.id, currency: "PEN", as_of: "2026-06-30", costs: 800 });
  opening(rt, casa, { income: 3000, costs: 0, igv_collected: 0, igv_credit: 0 });
  const d = rt.api("getCompanyDetail", { id: co.id });
  assert.equal(card(d).income, 4000, "the project's lump + its entry");
  assert.equal(card(d).costs, 840, "the company-level lump + the later rent; the May rent is inside the lump");
  assert.equal(card(d.companyLevel).costs, 840);
  assert.equal(d.openings.length, 1, "the company screen lists its own level's opening");
  const list = rt.api("listCompaniesAndProjects", {}).find((c) => c.id === co.id);
  assert.equal(card(list).income, 4000);
  assert.equal(card(list.projects[0]).income, 4000);
});

test("everything else keeps counting every entry: the list, Overview and the IGV screen", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1180, "2026-05-10", { igv_amount: 180 });
  income(rt, casa, 590, "2026-07-10", { igv_amount: 90 });
  opening(rt, casa, { igv_collected: 0, igv_credit: 0, income: 0, costs: 0 });
  assert.equal(rt.api("listEntries", { projectId: casa.id }).length, 2, "the entry rows are untouched");
  const igv = rt.api("getCompanyIgv", { id: casa.company_id, year: "2026" });
  assert.equal(igv.totals[0].collected, 270, "the IGV screen counts both invoices");
  assert.equal(card(rt.api("getProjectDetail", { id: casa.id })).income, 500, "the project screen counts only the later one");
});

test("deleting an opening brings its entries back and says how many; deleting a project or company removes its openings", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  income(rt, casa, 100, "2026-05-01");
  income(rt, casa, 200, "2026-06-01");
  const saved = opening(rt, casa, { income: 0, costs: 0, igv_collected: 0, igv_credit: 0 });
  assert.equal(card(rt.api("getProjectDetail", { id: casa.id })).income, 0);
  const gone = rt.api("deleteBusinessOpening", { id: saved.opening.id });
  assert.equal(gone.restored, 2);
  assert.equal(card(rt.api("getProjectDetail", { id: casa.id })).income, 300);
  assert.throws(() => rt.api("deleteBusinessOpening", { id: saved.opening.id }), /not found/i);
  opening(rt, casa);
  const empty = company(rt, { name: "Studio B" });
  rt.api("saveBusinessOpening", { company_id: empty.id, currency: "PEN", as_of: "2026-06-30" });
  assert.equal(rt.rows("Business Openings").length, 2);
  rt.api("deleteProject", { id: casa.id });
  assert.equal(rt.rows("Business Openings").length, 1, "the project's opening went with it");
  rt.api("deleteCompany", { id: empty.id });
  assert.equal(rt.rows("Business Openings").length, 0, "and the company's own level goes with the company");
});

test("a figure that cannot be right is refused; the impact preview counts what a date would cover", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 100, "2026-05-01");
  income(rt, casa, 100, "2026-07-01");
  assert.throws(() => opening(rt, casa, { costs: -5 }), /zero or more/i);
  assert.throws(() => opening(rt, casa, { income: "abc" }), /zero or more/i);
  assert.throws(() => opening(rt, casa, { as_of: "2999-01-01" }), /future/i);
  assert.throws(() => opening(rt, casa, { as_of: "nope" }), /date/i);
  assert.throws(() => opening(rt, casa, { currency: "XX" }), /currency/i);
  assert.throws(() => rt.api("saveBusinessOpening", { as_of: "2026-06-30" }), /project or a company/i);
  assert.throws(() => rt.api("saveBusinessOpening", { project_id: "nope", as_of: "2026-06-30" }), /not found/i);
  assert.equal(rt.rows("Business Openings").length, 0, "nothing was saved");
  assert.equal(rt.api("getOpeningImpact", { project_id: casa.id, currency: "PEN", as_of: "2026-06-30" }).ignored, 1);
  assert.equal(rt.api("getOpeningImpact", { project_id: casa.id, currency: "PEN", as_of: "2026-12-31" }).ignored, 2);
  assert.equal(rt.api("getOpeningImpact", { project_id: casa.id, currency: "PEN", as_of: "" }).ignored, 0);
});

test("the new tabs are in the backup and the structure list, and a project's stale company never disagrees", () => {
  const rt = setup();
  assert.ok(rt.run(`EXPORT_BACKUP_TABS_.indexOf('Business Openings') !== -1 && EXPORT_BACKUP_TABS_.indexOf('Accountant Figures') !== -1`));
  assert.ok(rt.run(`STRUCTURE_SHEETS_['Business Openings'] === true && STRUCTURE_SHEETS_['Accountant Figures'] === true`));
  const co = company(rt);
  const casa = project(rt, co.id);
  opening(rt, casa);
  rt.run(`(function(){ var s = getSheet('Business Openings'); var h = getHeaders(s); setCellByRow_(s, h, 2, 'company_id', 'stale'); })()`);
  assert.equal(rt.api("getProjectDetail", { id: casa.id }).openings[0].company_id, co.id);
});
