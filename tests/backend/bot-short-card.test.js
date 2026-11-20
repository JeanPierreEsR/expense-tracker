// The bot's transaction message, shorter (owner, 2026-11-20): no "Paid by" when the person paid, no type word for an expense,
// "Today" for today's date on the account's line, and the "Reply to edit" line only until replies are learned, then 1 in 15.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense");
  rt.run(`appendRowObject('Telegram Messages', { message_id: '700', entry_id: ${JSON.stringify(pending.id)}, created_at: 'x' });`);
  let n = 0;
  const reply = (text) => rt.rawPost(JSON.stringify({ update_id: 6000 + (++n), message: { chat: { id: chat }, message_id: 900 + n, text, reply_to_message: { message_id: 700 } } }));
  const card = (id, opts) => rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(id)}), null, null, ${JSON.stringify(opts || {})})`);
  const hintShows = () => rt.run("replyHintShow_()");
  return { rt, data, reply, card, hintShows, pending };
}

test("an expense the person paid: no type word, no Paid by, date and account on one line", () => {
  const { rt, card, pending } = setup();
  rt.run(`setEntryField_(${JSON.stringify(pending.id)}, 'paid_by', 'me')`);
  const text = card(pending.id);
  assert.doesNotMatch(text, /Paid by/);
  assert.doesNotMatch(text.split("\n")[0], /expense/);
  assert.match(text.split("\n")[2], /· 💳 /);
});

test("an expense a friend paid still says who paid", () => {
  const { rt, data, card, pending } = setup();
  rt.run(`setEntryField_(${JSON.stringify(pending.id)}, 'paid_by', ${JSON.stringify(data.friends[0].id)})`);
  assert.match(card(pending.id), new RegExp("Paid by: " + data.friends[0].name));
});

test("today's date reads Today; other types keep their word on the first line", () => {
  const { rt, data, card, pending } = setup();
  const today = rt.run("Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd')");
  rt.run(`setEntryField_(${JSON.stringify(pending.id)}, 'date', ${JSON.stringify(today)})`);
  assert.match(card(pending.id).split("\n")[2], /^Today · /);
  const income = data.entries.find((e) => e.type === "income");
  assert.match(card(income.id).split("\n")[0], /· income/);
});

test("the hint line can be left out", () => {
  const { card, pending } = setup();
  assert.match(card(pending.id), /Reply to edit/);
  assert.doesNotMatch(card(pending.id, { hint: false }), /Reply to edit/);
});

test("hint: every card until 3 written edits, then 1 in 15; 'help' brings it back for 3 cards", () => {
  const { reply, hintShows } = setup();
  for (let i = 0; i < 5; i++) assert.equal(hintShows(), true, "still learning");
  reply("amount 20");
  reply("description Lunch");
  reply("amount 21");
  const shown = [];
  for (let i = 0; i < 30; i++) shown.push(hintShows());
  assert.equal(shown.filter(Boolean).length, 2, "two reminders in 30 cards");
  assert.equal(shown.indexOf(true) + 1, 14, "the refreshed card after the 3rd edit was card 1 of the 15");
  reply("help");
  assert.deepEqual([hintShows(), hintShows(), hintShows()], [true, true, true]);
  assert.equal(hintShows(), false);
});

test("words the bot does not understand also bring the hint back", () => {
  const { reply, hintShows } = setup();
  reply("amount 20"); reply("amount 21"); reply("amount 22");
  for (let i = 0; i < 3; i++) hintShows();
  reply("amount banana");
  assert.equal(hintShows(), true);
});
