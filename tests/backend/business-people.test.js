// Business pack, step 2 (specs/business.md § Step 2): people with a business role and debts that belong to a project.
// Made-up data on the fake Google layer.
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
const company = (rt, name = "Studio A") => rt.api("addCompany", { name });
const project = (rt, company_id, name) => rt.api("addProject", { company_id, name });
const person = (rt, name, role = "client") => rt.api("addFriend", { name, role });
const loansOf = (rt) => rt.rows("Loans");
const loanOfEntry = (rt, e) => loansOf(rt).find((l) => l.entry_id === e.id);
const base = { date: "2026-10-05", currency: "PEN", category_id: "cat-x", paid_by: "me" };

// An expense paid by me for a project, 100% to the client (a reimbursable cost).
function reimbursable(rt, who, proj, amount, over = {}) {
  const e = rt.api("createEntry", { type: "expense", ...base, amount, description: "Plotter", project_id: proj.id, ...over });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: who.id, amount }] });
  return e;
}

test("OFF: a role is ignored, nothing is created on the friends or loans tabs, and the people actions refuse", () => {
  const rt = setup({ on: false });
  const f = rt.api("addFriend", { name: "Ana", role: "client" });
  assert.ok(!f.role);
  assert.ok(!rt.run(`getHeaders(getSheet('Friends'))`).includes("role"));
  assert.ok(!rt.run(`getHeaders(getSheet('Loans'))`).includes("project_id"));
  for (const action of ["listBusinessPeople", "getProjectDebts"]) {
    assert.throws(() => rt.api(action, { id: f.id, name: "X", project_id: "p" }), /turned off/i, action);
  }
  // A plain friend can be edited and deleted in any copy (More → Friends); a business role still needs the pack.
  assert.throws(() => rt.api("updateFriend", { id: f.id, name: "X", role: "client" }), /turned off/i);
  // A loan made while off carries no project, and the Loans list is the one it always was.
  rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-05", project_id: "ghost" });
  assert.ok(!rt.run(`getHeaders(getSheet('Loans'))`).includes("project_id"));
  const everything = rt.api("listLoanBalances", {}).length;
  assert.equal(rt.api("listLoanBalances", { personal: true }).length, everything, "the scope is ignored while off");
});

test("a person has one role; addFriend keeps it, updateFriend changes it, names stay unique", () => {
  const rt = setup();
  const a = person(rt, "Ana Client", "client");
  assert.equal(a.role, "client");
  assert.equal(person(rt, "Plain Pal", "friend").role, undefined, "a friend has no role column value");
  assert.equal(rt.api("addFriend", { name: "ana client", role: "supplier" }).id, a.id, "idempotent by name; the role is not overwritten");
  assert.equal(rt.api("updateFriend", { id: a.id, name: "Ana Client", role: "partner" }).role, "partner");
  assert.throws(() => rt.api("updateFriend", { id: a.id, name: "plain pal", role: "client" }), /already have a person/i);
  assert.throws(() => rt.api("updateFriend", { id: a.id, name: "  ", role: "client" }), /name/i);
  assert.equal(rt.api("updateFriend", { id: a.id, name: "Ana C.", role: "bogus" }).role, "friend", "an unknown role means friend");
});

test("people list: only business roles, with what is owed per project and in total, per currency", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const ana = person(rt, "Ana Client", "client");
  person(rt, "Plain Pal", "friend");
  reimbursable(rt, ana, casa, 300);
  reimbursable(rt, ana, torre, 120);
  const usd = rt.api("createEntry", { type: "expense", ...base, currency: "USD", amount: 80, project_id: casa.id });
  rt.api("saveEntrySplits", { entryId: usd.id, splits: [{ friend_id: ana.id, amount: 80 }] });

  const people = rt.api("listBusinessPeople", {});
  assert.deepEqual(people.map((p) => p.name), ["Ana Client"], "the plain friend is not listed");
  const row = people[0];
  assert.deepEqual(row.totals.map((t) => [t.currency, t.net]), [["PEN", 420], ["USD", 80]]);
  assert.deepEqual(row.projects.find((p) => p.project_id === casa.id).balances.map((b) => [b.currency, b.net]), [["PEN", 300], ["USD", 80]]);
  assert.deepEqual(row.projects.find((p) => p.project_id === torre.id).balances.map((b) => [b.currency, b.net]), [["PEN", 120]]);
});

