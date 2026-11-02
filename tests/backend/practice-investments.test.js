// The Investments first-use practice: its platform and its deposit / withdrawal are removed in one call, nothing real is touched,
// and while it exists nothing is alerted or learned. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const bank = data.pms.find((p) => p.type !== "investment") || data.pms[3];
  const mine = rt.api("savePaymentMethod", { nickname: "Practice platform", type: "investment" });
  const invest = (platform, amount, description, extra = {}) => rt.api("createEntry", {
    type: "investment", date: today(), amount, currency: "PEN", description, paid_by: "me", payment_method_id: bank.id, to_payment_method_id: platform, ...extra
  });
  return { rt, data, bank, mine, invest };
}

test("capability: a backend that can clean the Investments practice up says so", () => {
  const { rt } = setup();
  assert.equal(rt.api("getMeta").capabilities.practiceInvestments, true);
});

test("removePracticeInvestments deletes the practice's deposit, withdrawal and platform (either language) and nothing else", () => {
  const { rt, data, mine, invest } = setup();
  const es = rt.api("savePaymentMethod", { nickname: "Plataforma de práctica", type: "investment" });
  const realPlatform = rt.api("savePaymentMethod", { nickname: "Real platform", type: "investment" });
  const entriesBefore = rt.rows("Entries").length;
  const pmsBefore = rt.rows("Payment Methods").length;
  invest(mine.id, 100, "Practice deposit");
  invest(mine.id, -40, "Practice withdrawal");
  invest(es.id, 50, "Depósito de práctica");
  invest(es.id, -10, "Retiro de práctica");
  const realEntry = invest(realPlatform.id, 70, "Real deposit");
  const res = rt.api("removePracticeInvestments", { started_on: today() });
  assert.equal(res.entries, 4);
  assert.equal(res.platforms, 2);
  assert.equal(res.kept, 0);
  assert.equal(rt.rows("Entries").length, entriesBefore + 1, "only the real deposit is left");
  assert.ok(rt.rows("Entries").some((e) => e.id === realEntry.id));
  const names = rt.rows("Payment Methods").map((p) => p.nickname);
  assert.ok(!names.includes("Practice platform") && !names.includes("Plataforma de práctica"));
  assert.ok(names.includes("Real platform"), "a real platform stays");
  assert.equal(rt.rows("Payment Methods").length, pmsBefore - 2);
  assert.equal(rt.api("removePracticeInvestments", { started_on: today() }).entries, 0, "a repeat is harmless");
  void data;
});

test("a real entry pointing at the practice platform is only unpointed, never deleted; an older marker entry is kept", () => {
  const { rt, mine, invest } = setup();
  const real = invest(mine.id, 25, "My real thing");
  const old = invest(mine.id, 9, "Practice deposit", { date: "2020-01-01" });
  const res = rt.api("removePracticeInvestments", { started_on: today() });
  assert.equal(res.entries, 0, "nothing of today carries the marker");
  assert.equal(res.unlinked, 2, "the real entry and the older marker entry are unpointed");
  assert.equal(res.platforms, 1);
  const kept = rt.rows("Entries").find((e) => e.id === real.id);
  assert.ok(kept, "the real entry is NOT deleted");
  assert.equal(String(kept.to_payment_method_id || ""), "");
  assert.ok(rt.rows("Entries").some((e) => e.id === old.id), "dated before the practice started: not its own");
});

test("a platform something else still uses is kept, not an error", () => {
  const { rt, mine, bank } = setup();
  rt.run(`appendRowObject('Loans', { id: 'loan-pi', payment_method_id: ${JSON.stringify(mine.id)} });`);
  void bank;
  const res = rt.api("removePracticeInvestments", {});
  assert.equal(res.platforms, 0);
  assert.equal(res.kept, 1);
});

test("the practice's deposit and withdrawal alert nobody and move no budget", () => {
  const { rt, data, mine, invest } = setup();
  const cat = data.cats.find((c) => c.type === "expense");
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  rt.api("addBudget", { category_id: cat.id, amount: 1, currency: "PEN", period_type: "monthly", thresholds: "10" });
  rt.run("checkBudgets()");   // first run on a copy only writes down what is already over
  const noticesBefore = rt.api("listNotices").notices.length;
  const sentBefore = rt.svc.fetchLog.length;
  invest(mine.id, 5000, "Practice deposit");
  invest(mine.id, -4000, "Practice withdrawal");
  rt.run("checkBudgets()");
  rt.run("backfillInvestmentCategories_()");
  assert.equal(rt.api("listNotices").notices.length, noticesBefore, "no notice");
  assert.equal(rt.svc.fetchLog.length, sentBefore, "nothing sent to Telegram or anywhere else");
  const habits = rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee Habits') ? getAllRows('Payee Habits').length : 0");
  assert.equal(habits, 0, "no payee memory is written for investments");
  assert.equal(rt.api("getMeta").capabilities.practiceInvestments, true);
});

test("a person with no platform at all can add one from Accounts (type Investment platform) and remove it again", () => {
  const { rt } = freshApp();
  const before = rt.rows("Payment Methods").length;
  const pm = rt.api("savePaymentMethod", { nickname: "Practice platform", type: "investment" });
  assert.equal(pm.type, "investment");
  assert.equal(rt.rows("Payment Methods").length, before + 1);
  assert.equal(rt.api("removePracticeInvestments", {}).platforms, 1);
  assert.equal(rt.rows("Payment Methods").length, before);
});
