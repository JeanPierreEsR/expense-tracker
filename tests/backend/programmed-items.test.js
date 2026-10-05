// Programmed (recurring) items: start/end dates, skipping one month, manual
// "this entry paid it" override on top of the automatic matching (2026-10-05).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const ym = (d = new Date()) => d.toISOString().slice(0, 7);
const jr = (rt, code) => JSON.parse(rt.run(`JSON.stringify(${code})`));
const rowOf = (rt, id) => jr(rt, `getRecurringExpenseRows_().filter(function (r) { return r.id === ${JSON.stringify(id)}; })[0]`);
const occ = (rt, id, a, b) => jr(rt, `recurringExpenseOccurrencesInRange_(getRecurringExpenseRows_().filter(function (r) { return r.id === ${JSON.stringify(id)}; })[0], '${a}', '${b}')`);
const expenseCat = (data, i = 0) => data.cats.filter((c) => c.type === "expense")[i];

function item(rt, data, extra = {}) {
  return rt.api("addRecurringExpense", {
    category_id: expenseCat(data, 3).id, description: "Gym " + Math.random().toString(36).slice(2, 6),
    amount: 80, currency: "PEN", frequency: "monthly", day: 15, ...extra
  });
}

// ---- end / start dates -------------------------------------------------------
test("an end date stops future months but keeps the past", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data, { end_date: "2026-06-30" });
  const months = occ(rt, r.id, "2026-01-01", "2026-12-31").map((d) => d.slice(0, 7));
  assert.deepEqual(months, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
});

test("a start date means earlier months don't count", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data, { start_date: "2026-09-01" });
  const months = occ(rt, r.id, "2026-01-01", "2026-12-31").map((d) => d.slice(0, 7));
  assert.deepEqual(months, ["2026-09", "2026-10", "2026-11", "2026-12"]);
});

test("start and end together give a window; a yearly item respects it too", () => {
  const { rt, data } = freshApp();
  const m = item(rt, data, { start_date: "2026-03-10", end_date: "2026-05-20" });
  assert.deepEqual(occ(rt, m.id, "2026-01-01", "2026-12-31").map((d) => d.slice(0, 7)), ["2026-03", "2026-04", "2026-05"]);
  const y = item(rt, data, { frequency: "yearly", month: 4, day: 1, start_date: "2026-01-01", end_date: "2027-03-31" });
  assert.deepEqual(occ(rt, y.id, "2025-01-01", "2029-12-31"), ["2026-04-01"]);
});

test("the end date can be set later on an existing item, and cleared again", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  rt.api("updateRecurringExpense", { id: r.id, end_date: "2026-03-31" });
  assert.equal(occ(rt, r.id, "2026-01-01", "2026-12-31").length, 3);
  rt.api("updateRecurringExpense", { id: r.id, end_date: "" });
  assert.equal(occ(rt, r.id, "2026-01-01", "2026-12-31").length, 12);
});

test("dates must be real YYYY-MM-DD and the end can't be before the start", () => {
  const { rt, data } = freshApp();
  assert.throws(() => item(rt, data, { end_date: "June 30" }), /date/i);
  assert.throws(() => item(rt, data, { start_date: "2026-06-30", end_date: "2026-01-01" }), /before|end/i);
  const r = item(rt, data, { start_date: "2026-06-01" });
  assert.throws(() => rt.api("updateRecurringExpense", { id: r.id, end_date: "2026-05-01" }), /before|end/i);
});

test("the client list carries start/end dates", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data, { start_date: "2026-01-01", end_date: "2026-12-31" });
  const listed = rt.api("listRecurringExpenses").find((x) => x.id === r.id);
  assert.equal(listed.start_date, "2026-01-01");
  assert.equal(listed.end_date, "2026-12-31");
});

test("a one-time item ignores start/end dates", () => {
  const { rt, data } = freshApp();
  const r = rt.api("addRecurringExpense", { category_id: expenseCat(data, 3).id, description: "One off", amount: 50, currency: "PEN", frequency: "once", date: "2026-07-04", start_date: "2026-09-01" });
  assert.deepEqual(occ(rt, r.id, "2026-01-01", "2026-12-31"), ["2026-07-04"]);
});