test("reimbursable cost: the debt takes the entry's project; the owner's share (not a cost) is 0; the label follows an edit", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const ana = person(rt, "Ana Client");
  const e = reimbursable(rt, ana, casa, 300);
  assert.equal(loanOfEntry(rt, e).project_id, casa.id);
  assert.equal(loanOfEntry(rt, e).direction, "they_owe_me");
  // The project's costs do not include it (100% split away).
  assert.equal(rt.api("getProjectDetail", { id: casa.id }).currencies[0].costs, 0);

  rt.api("updateEntry", { id: e.id, fields: { project_id: torre.id, company_id: co.id } });
  assert.equal(loanOfEntry(rt, e).project_id, torre.id, "the debt moved with the entry");
  rt.api("updateEntry", { id: e.id, fields: { project_id: "", company_id: "" } });
  assert.ok(!loanOfEntry(rt, e).project_id, "no project any more: a personal debt");
  rt.api("updateEntry", { id: e.id, fields: { project_id: casa.id } });
  assert.equal(loanOfEntry(rt, e).project_id, casa.id);

  // Even with a repayment already recorded, the label moves and the money history stays.
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-06" });
  const settlementsBefore = rt.rows("Settlements").length;
  rt.api("updateEntry", { id: e.id, fields: { project_id: torre.id } });
  assert.equal(loanOfEntry(rt, e).project_id, torre.id);
  assert.equal(rt.rows("Settlements").length, settlementsBefore, "the repayment history is untouched");
});

test("balances can be scoped: everything (default), one project, or personal only", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const ana = person(rt, "Ana Client");
  reimbursable(rt, ana, casa, 300);
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-10-06" });   // personal
  const net = (list) => list.filter((r) => r.friend_name === "Ana Client").map((r) => [r.friend_name, r.role, r.balances[0].net]);
  assert.deepEqual(net(rt.api("listLoanBalances", {})), [["Ana Client", "client", 340]]);
  assert.deepEqual(net(rt.api("listLoanBalances", { project_id: casa.id })), [["Ana Client", "client", 300]]);
  assert.deepEqual(net(rt.api("listLoanBalances", { personal: true })), [["Ana Client", "client", 40]]);
  assert.deepEqual(net(rt.api("getProjectDebts", { project_id: casa.id })), [["Ana Client", "client", 300]]);
  assert.throws(() => rt.api("getProjectDebts", { project_id: "ghost" }), /Project not found/i);
  const row = rt.api("listLoanBalances", {}).find((r) => r.friend_name === "Ana Client");
  assert.deepEqual(row.project_ids, [casa.id], "the row says which projects the debts belong to");
  // A cost the client repays in full leaves nothing in the project's category list.
  assert.deepEqual(rt.api("getProjectDetail", { id: casa.id }).byCategory.expense, {});
});

test("a repayment from a project only pays that project's loans; from the Loans tab it is oldest first across all", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const ana = person(rt, "Ana Client");
  reimbursable(rt, ana, casa, 100, { date: "2026-09-01" });      // oldest
  reimbursable(rt, ana, torre, 100, { date: "2026-09-10" });
  const owed = (proj) => rt.api("listLoanBalances", { project_id: proj.id }).reduce((s, r) => s + r.balances[0].net, 0);

  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: "2026-10-01", project_id: torre.id });
  assert.equal(owed(torre), 40, "the newer project was paid even though Casa Lima is older");
  assert.equal(owed(casa), 100, "Casa Lima untouched");

  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-02" });   // Loans tab: no project
  assert.equal(owed(casa), 0, "oldest first across projects");
  assert.equal(owed(torre), 40);
});

