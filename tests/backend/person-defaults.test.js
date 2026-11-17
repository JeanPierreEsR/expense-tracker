// Defaults that were the owner's own habits (owner, 2026-11-16; backend/PersonDefaults.gs). A NEW person's copy (marked at install)
// does not tag Travel Annual by itself and gives loans no due date; every copy's new budgets alert at 75/100 (the owner's at
// 75/100/125, his existing budgets switched once); and each person's time zone follows their phone. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setSheetTimeZone } = require("../harness/fake-google");
const { freshApp, today } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload })).data;
const annualIds = (rt) => rt.rows("Entry Tags").filter((t) => t.tag_id === "system-annual").map((t) => t.entry_id);
const travelId = (rt) => rt.run(`getAllRows('Categories').filter(function (c) { return c.key === 'travel'; })[0].id`);

// A copy made by the installer: FEATURES present when the Settings tab is seeded.
function newPersonCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.sheet("Settings").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedSettings();");
  post(rt, "getMeta");
  return rt;
}
// A friend's copy installed before 2026-11-16: FEATURES present, no marker.
function earlierFriendCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  post(rt, "getMeta");
  return rt;
}
function ownerCopy() {
  const { rt } = freshApp({ small: true });
  post(rt, "getMeta");
  return rt;
}
// A category no budget uses yet (the sample data already has budgets).
function freshCategory(rt) {
  rt.run(`appendRowObject('Categories', { id: 'cat-new-x', name: 'Test bucket', type: 'expense', icon: '', color: '#ccc', parent_id: '' })`);
  return "cat-new-x";
}
function travelExpense(rt, over = {}) {
  return rt.api("createEntry", { type: "expense", date: today(), amount: 120, currency: "PEN", category_id: travelId(rt), description: "Bus to the coast", paid_by: "me", ...over });
}

test("install: only a new person's copy is marked; the owner's copy and earlier copies are not", () => {
  assert.equal(newPersonCopy().rows("Settings").find((s) => s.key === "new_person_defaults").value, "yes");
  assert.ok(!earlierFriendCopy().rows("Settings").some((s) => s.key === "new_person_defaults"));
  assert.ok(!ownerCopy().rows("Settings").some((s) => s.key === "new_person_defaults"));
});

test("Travel: a new person's Travel expense is not marked Annual; the owner's and an earlier copy's still are", () => {
  const fresh = newPersonCopy();
  const e = travelExpense(fresh);
  assert.ok(!annualIds(fresh).includes(e.id));
  assert.equal(post(fresh, "getMeta").settings.travel_annual_on, "no");
  assert.equal(post(fresh, "getMeta").settings.travel_annual_ask, "yes");
  for (const rt of [ownerCopy(), earlierFriendCopy()]) {
    const x = travelExpense(rt);
    assert.ok(annualIds(rt).includes(x.id));
    assert.equal(post(rt, "getMeta").settings.travel_annual_on, "yes");
    assert.equal(post(rt, "getMeta").settings.travel_annual_ask, "");
  }
});

test("Travel: moving entries into Travel in bulk follows the same rule", () => {
  const rt = newPersonCopy();
  const other = rt.run(`getAllRows('Categories').filter(function (c) { return c.type === 'expense' && c.key !== 'travel'; })[0].id`);
  const e = travelExpense(rt, { category_id: other });
  rt.run(`annualForTravelMoves_(['${e.id}'], '${travelId(rt)}')`);
  assert.ok(!annualIds(rt).includes(e.id));
});

test("Travel: the answer on the first annual budget is kept; yes also marks the Travel expenses so far", () => {
  const rt = newPersonCopy();
  const before = travelExpense(rt);
  const budget = rt.api("addBudget", { category_id: "ANNUAL", amount: 5000, currency: "PEN", period_type: "yearly", start: "always", travel_annual: true });
  assert.equal(budget.travel_annual.on, true);
  assert.ok(budget.travel_annual.tagged >= 1);
  assert.ok(annualIds(rt).includes(before.id), "the earlier Travel expense now counts as annual");
  const after = travelExpense(rt);
  assert.ok(annualIds(rt).includes(after.id), "and new ones are marked");
  const meta = post(rt, "getMeta");
  assert.equal(meta.settings.travel_annual_on, "yes");
  assert.equal(meta.settings.travel_annual_ask, "", "asked once");

  const no = newPersonCopy();
  no.api("addBudget", { category_id: "ANNUAL", amount: 5000, currency: "PEN", period_type: "yearly", start: "always", travel_annual: false });
  assert.ok(!annualIds(no).includes(travelExpense(no).id));
  assert.equal(post(no, "getMeta").settings.travel_annual_ask, "");
});

