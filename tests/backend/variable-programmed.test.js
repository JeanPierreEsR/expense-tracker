// Variable-amount programmed items (2026-10-19): a monthly bill that surely
// arrives but never costs the same (electricity, gas).
//  - Its estimate is the average of its last 3 recognised payments.
//  - A payment is recognised by a keyword + the plausible amount range, not by
//    the fixed ±10% rule.
//  - A recognised payment is pulled out of the category's year-to-date average
//    in Projections, so the same bill is not counted twice (Programmed AND Expected).
//  - "Look for variable bills" proposes such items from the last 6 months of entries.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const CAT = "cat-var-test";
const year = new Date().getFullYear();
const monthsElapsed = new Date().getMonth();   // complete months before this one
const needsHistory = monthsElapsed < 1 ? "no complete month yet this year" : false;

// A brand-new expense category, so only the entries below feed its figures.
function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(CAT)}, name: 'Home test', type: 'expense', icon: '🏠', color: '#ccc', parent_id: '' });`);
  return { rt, data };
}
let seq = 0;
function addEntry(rt, date, amount, description, extra = {}) {
  const id = "e-var-" + ++seq;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({
    id, type: "expense", date, amount, currency: "PEN", category_id: CAT, description, paid_by: "me", status: "confirmed", source: "manual", ...extra
  })});`);
  return id;
}
// YYYY-MM-DD of `day` in the month `k` months before the (backend's) current one.
function monthsAgo(k, day) {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const thisMonthDay = (day) => today().slice(0, 7) + "-" + String(day).padStart(2, "0");
const variableItem = (rt, extra = {}) => rt.api("addRecurringExpense", {
  category_id: CAT, description: "Electricity", amount: 120, currency: "PEN", frequency: "monthly", day: 12,
  variable: true, match_words: "luz", ...extra
});
const listed = (rt, id) => rt.api("listRecurringExpenses").find((x) => x.id === id);
const expectedIds = (rt) => rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items.map((i) => i.id));
const projection = (rt) => rt.api("listCategoryProjections", { displayPeriodType: "month" }).categories.find((c) => c.category_id === CAT);

test("the estimate is the average of the last 3 payments; older ones don't count", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(1, 12), 200, "Recibo luz");
  addEntry(rt, monthsAgo(2, 12), 150, "Recibo luz");
  addEntry(rt, monthsAgo(3, 12), 100, "Recibo luz");
  addEntry(rt, monthsAgo(4, 12), 700, "Recibo luz");   // too old to count
  const r = variableItem(rt);
  const item = listed(rt, r.id);
  assert.equal(item.variable, true);
  assert.equal(item.amount, 150, "(200 + 150 + 100) / 3");
  assert.equal(item.base_amount, 120, "what was typed is kept");
  assert.equal(item.payments_used, 3);
  assert.equal(item.match_words, "luz");
});

test("until a payment exists, the typed estimate is used", () => {
  const { rt } = setup();
  const item = listed(rt, variableItem(rt).id);
  assert.equal(item.amount, 120);
  assert.equal(item.payments_used, 0);
});

test("a normal item is untouched: not variable, no range", () => {
  const { rt } = setup();
  const r = rt.api("addRecurringExpense", { category_id: CAT, description: "Gym", amount: 80, currency: "PEN", frequency: "monthly", day: 5 });
  const item = listed(rt, r.id);
  assert.equal(item.variable, false);
  assert.equal(item.amount, 80);
  assert.equal(item.amount_low, null);
});

test("a payment is recognised by keyword and plausible amount, not by the fixed 10% rule", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(1, 12), 100, "Recibo luz");
  addEntry(rt, monthsAgo(2, 12), 200, "Recibo luz");
  const r = variableItem(rt);
  assert.ok(expectedIds(rt).includes(r.id), "nothing paid this month yet");

  addEntry(rt, thisMonthDay(3), 5000, "Recibo luz");              // way outside the range
  assert.ok(expectedIds(rt).includes(r.id), "an absurd amount is not the bill");
  addEntry(rt, thisMonthDay(3), 160, "Compra supermercado");       // plausible amount, other words
  assert.ok(expectedIds(rt).includes(r.id), "other words are not the bill");

  addEntry(rt, thisMonthDay(3), 260, "Pago luz del mes");           // 160 away from the 150 estimate
  assert.ok(!expectedIds(rt).includes(r.id), "keyword + amount in range = paid, even on another day of the month");
});

