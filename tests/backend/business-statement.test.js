// Business pack, step 4 (specs/business.md § Step 4): the Project / Company statement — Opening · Movements · Closing per currency,
// and "right now". Made-up data on the fake Google layer.
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
const block = (st, cur = "PEN") => st.currencies.find((c) => c.currency === cur);
const card = (detail, cur = "PEN") => detail.currencies.find((c) => c.currency === cur);
const opening = (rt, proj, over = {}) =>
  rt.api("saveBusinessOpening", { project_id: proj.id, currency: "PEN", as_of: "2026-06-30", income: 10000, igv_collected: 1800, costs: 4000, igv_credit: 720, ...over });

test("OFF: the statements refuse", () => {
  const rt = setup({ on: false });
  assert.throws(() => rt.api("getProjectStatement", { id: "x" }), /turned off/i);
  assert.throws(() => rt.api("getCompanyStatement", { id: "x" }), /turned off/i);
});

test("with no opening, All time starts from zero and closes where the project screen stands", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1180, "2026-07-01", { igv_amount: 180 });
  cost(rt, casa, 236, "2026-08-01", { igv_amount: 36 });
  const st = rt.api("getProjectStatement", { id: casa.id });
  const b = block(st);
  assert.deepEqual(b.opening, { income: 0, igv_collected: 0, costs: 0, igv_credit: 0, result: 0 });
  assert.deepEqual(b.movements, { income: 1000, igv_collected: 180, costs: 200, igv_credit: 36, result: 800 });
  assert.deepEqual(b.closing, b.movements);
  const screen = card(rt.api("getProjectDetail", { id: casa.id }));
  assert.equal(b.closing.income, screen.income);
  assert.equal(b.closing.result, screen.margin);
  assert.equal(st.coveredEntries, 0);
  assert.deepEqual(st.lumps, []);
});

test("with an opening, All time opens with the typed figures and closes where the project screen stands", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 500, "2026-05-10");   // inside the opening
  income(rt, casa, 1000, "2026-07-01");
  cost(rt, casa, 300, "2026-08-15");
  opening(rt, casa);
  const st = rt.api("getProjectStatement", { id: casa.id });
  const b = block(st);
  assert.deepEqual(b.opening, { income: 10000, igv_collected: 1800, costs: 4000, igv_credit: 720, result: 6000 });
  assert.equal(b.movements.income, 1000);
  assert.equal(b.movements.costs, 300);
  assert.equal(b.closing.income, 11000);
  assert.equal(b.closing.result, 6700);
  const screen = card(rt.api("getProjectDetail", { id: casa.id }));
  assert.equal(b.closing.income, screen.income);
  assert.equal(b.closing.costs, screen.costs);
  assert.equal(b.closing.result, screen.margin);
  assert.equal(st.coveredEntries, 1, "one entry is inside the typed opening and says so");
  assert.equal(st.lumps[0].where, "opening");
});

test("a period that starts after the opening carries it forward; its movements are what the project screen shows", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-07-10");
  cost(rt, casa, 300, "2026-08-15");
  income(rt, casa, 200, "2026-09-02");
  opening(rt, casa);
  const st = rt.api("getProjectStatement", { id: casa.id, startDate: "2026-08-01", endDate: "2026-12-31" });
  const b = block(st);
  assert.equal(b.opening.income, 11000, "typed 10,000 + the July invoice");
  assert.equal(b.opening.costs, 4000);
  assert.equal(b.movements.income, 200);
  assert.equal(b.movements.costs, 300);
  assert.equal(b.closing.income, 11200);
  assert.equal(b.closing.result, 6900);
  const screen = card(rt.api("getProjectDetail", { id: casa.id, startDate: "2026-08-01", endDate: "2026-12-31" }));
  assert.equal(b.movements.income, screen.income);
  assert.equal(b.movements.costs, screen.costs);
  assert.equal(b.movements.result, screen.margin);
});

test("a period that contains the opening date shows the typed figures among its movements, like the project screen", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-07-10");
  opening(rt, casa);
  const period = { startDate: "2026-01-01", endDate: "2026-12-31" };
  const b = block(rt.api("getProjectStatement", { id: casa.id, ...period }));
  assert.equal(b.opening.income, 0);
  assert.equal(b.movements.income, 11000);
  assert.equal(b.movements.income, card(rt.api("getProjectDetail", { id: casa.id, ...period })).income);
  assert.equal(rt.api("getProjectStatement", { id: casa.id, ...period }).lumps[0].where, "movements");
});

