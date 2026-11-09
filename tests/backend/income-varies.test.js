// Income that varies (owner, 2026-11-07): income categories are regular, varying or neither; "How do you get paid?" adds one
// varying category; Overview gets the varying income per day, per payer and the months before. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

let n = 0;
function setup() {
  const { rt } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Entries', function () { return true; })");
  // The copy's own income categories are set aside, so only these three count.
  rt.run("deleteRowsWhere_('Categories', function (c) { return c.type === 'income'; })");
  rt.run(`appendRowObject('Categories', { id: 'inc-sal', name: 'Salary', type: 'income', icon: '', color: '#ccc', parent_id: '', key: 'salary' });`);
  rt.run(`appendRowObject('Categories', { id: 'inc-gift', name: 'Gifts test', type: 'income', icon: '', color: '#ccc', parent_id: '', key: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'inc-biz', name: 'Business', type: 'income', icon: '', color: '#ccc', parent_id: '', key: 'business' });`);
  rt.run(`appendRowObject('Payors', { id: 'pay-1', name: 'Client One', notes: '' });`);
  return rt;
}
function income(rt, date, amount, category_id, paid_by = "") {
  const e = { id: "iv" + ++n, type: "income", date, amount, currency: "PEN", category_id, description: "x", paid_by, status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}
const monthsAgo = (k) => { const [y, m] = today().split("-").map(Number); const d = new Date(y, m - 1 - k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const lastDay = (ym) => `${ym}-${String(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate()).padStart(2, "0")}`;
const summary = (rt, ym) => rt.api("getPeriodSummary", { startDate: ym + "-01", endDate: lastDay(ym) });

test("the backend says income that varies is there", () => {
  assert.equal(setup().api("getMeta", {}).capabilities.incomeVaries, true);
});

test("built-in kinds: Salary is regular, Business varies, anything else is not earnings until chosen", () => {
  const rt = setup();
  const cats = rt.api("getMeta", {}).categories;
  const kind = (id) => cats.find((c) => c.id === id).earning;
  assert.deepEqual([kind("inc-sal"), kind("inc-biz"), kind("inc-gift")], ["regular", "varies", ""]);
  rt.api("saveCategory", { id: "inc-gift", name: "Gifts test", icon: "🎁", color: "#cccccc", income_kind: "varies" });
  rt.api("saveCategory", { id: "inc-biz", name: "Business", icon: "👔", color: "#cccccc", income_kind: "none" });
  const after = rt.api("getMeta", {}).categories;
  assert.equal(after.find((c) => c.id === "inc-gift").earning, "varies");
  assert.equal(after.find((c) => c.id === "inc-biz").earning, "", "'none' overrides the built-in default");
});

test("a month's income split into regular and varying, per payer, and the days it came in", () => {
  const rt = setup();
  const ym = monthsAgo(1);
  income(rt, ym + "-03", 2000, "inc-sal");
  income(rt, ym + "-05", 100, "inc-biz", "pay-1");
  income(rt, ym + "-05", 50, "inc-biz", "pay-1");
  income(rt, ym + "-09", 30, "inc-biz");
  income(rt, ym + "-10", 999, "inc-gift");   // not earnings
  const v = summary(rt, ym).incomeVaries;
  assert.equal(v.regular, 2000);
  assert.equal(v.varies, 180);
  assert.equal(v.daysWithIncome, 2);
  assert.deepEqual(v.byPayer.map((p) => [p.name, p.amount, p.count]), [["Client One", 150, 2], ["", 30, 1]]);
});

test("the months before a month: complete months only, none before the first entry, a quiet month counts 0", () => {
  const rt = setup();
  income(rt, monthsAgo(4) + "-10", 400, "inc-biz");
  income(rt, monthsAgo(2) + "-10", 200, "inc-biz");
  income(rt, monthsAgo(1) + "-10", 2000, "inc-sal");   // regular: not in these figures
  const months = summary(rt, today().slice(0, 7)).incomeVaries.months;
  assert.deepEqual(months.map((m) => [m.month, m.amount]), [[monthsAgo(1), 0], [monthsAgo(2), 200], [monthsAgo(3), 0], [monthsAgo(4), 400]]);
});

test("no income category varies: nothing to show", () => {
  const rt = setup();
  rt.api("saveCategory", { id: "inc-biz", name: "Business", icon: "👔", color: "#cccccc", income_kind: "none" });
  assert.equal(summary(rt, today().slice(0, 7)).incomeVaries, null);
});

test("How do you get paid? — 'It varies' adds ONE varying category of that kind, once; a fixed salary adds nothing", () => {
  const rt = setup();
  const before = rt.rows("Categories").length;
  assert.equal(rt.api("setPay", { pay: "salary" }).pay, "salary");
  assert.equal(rt.rows("Categories").length, before);
  const r = rt.api("setPay", { pay: "varies", kind: "freelance" });
  assert.equal(r.pay, "varies:freelance");
  assert.equal(r.added.name, "Freelance");
  const made = rt.rows("Categories").find((c) => c.key === "freelance");
  assert.equal(made.income_kind, "varies");
  rt.api("setPay", { pay: "varies", kind: "freelance" });
  assert.equal(rt.rows("Categories").filter((c) => c.key === "freelance").length, 1, "never twice");
  assert.equal(rt.api("getMeta", {}).settings.pay, "varies:freelance");
});

test("a week: the 8 complete weeks before it; a whole year: its complete months (Overview's 'usual' line)", () => {
  const rt = setup();
  const addD = (iso, k) => { const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + k)); return d.toISOString().slice(0, 10); };
  const mon = addD(today(), -((new Date(today() + "T00:00:00Z").getUTCDay() + 6) % 7));
  income(rt, addD(mon, -60), 1, "inc-sal");   // the first entry: far enough back for 8 weeks
  income(rt, addD(mon, -7), 70, "inc-biz");    // last week
  income(rt, addD(mon, -13), 20, "inc-biz");   // the week before
  const v = rt.api("getPeriodSummary", { startDate: mon, endDate: addD(mon, 6) }).incomeVaries;
  assert.equal(v.weeks.length, 8);
  assert.deepEqual(v.weeks.slice(0, 2).map((w) => [w.week, w.amount]), [[addD(mon, -7), 70], [addD(mon, -14), 20]]);
  const y = today().slice(0, 4);
  const yv = rt.api("getPeriodSummary", { startDate: `${y}-01-01`, endDate: `${y}-12-31` }).incomeVaries;
  assert.ok(yv.yearMonths.every((m) => m.month < today().slice(0, 7)), "only complete months");
});

test("How do you get paid? — several kinds at once, each adding its category once (owner, 2026-11-08)", () => {
  const rt = setup();
  const r = rt.api("setPay", { pay: "varies", kinds: ["sales", "daily", "sales"] });
  assert.equal(r.pay, "varies:sales,daily");
  assert.deepEqual(r.addedAll.map((a) => a.name).sort(), ["Daily work", "Sales"]);
  rt.api("setPay", { pay: "varies", kinds: ["sales", "daily", "freelance"] });
  for (const k of ["sales", "daily_work", "freelance"]) assert.equal(rt.rows("Categories").filter((c) => c.key === k).length, 1, k);
  rt.api("setPay", { pay: "varies", kinds: ["sales"] });   // un-ticking never deletes a category
  assert.equal(rt.rows("Categories").filter((c) => c.key === "freelance").length, 1);
  assert.equal(rt.api("getMeta", {}).settings.pay, "varies:sales");
});

test("How do you get paid? — a fixed salary AND income that varies; both un-ticked clears it (owner, 2026-11-08)", () => {
  const rt = setup();
  const r = rt.api("setPay", { pay: "both", kinds: ["freelance"] });
  assert.equal(r.pay, "both:freelance");
  assert.equal(rt.rows("Categories").filter((c) => c.key === "freelance").length, 1);
  assert.equal(rt.api("setPay", { pay: "none" }).pay, "");
  assert.equal(rt.rows("Categories").filter((c) => c.key === "freelance").length, 1, "clearing the answer deletes nothing");
});
