// Programmed items: "Stop it" (end date today) vs "Delete it", the preview of what deleting would add to the monthly average,
// and one-time items that are already paid. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const CAT = "cat-gym-test";
const INC = "cat-salary-test";
const [Y, M] = today().split("-").map(Number);
const ago = (k, day) => {
  const d = new Date(Date.UTC(Y, M - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
let seq = 0;

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: '${CAT}', name: 'Gym test', type: 'expense', icon: '🏋️', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: '${INC}', name: 'Salary test', type: 'income', icon: '💼', color: '#ccc', parent_id: '' });`);
  const add = (date, amount, description, category = CAT, type = "expense") => {
    const id = "gs-" + ++seq;
    rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type, date, amount, currency: "PEN", category_id: category, description, paid_by: "me", status: "confirmed", source: "manual" })});`);
    return id;
  };
  add(ago(40, 1), 1, "first ever");
  for (let k = 12; k >= 0; k--) add(ago(k, 1), 100, "Gym membership");
  const gym = rt.api("addRecurringExpense", { category_id: CAT, description: "Gym membership", amount: 100, currency: "PEN", frequency: "monthly", day: 1 });
  return { rt, data, add, gym };
}
const rate = (rt, cat = CAT) => rt.api("listCategoryProjections", { displayPeriodType: "year" }).categories.find((c) => c.category_id === cat).ratePerMonth;

test("preview: deleting an item that explains 12 months of payments adds its monthly cost to the average; one with no payments adds nothing", () => {
  const { rt, gym } = setup();
  const idle = rt.api("addRecurringExpense", { category_id: CAT, description: "Never paid", amount: 55, currency: "PEN", frequency: "monthly", day: 9 });
  const out = rt.api("previewProgrammedDelete", { ids: [gym.id, idle.id] });
  const g = out.items.find((x) => x.id === gym.id), i = out.items.find((x) => x.id === idle.id);
  assert.ok(Math.abs(g.monthlyEffectPen - 100) < 1, "about its 100 a month");
  assert.equal(i.monthlyEffectPen, 0);
  assert.ok(Math.abs(out.totalPen - 100) < 1);
  // The preview changes nothing.
  assert.ok(Math.abs(rate(rt)) < 0.01);
});

test("preview: a paused item still counts (its history is excluded until it is deleted); an income item has no effect", () => {
  const { rt, gym, add } = setup();
  rt.api("updateRecurringExpense", { id: gym.id, active: false });
  assert.ok(rt.api("previewProgrammedDelete", { ids: [gym.id] }).items[0].monthlyEffectPen > 90);
  for (let k = 6; k >= 1; k--) add(ago(k, 25), 3000, "Salary", INC, "income");
  const pay = rt.api("addRecurringExpense", { category_id: INC, description: "Salary", amount: 3000, currency: "PEN", frequency: "monthly", day: 25 });
  assert.equal(rt.api("previewProgrammedDelete", { ids: [pay.id] }).items[0].monthlyEffectPen, 0);
});

test("Stop it ends the item today: history stays explained (no change to the average), it stops projecting, and it moves to Past", () => {
  const { rt, gym } = setup();
  const out = rt.api("stopRecurringExpenses", { ids: [gym.id] });
  assert.deepEqual(out.stopped, [gym.id]);
  assert.equal(out.end_date, today());
  const row = rt.api("listRecurringExpenses", {}).find((x) => x.id === gym.id);
  assert.equal(row.end_date, today());
  assert.ok(Math.abs(rate(rt)) < 0.01, "stopping does not push its payments into the average");
  const prog = rt.api("listCategoryProjections", { displayPeriodType: "year" }).categories.find((c) => c.category_id === CAT).programmedRemainingPen;
  assert.equal(prog, 0, "nothing is projected after today");
});

test("Delete it pushes the payments into the average; Stop it first does not", () => {
  const { rt, gym } = setup();
  const out = rt.api("deleteRecurringExpenses", { ids: [gym.id] });
  assert.deepEqual(out.deleted, [gym.id]);
  assert.ok(rate(rt) > 90, "deleted: ordinary spending again");
});

