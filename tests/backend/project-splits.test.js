// Business 2, piece 6: one company expense or income split between its projects (ProjectSplits.gs). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { freshApp } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte", "Otros proyectos"] });
  return rt;
}
const ids = (rt) => { const [a, b] = rt.rows("Projects"); return { a: a.id, b: b.id, company: rt.rows("Companies")[0].id }; };
const cat = (rt) => rt.rows("Categories").find((c) => c.type === "expense" && c.key === "labor").id;
const pay = (rt, amount, date, description = "Honorarios Ingeniero Prueba") =>
  rt.api("createEntry", { type: "expense", date, amount, currency: "PEN", category_id: cat(rt), description, paid_by: "me" });
const totals = (rt, fn, payload) => rt.api(fn, payload);

test("a split: the parts must add up to the amount; each project counts only its part; the company counts the total once", () => {
  const rt = companyCopy();
  const p = ids(rt);
  const e = pay(rt, 5000, "2026-10-28");
  // read once BEFORE the split (found on the test server: a cache kept the empty list of splits for an hour)
  assert.equal(Number(rt.api("getPeriodSummary", { startDate: "2026-10-01", endDate: "2026-10-31", scope: "project:" + p.a }).totals.expense), 0);
  rt.api("listEntries", { projectId: p.b, startDate: "2026-10-01", endDate: "2026-10-31" });
  assert.throws(() => rt.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 3000 }, { project_id: p.b, amount: 1000 }] }), /4[,]?000.*5[,]?000/);
  assert.throws(() => rt.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 5000 }] }), /two|dos/i);
  rt.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 3000 }, { project_id: p.b, amount: 2000 }] });
  const saved = rt.rows("Entries").find((x) => x.id === e.id);
  assert.equal(saved.project_id, "");
  assert.equal(saved.company_id, p.company);
  const sumParts = rt.rows("Project Splits").filter((s) => s.entry_id === e.id).reduce((n, s) => n + Number(s.amount), 0);
  assert.equal(sumParts, 5000);
  const range = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const spent = (scope) => Number(rt.api("getPeriodSummary", Object.assign({ scope }, range)).totals.expense);
  assert.equal(spent("project:" + p.a), 3000);
  assert.equal(spent("project:" + p.b), 2000);
  assert.equal(spent("company:" + p.company), 5000, "the company counts the whole amount once");
  // The project screens and the company screen (businessRows_) agree.
  const proj = (id) => JSON.parse(JSON.stringify(rt.run(`businessRows_(function (e) { return String(e.project_id || '') === ${JSON.stringify(id)}; }, '2026-10-01', '2026-10-31')`)))
    .reduce((n, r) => n + r.own, 0);
  assert.equal(proj(p.a), 3000);
  assert.equal(proj(p.b), 2000);
  const companyRows = JSON.parse(JSON.stringify(rt.run(`businessRows_(function (e) { return String(e.company_id || '') === ${JSON.stringify(p.company)}; }, '2026-10-01', '2026-10-31')`)));
  assert.equal(companyRows.reduce((n, r) => n + r.own, 0), 5000);
  // a project's entry list shows the split entry
  assert.ok(rt.api("listEntries", { projectId: p.b, startDate: "2026-10-01", endDate: "2026-10-31" }).some((x) => x.id === e.id && x.project_parts && x.project_parts.length === 2));
});

test("changing the amount removes the split (never one that does not add up); picking one project removes it too", () => {
  const rt = companyCopy();
  const p = ids(rt);
  const e = pay(rt, 1000, "2026-10-10");
  rt.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 600 }, { project_id: p.b, amount: 400 }] });
  rt.api("updateEntry", { id: e.id, fields: { amount: 1200 } });
  assert.equal(rt.rows("Project Splits").filter((s) => s.entry_id === e.id).length, 0);
  rt.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 700 }, { project_id: p.b, amount: 500 }] });
  rt.api("updateEntry", { id: e.id, fields: { project_id: p.a, company_id: p.company } });
  assert.equal(rt.rows("Project Splits").filter((s) => s.entry_id === e.id).length, 0);
  // removing on purpose
  rt.api("updateEntry", { id: e.id, fields: { project_id: "", company_id: p.company } });
  rt.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 700 }, { project_id: p.b, amount: 500 }] });
  rt.api("saveProjectSplit", { entry_id: e.id, parts: [] });
  assert.equal(rt.rows("Project Splits").filter((s) => s.entry_id === e.id).length, 0);
});

test("next month: the same payment waiting in Needs review is offered last month's split, and Confirm applies it to the new amount", () => {
  const rt = companyCopy();
  const p = ids(rt);
  const oct = pay(rt, 5000, "2026-10-28");
  rt.api("saveProjectSplit", { entry_id: oct.id, parts: [{ project_id: p.a, amount: 3000 }, { project_id: p.b, amount: 2000 }] });
  // November's payment arrives by itself (a bank e-mail, say): waiting, with the company (piece 2), a different amount.
  const id = "nov-" + Date.now();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: "2026-11-28", amount: 6200, currency: "PEN", category_id: "", description: "Honorarios Ingeniero Prueba", payment_method_id: "", paid_by: "me", status: "pending", source: "email" })})`);
  const waiting = rt.api("listEntries", { status: "pending", limit: 50 });
  const review = JSON.parse(JSON.stringify(rt.run("listPendingEntries()"))).find((x) => x.id === id) || waiting.find((x) => x.id === id);
  assert.ok(review.split_match, "the suggestion is on the waiting item");
  assert.deepEqual(review.split_match.parts.map((x) => [x.name, x.pct]), [["Obra Norte", 60], ["Otros proyectos", 40]]);
  rt.api("saveEntryAll", { kind: "confirm", id, fields: { category_id: cat(rt) }, project_split: review.split_match.parts });
  const parts = rt.rows("Project Splits").filter((s) => s.entry_id === id).map((s) => Number(s.amount)).sort((x, y) => y - x);
  assert.deepEqual(parts, [3720, 2480], "60 % and 40 % of 6,200");
  assert.equal(rt.rows("Entries").find((x) => x.id === id).status, "confirmed");
});

test("not on the owner's copy: no suggestion; a split with friends is refused", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setBusinessFeatures", { on: true });
  rt.api("addCompany", { name: "Estudio Prueba" });
  const pending = JSON.parse(JSON.stringify(rt.run("listPendingEntries()")));
  assert.ok(pending.every((x) => !x.split_match));
  const co = companyCopy();
  const p = ids(co);
  const friend = co.api("addFriend", { name: "Amiga Prueba" });
  const e = pay(co, 100, "2026-10-05");
  co.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: friend.id, amount: 50 }] });
  assert.throws(() => co.api("saveProjectSplit", { entry_id: e.id, parts: [{ project_id: p.a, amount: 60 }, { project_id: p.b, amount: 40 }] }), /friends|amigos|contacts|contactos/i);
});

test("the phone: the split button and sheet, the card's 'as last month' line; app.js loads", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /callApi\("saveProjectSplit"/);
  assert.match(src, /review-split-check/);
  assert.match(src, /project_split:/);
  // found on the test server: the card's Confirm sent its own copy of the action, without the split
  assert.match(src, /applyReviewAction_\(Object\.assign\(\{ id: entry\.id, action: "confirm", fields \}, extra\)\)/);
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  assert.match(html, /id="psplit-modal-backdrop"/);
  assert.match(html, /id="entry-psplit-btn"/);
});
