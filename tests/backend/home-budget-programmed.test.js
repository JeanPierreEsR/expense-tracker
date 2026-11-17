// Home's Monthly budget card counts the Programmed items still to come this month (owner, 2026-11-16; specs/home-tab.md):
// getHomeGlance's budget.programmedPen = the same "still to come" rule as the Budgets tab's rows, each item once even when two
// monthly budgets hold its category, Annual-tagged items and items outside the budgets left out, a paid occurrence not counted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp, today, lastDayOfMonth } = require("./helpers");

const STRINGS = require(path.join(__dirname, "../../docs/strings.js"));

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-hb', name: 'Gym test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-hb3', name: 'Pool test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-hb2', name: 'Out test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }));
  return rt;
}
const item = (rt, fields) => rt.api("addRecurringExpense", Object.assign({ category_id: "cat-hb", description: "Gym", amount: 120, currency: "PEN", frequency: "monthly", day: 31 }, fields));
const prog = (rt) => rt.api("getHomeGlance", {}).budget.programmedPen;

test("Home budget: programmed still to come, once per item, without Annual or unbudgeted items", { skip: lastDayOfMonth }, () => {
  const rt = setup();
  rt.api("addBudget", { category_id: "cat-hb", amount: 1000, currency: "PEN", period_type: "monthly", start: "always" });
  const base = prog(rt);   // the demo data's own budgets and items
  const gym = item(rt, {});
  assert.equal(prog(rt) - base, 120);
  // A second monthly budget holding the same category: the item still counts once.
  rt.api("addBudget", { category_id: "cat-hb,cat-hb3", name: "Twin", amount: 500, currency: "PEN", period_type: "monthly", start: "always" });
  assert.equal(prog(rt) - base, 120);
  item(rt, { category_id: "cat-hb2", description: "Outside", amount: 70 });
  assert.equal(prog(rt) - base, 120, "a category no monthly budget holds is left out");
  rt.api("updateRecurringExpense", { id: gym.id, tag_ids: ["system-annual"] });
  assert.equal(Math.round((prog(rt) - base) * 100) / 100, 0, "an Annual item leaves the monthly figure");
  assert.equal(rt.api("listBudgets", {}).summary.monthProgrammedPen, null, "the Budgets tab's own request skips the extra sum");
});

test("the card's programmed line is in both languages", () => {
  const s = STRINGS["home.budgetProgrammed"] || (STRINGS.STRINGS || {})["home.budgetProgrammed"];
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.match(app, /tr\("home\.budgetProgrammed"/);
  if (s) { assert.ok(s.en && s.es); }
  else assert.match(fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8"), /"home\.budgetProgrammed": \{ en: .+, es: .+ \}/);
});