test("loans: a new person's loan has no due date unless one is typed; the owner's gets a week out", () => {
  const rt = newPersonCopy();
  const f = rt.api("addFriend", { name: "Ana Lo" });
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-21", description: "L" });
  assert.equal(rt.rows("Loans").find((l) => l.id === loan.id).due_date, "");
  const typed = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-21", due_date: "2026-11-30", description: "T" });
  assert.equal(String(rt.rows("Loans").find((l) => l.id === typed.id).due_date).slice(0, 10), "2026-11-30");
  assert.equal(post(rt, "getMeta").settings.loan_due_week, "no");

  const owner = ownerCopy();
  const g = owner.api("addFriend", { name: "Ben Lo" });
  const ol = owner.api("addLoan", { friend_id: g.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-21", description: "L" });
  assert.equal(owner.api("getFriendLoanDetail", { friendId: g.id }).find((x) => x.id === ol.id).due_date, "2026-10-28");
  assert.equal(post(owner, "getMeta").settings.loan_due_week, "yes");
});

test("budget alerts: a budget with no percentages typed alerts at 75/100 on a friend's copy and 75/100/125 on the owner's", () => {
  const rt = earlierFriendCopy();
  assert.equal(post(rt, "getMeta").settings.budget_thresholds_default, "75,100");
  const cat = freshCategory(rt);
  const b = rt.api("addBudget", { category_id: cat, amount: 300, currency: "PEN", period_type: "monthly", thresholds: "" });
  assert.equal(String(rt.rows("Budgets").find((x) => x.id === b.id).thresholds), "75,100");
  assert.equal(post(ownerCopy(), "getMeta").settings.budget_thresholds_default, "75,100,125");
});

test("budget alerts: the owner's existing budgets all switch to 75/100/125 once; a friend's are never touched", () => {
  const { rt } = freshApp({ small: true });
  const cat = freshCategory(rt);
  const a = rt.api("addBudget", { category_id: cat, amount: 300, currency: "PEN", period_type: "monthly", thresholds: "50,75,100,110,125,150" });
  rt.svc.props.set("HEALS_DONE", "");
  post(rt, "getMeta");
  assert.ok(rt.rows("Budgets").every((x) => String(x.thresholds) === "75,100,125"));
  assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("owner-budget-alerts-75-100-125"));
  rt.run(`updateRowFields_('Budgets', '${a.id}', { thresholds: '50,100' })`);
  post(rt, "getMeta");
  assert.equal(String(rt.rows("Budgets").find((x) => x.id === a.id).thresholds), "50,100", "runs once: a later change by hand stays");

  const friend = freshApp({ small: true }).rt;
  const fc = freshCategory(friend);
  const fb = friend.api("addBudget", { category_id: fc, amount: 300, currency: "PEN", period_type: "monthly", thresholds: "50,75,100,110,125,150" });
  friend.svc.props.set("FEATURES", "base");
  post(friend, "getMeta");
  assert.equal(String(friend.rows("Budgets").find((x) => x.id === fb.id).thresholds), "50,75,100,110,125,150");
  assert.ok(!String(friend.svc.props.get("HEALS_DONE") || "").includes("owner-budget-alerts"));
});

test("time zone: the phone's zone becomes the person's; no recorded date changes; a bad value is ignored", () => {
  try {
    const rt = ownerCopy();
    const e = rt.api("createEntry", { type: "expense", date: "2026-10-26", amount: 10, currency: "PEN", category_id: travelId(rt), description: "x" });
    post(rt, "getStartupBundle", { tz: "Asia/Tokyo" });
    assert.equal(rt.run("SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()"), "Asia/Tokyo");
    assert.equal(rt.run("personTz_()"), "Asia/Tokyo");
    assert.equal(rt.api("listEntries", { limit: 1000 }).find((x) => x.id === e.id).date, "2026-10-26");
    post(rt, "getMeta", { tz: "not a zone; drop table" });
    assert.equal(rt.run("personTz_()"), "Asia/Tokyo");
    assert.deepEqual(post(rt, "setTimeZone", { tz: "America/Los_Angeles" }), { tz: "America/Los_Angeles", changed: true });
    assert.equal(rt.api("listEntries", { limit: 1000 }).find((x) => x.id === e.id).date, "2026-10-26");
    assert.deepEqual(post(rt, "setTimeZone", { tz: "America/Los_Angeles" }), { tz: "America/Los_Angeles", changed: false });
  } finally { setSheetTimeZone(null); }
});

test("time zone: once the phone has set it, the old Lima heal never puts it back", () => {
  try {
    const { rt } = freshApp({ small: true });
    rt.svc.props.set("FEATURES", "base");
    rt.svc.props.set("HEALS_DONE", "");
    post(rt, "getStartupBundle", { tz: "Europe/Madrid" });
    assert.equal(rt.run("personTz_()"), "Europe/Madrid");
    assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("sheet-time-zone"));
  } finally { setSheetTimeZone(null); }
});
