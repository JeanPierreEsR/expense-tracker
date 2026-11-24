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

// ---- the loans in the chat, and the words after "repayment" (piece 3) ----

test("after the mark, the chat lists the loans: Oldest first, each loan (exact one said), Several → in the app", () => {
  const a = waApp();
  const l1 = a.loan(50, "2026-01-05"), l2 = a.loan(20, "2026-02-05");
  a.loan(80, "2026-03-05");
  const e = readyExpense(a);   // 20
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  const rows = a.lastRows();
  assert.deepEqual(rows.map((r) => r.id), [`warl:${e.id}:oldest`, `warl:${e.id}:${l1.id}`, `warl:${e.id}:${l2.id}`, `warl:${e.id}:` + rows[3].id.split(":").pop(), `warl:${e.id}:app`]);
  assert.match(rows[2].description, /= this payment/, "the loan of exactly 20 is pointed out");
  assert.ok(!/= this payment/.test(rows[1].description));
});

test("tapping a loan pays THAT loan first; 'deshacer' takes it back to waiting, marked", () => {
  const a = waApp();
  const l1 = a.loan(50, "2026-01-05"), l2 = a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  a.tap(`warl:${e.id}:${l2.id}`);
  assert.equal(a.entry(e.id), undefined);
  assert.equal(a.settlementsOf(l2.id).reduce((n, s) => n + Number(s.amount), 0), 20, "the loan tapped");
  assert.equal(a.settlementsOf(l1.id).length, 0);
  a.text("deshacer");
  assert.equal(a.settlementsOf(l2.id).length, 0, "the repayment is gone");
  assert.ok(a.entry(e.id).repay_intent, "waiting again, still marked");
});

test("'Oldest first' in the list pays the oldest; 'Several → in the app' changes nothing", () => {
  const a = waApp();
  const l1 = a.loan(50, "2026-01-05"); a.loan(50, "2026-02-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test", { context_id: a.cardIdOf(e.id) });
  a.tap(`warl:${e.id}:app`);
  assert.ok(a.entry(e.id).repay_intent);
  assert.match(a.bodies().pop(), /stays in Needs review/);
  a.tap(`warl:${e.id}:oldest`);
  assert.equal(a.entry(e.id), undefined);
  assert.equal(a.settlementsOf(l1.id).length, 1);
});

test("'repayment, paid by Zoe' (a tester's words) is a repayment, never an edit of the description or of who paid", () => {
  const a = waApp();
  const only = a.loan(50, "2026-01-05");
  const e = readyExpense(a);
  a.text("repayment, paid by Zoe Test", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id), undefined, "recorded (one loan: nothing to choose)");
  assert.equal(a.settlementsOf(only.id).length, 1);
  const b = waApp();
  b.loan(50, "2026-01-05");
  const e2 = readyExpense(b);
  b.text("repago de Zoe Test", { context_id: b.cardIdOf(e2.id) });
  assert.equal(b.entry(e2.id), undefined);
});

test("'repayment Zoe, amount 30' changes the amount first, then records it; a part that cannot be applied stops everything", () => {
  const a = waApp();
  const only = a.loan(50, "2026-01-05");
  const e = readyExpense(a);
  a.text("repayment Zoe Test, amount 30", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id), undefined);
  assert.equal(a.settlementsOf(only.id).reduce((n, s) => n + Number(s.amount), 0), 30);

  const b = waApp();
  b.loan(50, "2026-01-05");
  const e2 = readyExpense(b);
  b.text("repayment Zoe Test, amount lots", { context_id: b.cardIdOf(e2.id) });
  assert.ok(b.entry(e2.id), "nothing recorded");
  assert.match(b.bodies().join("\n"), /Nothing was marked/);
});

// ---- Telegram: check several loans in place, then save (owner, 2026-11-24) ----
const { linkTelegram } = require("./helpers");
function tgApp() {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let mid = 1000, upd = 5000;
  rt.state.fetchHandler = (url) => (/sendMessage/.test(String(url)) ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: true });
  const calls = (method) => rt.svc.fetchLog.filter((f) => String(f.url).endsWith("/" + method)).map((f) => JSON.parse(f.options.payload));
  const say = (text, replyTo) => rt.rawPost(JSON.stringify({ update_id: ++upd, message: Object.assign({ chat: { id: chat }, message_id: ++mid, date: Math.floor(Date.now() / 1000), text }, replyTo ? { reply_to_message: { message_id: replyTo } } : {}) }));
  const tap = (data, messageId) => rt.rawPost(JSON.stringify({ update_id: ++upd, callback_query: { id: "cb" + upd, data, message: { chat: { id: chat }, message_id: messageId } } }));
  const a = {
    rt, calls, say, tap,
    sentWithButtons: () => calls("sendMessage").filter((m) => m.reply_markup),
    entry: (id) => rt.rows("Entries").find((e) => e.id === id),
    newest: () => rt.rows("Entries").filter((e) => e.source === "telegram").pop(),
    cardIdOf: (entryId) => Number(rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId).pop().message_id)
  };
  rt.ctx.__f = { name: "Zoe Test" };
  a.friend = rt.run("addFriend(__f)");
  a.loan = (amount, date) => { rt.ctx.__l = { friend_id: a.friend.id, direction: "i_owe_them", amount, currency: "PEN", date }; return rt.run("addLoan(__l)"); };
  a.settlementsOf = (loanId) => rt.rows("Settlements").filter((s) => s.loan_id === loanId && !s.offset_loan_id);
  return a;
}
const buttonsOf = (markup) => markup.inline_keyboard.map((r) => r[0]);

