// More → Companies & projects → Edit, and → People → Edit (owner's request 2026-11-03): several at once, by the single delete's rules. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-x', name: 'Materials test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.api("setBusinessFeatures", { on: true });
  const base = { date: "2026-10-05", currency: "PEN", category_id: "cat-x", paid_by: "me" };
  const studio = rt.api("addCompany", { name: "Studio A" });
  const empty = rt.api("addCompany", { name: "Empty Co" });
  const withProject = rt.api("addCompany", { name: "Has Project Co" });
  const withEntries = rt.api("addCompany", { name: "Has Entries Co" });
  const p1 = rt.api("addProject", { company_id: studio.id, name: "House 1" });
  const p2 = rt.api("addProject", { company_id: studio.id, name: "House 2" });
  const p3 = rt.api("addProject", { company_id: withProject.id, name: "Kept project" });
  const e1 = rt.api("createEntry", { type: "expense", ...base, amount: 120, description: "Plotter", project_id: p1.id });
  rt.api("createEntry", { type: "expense", ...base, amount: 35, description: "Paper", company_id: withEntries.id });
  rt.api("addExpectedPayment", { project_id: p1.id, client: "Client", amount: 500, currency: "PEN", due_date: "2026-11-30" });
  return { rt, studio, empty, withProject, withEntries, p1, p2, p3, e1 };
}

test("the backend says it can delete business items in bulk", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.businessBulkDelete, true);
});

test("projects: entries keep the company and lose the project; the project's expected payments go; others untouched", () => {
  const { rt, studio, p1, p2, p3, e1 } = setup();
  const entriesBefore = rt.rows("Entries").length;
  const out = rt.api("deleteBusinessItems", { project_ids: [p1.id, p2.id, p1.id, "gone-1"] });
  assert.deepEqual(out.projects.deleted.map((d) => d.name).sort(), ["House 1", "House 2"]);
  assert.deepEqual(out.projects.missing, ["gone-1"]);
  assert.deepEqual(rt.rows("Projects").map((p) => p.id), [p3.id]);
  assert.equal(rt.rows("Entries").length, entriesBefore, "no entry is deleted");
  const e = rt.rows("Entries").find((x) => x.id === e1.id);
  assert.equal(e.project_id, "", "it lost the project");
  assert.equal(e.company_id, studio.id, "and kept the company");
  assert.equal(rt.rows("Expected Payments").length, 0);
});

test("companies: deleted only when no project and no entry is left; the rest are kept with the reason", () => {
  const { rt, studio, empty, withProject, withEntries, p1, p2 } = setup();
  const out = rt.api("deleteBusinessItems", { company_ids: [empty.id, withProject.id, withEntries.id, studio.id, "gone-2"] });
  assert.deepEqual(out.companies.deleted.map((d) => d.name), ["Empty Co"]);
  const why = Object.fromEntries(out.companies.kept.map((k) => [k.id, k.reason]));
  assert.equal(why[withProject.id], "projects");
  assert.equal(why[withEntries.id], "entries");
  assert.equal(why[studio.id], "projects", "its projects were not in the batch");
  assert.equal(why["gone-2"], "missing");
  assert.ok(!rt.rows("Companies").some((c) => c.id === empty.id));
  assert.equal(rt.rows("Projects").length, 3, "no project was touched");
  assert.ok(p1 && p2);
});

test("a company and ALL its projects in one batch: the projects go first, then the company is judged by its entries", () => {
  const { rt, studio, p1, p2 } = setup();
  const out = rt.api("deleteBusinessItems", { company_ids: [studio.id], project_ids: [p1.id, p2.id] });
  assert.equal(out.projects.deleted.length, 2);
  assert.deepEqual(out.companies.kept.map((k) => k.reason), ["entries"], "the plotter entry still carries the company");
  const clean = setup();
  const out2 = clean.rt.api("deleteBusinessItems", { company_ids: [clean.withProject.id], project_ids: [clean.p3.id] });
  assert.deepEqual(out2.companies.deleted.map((d) => d.name), ["Has Project Co"], "no entries: the company goes with its project");
});

test("the business actions refuse while the pack is off, and an empty batch does nothing", () => {
  const { rt } = freshApp({ entries: 10 });
  assert.throws(() => rt.api("deleteBusinessItems", { project_ids: ["x"] }), /turned off/i);
  assert.throws(() => rt.api("deleteBusinessPeople", { ids: ["x"] }), /turned off/i);
  rt.api("setBusinessFeatures", { on: true });
  assert.deepEqual(rt.api("deleteBusinessItems", {}), { projects: { deleted: [], missing: [] }, companies: { deleted: [], kept: [] } });
  assert.deepEqual(rt.api("deleteBusinessPeople", {}), { deleted: [], kept: [] });
});

test("people: unused ones are deleted; one with loans, a trip group, a plain friend and a missing id are kept", () => {
  const { rt } = setup();
  const free = rt.api("addFriend", { name: "Free Client", role: "client" });
  const free2 = rt.api("addFriend", { name: "Free Supplier", role: "supplier" });
  const owes = rt.api("addFriend", { name: "Owing Partner", role: "partner" });
  const plain = rt.api("addFriend", { name: "Plain Friend" });
  rt.api("addLoan", { friend_id: owes.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-10-01" });
  const trip = rt.api("addTrip", { name: "Group trip", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-12" });
  const group = rt.rows("Friends").find((f) => f.trip_id === trip.id);
  const out = rt.api("deleteBusinessPeople", { ids: [free.id, free2.id, owes.id, plain.id, "gone-3", ...(group ? [group.id] : [])] });
  assert.deepEqual(out.deleted.map((d) => d.name).sort(), ["Free Client", "Free Supplier"]);
  const why = Object.fromEntries(out.kept.map((k) => [k.id, k.reason]));
  assert.equal(why[owes.id], "inUse");
  assert.equal(why[plain.id], "notPerson");
  assert.equal(why["gone-3"], "missing");
  if (group) assert.equal(why[group.id], "group");
  assert.ok(rt.rows("Friends").some((f) => f.id === owes.id) && rt.rows("Friends").some((f) => f.id === plain.id));
});

test("the screens: pencils, checkboxes on companies and projects, one question, names in the result, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  for (const id of ["business-edit-btn", "business-editbar", "business-done-btn", "people-edit-btn", "people-editbar", "people-done-btn"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /callApi\("deleteBusinessItems", \{ company_ids, project_ids \}\)/);
  assert.match(app, /callApi\("deleteBusinessPeople", \{ ids \}\)/);
  assert.match(app, /busy: "common\.deletingToast"/);
  assert.match(app, /name !== "business" && businessEditing_/);
  assert.match(app, /name !== "business-people" && peopleEditing_/);
  for (const key of ["bizBulk.confirm", "bizBulk.projectsNote", "bizBulk.companiesNote", "bizBulk.resultProjects", "bizBulk.resultCompanies", "bizBulk.resultKeptProjects", "bizBulk.resultKeptEntries",
    "bizBulk.peopleConfirm", "bizBulk.resultPeople", "bizBulk.resultPeopleInUse", "bizBulk.resultPeopleGroup", "bizBulk.resultKept", "bizBulk.resultMissing"]) {
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), key);
  }
});