test("an entry in another currency or another category is not the bill", () => {
  const { rt, data } = setup();
  const other = data.cats.filter((c) => c.type === "expense")[0];
  addEntry(rt, monthsAgo(1, 12), 100, "Recibo luz");
  const r = variableItem(rt);
  addEntry(rt, thisMonthDay(3), 100, "Recibo luz", { category_id: other.id });
  addEntry(rt, thisMonthDay(3), 100, "Recibo luz", { currency: "USD" });
  assert.ok(expectedIds(rt).includes(r.id));
});

test("an entry linked by hand to this item always counts as its payment", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(1, 12), 100, "Recibo luz");
  const r = variableItem(rt);
  const odd = addEntry(rt, thisMonthDay(3), 20, "Electricidad");   // no keyword, tiny amount
  assert.ok(expectedIds(rt).includes(r.id));
  rt.api("linkEntryToRecurring", { entryId: odd, recurringExpenseId: r.id });
  assert.ok(!expectedIds(rt).includes(r.id));
});

test("'Programmed this month' marks a variable amount as an estimate", () => {
  const { rt } = setup();
  const r = variableItem(rt);
  const item = rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items).find((i) => i.id === r.id);
  assert.equal(item.estimated, true);
});

test("only a monthly item can be variable, and it needs a usable keyword", () => {
  const { rt } = setup();
  assert.throws(() => variableItem(rt, { match_words: "" }), /keyword/i);
  assert.throws(() => variableItem(rt, { match_words: "de 12" }), /keyword/i);
  assert.throws(() => variableItem(rt, { frequency: "yearly", month: 3 }), /monthly/i);
  const r = variableItem(rt);
  assert.throws(() => rt.api("updateRecurringExpense", { id: r.id, match_words: "" }), /keyword/i);
  assert.throws(() => rt.api("updateRecurringExpense", { id: r.id, frequency: "yearly" }), /monthly/i);
  rt.api("updateRecurringExpense", { id: r.id, match_words: "enel luz" });
  assert.equal(listed(rt, r.id).match_words, "enel luz");
  rt.api("updateRecurringExpense", { id: r.id, variable: false });
  const back = listed(rt, r.id);
  assert.equal(back.variable, false);
  assert.equal(back.match_words, "", "turning it off drops the words");
  assert.equal(back.amount, 120);
});

test("three-letter keywords work, accents and case don't matter", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(1, 12), 100, "GAS natural");
  const r = variableItem(rt, { match_words: "Gás" });
  assert.equal(listed(rt, r.id).payments_used, 1);
});

test("projections: a recognised payment leaves the year-to-date rate, so the bill isn't counted twice", { skip: needsHistory }, () => {
  const { rt } = setup();
  const k = Math.min(3, monthsElapsed);
  const amounts = [100, 200, 300].slice(0, k);
  amounts.forEach((a, i) => addEntry(rt, `${year}-${String(monthsElapsed - i).padStart(2, "0")}-12`, a, "Recibo luz"));
  const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;

  // Without the item the whole electricity bill feeds the average spend.
  assert.ok(projection(rt).ratePerMonth > 0);

  const r = variableItem(rt);
  const p = projection(rt);
  assert.ok(Math.abs(p.ratePerMonth) < 0.001, "all year-to-date spend is explained by the item, nothing left for Expected");
  assert.ok(Math.abs(p.programmedRemainingPen - avg) < 0.01, "this month's bill is Programmed at the average of the last payments");

  addEntry(rt, thisMonthDay(Number(today().slice(8, 10))), Math.round(avg), "Recibo luz");
  const paid = projection(rt);
  assert.ok(Math.abs(paid.programmedRemainingPen) < 0.001, "once paid, nothing is left to program");
  assert.ok(Math.abs(paid.actualPen - Math.round(avg)) < 0.001);
  assert.ok(paid.expectedRemainingPen < 0.001);
});

