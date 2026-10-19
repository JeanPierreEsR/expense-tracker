// The "Home" case (owner, 2026-10-19): a shared rent that used to be logged as ONLY
// his share (on odd days) and from last month as the FULL payment with splits, plus
// Annual-tagged repairs.
//  - "Find past entries" / the Mark-as-paid picker compare his share with his share.
//  - Old rent entries that aren't matched stay in the average and are counted a second
//    time on top of the programmed rent; linking them (one tap) takes them out.
//  - A Month view leaves Annual-tagged expenses out of Actual.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const HOME = "cat-home-test";
const [thisYear, thisMonth] = today().split("-").map(Number);
const ago = (k, day) => {
  const d = new Date(Date.UTC(thisYear, thisMonth - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
let seq = 0;

function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(HOME)}, name: 'Home test', type: 'expense', icon: '🏠', color: '#ccc', parent_id: '' });`);
  for (let k = 0; k <= 16; k++) rt.api("setExchangeRate", { currency: "USD", month: ago(k, 1).slice(0, 7), rate: 3.8 });
  const f1 = data.friends[0].id, f2 = data.friends[1].id;
  const add = (date, amount, description, currency = "PEN") => {
    const id = "h-" + ++seq;
    rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date, amount, currency, category_id: HOME, description, paid_by: "me", status: "confirmed", source: "manual" })});`);
    return id;
  };
  add(ago(40, 1), 1, "first ever");
  // Rent: until last month ONLY his share (USD 266.67) on the 4th; last month the full USD 800 on the 20th with two splits.
  for (let k = 12; k >= 2; k--) add(ago(k, 4), 266.67, "Apartment rent", "USD");
  const full = add(ago(1, 20), 800, "Apartment rent", "USD");
  rt.run(`appendRowObject('Entry Splits', { id: 'hs1', entry_id: ${JSON.stringify(full)}, friend_id: ${JSON.stringify(f1)}, amount: 266.67 }); appendRowObject('Entry Splits', { id: 'hs2', entry_id: ${JSON.stringify(full)}, friend_id: ${JSON.stringify(f2)}, amount: 266.66 });`);
  for (let k = 12; k >= 1; k--) { add(ago(k, 8), 120, "Internet"); add(ago(k, 2), 248.47, "Building maintenance fee"); }
  const rent = rt.api("addRecurringExpense", { category_id: HOME, description: "Apartment rent", amount: 800, currency: "USD", frequency: "monthly", day: 20 });
  rt.api("saveRecurringExpenseSplits", { recurringExpenseId: rent.id, splits: [{ friend_id: f1, amount: 266.67 }, { friend_id: f2, amount: 266.66 }] });
  rt.api("addRecurringExpense", { category_id: HOME, description: "Internet", amount: 120, currency: "PEN", frequency: "monthly", day: 8 });
  rt.api("addRecurringExpense", { category_id: HOME, description: "Building maintenance fee", amount: 248.47, currency: "PEN", frequency: "monthly", day: 2 });
  return { rt, add, rent, f1, f2 };
}
const projection = (rt, type = "month") => rt.api("listCategoryProjections", { displayPeriodType: type }).categories.find((c) => c.category_id === HOME);

test("'Find past entries' finds the old entries that hold only the owner's share of a shared item, pre-checked", () => {
  const { rt, rent } = setup();
  const { candidates } = rt.api("findRecurringLinkCandidates", { recurringExpenseId: rent.id });
  const old = candidates.filter((c) => c.amount === 266.67);
  assert.equal(old.length, 11, "all 11 old rent entries (his share only, on the 4th)");
  assert.ok(old.every((c) => c.score >= 1.3), "word + amount match: the app pre-checks them");
});

test("the Mark-as-paid picker ranks an own-share-only entry high for the shared item", () => {
  const { rt, rent } = setup();
  const list = rt.api("listEntriesForRecurringMonth", { id: rent.id, month: ago(3, 1).slice(0, 7) });
  const mine = list.find((e) => e.amount === 266.67 && e.description === "Apartment rent");
  assert.ok(mine && mine.is_top, "in the 'most similar' group");
  assert.equal(mine.own_amount, undefined, "the helper field is not sent to the app");
});

test("the old rent is counted twice until it is linked: Expected carries it, then linking takes it out", () => {
  const { rt, rent } = setup();
  const before = projection(rt);
  assert.ok(before.expectedRemainingPen > 100, "the unmatched old rent sits in the average and is added on top of the programmed rent");
  assert.ok(before.ratePerMonth > 900, "about USD 266.67 x 3.8 = 1,013 a month");
  const ids = rt.api("findRecurringLinkCandidates", { recurringExpenseId: rent.id }).candidates.map((c) => c.id);
  rt.api("linkEntriesToRecurring", { recurringExpenseId: rent.id, entryIds: ids });
  const after = projection(rt);
  assert.ok(Math.abs(after.ratePerMonth) < 0.01, "linked: the old rent left the average");
  assert.ok(Math.abs(after.expectedRemainingPen) < 0.01);
});

test("a PAUSED item keeps its past payments out of the averages; deleting it brings them back", () => {
  const { rt, rent } = setup();
  const ids = rt.api("findRecurringLinkCandidates", { recurringExpenseId: rent.id }).candidates.map((c) => c.id);
  rt.api("linkEntriesToRecurring", { recurringExpenseId: rent.id, entryIds: ids });
  assert.ok(Math.abs(projection(rt).ratePerMonth) < 0.01, "linked: out of the average");

  rt.api("updateRecurringExpense", { id: rent.id, active: false });
  const paused = projection(rt);
  assert.ok(Math.abs(paused.ratePerMonth) < 0.01, "paused: its history is still excluded");
  assert.ok(paused.programmedRemainingPen < 400, "and the paused rent no longer projects (only internet + the fee are left)");

  rt.api("deleteRecurringExpense", { id: rent.id });
  assert.ok(projection(rt).ratePerMonth > 900, "deleted: the old rent entries count as ordinary spending again");
});

test("an automatically matched paused item (no hand links) keeps its history excluded too", () => {
  const { rt } = setup();
  const internet = rt.rows("Recurring Expenses").find((r) => r.description === "Internet");
  const before = projection(rt).ratePerMonth;
  rt.api("updateRecurringExpense", { id: internet.id, active: false });
  assert.ok(Math.abs(projection(rt).ratePerMonth - before) < 0.01, "pausing the item doesn't push its 12 matched payments back into the average");
});

test("a Month view's total = what is programmed (+ real Actual): Annual-tagged lumps are not in it", () => {
  const { rt, add } = setup();
  rt.run("ensureAnnualTag_()");
  const repair = add(ago(0, 1), 1800, "Plumbing");   // this month, tagged Annual
  rt.run(`appendRowObject('Entry Tags', { entry_id: ${JSON.stringify(repair)}, tag_id: ANNUAL_TAG_ID });`);
  const m = projection(rt, "month");
  assert.equal(m.actualPen, 0, "the 1,800 repair isn't part of the month's Actual");
  assert.equal(m.annualInPeriodPen, 1800, "it is reported on its own line");
  const y = projection(rt, "year");
  assert.equal(y.actualPen > 1799, true, "but a Year view counts it");
  // And it still shows where entries are listed.
  const listed = rt.api("listEntries", { categoryId: HOME }).map((e) => e.id);
  assert.ok(listed.includes(repair), "Overview / lists still show Annual-tagged entries");
});
