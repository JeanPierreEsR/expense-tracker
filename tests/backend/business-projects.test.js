// Business pack, step 1 (specs/business.md): opt-in switch, companies, projects, entry links and the
// per-currency profit and loss. Everything is made-up data on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const sheetExists = (rt, name) => rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(${JSON.stringify(name)})`);

function setup(opts = {}) {
  const { rt } = freshApp({ entries: 30 });
  rt.run(`appendRowObject('Categories', { id: 'cat-x', name: 'Materials test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-y', name: 'Fees test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  if (opts.on !== false) rt.api("setBusinessFeatures", { on: true });
  return rt;
}
// Confirmed entry written straight to the sheet (the form path is covered separately).
function entry(rt, id, over = {}) {
  const e = { id, type: "expense", date: "2026-10-05", amount: 100, currency: "PEN", category_id: "cat-x", description: id, paid_by: "me", status: "confirmed", source: "manual", ...over };
  rt.run(`ensureBusinessSheets_(); appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}
const company = (rt, name = "Studio A") => rt.api("addCompany", { name, emoji: "🏢" });
const project = (rt, company_id, name = "Casa Lima", extra = {}) => rt.api("addProject", { company_id, name, ...extra });

test("OFF by default: nothing business is visible, read, created or accepted", () => {
  const rt = setup({ on: false });
  const meta = rt.api("getMeta", {});
  assert.equal(meta.capabilities.business, false);
  assert.deepEqual(meta.companies, []);
  assert.deepEqual(meta.projects, []);
  for (const tab of ["Companies", "Projects", "Project Budgets"]) assert.equal(sheetExists(rt, tab), false, tab + " must not exist");
  for (const action of ["addCompany", "addProject", "listCompaniesAndProjects", "getProjectDetail", "getCompanyDetail"]) {
    assert.throws(() => rt.api(action, { name: "X", id: "x" }), /turned off/i, action);
  }
  // A link in a payload is ignored, not stored.
  const e = rt.api("createEntry", { type: "expense", date: "2026-10-05", amount: 10, currency: "PEN", category_id: "cat-x", paid_by: "me", project_id: "p", company_id: "c" });
  assert.ok(!e.project_id && !e.company_id);
  assert.equal(sheetExists(rt, "Companies"), false);
  // The search copy has no business fields at all.
  const rows = rt.api("listEntrySearchIndex", {});
  assert.ok(rows.length && rows.every((r) => !("project_id" in r) && !("company_id" in r)));
});

test("turning it on creates the tabs and the columns; off hides everything and deletes nothing", () => {
  const rt = setup({ on: false });
  const res = rt.api("setBusinessFeatures", { on: true });
  assert.equal(res.business, true);
  assert.equal(res.capabilities.business, true);
  for (const tab of ["Companies", "Projects", "Project Budgets"]) assert.equal(sheetExists(rt, tab), true, tab);
  const headers = rt.run(`getHeaders(getSheet('Entries'))`);
  assert.ok(headers.includes("project_id") && headers.includes("company_id"));

  const c = company(rt);
  const p = project(rt, c.id);
  assert.equal(rt.api("getMeta", {}).companies.length, 1);
  assert.equal(rt.api("getMeta", {}).projects.length, 1);

  rt.api("setBusinessFeatures", { on: false });
  const off = rt.api("getMeta", {});
  assert.equal(off.capabilities.business, false);
  assert.deepEqual(off.companies, []);
  assert.deepEqual(off.projects, []);
  assert.equal(rt.rows("Companies").length, 1, "nothing deleted");

  rt.api("setBusinessFeatures", { on: true });
  assert.equal(rt.api("getMeta", {}).projects[0].id, p.id);
});

test("companies: a name is required and unique; delete is refused while it is in use", () => {
  const rt = setup();
  const a = company(rt, "Studio A");
  assert.throws(() => company(rt, "  "), /name/i);
  assert.throws(() => company(rt, "studio a"), /already have a company/i);
  assert.equal(rt.api("updateCompany", { id: a.id, name: "Studio Alpha", emoji: "🏗️" }).name, "Studio Alpha");
  assert.throws(() => rt.api("updateCompany", { id: "ghost", name: "X" }), /not found/i);

  const p = project(rt, a.id);
  assert.throws(() => rt.api("deleteCompany", { id: a.id }), /still has projects or entries/i);
  rt.api("deleteProject", { id: p.id });
  entry(rt, "e1", { company_id: a.id });
  assert.throws(() => rt.api("deleteCompany", { id: a.id }), /still has projects or entries/i);
  const b = company(rt, "Empty Co");
  assert.deepEqual(rt.api("deleteCompany", { id: b.id }), { done: true });
});

test("projects: unique per company, budgets per currency, closing, and no move once it has entries", () => {
  const rt = setup();
  const a = company(rt, "Studio A");
  const b = company(rt, "Studio B");
  const p = project(rt, a.id, "Casa Lima", { budgets: [{ currency: "PEN", amount: 20000 }, { currency: "usd", amount: 5000 }] });
  assert.deepEqual(p.budgets, [{ currency: "PEN", amount: 20000 }, { currency: "USD", amount: 5000 }]);
  assert.throws(() => project(rt, a.id, "casa lima"), /already has a project/i);
  assert.ok(project(rt, b.id, "Casa Lima"), "same name in another company is fine");
  assert.throws(() => project(rt, "ghost", "X"), /Company not found/i);
  assert.throws(() => project(rt, a.id, "Bad", { budgets: [{ currency: "PEN", amount: 0 }] }), /greater than 0/i);
  assert.throws(() => project(rt, a.id, "Bad2", { budgets: [{ currency: "PEN", amount: 5 }, { currency: "PEN", amount: 6 }] }), /only once/i);

  assert.equal(rt.api("updateProject", { id: p.id, name: "Casa Lima", status: "closed" }).status, "closed");
  assert.equal(rt.api("getMeta", {}).projects.find((x) => x.id === p.id).status, "closed");
  assert.equal(rt.rows("Project Budgets").length, 2, "budgets untouched when not sent");
  rt.api("updateProject", { id: p.id, name: "Casa Lima", budgets: [{ currency: "PEN", amount: 1 }] });
  assert.equal(rt.rows("Project Budgets").filter((r) => r.project_id === p.id).length, 1, "budgets replaced when sent");

  const cc = company(rt, "Studio C");
  rt.api("updateProject", { id: p.id, name: "Casa Lima", company_id: cc.id });   // no entries yet: allowed
  entry(rt, "e1", { project_id: p.id, company_id: cc.id });
  assert.throws(() => rt.api("updateProject", { id: p.id, name: "Casa Lima", company_id: a.id }), /can't move/i);
});

test("entries: a project forces its company; only expense and income; unknown ids mean none; edits and conversions", () => {
  const rt = setup();
  const c = company(rt);
  const p = project(rt, c.id);
  const base = { date: "2026-10-05", amount: 50, currency: "PEN", category_id: "cat-x", paid_by: "me" };

  const viaProject = rt.api("createEntry", { type: "expense", ...base, project_id: p.id });
  assert.equal(viaProject.project_id, p.id);
  assert.equal(viaProject.company_id, c.id);
  const viaCompany = rt.api("createEntry", { type: "expense", ...base, company_id: c.id });
  assert.equal(viaCompany.company_id, c.id);
  assert.equal(viaCompany.project_id, "");
  const income = rt.api("createEntry", { type: "income", ...base, category_id: "cat-y", paid_by: "payor-x", project_id: p.id });
  assert.equal(income.project_id, p.id);
  const ghost = rt.api("createEntry", { type: "expense", ...base, project_id: "ghost", company_id: "ghost" });
  assert.ok(!ghost.project_id && !ghost.company_id);
  const transfer = rt.api("createEntry", { type: "transfer", ...base, project_id: p.id });
  assert.ok(!transfer.project_id && !transfer.company_id, "a transfer never carries a link");

  // Edit: move to the company only, then clear.
  rt.api("updateEntry", { id: viaProject.id, fields: { project_id: "", company_id: c.id } });
  let row = rt.rows("Entries").find((e) => e.id === viaProject.id);
  assert.equal(row.project_id, "");
  assert.equal(row.company_id, c.id);
  rt.api("updateEntry", { id: viaProject.id, fields: { project_id: "", company_id: "" } });
  row = rt.rows("Entries").find((e) => e.id === viaProject.id);
  assert.ok(!row.project_id && !row.company_id);
  // A one-key payload counts the other as blank.
  rt.api("updateEntry", { id: viaProject.id, fields: { project_id: p.id } });
  row = rt.rows("Entries").find((e) => e.id === viaProject.id);
  assert.equal(row.project_id, p.id);
  assert.equal(row.company_id, c.id);
  // Converting to a transfer clears the label.
  rt.api("updateEntry", { id: viaProject.id, fields: { type: "transfer" } });
  row = rt.rows("Entries").find((e) => e.id === viaProject.id);
  assert.ok(!row.project_id && !row.company_id);
  // Other edits leave the link alone.
  rt.api("updateEntry", { id: income.id, fields: { description: "renamed" } });
  assert.equal(rt.rows("Entries").find((e) => e.id === income.id).project_id, p.id);
});

test("per-currency profit and loss: own share, income in full, nothing converted; pending and transfers left out", () => {
  const rt = setup();
  const c = company(rt);
  const p = project(rt, c.id, "Casa Lima", { budgets: [{ currency: "PEN", amount: 1000 }, { currency: "USD", amount: 500 }] });
  entry(rt, "i1", { type: "income", category_id: "cat-y", amount: 5000, project_id: p.id, company_id: c.id, paid_by: "payor-x" });
  entry(rt, "i2", { type: "income", category_id: "cat-y", amount: 400, currency: "USD", project_id: p.id, company_id: c.id, paid_by: "payor-x" });
  entry(rt, "x1", { amount: 300, project_id: p.id, company_id: c.id });
  entry(rt, "x2", { amount: 200, project_id: p.id, company_id: c.id });
  entry(rt, "x3", { amount: 120, currency: "USD", project_id: p.id, company_id: c.id });
  rt.api("saveEntrySplits", { entryId: "x2", splits: [{ friend_id: "friend-x", amount: 200 }] });   // a client repays it all: my share is 0
  entry(rt, "pending1", { amount: 999, project_id: p.id, company_id: c.id, status: "pending" });
  entry(rt, "t1", { type: "transfer", amount: 777, project_id: p.id, company_id: c.id });
  entry(rt, "other", { amount: 55 });   // not linked

  const d = rt.api("getProjectDetail", { id: p.id });
  const pen = d.currencies.find((x) => x.currency === "PEN");
  const usd = d.currencies.find((x) => x.currency === "USD");
  assert.deepEqual([pen.income, pen.costs, pen.margin], [5000, 300, 4700]);
  assert.deepEqual([usd.income, usd.costs, usd.margin], [400, 120, 280]);
  assert.equal(pen.budget, 1000);
  assert.equal(pen.budgetPct, 30);
  assert.equal(usd.budgetPct, 24);
  assert.equal(d.currencies[0].currency, "PEN", "main currency first");
  assert.equal(d.entryCount, 5);
  assert.equal(d.approx.currency, "PEN");
  assert.ok(d.approx.income > 5000 && d.approx.margin > 4700, "the USD part is converted with the rate table");
  assert.equal(d.approx.missing, 0);
  assert.deepEqual(d.byCategory.expense.PEN.map((x) => [x.name, x.amount]), [["Materials test", 300]]);
  assert.deepEqual(d.byCategory.income.USD.map((x) => [x.name, x.amount]), [["Fees test", 400]]);

  // Period filter.
  entry(rt, "late", { amount: 40, date: "2026-12-20", project_id: p.id, company_id: c.id });
  assert.equal(rt.api("getProjectDetail", { id: p.id, startDate: "2026-12-01", endDate: "2026-12-31" }).currencies.find((x) => x.currency === "PEN").costs, 40);
  assert.equal(rt.api("getProjectDetail", { id: p.id }).currencies.find((x) => x.currency === "PEN").costs, 340);
});

test("a currency with no exchange rate only leaves out the converted line, and says how many", () => {
  const rt = setup();
  const c = company(rt);
  const p = project(rt, c.id);
  entry(rt, "n1", { amount: 80, currency: "JPY", project_id: p.id, company_id: c.id });
  entry(rt, "n2", { amount: 20, project_id: p.id, company_id: c.id });
  const d = rt.api("getProjectDetail", { id: p.id });
  assert.equal(d.currencies.find((x) => x.currency === "JPY").costs, 80, "still shown in its own currency");
  assert.equal(d.approx.missing, 1);
  assert.equal(d.approx.costs, 20);
});

test("company screen: its projects, its company-level entries, and the list", () => {
  const rt = setup();
  const a = company(rt, "Studio A");
  const b = company(rt, "Studio B");
  const p1 = project(rt, a.id, "Casa Lima");
  const p2 = project(rt, a.id, "Torre Sur");
  entry(rt, "a1", { amount: 100, project_id: p1.id, company_id: a.id });
  entry(rt, "a2", { amount: 50, project_id: p2.id, company_id: a.id });
  entry(rt, "a3", { amount: 30, company_id: a.id });                 // company-level (rent, software…)
  entry(rt, "b1", { amount: 7, company_id: b.id });

  const d = rt.api("getCompanyDetail", { id: a.id });
  assert.equal(d.currencies[0].costs, 180);
  assert.equal(d.companyLevel.currencies[0].costs, 30);
  assert.deepEqual(d.projects.map((x) => [x.name, x.currencies[0].costs]), [["Casa Lima", 100], ["Torre Sur", 50]]);

  const list = rt.api("listCompaniesAndProjects", {});
  assert.deepEqual(list.map((x) => x.name), ["Studio A", "Studio B"]);
  assert.equal(list[0].projects.length, 2);
  assert.equal(list[1].currencies[0].costs, 7);
});

test("Overview scope: all, personal only, one company, one project; ignored while off", () => {
  const rt = setup();
  const a = company(rt, "Studio A");
  const p = project(rt, a.id);
  const range = { startDate: "2030-01-01", endDate: "2030-01-31" };   // outside the seeded data
  entry(rt, "s1", { date: "2030-01-10", amount: 10 });
  entry(rt, "s2", { date: "2030-01-10", amount: 20, company_id: a.id });
  entry(rt, "s3", { date: "2030-01-10", amount: 40, company_id: a.id, project_id: p.id });
  const exp = (scope) => rt.api("getPeriodSummary", { ...range, scope }).totals.expense;
  assert.equal(exp(undefined), 70);
  assert.equal(exp("all"), 70);
  assert.equal(exp("personal"), 10);
  assert.equal(exp("company:" + a.id), 60);
  assert.equal(exp("project:" + p.id), 40);
  rt.api("setBusinessFeatures", { on: false });
  assert.equal(exp("personal"), 70, "the filter is ignored while the pack is off");
});

test("deleting a project keeps its entries in the company and removes its budgets", () => {
  const rt = setup();
  const a = company(rt);
  const p = project(rt, a.id, "Casa Lima", { budgets: [{ currency: "PEN", amount: 100 }] });
  entry(rt, "d1", { project_id: p.id, company_id: a.id });
  assert.deepEqual(rt.api("deleteProject", { id: p.id }), { done: true });
  const row = rt.rows("Entries").find((e) => e.id === "d1");
  assert.ok(!row.project_id);
  assert.equal(row.company_id, a.id);
  assert.equal(rt.rows("Project Budgets").length, 0);
  assert.throws(() => rt.api("deleteProject", { id: p.id }), /not found/i);
});

test("lists and search: filter by project or company, find by name; the search copy carries the ids only while on", () => {
  const rt = setup();
  const a = company(rt, "Studio Alfa");
  const p = project(rt, a.id, "Casa Miraflores");
  entry(rt, "f1", { project_id: p.id, company_id: a.id, date: "2026-10-06" });
  entry(rt, "f2", { company_id: a.id, date: "2026-10-07" });
  entry(rt, "f3", { date: "2026-10-08" });
  assert.deepEqual(rt.api("listEntries", { projectId: p.id }).map((e) => e.id), ["f1"]);
  assert.deepEqual(rt.api("listEntries", { companyId: a.id }).map((e) => e.id).sort(), ["f1", "f2"]);
  assert.deepEqual(rt.api("listEntries", { search: "miraflores" }).map((e) => e.id), ["f1"]);
  assert.deepEqual(rt.api("listEntries", { search: "alfa" }).map((e) => e.id).sort(), ["f1", "f2"]);
  const idx = rt.api("listEntrySearchIndex", {}).find((r) => r.id === "f1");
  assert.equal(idx.project_id, p.id);
  assert.equal(idx.company_id, a.id);
  assert.match(idx._s, /miraflores/);

  rt.api("setBusinessFeatures", { on: false });
  assert.equal(rt.api("listEntries", { projectId: p.id }).length > 0, true, "filter ignored while off (returns everything)");
  assert.deepEqual(rt.api("listEntries", { search: "miraflores" }), [], "names are not searchable while off");
});

test("a resent addCompany / addProject with the same request id is applied once", () => {
  const rt = setup();
  const a = rt.api("addCompany", { name: "Once Co", _requestId: "req-1" });
  const again = rt.api("addCompany", { name: "Once Co", _requestId: "req-1" });
  assert.equal(again.id, a.id);
  assert.equal(rt.rows("Companies").length, 1);
});

test("Overview filter: the entry list and the totals use the same scope, so a drill-down adds up", () => {
  const rt = setup();
  const a = company(rt, "Studio A");
  const p = project(rt, a.id);
  const range = { startDate: "2031-01-01", endDate: "2031-01-31" };
  entry(rt, "g1", { date: "2031-01-10", amount: 10 });
  entry(rt, "g2", { date: "2031-01-11", amount: 20, company_id: a.id });
  entry(rt, "g3", { date: "2031-01-12", amount: 40, company_id: a.id, project_id: p.id });
  for (const [scope, expected] of [[undefined, 70], ["all", 70], ["personal", 10], ["company:" + a.id, 60], ["project:" + p.id, 40]]) {
    const listed = rt.api("listEntries", { ...range, scope }).reduce((sum, e) => sum + Number(e.amount), 0);
    assert.equal(listed, expected, "list for " + scope);
    assert.equal(rt.api("getPeriodSummary", { ...range, scope }).totals.expense, expected, "totals for " + scope);
  }
  rt.api("setBusinessFeatures", { on: false });
  assert.equal(rt.api("listEntries", { ...range, scope: "personal" }).length, 3, "ignored while the pack is off");
});

test("the owner's own copy is switched on once; a choice (yes or no) is never overridden; a friend's copy never", () => {
  // Owner's copy (no FEATURES property): nothing chosen -> on, once.
  const rt = setup({ on: false });
  const first = rt.api("enableBusinessForOwnerOnce", {});
  assert.equal(first.changed, true);
  assert.equal(first.capabilities.business, true);
  assert.equal(rt.api("enableBusinessForOwnerOnce", {}).changed, false, "already chosen: nothing to do");
  // The owner turns it off: a later (even stale-phone) call must not turn it back on.
  rt.api("setBusinessFeatures", { on: false });
  const again = rt.api("enableBusinessForOwnerOnce", {});
  assert.equal(again.changed, false);
  assert.equal(again.capabilities.business, false);
  assert.equal(rt.api("getMeta", {}).capabilities.business, false);

  // A friend's copy (FEATURES present): never switched on this way.
  const friend = setup({ on: false });
  friend.svc.props.set("FEATURES", "base");
  const res = friend.api("enableBusinessForOwnerOnce", {});
  assert.equal(res.changed, false);
  assert.equal(res.capabilities.business, false);
  assert.equal(friend.rows("Settings").some((r) => r.key === "business_features"), false, "nothing written");
});

test("export: the CSV gains Company and Project columns only while the pack is on; the backup always keeps the tabs", () => {
  const rt = setup();
  const a = company(rt, "Studio A");
  const p = project(rt, a.id, "Casa Lima");
  entry(rt, "x1", { date: "2032-02-10", amount: 12, company_id: a.id, project_id: p.id });
  entry(rt, "x2", { date: "2032-02-11", amount: 7 });
  const files = (cards) => rt.api("exportDownload", { cards, startDate: "2032-02-01", endDate: "2032-02-28" }).files;
  const csvOn = files(["entries"]).find((f) => /\.csv$/.test(f.name)).text.split(/\r?\n/).filter(Boolean);
  const head = csvOn[0].split(",");
  assert.ok(head.includes("Company") && head.includes("Project"));
  assert.equal(head.indexOf("Project"), head.indexOf("Company") + 1);
  assert.equal(head.indexOf("Company"), head.indexOf("Trip / event") + 1, "right after Trip / event");
  const row1 = csvOn.find((l) => l.startsWith("x1"));
  assert.ok(row1.includes("Studio A,Casa Lima"));
  assert.equal(csvOn.find((l) => l.startsWith("x2")).split(",").length, head.length, "every row has every column");

  rt.api("setBusinessFeatures", { on: false });
  const csvOff = files(["entries"]).find((f) => /\.csv$/.test(f.name)).text.split(/\r?\n/)[0];
  assert.ok(!/Company|Project/.test(csvOff), "a personal-only file is what it always was");
  const backup = JSON.parse(files(["backup"]).find((f) => /\.json$/.test(f.name)).text);
  assert.equal(backup.tables["Companies"].length, 1, "the backup keeps the business tabs even while off");
  assert.equal(backup.tables["Projects"].length, 1);
  assert.ok(backup.tables["Project Budgets"]);
});