// ---- "Look for variable bills" -------------------------------------------------
function monthlyHistory(rt, words, amounts, day = 14, firstK = 1) {
  amounts.forEach((a, i) => { if (a != null) addEntry(rt, monthsAgo(firstK + i, day), a, words); });
}

test("the scan proposes a monthly bill whose amount moves, and ignores fixed amounts and shopping habits", () => {
  const { rt } = setup();
  monthlyHistory(rt, "Recibo luz Enel", [180, 150, 210, 170, 160, 190]);
  monthlyHistory(rt, "Netflix", [45, 45, 45, 45, 45, 45], 3);                       // fixed amount: a normal item
  for (let k = 1; k <= 6; k++) for (let n = 0; n < 5; n++) addEntry(rt, monthsAgo(k, 2 + n * 5), 60 + n * 7 + k, "Supermercado Wong");
  const { suggestions } = rt.api("suggestVariableRecurring");
  const mine = suggestions.filter((s) => s.category_id === CAT);
  assert.equal(mine.length, 1, "only the electricity bill");
  const s = mine[0];
  assert.deepEqual(s.match_words.split(" ").sort(), ["enel", "luz"], "both words that point at the same payments");
  assert.equal(s.months_seen, 6);
  assert.equal(s.avg_amount, Math.round(((180 + 150 + 210) / 3) * 100) / 100, "average of the 3 newest");
  assert.equal(s.min_amount, 150);
  assert.equal(s.max_amount, 210);
  assert.equal(s.typical_day, 14);
  assert.equal(s.currency, "PEN");
  assert.equal(s.recent.length, 3);
});

test("the estimate the scan proposes is the one the item shows once it is added", () => {
  const { rt } = setup();
  monthlyHistory(rt, "Recibo luz", [180, 150, 210, 170, 160, 190], 14);
  addEntry(rt, monthsAgo(1, 2), 35, "Luz bombilla");          // a small extra "luz" entry early in the newest month
  addEntry(rt, monthsAgo(3, 27), 95, "Luz de emergencia");    // and another late in an older one
  const s = rt.api("suggestVariableRecurring").suggestions.find((x) => x.category_id === CAT);
  assert.ok(s, "still proposed");
  const r = variableItem(rt, { match_words: s.match_words, day: s.typical_day });
  assert.equal(listed(rt, r.id).amount, s.avg_amount);
});

test("the scan needs the bill in at least 4 of the last 6 months", () => {
  const { rt } = setup();
  monthlyHistory(rt, "Recibo luz", [180, 150, null, null, 160, null]);   // 3 of 6
  assert.equal(rt.api("suggestVariableRecurring").suggestions.filter((s) => s.category_id === CAT).length, 0);
  monthlyHistory(rt, "Recibo luz", [190], 14, 4);                          // now 4 of 6
  assert.equal(rt.api("suggestVariableRecurring").suggestions.filter((s) => s.category_id === CAT).length, 1);
});

test("once added as a variable item the bill is no longer suggested", () => {
  const { rt } = setup();
  monthlyHistory(rt, "Recibo luz", [180, 150, 210, 170, 160, 190]);
  const first = rt.api("suggestVariableRecurring").suggestions.find((s) => s.category_id === CAT);
  assert.ok(first);
  variableItem(rt, { match_words: first.match_words });
  assert.equal(rt.api("suggestVariableRecurring").suggestions.filter((s) => s.category_id === CAT).length, 0);
});

test("payments already explained by a fixed programmed item aren't suggested", () => {
  const { rt } = setup();
  monthlyHistory(rt, "Water bill", [100, 120, 100, 110, 105, 115]);
  rt.api("addRecurringExpense", { category_id: CAT, description: "Water", amount: 110, currency: "PEN", frequency: "monthly", day: 14 });
  assert.equal(rt.api("suggestVariableRecurring").suggestions.filter((s) => s.category_id === CAT).length, 0);
});