test("Telegram: the loans are check buttons; checking two and saving pays them oldest first; unchecking takes one back; 'deshacer' undoes it", () => {
  const a = tgApp();
  const l1 = a.loan(10, "2026-01-05"), l2 = a.loan(30, "2026-02-05"), l3 = a.loan(30, "2026-03-05");
  a.say("25 pago, category " + a.rt.rows("Categories").find((c) => c.type === "expense").name);
  const e = a.newest();
  a.say("repayment Zoe Test", a.cardIdOf(e.id));
  assert.equal(a.entry(e.id).status, "pending", "kept waiting: 25 does not cover 70");
  const list = a.sentWithButtons().pop();
  assert.match(list.text, /Tap one or more to check them/);
  let buttons = buttonsOf(list.reply_markup);
  assert.equal(buttons.length, 5, "Oldest first, three loans, in the app (no Save until something is checked)");
  assert.ok(buttons[2].text.startsWith("☐ "));
  const listId = 7777;
  a.tap(buttons[3].callback_data, listId);   // l3
  a.tap(buttons[2].callback_data, listId);   // l2
  a.tap(buttons[3].callback_data, listId);   // l3 again: unchecked
  a.tap(buttons[3].callback_data, listId);   // and checked again
  const edits = a.calls("editMessageReplyMarkup").filter((c) => c.message_id === listId);
  buttons = buttonsOf(edits[edits.length - 1].reply_markup);
  assert.ok(buttons[2].text.startsWith("☑ ") && buttons[3].text.startsWith("☑ ") && buttons[1].text.startsWith("☐ "));
  const save = buttons.find((b) => /Save the checked ones \(2\)/.test(b.text));
  assert.ok(save, "Save shows the count");
  assert.ok(edits.every((c) => c.reply_markup.inline_keyboard.length), "the list's buttons were never taken away while checking");
  a.tap(save.callback_data, listId);
  assert.equal(a.entry(e.id), undefined, "recorded");
  assert.equal(a.settlementsOf(l2.id).reduce((n, s) => n + Number(s.amount), 0), 25, "the older checked loan takes the payment first");
  assert.equal(a.settlementsOf(l3.id).length, 0);
  assert.equal(a.settlementsOf(l1.id).length, 0, "the unchecked oldest loan is not touched");
  a.say("deshacer");
  assert.equal(a.settlementsOf(l2.id).length, 0);
  assert.ok(a.entry(e.id).repay_intent, "waiting again, marked");
});

test("Telegram: checked loans pay in order until the payment runs out; the rest goes to the oldest others", () => {
  const a = tgApp();
  const l1 = a.loan(10, "2026-01-05"), l2 = a.loan(10, "2026-02-05"), l3 = a.loan(50, "2026-03-05");
  a.say("25 pago, category " + a.rt.rows("Categories").find((c) => c.type === "expense").name);
  const e = a.newest();
  a.say("repayment Zoe Test", a.cardIdOf(e.id));
  const buttons = buttonsOf(a.sentWithButtons().pop().reply_markup);
  a.tap(buttons[2].callback_data, 8888);   // l2 only: 10 of the 25
  const edits = a.calls("editMessageReplyMarkup").filter((c) => c.message_id === 8888);
  a.tap(buttonsOf(edits.pop().reply_markup).find((b) => /Save the checked one$/.test(b.text)).callback_data, 8888);
  assert.equal(a.settlementsOf(l2.id).reduce((n, s) => n + Number(s.amount), 0), 10);
  assert.equal(a.settlementsOf(l1.id).reduce((n, s) => n + Number(s.amount), 0), 10, "what is left goes to the oldest other loan");
  assert.equal(a.settlementsOf(l3.id).reduce((n, s) => n + Number(s.amount), 0), 5);
});