test("a period that ends before the opening shows nothing: the entries and the typed figures both belong to the opening", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-03-10");
  opening(rt, casa);
  const st = rt.api("getProjectStatement", { id: casa.id, startDate: "2026-01-01", endDate: "2026-03-31" });
  assert.deepEqual(st.currencies, []);
  assert.deepEqual(st.lumps, []);
});

test("an 'as of' date closes the statement there: later entries are left out", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-07-10");
  income(rt, casa, 700, "2026-09-10");
  opening(rt, casa);
  const b = block(rt.api("getProjectStatement", { id: casa.id, endDate: "2026-08-31" }));
  assert.equal(b.closing.income, 11000);
});

test("the company statement adds its projects and its own level; each currency has its own block", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  const otra = project(rt, co.id, "Otra");
  income(rt, casa, 1000, "2026-07-01");
  income(rt, otra, 400, "2026-07-02", { currency: "USD" });
  rt.api("createEntry", { type: "expense", ...base, date: "2026-07-03", category_id: "cat-x", amount: 60, description: "Rent", company_id: co.id });
  opening(rt, casa, { income: 2000, costs: 0, igv_collected: 0, igv_credit: 0 });
  rt.api("saveBusinessOpening", { company_id: co.id, currency: "PEN", as_of: "2026-06-30", costs: 500 });
  const st = rt.api("getCompanyStatement", { id: co.id });
  assert.deepEqual(st.currencies.map((c) => c.currency), ["PEN", "USD"]);
  assert.equal(block(st).closing.income, 3000);
  assert.equal(block(st).closing.costs, 560);
  assert.equal(block(st, "USD").closing.income, 400);
  const screen = card(rt.api("getCompanyDetail", { id: co.id }));
  assert.equal(block(st).closing.income, screen.income);
  assert.equal(block(st).closing.result, screen.margin);
  assert.equal(st.openings.length, 2);
  assert.equal(st.openings.find((o) => o.project_id).project_name, "Casa Lima");
});

test("right now: who owes what on the project and what is still expected, never counted as income", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  const otra = project(rt, co.id, "Otra");
  const ana = rt.api("addFriend", { name: "Ana", role: "client" });
  const carlos = rt.api("addFriend", { name: "Carlos", role: "supplier" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 400, currency: "USD", date: "2026-10-01", project_id: casa.id });
  rt.api("addLoan", { friend_id: carlos.id, direction: "i_owe_them", amount: 500, currency: "PEN", date: "2026-10-01", project_id: casa.id });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 90, currency: "PEN", date: "2026-10-01", project_id: otra.id });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 33, currency: "PEN", date: "2026-10-01" });   // personal: never here
  rt.api("addExpectedPayment", { project_id: casa.id, amount: 1180, currency: "PEN", due_date: "2026-11-15", invoice_no: "F001-9" });
  const st = rt.api("getProjectStatement", { id: casa.id });
  const byName = Object.fromEntries(st.rightNow.people.map((p) => [p.name, p.balances]));
  assert.deepEqual(byName.Ana, [{ currency: "USD", net: 400 }]);
  assert.deepEqual(byName.Carlos, [{ currency: "PEN", net: -500 }]);
  assert.equal(st.rightNow.expected.items.length, 1);
  assert.deepEqual(st.rightNow.expected.totals, [{ currency: "PEN", remaining: 1180 }]);
  assert.deepEqual(st.currencies, [], "an expected payment and a debt are not income or cost");
  const all = rt.api("getCompanyStatement", { id: co.id }).rightNow.people.find((p) => p.name === "Ana");
  assert.deepEqual(all.balances, [{ currency: "PEN", net: 90 }, { currency: "USD", net: 400 }], "the company adds its projects (not the personal loan)");
});

test("a cost the client repays in full leaves the statement's costs at the owner's share", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  const ana = rt.api("addFriend", { name: "Ana", role: "client" });
  const e = cost(rt, casa, 100, "2026-07-01");
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: ana.id, amount: 100 }] });
  income(rt, casa, 50, "2026-07-02");
  const b = block(rt.api("getProjectStatement", { id: casa.id }));
  assert.equal(b.closing.costs, 0);
  assert.equal(b.closing.income, 50);
});

// ---- Compare with the accountant ----
const acct = (rt, proj, over = {}) =>
  rt.api("saveAccountantFigures", { project_id: proj.id, currency: "PEN", as_of: "2026-08-31", income: 11000, igv_collected: 1800, costs: 4300, igv_credit: 720, ...over });