// ---- bills the owner pays for several people (flatmates) ---------------------------
// Entry `id` shared with the (made-up) friend "Flatmate A": `friendShare` is theirs.
function shareEntry(rt, entryId, friendShare, friendId = "f-flat-a") {
  if (!rt.rows("Friends").some((f) => f.id === friendId)) rt.run(`appendRowObject('Friends', { id: ${JSON.stringify(friendId)}, name: 'Flatmate A', notes: '' });`);
  rt.run(`appendRowObject('Entry Splits', { id: ${JSON.stringify("s-" + entryId + friendId)}, entry_id: ${JSON.stringify(entryId)}, friend_id: ${JSON.stringify(friendId)}, amount: ${friendShare} });`);
}
function sharedGasHistory(rt, months = 6) {
  const bills = [60, 66, 72, 54, 63, 69];
  for (let i = 0; i < months; i++) {
    const id = addEntry(rt, monthsAgo(1 + i, 8), bills[i], "Gas del depa");
    shareEntry(rt, id, bills[i] * 2 / 3);   // two thirds paid back by flatmates
  }
}

test("the scan says when a bill is usually shared, with whom, and the owner's own share", () => {
  const { rt } = setup();
  sharedGasHistory(rt);
  const s = rt.api("suggestVariableRecurring").suggestions.find((x) => x.category_id === CAT);
  assert.ok(s);
  assert.equal(s.shared, true);
  assert.deepEqual(s.split.map((f) => f.name), ["Flatmate A"]);
  assert.equal(s.split[0].amount, 40, "the newest payment (60) was shared out as 40 for the flatmate");
  assert.equal(s.avg_amount, 66, "total bill: average of the newest 3 (60, 66, 72)");
  assert.equal(s.own_avg_amount, 22, "the owner's third of that");
});

test("a bill nobody shares is not marked shared", () => {
  const { rt } = setup();
  monthlyHistory(rt, "Recibo luz", [180, 150, 210, 170, 160, 190]);
  const s = rt.api("suggestVariableRecurring").suggestions.find((x) => x.category_id === CAT);
  assert.equal(s.shared, false);
  assert.deepEqual(s.split, []);
  assert.equal(s.own_avg_amount, s.avg_amount);
});

test("a shared variable item counts only the owner's share, following the real payments", () => {
  const { rt } = setup();
  sharedGasHistory(rt, 3);   // 60, 66, 72: the owner paid a third of each
  const r = variableItem(rt, { match_words: "gas", day: 8 });
  const item = listed(rt, r.id);
  assert.equal(item.amount, 66, "total bill estimate");
  assert.equal(item.split_total, 44, "two thirds of it is shared out");
  const group = rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items).find((i) => i.id === r.id);
  assert.equal(group.amount, 22, "Programmed this month counts the owner's third: 66 / 3");
});

test("a fixed split saved on the item does not follow a bill that changes every month", () => {
  const { rt } = setup();
  sharedGasHistory(rt, 3);
  const r = variableItem(rt, { match_words: "gas", day: 8 });
  rt.api("saveRecurringExpenseSplits", { recurringExpenseId: r.id, splits: [{ friend_id: "f-flat-a", amount: 10 }] });   // a stale fixed amount
  const group = rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items).find((i) => i.id === r.id);
  assert.equal(group.amount, 22, "the real shares of recent payments win over the fixed 10");
});

// ---- existing sheets ---------------------------------------------------------------
test("a sheet from before these columns existed upgrades itself", () => {
  const { rt } = setup();
  const sheet = rt.sheet("Recurring Expenses");
  sheet.rows.forEach((r) => { r.length = 12; });          // old layout: no variable / match_words
  sheet.lastCol = 12;
  const r = variableItem(rt);
  assert.equal(listed(rt, r.id).variable, true);
  assert.equal(listed(rt, r.id).match_words, "luz");
});