test("Stop leaves one-time items, unstarted items and unknown ids alone, and reactivates a legacy paused item", () => {
  const { rt, gym } = setup();
  const once = rt.api("addRecurringExpense", { category_id: CAT, description: "Laptop", amount: 900, currency: "PEN", frequency: "once", date: ago(0, 1) });
  const future = rt.api("addRecurringExpense", { category_id: CAT, description: "Starts later", amount: 10, currency: "PEN", frequency: "monthly", day: 3, start_date: `${Y + 1}-01-03` });
  rt.api("updateRecurringExpense", { id: gym.id, active: false });
  const out = rt.api("stopRecurringExpenses", { ids: [once.id, future.id, "ghost", gym.id, gym.id] });
  assert.deepEqual(out.stopped, [gym.id]);
  assert.deepEqual(out.skipped.map((s) => s.reason).sort(), ["missing", "notStarted", "once"]);
  assert.equal(rt.api("listRecurringExpenses", {}).find((x) => x.id === gym.id).active, true, "the pause is replaced by the end date");
  assert.equal(rt.api("listRecurringExpenses", {}).find((x) => x.id === once.id).end_date, "");
});

test("deleting several items removes their splits and skipped months too", () => {
  const { rt, data, gym } = setup();
  const other = rt.api("addRecurringExpense", { category_id: CAT, description: "Keep me", amount: 20, currency: "PEN", frequency: "monthly", day: 11 });
  rt.api("saveRecurringExpenseSplits", { recurringExpenseId: gym.id, splits: [{ friend_id: data.friends[0].id, amount: 30 }] });
  rt.api("skipRecurringOccurrence", { id: gym.id, month: `${Y}-${String(M).padStart(2, "0")}` });
  rt.api("deleteRecurringExpenses", { ids: [gym.id] });
  assert.ok(!rt.rows("Recurring Expenses").some((r) => r.id === gym.id));
  assert.ok(rt.rows("Recurring Expenses").some((r) => r.id === other.id));
  assert.equal(rt.rows("Recurring Expense Splits").filter((s) => s.recurring_expense_id === gym.id).length, 0);
  assert.equal(rt.rows("Recurring Skips").filter((s) => s.recurring_expense_id === gym.id).length, 0);
  assert.deepEqual(rt.api("deleteRecurringExpenses", { ids: [] }), { deleted: [] });
});

test("a one-time item is flagged paid once its date has come and a real entry matches it", () => {
  const { rt, add } = setup();
  const paid = rt.api("addRecurringExpense", { category_id: CAT, description: "Laptop", amount: 900, currency: "PEN", frequency: "once", date: ago(2, 10) });
  const unpaid = rt.api("addRecurringExpense", { category_id: CAT, description: "Desk", amount: 450, currency: "PEN", frequency: "once", date: ago(2, 12) });
  const later = rt.api("addRecurringExpense", { category_id: CAT, description: "Chair", amount: 300, currency: "PEN", frequency: "once", date: `${Y + 1}-03-01` });
  add(ago(2, 11), 900, "Laptop");
  const list = rt.api("listRecurringExpenses", {});
  assert.equal(list.find((x) => x.id === paid.id).paid, true);
  assert.equal(list.find((x) => x.id === unpaid.id).paid, false);
  assert.equal(list.find((x) => x.id === later.id).paid, false);
  assert.equal(list.find((x) => x.frequency === "monthly").paid, undefined, "only one-time items carry the flag");
});

test("the backend says it has the Programmed items Stop / Delete calls", () => {
  assert.equal(setup().rt.api("getMeta", {}).capabilities.programmedStop, true);
});

// ---- Pause was removed: paused items are converted (heal on friends' copies, once on the owner's) -------------------------------------
const figures = (rt, cat = CAT) => ["month", "year"].map((displayPeriodType) => {
  const c = rt.api("listCategoryProjections", { displayPeriodType }).categories.find((x) => x.category_id === cat);
  return [c.ratePerMonth, c.programmedRemainingPen, c.expectedRemainingPen, c.actualPen, c.totalPen].map((n) => Math.round(n * 100) / 100);
});
const expectedItems = (rt) => JSON.stringify(rt.api("listExpectedRecurringItems", {}));
const rowOf = (rt, id) => rt.rows("Recurring Expenses").find((r) => r.id === id);
const convert = (rt) => JSON.parse(rt.run("JSON.stringify(convertPausedProgrammed_())"));

// gym: 13 paid months, paused (clean: converts). oldSub: paid months 7..2 ago on the 20th, end date 2 months ago, paused (clean, keeps its end).
// The rest cannot be converted without changing a figure and stay paused: never paid, a month missed in the middle, one-time, not started yet.
function pausedScenario() {
  const { rt, data, add, gym } = setup();
  const item = (extra) => rt.api("addRecurringExpense", Object.assign({ category_id: CAT, currency: "PEN", frequency: "monthly" }, extra));
  const pause = (it) => { rt.api("updateRecurringExpense", { id: it.id, active: false }); return it; };
  pause(gym);
  for (let k = 7; k >= 2; k--) add(ago(k, 20), 33, "Old sub");
  const oldSub = pause(item({ description: "Old sub", amount: 33, day: 20, end_date: ago(2, 28) }));
  const never = pause(item({ description: "Never paid", amount: 55, day: 9 }));
  for (const k of [6, 5, 3, 2]) add(ago(k, 14), 71, "Gappy");   // month 4 ago is missing
  const gappy = pause(item({ description: "Gappy", amount: 71, day: 14 }));
  const once = pause(item({ description: "One off", amount: 90, frequency: "once", date: ago(0, 1) }));
  const future = pause(item({ description: "Later", amount: 20, day: 3, start_date: `${Y + 1}-01-03` }));
  return { rt, data, add, gym, oldSub, never, gappy, once, future };
}

