// A repayment kept waiting for its loans (RepayIntent.gs; owner 2026-11-23): a bot told "repayment Zoe" when Zoe has two or more open
// loans and the payment does not cover them all keeps the entry in Needs review, marked, instead of paying the oldest first. The bot's
// Confirm and the app's bulk confirm record it oldest first; bulk confirm's Undo brings the waiting entry back. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const OWNER = "51900000000";

function waApp() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  const sent = [];
  let inId = 0;
  rt.state.fetchHandler = (url, opts) => {
    if (String(url).endsWith("/send")) { sent.push(JSON.parse(opts.payload).message); return { messages: [{ id: "wamid.out" + sent.length }] }; }
    return { ok: true };
  };
  const post = (msg) => {
    rt.ctx.__body = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.in" + (++inId), from: OWNER }, msg), relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  };
  const a = {
    rt, sent,
    text: (t, extra) => post(Object.assign({ type: "text", text: t }, extra || {})),
    tap: (id, contextId) => post({ type: "interactive", reply_id: id, context_id: contextId }),
    waEntries: () => rt.rows("Entries").filter((e) => e.source === "whatsapp"),
    entry: (id) => rt.rows("Entries").find((x) => x.id === id),
    cardIdOf: (entryId) => rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId && /^wamid\./.test(m.message_id)).pop().message_id,
    bodies: () => sent.map((m) => (m.text && m.text.body) || (m.interactive && m.interactive.body.text) || ""),
    lastRows: () => sent[sent.length - 1].interactive.action.sections[0].rows
  };
  // A friend of our own, with loans the tests choose (the demo friends have their own history).
  rt.ctx.__f = { name: "Zoe Test" };
  a.friend = rt.run("addFriend(__f)");
  a.loan = (amount, date) => { rt.ctx.__l = { friend_id: a.friend.id, direction: "i_owe_them", amount, currency: "PEN", date }; return rt.run("addLoan(__l)"); };
  a.settlementsOf = (loanId) => rt.rows("Settlements").filter((s) => s.loan_id === loanId && !s.offset_loan_id);
  return a;
}

// A waiting expense with a category (money that left: a repayment of it is one the person PAID, i_owe_them).
function readyExpense(a, text) {
  a.text(text || "20 pago");
  const e = a.waEntries().pop();
  a.tap(`wafield:${e.id}:category`);
  a.tap(a.lastRows().find((r) => r.id.startsWith("wapick:")).id);
  return e;
}

test("two open loans and a payment that does not cover them: kept in Needs review, marked, nothing recorded", () => {
  const a = waApp();
  const l1 = a.loan(50, "2026-01-05"), l2 = a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  const now = a.entry(e.id);
  assert.ok(now, "the entry is still there");
  assert.equal(now.status, "pending");
  assert.deepEqual(JSON.parse(now.repay_intent), { friend_id: a.friend.id, direction: "i_owe_them" });
  assert.equal(a.settlementsOf(l1.id).length + a.settlementsOf(l2.id).length, 0, "no repayment yet");
  assert.match(a.bodies().join("\n"), /Kept in Needs review: Zoe Test has 2 open loans/);
  assert.match(a.bodies().join("\n"), /Repayment to Zoe Test: Confirm pays the oldest loans first/, "the fresh card says what Confirm does");
  const listed = a.rt.run("listPendingEntries()").find((x) => x.id === e.id);
  assert.deepEqual(JSON.parse(JSON.stringify(listed.repay_intent)), { friend_id: a.friend.id, friend_name: "Zoe Test", direction: "i_owe_them", matters: true, owed: true });
});

test("the bot's Confirm on the marked card records it, oldest loan first", () => {
  const a = waApp();
  const l1 = a.loan(50, "2026-01-05"), l2 = a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entry(e.id), undefined, "it became a repayment");
  assert.equal(a.settlementsOf(l1.id).reduce((n, s) => n + Number(s.amount), 0), 20, "the oldest loan is paid");
  assert.equal(a.settlementsOf(l2.id).length, 0);
  assert.match(a.bodies().join("\n"), /Marked as a repayment to Zoe Test/);
});