// ---- skipping one month ------------------------------------------------------
test("skipping a month removes just that occurrence; undoing restores it", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  const months = occ(rt, r.id, "2026-01-01", "2026-05-31").map((d) => d.slice(0, 7));
  assert.deepEqual(months, ["2026-01", "2026-02", "2026-04", "2026-05"]);

  rt.api("unskipRecurringOccurrence", { id: r.id, month: "2026-03" });
  assert.equal(occ(rt, r.id, "2026-01-01", "2026-05-31").length, 5);
});

test("skipping twice is harmless, and bad input is refused", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  assert.equal(rt.rows("Recurring Skips").filter((s) => s.recurring_expense_id === r.id).length, 1);
  assert.throws(() => rt.api("skipRecurringOccurrence", { id: r.id, month: "march" }), /month/i);
  assert.throws(() => rt.api("skipRecurringOccurrence", { id: "nope", month: "2026-03" }), /not found/i);
});

test("a skip survives the item's day being changed", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  rt.api("updateRecurringExpense", { id: r.id, day: 28 });
  assert.equal(occ(rt, r.id, "2026-03-01", "2026-03-31").length, 0);
});

test("the client list shows which months were skipped", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-01" });
  const listed = rt.api("listRecurringExpenses").find((x) => x.id === r.id);
  assert.deepEqual(JSON.parse(JSON.stringify(listed.skipped_months)), ["2026-01", "2026-03"]);
});

test("deleting an item deletes its skips", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  rt.api("deleteRecurringExpense", { id: r.id });
  assert.equal(rt.rows("Recurring Skips").filter((s) => s.recurring_expense_id === r.id).length, 0);
});

// ---- "Programmed this month" -------------------------------------------------
const expectedIds = (rt) => rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items.map((i) => i.id));
// A category nobody else logs into this month, so only OUR entries could match.
const quietCat = (rt, data) => {
  const used = new Set(rt.rows("Entries").filter((e) => e.date.startsWith(ym())).map((e) => e.category_id));
  const rec = new Set(rt.rows("Recurring Expenses").map((r) => r.category_id));
  return data.cats.filter((c) => c.type === "expense").find((c) => !used.has(c.id) && !rec.has(c.id));
};

test("an item expected this month disappears when skipped, and comes back when un-skipped", () => {
  const { rt, data } = freshApp();
  const cat = quietCat(rt, data);
  const r = item(rt, data, { category_id: cat.id, day: 28 });
  assert.ok(expectedIds(rt).includes(r.id));
  rt.api("skipRecurringOccurrence", { id: r.id, month: ym() });
  assert.ok(!expectedIds(rt).includes(r.id));
  rt.api("unskipRecurringOccurrence", { id: r.id, month: ym() });
  assert.ok(expectedIds(rt).includes(r.id));
});

test("an item that has ended no longer shows as expected; one not started yet doesn't either", () => {
  const { rt, data } = freshApp();
  const cat = quietCat(rt, data);
  const ended = item(rt, data, { category_id: cat.id, day: 28, end_date: "2020-01-31" });
  const future = item(rt, data, { category_id: cat.id, day: 28, start_date: "2099-01-01" });
  assert.ok(!expectedIds(rt).includes(ended.id));
  assert.ok(!expectedIds(rt).includes(future.id));
});

test("automatic matching still works: a close entry marks the item handled", () => {
  const { rt, data } = freshApp();
  const cat = quietCat(rt, data);
  const r = item(rt, data, { category_id: cat.id, day: 28, amount: 100 });
  assert.ok(expectedIds(rt).includes(r.id));
  rt.api("createEntry", { type: "expense", date: ym() + "-28", amount: 103, currency: "PEN", category_id: cat.id, description: "paid", paid_by: "me", payment_method_id: data.pms[3].id });
  assert.ok(!expectedIds(rt).includes(r.id));
});

