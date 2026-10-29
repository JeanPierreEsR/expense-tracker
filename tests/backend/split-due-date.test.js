// The optional due date of the debts a split creates (owner's request, 2026-10-29). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function shared(rt, data, splits) {
  const friend = rt.api("addFriend", { name: "Due Friend " + Math.random().toString(36).slice(2, 7) });
  const cat = data.cats.find((c) => c.type === "expense");
  const entry = rt.api("createEntry", {
    type: "expense", date: today(), amount: 100, currency: "PEN", category_id: cat.id,
    description: "Test dinner", paid_by: "me", payment_method_id: data.pms[3].id
  });
  rt.api("saveEntrySplits", { entryId: entry.id, splits: splits(friend) });
  return { entry, friend };
}
const loanOf = (rt, entry) => rt.rows("Loans").filter((l) => l.entry_id === entry.id && l.origin === "entry");

test("a split with no due date keeps creating loans without one (as before)", () => {
  const { rt, data } = freshApp({ small: true });
  const { entry } = shared(rt, data, (f) => [{ friend_id: f.id, amount: 40 }]);
  assert.equal(loanOf(rt, entry)[0].due_date || "", "");
});

test("a due date sent with the split lands on the loan, and the edit form can read it back", () => {
  const { rt, data } = freshApp({ small: true });
  const { entry } = shared(rt, data, (f) => [{ friend_id: f.id, amount: 40, due_date: "2031-05-20" }]);
  assert.equal(loanOf(rt, entry)[0].due_date, "2031-05-20");
  const listed = rt.api("listEntries", {}).find((e) => e.id === entry.id);
  assert.equal(listed.split_due_date, "2031-05-20");
});

test("saving the split again without a date keeps the one the loan has; sending '' clears it", () => {
  const { rt, data } = freshApp({ small: true });
  const { entry, friend } = shared(rt, data, (f) => [{ friend_id: f.id, amount: 40, due_date: "2031-05-20" }]);
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 45 }] });   // e.g. a Telegram edit
  assert.equal(loanOf(rt, entry)[0].due_date, "2031-05-20");
  assert.equal(Number(loanOf(rt, entry)[0].amount), 45);
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 45, due_date: "" }] });
  assert.equal(loanOf(rt, entry)[0].due_date || "", "");
});

test("one date goes to every friend's loan; a bad date counts as none", () => {
  const { rt, data } = freshApp({ small: true });
  const second = rt.api("addFriend", { name: "Due Friend Two" });
  const { entry } = shared(rt, data, (f) => [{ friend_id: f.id, amount: 30, due_date: "2031-06-01" }, { friend_id: second.id, amount: 30, due_date: "2031-06-01" }]);
  assert.deepEqual(loanOf(rt, entry).map((l) => l.due_date), ["2031-06-01", "2031-06-01"]);
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: second.id, amount: 30, due_date: "not a date" }] });
  assert.equal(loanOf(rt, entry)[0].due_date || "", "");
});

test("the new texts exist in both languages", () => {
  const strings = require("fs").readFileSync(require("path").join(__dirname, "../../docs/strings.js"), "utf8");
  ["split.addDue", "split.dueWeek", "split.dueMonthEnd", "split.dueClear"].forEach((k) => {
    const m = strings.match(new RegExp('"' + k.replace(".", "\\.") + '": \\{ en: "([^"]+)", es: "([^"]+)"'));
    assert.ok(m && m[1] && m[2], k);
  });
});
