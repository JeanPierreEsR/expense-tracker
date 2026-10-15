// A message typed without replying to anything is assumed to be about the last
// notification — if that was an entry card still pending approval. Also: a
// missing payment method shows as "❓ not set" on the card.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  let mid = 100;
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: ++mid } });   // each bot message gets a new id
  const pending = data.entries.filter((e) => e.status === "pending" && e.type === "expense");
  const card = (e) => { rt.run(`sendTelegramEntryNotification_(getEntryById_(${JSON.stringify(e.id)}), null);`); return mid; };
  let n = 0;
  const say = (text) => rt.rawPost(JSON.stringify({ update_id: 7000 + (++n), message: { chat: { id: chat }, message_id: 900 + n, text } }));
  const sent = () => rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n");
  const entry = (id) => rt.rows("Entries").find((e) => e.id === id);
  return { rt, data, pending, card, say, sent, entry };
}

test("a plain message edits the last notification when it is a pending entry card", () => {
  const { pending, card, say, entry } = setup();
  const [a, b] = pending;
  card(a);
  card(b);
  say("description Typed without replying");
  assert.equal(entry(b.id).description, "Typed without replying", "goes to the newest card");
  assert.notEqual(entry(a.id).description, "Typed without replying");
});

test("after a budget alert, a plain message gets the 'reply directly' note and edits nothing", () => {
  const { rt, pending, card, say, sent, entry } = setup();
  card(pending[0]);
  rt.run("noteTelegramAlertSent_({ ok: true, result: { message_id: 999 } });");   // an alert arrives after the card
  const before = entry(pending[0].id).description;
  say("description Should not apply");
  assert.equal(entry(pending[0].id).description, before);
  assert.match(sent(), /Reply directly to an entry message/);
});

test("when the last card's entry is no longer pending, a plain message gets the 'reply directly' note", () => {
  const { rt, pending, card, say, sent, entry } = setup();
  card(pending[0]);
  rt.run(`deleteEntry_(${JSON.stringify(pending[0].id)});`);
  say("description Nope");
  assert.match(sent(), /Reply directly to an entry message/);
});

test("with no notification at all, a plain message gets the 'reply directly' note", () => {
  const { say, sent } = setup();
  say("amount 5");
  assert.match(sent(), /Reply directly to an entry message/);
});

test("a card for an expense with no payment method shows a ❓ line", () => {
  const { rt, pending } = setup();
  const e = pending[0];
  rt.run(`updateRowFields_('Entries', ${JSON.stringify(e.id)}, { payment_method_id: '' });`);
  const text = rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(e.id)}), null)`);
  assert.match(text, /💳 ❓ not set — reply "payment method Interbank"/);
});