test("converting paused items changes NO figure; the ones that would change a figure stay paused", () => {
  const { rt, gym, oldSub, never, gappy, once, future } = pausedScenario();
  const before = figures(rt), beforeList = expectedItems(rt);
  const res = convert(rt);
  assert.equal(res.converted, 2, "gym and old sub");
  assert.deepEqual(res.remaining.sort(), [never.id, gappy.id, once.id, future.id].sort());
  assert.deepEqual(figures(rt), before, "month and year projections are identical");
  assert.equal(expectedItems(rt), beforeList, "Programmed this month is identical");
  assert.equal(String(rowOf(rt, gym.id).active), "true");
  assert.equal(rowOf(rt, gym.id).start_date, ago(12, 1), "no start date before: its first paid occurrence");
  assert.equal(rowOf(rt, gym.id).end_date, ago(0, 1), "ended on its last paid occurrence (this month's, paid on the 1st)");
  assert.equal(rowOf(rt, oldSub.id).end_date, ago(2, 28), "an existing end date is kept; only the pause is switched off");
  assert.equal(rowOf(rt, oldSub.id).start_date, ago(7, 20));
  [never, gappy, once, future].forEach((x) => assert.equal(String(rowOf(rt, x.id).active), "false", "left for the person to decide"));
  // Idempotent.
  const again = convert(rt);
  assert.equal(again.converted, 0);
  assert.deepEqual(again.remaining.sort(), res.remaining.sort());
  assert.deepEqual(figures(rt), before);
  // And the converted items now read as Past / ended in the list.
  const list = rt.api("listRecurringExpenses", {});
  assert.equal(list.find((x) => x.id === gym.id).end_date, ago(0, 1));
});

test("an item already ended before being paused keeps its end date and nothing changes", () => {
  const { rt, add } = setup();
  const sub = rt.api("addRecurringExpense", { category_id: CAT, description: "Sub", amount: 40, currency: "PEN", frequency: "monthly", day: 15, end_date: ago(3, 28) });
  for (let k = 6; k >= 3; k--) add(ago(k, 15), 40, "Sub");
  rt.api("updateRecurringExpense", { id: sub.id, active: false });
  const before = figures(rt);
  assert.equal(convert(rt).converted, 1);
  assert.deepEqual(figures(rt), before);
});

test("a friend's copy is healed at its first open (nobody is asked); only what could not be converted is offered by getMeta", () => {
  const { rt, gym, oldSub } = pausedScenario();
  rt.svc.props.set("FEATURES", "base");   // a friend's copy
  const before = figures(rt);
  const meta = rt.api("getMeta", {});
  assert.deepEqual(meta.pausedProgrammed.map((x) => x.description).sort(), ["Gappy", "Later", "Never paid", "One off"]);
  assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("paused-programmed-to-ended"));
  assert.equal(String(rowOf(rt, gym.id).active), "true");
  assert.equal(String(rowOf(rt, oldSub.id).active), "true");
  assert.deepEqual(figures(rt), before);
  assert.equal(rt.api("getMeta", {}).pausedProgrammed.length, 4, "a second open changes nothing");
});

test("the owner's copy converts once through the app's call; a second call does nothing; a friend's copy says it was healed instead", () => {
  const { rt, gym } = pausedScenario();
  const before = figures(rt);
  const first = rt.api("convertPausedProgrammedForOwnerOnce", {});
  assert.equal(first.ran, true);
  assert.equal(first.converted, 2);
  assert.equal(first.remaining.length, 4);
  assert.deepEqual(figures(rt), before);
  assert.equal(String(rowOf(rt, gym.id).active), "true");
  assert.equal(rt.api("convertPausedProgrammedForOwnerOnce", {}).ran, false);
  const friend = pausedScenario().rt;
  friend.svc.props.set("FEATURES", "base");
  const out = friend.api("convertPausedProgrammedForOwnerOnce", {});
  assert.equal(out.ran, false);
  assert.equal(out.remaining.length, 6, "nothing converted here: the heal does it on a friend's copy");
});
