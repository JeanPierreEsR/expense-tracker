// removePracticeData: the first-use practice's cleanup in ONE call. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function practice({ repay = 0, name = "Practice expense" } = {}) {
  const { rt, data } = freshApp();
  const friendsBefore = rt.rows("Friends").length;
  const friend = rt.api("addFriend", { name: "Practice Pal " + Math.random().toString(36).slice(2, 6) });
  const cat = data.cats.find((c) => c.type === "expense");
  const pm = data.pms[3].id;
  const entriesBefore = rt.rows("Entries").length;
  const entry = rt.api("createEntry", { type: "expense", date: today(), amount: 60, currency: "PEN", category_id: cat.id, description: name, paid_by: "me", payment_method_id: pm });
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 45 }] });
  if (repay) rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: repay, currency: "PEN", date: today(), payment_method_id: pm });
  return { rt, data, friend, entry, friendsBefore, entriesBefore, pm };
}

test("one call removes the expense, its repayment (money entry too) and the friend the practice added", () => {
  const { rt, friend, entry, friendsBefore, entriesBefore } = practice({ repay: 45 });
  assert.equal(rt.rows("Entries").length, entriesBefore + 2, "the expense and the repayment's money movement");
  const res = rt.api("removePracticeData", { entry_id: entry.id, friend_id: friend.id, delete_friend_ids: [friend.id] });
  assert.equal(res.removed, true);
  assert.deepEqual(res.friends_deleted, [friend.id]);
  assert.equal(rt.rows("Entries").length, entriesBefore, "every entry is gone");
  assert.equal(rt.rows("Loans").some((l) => l.friend_id === friend.id), false, "no refund loan is left behind");
  assert.equal(rt.rows("Settlements").some((s) => s.loan_id && rt.rows("Loans").every((l) => l.id !== s.loan_id) && s.friend_id === friend.id), false);
  assert.equal(rt.rows("Friends").length, friendsBefore);
});

test("an exit before any repayment removes just the expense; an existing friend is kept", () => {
  const { rt, friend, entry, entriesBefore } = practice();
  const res = rt.api("removePracticeData", { entry_id: entry.id, friend_id: friend.id, delete_friend_ids: [] });
  assert.equal(res.removed, true);
  assert.equal(rt.rows("Entries").length, entriesBefore);
  assert.ok(rt.rows("Friends").some((f) => f.id === friend.id));
});

test("a practice left before the expense was saved only deletes the added friend; a repeat call is harmless", () => {
  const { rt, friend, entry } = practice();
  rt.api("removePracticeData", { entry_id: entry.id, friend_id: friend.id, delete_friend_ids: [friend.id] });
  const again = rt.api("removePracticeData", { entry_id: entry.id, friend_id: friend.id, delete_friend_ids: [friend.id] });
  assert.equal(again.removed, false);
  assert.deepEqual(again.friends_deleted, []);
  const other = rt.api("addFriend", { name: "Never Used " + Math.random().toString(36).slice(2, 6) });
  const res = rt.api("removePracticeData", { entry_id: "", delete_friend_ids: [other.id] });
  assert.deepEqual(res.friends_deleted, [other.id]);
});

test("the Spanish name works; any other entry is refused and nothing is touched", () => {
  const es = practice({ name: "Gasto de práctica" });
  assert.equal(es.rt.api("removePracticeData", { entry_id: es.entry.id }).removed, true);
  const real = practice({ name: "Dinner with Ana" });
  assert.throws(() => real.rt.api("removePracticeData", { entry_id: real.entry.id, delete_friend_ids: [real.friend.id] }), /not a practice expense|no es un gasto de pr/);
  assert.ok(real.rt.rows("Entries").some((e) => e.id === real.entry.id), "the real entry is still there");
  assert.ok(real.rt.rows("Friends").some((f) => f.id === real.friend.id), "and so is the friend (refused before anything ran)");
});

test("a friend who is still in use is not deleted (the call still succeeds)", () => {
  const { rt, friend, entry } = practice();
  const other = rt.api("createEntry", { type: "expense", date: today(), amount: 10, currency: "PEN", category_id: rt.rows("Categories").find((c) => c.type === "expense").id, description: "Real dinner", paid_by: "me" });
  rt.api("saveEntrySplits", { entryId: other.id, splits: [{ friend_id: friend.id, amount: 5 }] });
  const res = rt.api("removePracticeData", { entry_id: entry.id, friend_id: friend.id, delete_friend_ids: [friend.id] });
  assert.equal(res.removed, true);
  assert.deepEqual(res.friends_deleted, [], "the friend has another real loan, so stays");
});

test("an 'Overpayment' leftover of the practice friend of exactly the typed extra is swept; others are not", () => {
  const { rt, friend, entry, entriesBefore } = practice({ repay: 50 });   // 5 more than owed: the server files the extra as a pending entry
  const extraEntry = rt.rows("Entries").find((e) => e.status === "pending" && /Overpayment|Pago de m/.test(e.description || ""));
  assert.ok(extraEntry, "the extra is waiting in Needs review");
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  const other = rt.api("createEntry", { type: "income", date: today(), amount: 7, currency: "PEN", category_id: cat, description: `Overpayment from ${friend.name}'s loan repayment` });
  rt.run(`updateEntryFields(${JSON.stringify(other.id)}, { status: 'pending' })`);
  const res = rt.api("removePracticeData", { entry_id: entry.id, friend_id: friend.id, extra: 5, started_on: today(), delete_friend_ids: [] });
  assert.equal(res.swept, 1);
  assert.equal(rt.rows("Entries").some((e) => e.id === extraEntry.id), false, "the practice's extra is gone");
  assert.ok(rt.rows("Entries").some((e) => e.id === other.id), "a different amount is not the practice's");
  assert.equal(rt.rows("Entries").length, entriesBefore + 1, "only the unrelated 7.00 remains");
});

test("capability: a backend that can do the cleanup in one call says so", () => {
  const { rt } = practice();
  assert.equal(rt.api("getMeta").capabilities.practiceRemove, true);
});

test("removePracticeBudgets deletes only the practice's budget (either language) and its alert history", () => {
  const { rt, data } = practice();
  const cat = (n) => { const id = "cat-pb-" + n; rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(id)}, name: 'PB ${n}', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`); return id; };
  const mine = rt.api("addBudget", { category_id: cat(1), amount: 1, currency: "PEN", period_type: "monthly", name: "Practice budget" });
  const es = rt.api("addBudget", { category_id: cat(2), amount: 1, currency: "PEN", period_type: "yearly", name: "Presupuesto de práctica" });
  const real = rt.api("addBudget", { category_id: cat(3), amount: 500, currency: "PEN", period_type: "monthly", name: "Real budget" });
  rt.run(`appendRowObject('Budget Alert Log', { id: 'log-pb', budget_id: ${JSON.stringify(mine.id)}, threshold: 50, period: '2026-11', sent_at: '2026-11-01' });`);
  const res = rt.api("removePracticeBudgets", {});
  assert.equal(res.removed, 2);
  const ids = rt.rows("Budgets").map((b) => b.id);
  assert.ok(!ids.includes(mine.id) && !ids.includes(es.id));
  assert.ok(ids.includes(real.id), "a real budget stays");
  assert.equal(rt.rows("Budget Alert Log").some((r) => r.budget_id === mine.id), false, "alert history gone with it");
  assert.equal(rt.api("removePracticeBudgets", {}).removed, 0, "a repeat is harmless");
  assert.equal(rt.api("getMeta").capabilities.practiceBudgets, true);
  void data;
});