test("OFF: the accountant's figures refuse and no tab is created", () => {
  const rt = setup({ on: false });
  assert.throws(() => rt.api("saveAccountantFigures", { project_id: "p", as_of: "2026-08-31" }), /turned off/i);
  assert.throws(() => rt.api("deleteAccountantFigures", { id: "x" }), /turned off/i);
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Accountant Figures')`));
});

test("the app's figures at the accountant's date are shown with the difference per line; a match is exact to the cent", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-07-01");
  cost(rt, casa, 300, "2026-08-15");
  income(rt, casa, 900, "2026-09-20");   // after the accountant's date: not part of the comparison
  opening(rt, casa);
  acct(rt, casa);
  let cmp = rt.api("getProjectStatement", { id: casa.id }).accountant;
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0].status, "match");
  assert.deepEqual(cmp[0].app, { income: 11000, igv_collected: 1800, costs: 4300, igv_credit: 720, result: 6700 });
  assert.deepEqual(cmp[0].diff, { income: 0, igv_collected: 0, costs: 0, igv_credit: 0, result: 0 });
  acct(rt, casa, { income: 11250, costs: 4300 });
  cmp = rt.api("getProjectStatement", { id: casa.id }).accountant;
  assert.equal(cmp.length, 1, "the same date replaces the earlier set");
  assert.equal(cmp[0].status, "differs");
  assert.equal(cmp[0].diff.income, -250, "the app is 250 below the accountant");
  assert.equal(cmp[0].diff.result, -250);
});

test("a date before the opening cannot be compared and says so; other dates and currencies are separate sets", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1000, "2026-07-01");
  opening(rt, casa);
  acct(rt, casa, { as_of: "2026-03-31" });
  acct(rt, casa, { as_of: "2026-12-31", income: 11000, costs: 4000, igv_collected: 1800, igv_credit: 720 });
  acct(rt, casa, { as_of: "2026-12-31", currency: "USD", income: 5 });
  const cmp = rt.api("getProjectStatement", { id: casa.id }).accountant;
  assert.equal(cmp.length, 3);
  assert.equal(cmp[cmp.length - 1].status, "beforeOpening");
  assert.equal(cmp[cmp.length - 1].app, undefined);
  const usd = cmp.find((c) => c.currency === "USD");
  assert.equal(usd.status, "differs");
  assert.equal(usd.app.income, 0, "no dollars in the app: a zero, not an error");
});

test("without any opening the comparison simply uses every entry up to the date", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id);
  income(rt, casa, 1180, "2026-07-01", { igv_amount: 180 });
  acct(rt, casa, { as_of: "2026-07-31", income: 1000, igv_collected: 180, costs: 0, igv_credit: 0 });
  assert.equal(rt.api("getProjectStatement", { id: casa.id }).accountant[0].status, "match");
});

test("the company statement keeps its own comparison; delete removes it; invalid input is refused", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id);
  income(rt, casa, 1000, "2026-07-01");
  const saved = rt.api("saveAccountantFigures", { company_id: co.id, currency: "PEN", as_of: "2026-07-31", income: 1000 });
  acct(rt, casa, { as_of: "2026-07-31", income: 1 });
  assert.equal(rt.api("getCompanyStatement", { id: co.id }).accountant.length, 1, "a project's set is not the company's");
  assert.equal(rt.api("getCompanyStatement", { id: co.id }).accountant[0].status, "match");
  assert.equal(rt.api("getProjectStatement", { id: casa.id }).accountant.length, 1);
  assert.throws(() => rt.api("saveAccountantFigures", { company_id: co.id, as_of: "2026-07-31", costs: -1 }), /zero or more/i);
  assert.throws(() => rt.api("saveAccountantFigures", { company_id: co.id, as_of: "x" }), /date/i);
  assert.throws(() => rt.api("saveAccountantFigures", { as_of: "2026-07-31" }), /project or a company/i);
  rt.api("deleteAccountantFigures", { id: saved.id });
  assert.equal(rt.api("getCompanyStatement", { id: co.id }).accountant.length, 0);
  assert.throws(() => rt.api("deleteAccountantFigures", { id: saved.id }), /not found/i);
  rt.api("deleteProject", { id: casa.id });
  assert.equal(rt.rows("Accountant Figures").length, 0, "a deleted project takes its accountant figures with it");
});
