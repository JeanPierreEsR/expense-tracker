// A repayment's entries are never deleted on their own: Telegram's Discard points to the app and offers to delete the WHOLE
// repayment; the app's discardEntry refuses too (owner's rule, 2026-10-28). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram } = require("./helpers");

// A repayment of 50 against a debt of 30: the 20 extra has no category chosen, so it WAITS (pending) — the entry that can
// carry a Telegram card with a Discard button.
function setup() {
  const { rt, data } = freshApp();
  const chat = linkTelegram(rt);
  const f = rt.api("addFriend", { name: "Tg Friend " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: today(), payment_method_id: pm });
  const row = rt.rows("Settlements").find((s) => s.gap_entry_id);
  const tap = (data_, n) => rt.rawPost(JSON.stringify({ update_id: 9100 + n, callback_query: { id: "cb" + n, data: data_, message: { chat: { id: chat }, message_id: 80 + n } } }));
  const sent = () => rt.svc.fetchLog.map((x) => x.options.payload).join("\n");
  const exists = (id) => rt.rows("Entries").some((e) => e.id === id);
  const owed = () => {
    const l = rt.rows("Loans").find((x) => x.id === loan.id);
    return Number(l.amount) - rt.rows("Settlements").filter((s) => s.loan_id === loan.id).reduce((n, s) => n + Number(s.amount), 0);
  };
  return { rt, data, f, pm, row, tap, sent, exists, owed, extraId: row.gap_entry_id, movementId: row.transfer_entry_id };
}

test("the extra waits as a pending entry (the case that can have a Telegram card)", () => {
  const { rt, extraId } = setup();
  assert.equal(rt.rows("Entries").find((e) => e.id === extraId).status, "pending");
});

test("Telegram Discard on a repayment's extra deletes NOTHING, points to the app and offers the whole repayment", () => {
  const { rt, tap, sent, exists, extraId, movementId, f } = setup();
  tap("discard:" + extraId, 1);
  assert.equal(exists(extraId), true, "the extra survives");
  assert.equal(exists(movementId), true);
  const out = sent();
  assert.match(out, /part of a repayment from/);
  assert.match(out, /Repayment history/, "points to the app");
  assert.match(out, new RegExp("delrep:" + extraId), "offers the delete-the-whole-repayment button");
  assert.match(out, new RegExp(f.name));
});

test("the message sent to Telegram is one Telegram accepts: valid JSON, one button, callback data within 64 bytes", () => {
  const { tap, extraId, rt } = setup();
  tap("discard:" + extraId, 7);
  const offers = rt.svc.fetchLog
    .filter((x) => /sendMessage/.test(x.url))
    .map((x) => JSON.parse(x.options.payload))
    .filter((p) => p.reply_markup && p.reply_markup.inline_keyboard.length);
  const offer = offers[offers.length - 1];
  assert.ok(offer, "the offer was sent");
  const rows = offer.reply_markup.inline_keyboard;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 1, "exactly one button: the choice is explicit");
  const btn = rows[0][0];
  assert.match(btn.text, /Delete the whole repayment/);
  assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, "Telegram rejects callback data over 64 bytes");
  assert.equal(btn.callback_data, "delrep:" + extraId);
  assert.ok(offer.text.length < 4096, "within Telegram's message length");
  assert.ok(offer.reply_to_message_id, "answers the card it came from");
  assert.equal(String(offer.chat_id).length > 0, true);
});

test("a late Discard tap on an entry that is now a CONFIRMED repayment entry gets the same answer, not the generic one", () => {
  const { rt, data, f, pm, tap, sent, exists } = setup();
  // a second repayment whose extra was given a category, so it is confirmed from the start
  const income = data.cats.find((c) => c.type === "income");
  rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-02-01", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 45, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id });
  const row = rt.rows("Settlements").filter((s) => s.gap_entry_id).pop();
  assert.equal(rt.rows("Entries").find((e) => e.id === row.gap_entry_id).status, "confirmed");
  tap("discard:" + row.gap_entry_id, 8);
  assert.equal(exists(row.gap_entry_id), true);
  assert.match(sent(), new RegExp("delrep:" + row.gap_entry_id));
  assert.doesNotMatch(sent(), /Already confirmed/);
});

test("choosing 'Delete the whole repayment' removes both entries and reopens the debt", () => {
  const { rt, tap, sent, exists, owed, extraId, movementId, row } = setup();
  assert.equal(owed(), 0);
  tap("delrep:" + extraId, 2);
  assert.equal(exists(extraId), false);
  assert.equal(exists(movementId), false);
  assert.equal(rt.rows("Settlements").some((s) => s.id === row.id), false);
  assert.equal(owed(), 30, "what it paid is owed again");
  assert.match(sent(), /deleted \(both entries\)/);
});

test("the delete-both button works from the money movement's id too, and a second tap says it is gone", () => {
  const { rt, tap, sent, exists, movementId } = setup();
  tap("delrep:" + movementId, 3);
  assert.equal(exists(movementId), false);
  tap("delrep:" + movementId, 4);
  assert.match(sent(), /no longer exists/);
});

test("the Needs review list marks a waiting repayment extra, so the app can send Discard to the repayment's screen", () => {
  const { rt, extraId, movementId, f } = setup();
  const waiting = rt.api("listPendingEntries", {}).find((e) => e.id === extraId);
  assert.equal(waiting.link.kind, "repaymentExtra");
  assert.equal(waiting.link.friend_id, f.id);
  assert.equal(waiting.link.transfer_entry_id, movementId);
});

test("an ordinary pending entry is still discarded as before", () => {
  const { rt, data, tap } = setup();
  const p = data.entries.find((e) => e.status === "pending");
  tap("discard:" + p.id, 5);
  assert.equal(rt.rows("Entries").find((e) => e.id === p.id), undefined);
});

test("the app's discardEntry refuses either entry of a repayment, and converting the extra is refused too", () => {
  const { rt, f, pm, extraId, movementId } = setup();
  assert.throws(() => rt.api("discardEntry", { id: extraId }), /part of a repayment/);
  assert.throws(() => rt.api("discardEntry", { id: movementId }), /part of a repayment/);
  assert.throws(() => rt.api("convertEntryToLoan", { entry_id: extraId, friend_id: f.id, direction: "i_owe_them", amount: 20, currency: "PEN", date: today(), payment_method_id: pm }), /extra part of a repayment/);
  assert.equal(rt.rows("Entries").some((e) => e.id === extraId), true);
});