test("manual override: an entry the automatic match misses can be marked as the payment, and unmarked", () => {
  const { rt, data } = freshApp();
  const cat = quietCat(rt, data);
  const r = item(rt, data, { category_id: cat.id, day: 28, amount: 100 });
  // different amount and different day: automatic matching correctly refuses it
  const e = rt.api("createEntry", { type: "expense", date: ym() + "-03", amount: 250, currency: "PEN", category_id: cat.id, description: "paid differently", paid_by: "me", payment_method_id: data.pms[3].id });
  assert.ok(expectedIds(rt).includes(r.id), "automatic match doesn't catch it");

  rt.api("linkEntryToRecurring", { entryId: e.id, recurringExpenseId: r.id });
  assert.ok(!expectedIds(rt).includes(r.id), "now counted as paid");

  rt.api("linkEntryToRecurring", { entryId: e.id, recurringExpenseId: "" });
  assert.ok(expectedIds(rt).includes(r.id), "unlinking puts it back");
});

test("the manual picker lists this month's confirmed entries, closest amount first", () => {
  const { rt, data } = freshApp();
  const cat = quietCat(rt, data);
  const r = item(rt, data, { category_id: cat.id, day: 28, amount: 100 });
  const far = rt.api("createEntry", { type: "expense", date: ym() + "-03", amount: 900, currency: "PEN", category_id: cat.id, description: "far", paid_by: "me", payment_method_id: data.pms[3].id });
  const near = rt.api("createEntry", { type: "expense", date: ym() + "-04", amount: 120, currency: "PEN", category_id: cat.id, description: "near", paid_by: "me", payment_method_id: data.pms[3].id });
  const list = rt.api("listEntriesForRecurringMonth", { id: r.id, month: ym() });
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes(near.id) && ids.includes(far.id));
  assert.ok(ids.indexOf(near.id) < ids.indexOf(far.id));
  assert.ok(list.every((x) => x.date.startsWith(ym())));
});

// ---- existing sheets -----------------------------------------------------------
test("a sheet from before these columns existed upgrades itself", () => {
  const { rt, data } = freshApp();
  const sheet = rt.sheet("Recurring Expenses");
  sheet.rows.forEach((r) => { r.length = 10; });            // old layout: no start_date/end_date
  sheet.lastCol = 10;
  rt.svc.ss.deleteSheet(rt.sheet("Recurring Skips"));        // and no skips sheet
  const r = item(rt, data, { end_date: "2026-06-30" });
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-02" });
  const months = occ(rt, r.id, "2026-01-01", "2026-12-31").map((d) => d.slice(0, 7));
  assert.deepEqual(months, ["2026-01", "2026-03", "2026-04", "2026-05", "2026-06"]);
});

// ---- Sheets turns "2026-10" into a real date in a non-text column ---------------
// (Reported 2026-10-05: undoing a skip "didn't save".) The skips tab is created
// text-formatted, but the code must not depend on that: a month that comes back
// as a Date has to still match, un-skip and de-duplicate.
function dateMonthSkips(rt) {
  const sheet = rt.sheet("Recurring Skips");
  sheet.textCols.clear();                                    // the column is NOT text-formatted
  return sheet;
}
test("skip / undo work even if Sheets stored the month as a real date", () => {
  const { rt, data } = freshApp();
  const r = item(rt, data);
  dateMonthSkips(rt);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });
  assert.ok(rt.sheet("Recurring Skips").rows[1][2] instanceof Date, "precondition: stored as a Date");

  assert.deepEqual(occ(rt, r.id, "2026-01-01", "2026-05-31").map((d) => d.slice(0, 7)), ["2026-01", "2026-02", "2026-04", "2026-05"]);
  assert.deepEqual(JSON.parse(JSON.stringify(rt.api("listRecurringExpenses").find((x) => x.id === r.id).skipped_months)), ["2026-03"]);

  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-03" });          // again: still one row
  assert.equal(rt.rows("Recurring Skips").filter((s) => s.recurring_expense_id === r.id).length, 1);

  rt.api("unskipRecurringOccurrence", { id: r.id, month: "2026-03" });        // the reported bug
  assert.equal(rt.rows("Recurring Skips").filter((s) => s.recurring_expense_id === r.id).length, 0);
  assert.equal(occ(rt, r.id, "2026-01-01", "2026-05-31").length, 5);
});
