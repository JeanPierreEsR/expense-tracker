// Input validation and hand-edit robustness (persona findings, 2026-10-05).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const month = () => new Date().toISOString().slice(0, 7);

// ---- Exchange rates ---------------------------------------------------------
test("exchange rate: 0, negative, text and non-finite values are rejected", () => {
  const { rt } = freshApp();
  for (const bad of [0, -3.7, "abc", NaN, null, "", Infinity]) {
    assert.throws(() => rt.api("setExchangeRate", { currency: "USD", month: month(), rate: bad }), /rate/i, String(bad));
  }
});
test("exchange rate: month must be YYYY-MM and currency is upper-cased", () => {
  const { rt } = freshApp();
  assert.throws(() => rt.api("setExchangeRate", { currency: "USD", month: "2026-9", rate: 3.7 }), /month/i);
  assert.throws(() => rt.api("setExchangeRate", { currency: "USD", month: "last month", rate: 3.7 }), /month/i);
  const r = rt.api("setExchangeRate", { currency: " usd ", month: "2030-01", rate: 3.7 });
  assert.equal(r.currency, "USD");
});

// ---- Budgets ----------------------------------------------------------------
const freeCat = (data) => data.cats.filter((c) => c.type === "expense")[15];
test("budget: amount must be a positive number", () => {
  const { rt, data } = freshApp();
  for (const bad of [0, -5, "abc", null]) {
    assert.throws(() => rt.api("addBudget", { category_id: freeCat(data).id, amount: bad, currency: "PEN", period_type: "monthly" }), /amount/i, String(bad));
  }
});
test("budget: thresholds must be positive numbers; valid ones are cleaned up", () => {
  const { rt, data } = freshApp();
  for (const bad of ["0", "-5", "abc", "75%", "75,,x"]) {
    assert.throws(() => rt.api("addBudget", { category_id: freeCat(data).id, amount: 100, currency: "PEN", period_type: "monthly", thresholds: bad }), /threshold/i, bad);
  }
  const b = rt.api("addBudget", { category_id: freeCat(data).id, amount: 100, currency: "PEN", period_type: "monthly", thresholds: " 100 , 75,75 " });
  assert.equal(b.thresholds, "75,100");
});
test("budget: raising the budget after an alert re-arms the alerts for this period", () => {
  const { rt, data } = freshApp();
  const cat = freeCat(data);
  const b = rt.api("addBudget", { category_id: cat.id, amount: 100, currency: "PEN", period_type: "monthly", thresholds: "75" });
  rt.api("createEntry", { type: "expense", date: today(), amount: 90, currency: "PEN", category_id: cat.id, description: "x", paid_by: "me", payment_method_id: data.pms[3].id });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t"); rt.svc.props.set("TELEGRAM_CHAT_ID", "1");
  rt.run("checkBudgets()");
  assert.equal(rt.rows("Budget Alert Log").filter((r) => r.budget_id === b.id).length, 1);

  rt.api("updateBudget", { id: b.id, amount: 100000 });        // far below 75% again
  assert.equal(rt.rows("Budget Alert Log").filter((r) => r.budget_id === b.id).length, 0, "old alerts for this period are cleared");
});

// ---- Friends ----------------------------------------------------------------
test("adding a friend with an existing name returns that friend instead of a duplicate", () => {
  const { rt, data } = freshApp();
  const before = rt.rows("Friends").length;
  const again = rt.api("addFriend", { name: "  " + data.friends[2].name.toUpperCase() + " " });
  assert.equal(again.id, data.friends[2].id);
  assert.equal(rt.rows("Friends").length, before);
});

// ---- Loans & splits ---------------------------------------------------------
test("editing a cash loan that already has repayments cannot change its amount/currency/friend", () => {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Edit Guard" });
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: today(), payment_method_id: data.pms[3].id });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: data.pms[3].id });
  const base = { id: loan.id, friend_id: f.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "ok" };

  assert.throws(() => rt.api("updateLoan", { ...base, amount: 20 }), /repayment/i, "below what was already repaid");
  assert.throws(() => rt.api("updateLoan", { ...base, currency: "USD" }), /repayment/i);
  assert.throws(() => rt.api("updateLoan", { ...base, friend_id: data.friends[0].id }), /repayment/i);
  const ok = rt.api("updateLoan", { ...base, description: "renamed" });
  assert.equal(ok.description, "renamed");
});
test("a split larger than the expense is rejected by the server", () => {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Split Guard" });
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 50, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", paid_by: "me", payment_method_id: data.pms[3].id });
  assert.throws(() => rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: f.id, amount: 60 }] }), /split/i);
  assert.equal(rt.rows("Loans").filter((l) => l.entry_id === e.id).length, 0);
});

// ---- Hand-edited sheets -----------------------------------------------------
test("an entry whose id was typed by hand as a NUMBER can still be edited and deleted", () => {
  const { rt, data } = freshApp();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 12, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "hand id", paid_by: "me", payment_method_id: data.pms[3].id });
  const sheet = rt.sheet("Entries");
  const row = sheet.rows.findIndex((r) => r[0] === e.id);
  sheet.rows[row][0] = 12345;   // the owner retyped the id cell; Sheets stores a number
  rt.api("updateEntry", { id: "12345", fields: { description: "edited" } });
  assert.equal(rt.rows("Entries").find((x) => x.id === "12345").description, "edited");
  rt.api("discardEntry", { id: "12345" });
  assert.equal(rt.rows("Entries").find((x) => x.id === "12345"), undefined);
});
test("tags and splits are written by column NAME, so reordering sheet columns is safe", () => {
  const { rt, data } = freshApp();
  const tags = rt.sheet("Entry Tags"), splits = rt.sheet("Entry Splits");
  tags.rows.forEach((r) => r.reverse());                    // [tag_id, entry_id]
  splits.rows.forEach((r) => { const [id, entry, friend, amount] = r; r.splice(0, 4, amount, friend, entry, id); });  // reversed
  const f = rt.api("addFriend", { name: "Order Test" });
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 80, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", paid_by: "me", payment_method_id: data.pms[3].id, tag_ids: [data.tags[0].id] });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: f.id, amount: 20 }] });
  rt.api("saveEntryTags", { entryId: e.id, tagIds: [data.tags[1].id] });

  assert.deepEqual(rt.rows("Entry Splits").filter((s) => s.entry_id === e.id).map((s) => [s.friend_id, Number(s.amount)]), [[f.id, 20]]);
  assert.deepEqual(rt.rows("Entry Tags").filter((t) => t.entry_id === e.id).map((t) => t.tag_id), [data.tags[1].id]);
});
test("changing an entry's split marks the entry changed (other phones refresh)", () => {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Version Test" });
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 80, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", paid_by: "me", payment_method_id: data.pms[3].id });
  const before = rt.svc.props.get("ENTRIES_VERSION");
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: f.id, amount: 20 }] });
  assert.notEqual(rt.svc.props.get("ENTRIES_VERSION"), before);
});

// ---- Duplicate-safe creates -------------------------------------------------
test("a resent addRecurringExpense (same _requestId) creates only one item", () => {
  const { rt, data } = freshApp();
  const payload = { category_id: data.cats.find((c) => c.type === "expense").id, description: "Gym", amount: 50, currency: "PEN", frequency: "monthly", day: 5, _requestId: "req-1" };
  const before = rt.rows("Recurring Expenses").length;
  rt.api("addRecurringExpense", payload);
  rt.api("addRecurringExpense", payload);
  assert.equal(rt.rows("Recurring Expenses").length, before + 1);
});