test("project-scoped offsetting never touches another project's opposite debt", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const carlos = person(rt, "Carlos Supplier", "supplier");
  reimbursable(rt, carlos, casa, 200);                                                       // he owes me 200 on Casa Lima
  rt.api("addLoan", { friend_id: carlos.id, direction: "i_owe_them", amount: 500, currency: "PEN", date: "2026-10-01", project_id: torre.id });   // I owe him 500 on Torre Sur
  rt.api("recordRepayment", { friend_id: carlos.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2026-10-03", project_id: casa.id });
  const net = (proj) => rt.api("listLoanBalances", { project_id: proj.id }).map((r) => r.balances[0].net);
  assert.deepEqual(net(casa), [], "Casa Lima is settled");
  assert.deepEqual(net(torre), [-500], "Torre Sur still owes 500: no cross-project netting");
});

test("an overpayment on a project becomes income of THAT project; so does a forgiven debt (as a cost)", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const ana = person(rt, "Ana Client");
  reimbursable(rt, ana, casa, 100);
  const res = rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 130, currency: "PEN", date: "2026-10-04", project_id: casa.id, overpay_category_id: "cat-y" });
  assert.equal(res.overpaid, 30);
  const d = rt.api("getProjectDetail", { id: casa.id });
  assert.equal(d.currencies[0].income, 30, "the extra counts as the project's income");

  const ben = person(rt, "Ben Client");
  reimbursable(rt, ben, casa, 70);
  const loan = loansOf(rt).find((l) => l.friend_id === ben.id);
  rt.api("forgiveLoan", { id: loan.id, category_id: "cat-x", date: "2026-10-05" });
  assert.equal(rt.api("getProjectDetail", { id: casa.id }).currencies[0].costs, 70, "forgiving is a cost of the project");
});

test("a cash loan can carry a project (and move to another); an unknown project is ignored", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const carlos = person(rt, "Carlos Supplier", "supplier");
  const loan = rt.api("addLoan", { friend_id: carlos.id, direction: "i_owe_them", amount: 500, currency: "PEN", date: "2026-10-01", project_id: casa.id });
  assert.equal(loan.project_id, casa.id);
  assert.ok(!rt.api("addLoan", { friend_id: carlos.id, direction: "i_owe_them", amount: 5, currency: "PEN", date: "2026-10-01", project_id: "ghost" }).project_id);
  rt.api("updateLoan", { id: loan.id, friend_id: carlos.id, direction: "i_owe_them", amount: 500, currency: "PEN", date: "2026-10-01", project_id: torre.id });
  assert.equal(loansOf(rt).find((l) => l.id === loan.id).project_id, torre.id);
});

test("deleting a person is refused while they have debts, shares or paid entries", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const ana = person(rt, "Ana Client");
  const free = person(rt, "Free Agent", "partner");
  reimbursable(rt, ana, casa, 50);
  assert.throws(() => rt.api("deleteFriend", { id: ana.id }), /still has debts/i);
  assert.deepEqual(rt.api("deleteFriend", { id: free.id }), { done: true });
  assert.throws(() => rt.api("deleteFriend", { id: "ghost" }), /not found|No se encontr/i);
});

test("a project can have a client (an existing person); an unknown one is ignored; editing without it keeps it", () => {
  const rt = setup();
  const co = company(rt);
  const ana = person(rt, "Ana Client");
  const p = rt.api("addProject", { company_id: co.id, name: "Casa Lima", client_id: ana.id });
  assert.equal(p.client_id, ana.id);
  assert.equal(rt.api("getProjectDetail", { id: p.id }).project.client_id, ana.id);
  assert.equal(rt.api("addProject", { company_id: co.id, name: "Torre Sur", client_id: "ghost" }).client_id, "");
  rt.api("updateProject", { id: p.id, name: "Casa Lima" });                         // client_id not sent: kept
  assert.equal(rt.api("getProjectDetail", { id: p.id }).project.client_id, ana.id);
  rt.api("updateProject", { id: p.id, name: "Casa Lima", client_id: "" });          // sent blank: cleared
  assert.equal(rt.api("getProjectDetail", { id: p.id }).project.client_id, "");
});

test("a business person disappears from lists only through the app (the data is kept): turning the pack off keeps them in the Sheet", () => {
  const rt = setup();
  person(rt, "Ana Client");
  rt.api("setBusinessFeatures", { on: false });
  assert.equal(rt.rows("Friends").some((f) => f.name === "Ana Client" && f.role === "client"), true);
  assert.throws(() => rt.api("listBusinessPeople", {}), /turned off/i);
});
