// QA round 1 (2026-11-03): the data-safety bugs the testers found in the bulk Edit modes. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const today = () => new Date().toISOString().slice(0, 10);

test("a friend a Programmed item splits with is hidden, never deleted (bulk and single)", () => {
  const { rt } = freshApp({ entries: 10 });
  const f = rt.api("addFriend", { name: "Prog Split Friend" });
  const free = rt.api("addFriend", { name: "Truly Free Friend" });
  const re = rt.api("addRecurringExpense", { description: "Demo rent", amount: 40, currency: "PEN", frequency: "monthly", day: 5 });
  rt.api("saveRecurringExpenseSplits", { recurring_expense_id: re.id, id: re.id, splits: [{ friend_id: f.id, amount: 20 }] });
  // single delete refuses
  assert.throws(() => rt.api("deleteFriend", { id: f.id }), /programmed items/i);
  // bulk: hidden (the split still points at a real row), the unused one is deleted
  const out = rt.api("deleteFriends", { ids: [f.id, free.id] });
  assert.deepEqual(out.deleted, [free.id]);
  assert.deepEqual(out.hidden.map((h) => h.id), [f.id]);
  assert.ok(rt.rows("Friends").some((x) => x.id === f.id), "the friend row is still there");
  assert.equal(rt.rows("Recurring Expense Splits").filter((s) => s.friend_id === f.id).length, 1, "the split is intact");
});

test("moving a category into one that already has a budget for the same period drops the moved budget (reported), keeps the existing one", () => {
  const { rt } = freshApp({ entries: 5 });
  const mk = (name) => rt.api("saveCategory", { type: "expense", name, icon: "🐶" }).id;
  const a = mk("QA A"), b = mk("QA B"), c = mk("QA C");
  const ba = rt.api("addBudget", { category_id: a, amount: 100, currency: "PEN", period_type: "monthly" });
  const bb = rt.api("addBudget", { category_id: b, amount: 150, currency: "PEN", period_type: "monthly" });
  const bc = rt.api("addBudget", { category_id: c, amount: 60, currency: "PEN", period_type: "yearly" });
  rt.run(`appendRowObject('Budget Alert Log', { id: 'log-a', budget_id: ${JSON.stringify(ba.id)}, threshold: 80, period: '2026-10', sent_at: '2026-10-20' });`);
  rt.api("createEntry", { type: "expense", date: "2026-10-05", amount: 5, currency: "PEN", category_id: a, description: "x", paid_by: "me" });
  rt.api("createEntry", { type: "expense", date: "2026-10-05", amount: 5, currency: "PEN", category_id: c, description: "y", paid_by: "me" });
  const out = rt.api("deleteCategories", { ids: [a, c], reassign: { expense: b } });
  assert.deepEqual(out.deleted.map((d) => d.name).sort(), ["QA A", "QA C"]);
  const onB = rt.rows("Budgets").filter((x) => String(x.category_id) === b);
  assert.deepEqual(onB.map((x) => [x.period_type || "monthly", Number(x.amount)]).sort(), [["monthly", 150], ["yearly", 60]], "B keeps its own monthly budget; the yearly one moved (a different period is no duplicate)");
  assert.equal(out.droppedBudgets.length, 1);
  assert.equal(out.droppedBudgets[0].amount, 100);
  assert.equal(out.droppedBudgets[0].period_type, "monthly");
  assert.ok(!rt.rows("Budget Alert Log").some((r) => r.id === "log-a"), "its alert history went with it");
  assert.ok(rt.rows("Budgets").some((x) => x.id === bb.id) && !rt.rows("Budgets").some((x) => x.id === ba.id) && rt.rows("Budgets").some((x) => x.id === bc.id));
});

test("bulk Discard in Needs review leaves entries that have repayments (or an exchange partner) for their own Discard", () => {
  const { rt, data } = freshApp({ entries: 10 });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense");
  const mkPending = (description) => {
    const e = rt.api("createEntry", { type: "expense", date: today(), amount: 100, currency: "PEN", category_id: cat.id, description, paid_by: "me", payment_method_id: pm });
    return e.id;
  };
  const setPending = (id) => rt.run(`(function(){ var s = getSheet('Entries'); var h = getHeaders(s); var r = findRowIndexById(s, h, ${JSON.stringify(id)}); setCellByRow_(s, h, r, 'status', 'pending'); if (ROWS_MEMO_) delete ROWS_MEMO_['Entries']; })()`);
  const pal = rt.api("addFriend", { name: "QA Pal" });
  const shared = mkPending("QA shared dinner");
  rt.api("saveEntrySplits", { entryId: shared, splits: [{ friend_id: pal.id, amount: 50 }] });
  rt.api("recordRepayment", { friend_id: pal.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: today(), payment_method_id: pm });
  const plain = mkPending("QA plain pending");
  setPending(shared); setPending(plain);
  const owedBefore = JSON.stringify(rt.api("listMyFriends", {}).find((f) => f.id === pal.id).totals);
  const out = rt.api("discardEntries", { ids: [shared, plain] });
  assert.deepEqual(out.discarded, [plain]);
  assert.deepEqual(out.kept.map((k) => [k.id, k.reason]), [[shared, "repaidLoans"]]);
  assert.ok(rt.rows("Entries").some((e) => e.id === shared), "the entry with a repayment is untouched");
  assert.equal(JSON.stringify(rt.api("listMyFriends", {}).find((f) => f.id === pal.id).totals), owedBefore, "the friend's balance did not move");
});

test("Business: a person who is a project's (or expected payment's) client is kept; deleting a project clears its loans' project link", () => {
  const { rt } = freshApp({ entries: 10 });
  rt.run(`appendRowObject('Categories', { id: 'cat-x', name: 'Materials test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.api("setBusinessFeatures", { on: true });
  const co = rt.api("addCompany", { name: "QA Studio" });
  const client = rt.api("addFriend", { name: "QA Client", role: "client" });
  const free = rt.api("addFriend", { name: "QA Free Person", role: "client" });
  const p1 = rt.api("addProject", { company_id: co.id, name: "QA House", client_id: client.id });
  const p2 = rt.api("addProject", { company_id: co.id, name: "QA Other" });
  // a loan carrying p1
  const loaner = rt.api("addFriend", { name: "QA Loan Person", role: "client" });
  rt.api("addLoan", { friend_id: loaner.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-05", project_id: p1.id });
  const people = rt.api("deleteBusinessPeople", { ids: [client.id, free.id] });
  assert.deepEqual(people.kept.map((k) => [k.id, k.reason]), [[client.id, "client"]]);
  assert.ok(!people.deleted.some((d) => d.id === client.id));
  assert.throws(() => rt.api("deleteFriend", { id: client.id }), /client/i);
  assert.ok(rt.rows("Friends").some((f) => f.id === client.id));
  const out = rt.api("deleteBusinessItems", { project_ids: [p1.id] });
  assert.equal(out.projects.deleted.length, 1);
  assert.ok(rt.rows("Loans").every((l) => !l.project_id || l.project_id !== p1.id), "no loan keeps the deleted project's id");
  rt.api("deleteProject", { id: p2.id });
});

test("the strings the round-1 fixes show exist in both languages", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8");
  for (const key of ["catBulk.resultBudgetDropped", "bizBulk.resultPeopleClient", "reviewBulk.why.repaidLoans", "reviewBulk.why.exchange", "reviewBulk.why.loanMovement", "reviewBulk.why.forgiveness", "reviewBulk.why.repaymentExtra"]) {
    assert.ok(src.includes(`"${key}"`), key);
  }
});