test("no real choice (one loan, or the payment covers all): recorded at once, as before", () => {
  const a = waApp();
  const only = a.loan(50, "2026-01-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id), undefined);
  assert.equal(a.settlementsOf(only.id).length, 1);

  const b = waApp();
  b.loan(10, "2026-01-05"); b.loan(5, "2026-02-05");
  const e2 = readyExpense(b);   // 20 covers 15
  b.text("repayment Zoe Test", { context_id: b.cardIdOf(e2.id) });
  assert.equal(b.entry(e2.id), undefined, "covers them all: no choice to make");
});

test("a confirmed entry marked through the bot goes back to waiting (owner's OK)", () => {
  const a = waApp();
  a.loan(50, "2026-01-05"); a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entry(e.id).status, "confirmed");
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id).status, "pending");
  assert.ok(a.entry(e.id).repay_intent);
});

test("'deshacer' after the mark puts the entry back as it was", () => {
  const a = waApp();
  a.loan(50, "2026-01-05"); a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  a.text("deshacer");
  assert.equal(a.entry(e.id).status, "confirmed");
  assert.ok(!a.entry(e.id).repay_intent, "the mark is gone");
});

test("confirming it as what it is (any other road) drops the mark", () => {
  const a = waApp();
  a.loan(50, "2026-01-05"); a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  a.rt.ctx.__id = e.id;
  a.rt.run("confirmEntryWithLearning_(__id)");
  assert.equal(a.entry(e.id).status, "confirmed");
  assert.equal(a.entry(e.id).repay_intent, "");
});

test("bulk confirm with repay: oldest first in date order; its Undo brings the waiting entry back and the debts are owed again", () => {
  const a = waApp();
  const l1 = a.loan(50, "2026-01-05"), l2 = a.loan(50, "2026-02-05");
  const e1 = readyExpense(a, "30 pago uno");
  const e2 = readyExpense(a, "30 pago dos");
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e1.id) });
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e2.id) });
  const before1 = a.entry(e1.id), loansBefore = a.rt.rows("Settlements").length;
  a.rt.ctx.__p = { items: [{ id: e2.id, repay: true }, { id: e1.id, repay: true }] };
  const out = a.rt.run("confirmEntries(__p)");
  assert.equal(out.repaid.length, 2);
  assert.equal(a.settlementsOf(l1.id).reduce((n, s) => n + Number(s.amount), 0), 50, "the oldest loan is paid off first");
  assert.equal(a.settlementsOf(l2.id).reduce((n, s) => n + Number(s.amount), 0), 10);
  a.rt.ctx.__u = { items: out.repaid.map((r) => ({ id: r.id, repaid: r.before })) };
  const undone = a.rt.run("unconfirmEntries(__u)");
  assert.equal(undone.undone.length, 2);
  assert.equal(a.rt.rows("Settlements").length, loansBefore, "both repayments are gone");
  const back = a.entry(e1.id);
  assert.equal(back.status, "pending");
  assert.equal(back.repay_intent, before1.repay_intent, "still marked");
  assert.equal(Number(back.amount), 30);
});

test("bulk confirm leaves a marked entry that is no longer waiting, and an older phone's plain confirm drops the mark", () => {
  const a = waApp();
  a.loan(50, "2026-01-05"); a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  a.rt.ctx.__p = { items: [{ id: e.id }] };
  const out = a.rt.run("confirmEntries(__p)");
  assert.deepEqual([...out.confirmed], [e.id]);
  assert.equal(a.entry(e.id).repay_intent, "");
  a.rt.ctx.__p = { items: [{ id: e.id, repay: true }] };
  assert.equal(a.rt.run("confirmEntries(__p)").kept[0].reason, "notPending");
});
