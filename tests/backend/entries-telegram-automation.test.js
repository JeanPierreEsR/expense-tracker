// Regression tests for the 2026-10-05 fixes outside loans: income account,
// Telegram discard guard, alerts only counted when Telegram says ok,
// automation failure isolation + alerts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram } = require("./helpers");

test("manual income keeps its 'Received at' account (paid_by is a payor id)", () => {
  const { rt, data } = freshApp();
  const e = rt.api("createEntry", {
    type: "income", date: today(), amount: 500, currency: "PEN",
    category_id: data.cats.find((c) => c.type === "income").id,
    description: "Salary", paid_by: data.payors[0].id, payment_method_id: data.pms[3].id
  });
  assert.equal(e.payment_method_id, data.pms[3].id);
  assert.equal(rt.rows("Entries").find((x) => x.id === e.id).payment_method_id, data.pms[3].id);
});

test("an expense paid by a friend still has no payment method", () => {
  const { rt, data } = freshApp();
  const e = rt.api("createEntry", {
    type: "expense", date: today(), amount: 30, currency: "PEN",
    category_id: data.cats.find((c) => c.type === "expense").id,
    description: "Friend paid", paid_by: data.friends[0].id, payment_method_id: data.pms[3].id
  });
  assert.equal(e.payment_method_id, "");
});

function pendingEntry(rt, data) {
  return data.entries.find((e) => e.status === "pending");
}
const tapDiscard = (rt, chatId, entryId, n = 1) =>
  rt.rawPost(JSON.stringify({ update_id: 9000 + n, callback_query: { id: "cb" + n, data: "discard:" + entryId, message: { chat: { id: chatId }, message_id: 77 } } }));

test("Telegram Discard removes a PENDING entry", () => {
  const { rt, data } = freshApp();
  const chat = linkTelegram(rt);
  const p = pendingEntry(rt, data);
  tapDiscard(rt, chat, p.id);
  assert.equal(rt.rows("Entries").find((e) => e.id === p.id), undefined);
});

test("a late Telegram Discard tap does NOT delete an entry already confirmed in the app", () => {
  const { rt, data } = freshApp();
  const chat = linkTelegram(rt);
  const p = pendingEntry(rt, data);
  rt.api("updateEntry", { id: p.id, fields: { category_id: data.cats.find((c) => c.type === "expense").id } });
  rt.api("confirmEntry", { id: p.id });
  assert.equal(rt.rows("Entries").find((e) => e.id === p.id).status, "confirmed");

  tapDiscard(rt, chat, p.id, 2);

  assert.ok(rt.rows("Entries").find((e) => e.id === p.id), "confirmed entry must survive");
  const sent = rt.svc.fetchLog.map((f) => f.options.payload).join(" ");
  assert.match(sent, /Already confirmed/);
});

test("a Discard tap from someone else's chat is ignored", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt, 555);
  const p = pendingEntry(rt, data);
  tapDiscard(rt, 999, p.id, 3);
  assert.ok(rt.rows("Entries").find((e) => e.id === p.id));
});

function overBudgetCategory(rt, data) {
  // Seeded budgets cover the first 12 expense categories; use one with no budget yet.
  const cat = data.cats.filter((c) => c.type === "expense")[14];
  const budget = rt.api("addBudget", { category_id: cat.id, amount: 100, currency: "PEN", period_type: "monthly", thresholds: "75" });
  rt.api("createEntry", {
    type: "expense", date: today(), amount: 90, currency: "PEN", category_id: cat.id,
    description: "Big spend", paid_by: "me", payment_method_id: data.pms[3].id
  });
  return budget;
}
const alertRows = (rt, budgetId) => rt.rows("Budget Alert Log").filter((r) => r.budget_id === budgetId);

test("budget alert is logged as sent when Telegram accepts it", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt);
  const b = overBudgetCategory(rt, data);
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, b.id).length, 1);
});

test("budget alert is NOT logged as sent when Telegram rejects it (so it retries)", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt);
  rt.state.fetchHandler = () => ({ ok: false, description: "Forbidden: bot was blocked by the user" });
  const b = overBudgetCategory(rt, data);
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, b.id).length, 0);

  rt.state.fetchHandler = null; // Telegram works again -> the next cycle delivers it
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, b.id).length, 1);
});

test("cancelling the expense that triggered a budget alert re-arms that alert", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt);
  // The made-up data already has spend in this category, so size the budget
  // so that only the big entry pushes it past 75%.
  const cat = data.cats.filter((c) => c.type === "expense")[14];
  const b = rt.api("addBudget", { category_id: cat.id, amount: 5000, currency: "PEN", period_type: "monthly", thresholds: "75" });
  const spend = (description) => rt.api("createEntry", {
    type: "expense", date: today(), amount: 4500, currency: "PEN", category_id: cat.id,
    description, paid_by: "me", payment_method_id: data.pms[3].id
  });
  spend("Big spend");
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, b.id).length, 1);

  const entry = rt.rows("Entries").find((e) => e.description === "Big spend");
  rt.api("discardEntry", { id: entry.id });
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, b.id).length, 0);

  spend("Again");
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, b.id).length, 1);
});

test("one failing automation step does not stop the others, and the owner is alerted", () => {
  const { rt } = freshApp();
  linkTelegram(rt);
  rt.run(`
    var __ran = [];
    pingWebApp_ = function () {};
    processEmails = function () { __ran.push('emails'); return { unparsed: 2, errors: 0, unparsedSubjects: ['Bank notice'] }; };
    pollTelegramUpdates = function () { __ran.push('telegram'); throw new Error('boom'); };
    checkBudgets = function () { __ran.push('budgets'); };
    checkOverdueLoans = function () { __ran.push('loans'); };
    backfillInvestmentCategories_ = function () { __ran.push('invest'); };
    scanStatementInbox_ = function () { __ran.push('stmt'); };
    retryStatementInboxNudges_ = function () {};
  `);
  rt.run("runAutomation()");
  assert.deepEqual(JSON.parse(rt.run("JSON.stringify(__ran)")), ["emails", "telegram", "budgets", "loans", "invest", "stmt"]);
  const sent = rt.svc.fetchLog.map((f) => f.options.payload).join(" ");
  assert.match(sent, /Automatic scan problem/);
  assert.match(sent, /boom/);
  assert.match(sent, /2 could not be read/);
});

test("automation alerts are throttled (not every 15 minutes)", () => {
  const { rt } = freshApp();
  linkTelegram(rt);
  rt.run(`
    pingWebApp_ = function () {}; processEmails = function () { return null; };
    pollTelegramUpdates = function () { throw new Error('boom'); };
    checkBudgets = function () {}; checkOverdueLoans = function () {};
    backfillInvestmentCategories_ = function () {}; scanStatementInbox_ = function () {}; retryStatementInboxNudges_ = function () {};
  `);
  rt.run("runAutomation()"); rt.run("runAutomation()");
  const alerts = rt.svc.fetchLog.filter((f) => /Automatic scan problem/.test(f.options.payload));
  assert.equal(alerts.length, 1);
});
