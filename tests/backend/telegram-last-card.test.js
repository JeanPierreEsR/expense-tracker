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
  rt.run("noteTelegramAlertSent_(telegramApi_('sendMessage', { chat_id: getOwnerTelegramChatId_(), text: 'Budget alert' }));");   // a real alert arrives after the card
  const before = entry(pending[0].id).description;
  say("description Should not apply");
  assert.equal(entry(pending[0].id).description, before);
  assert.match(sent(), /Reply directly to an entry message/);
});

// Since 2026-11-16 Telegram has WhatsApp's "last message" rule (owner): the transaction of the bot's last message, waiting OR
// confirmed; one deleted meanwhile says so.
test("when the last card's entry was deleted meanwhile, a plain message says so and edits nothing", () => {
  const { rt, pending, card, say, sent } = setup();
  card(pending[0]);
  rt.run(`deleteEntry_(${JSON.stringify(pending[0].id)});`);
  say("description Nope");
  assert.match(sent(), new RegExp(rt.run("tr_('bot.entryNotFound')").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("after the bot's 'Confirmed.' about a transaction, a plain message edits that confirmed transaction (the WhatsApp rule)", () => {
  const { rt, pending, card, say, entry } = setup();
  const e = pending[0];
  const cat = rt.rows("Categories").find((c) => c.type === "expense");
  rt.run(`updateRowFields_('Entries', ${JSON.stringify(e.id)}, { category_id: ${JSON.stringify(cat.id)} });`);
  const cardId = card(e);
  rt.rawPost(JSON.stringify({ update_id: 7999, callback_query: { id: "cbx", data: "confirm:" + e.id, message: { chat: { id: Number(rt.svc.props.get("TELEGRAM_CHAT_ID")) }, message_id: cardId } } }));
  assert.equal(entry(e.id).status, "confirmed");
  say("description Edited after confirming");
  assert.equal(entry(e.id).description, "Edited after confirming");
  assert.equal(entry(e.id).status, "confirmed");
});

test("plain words after a message that is not about a transaction: not taken as an edit; with no amount the bot says how to write one", () => {
  const { rt, pending, card, say, sent, entry } = setup();
  card(pending[0]);
  rt.run("telegramApi_('sendMessage', { chat_id: getOwnerTelegramChatId_(), text: 'Some other message' })");
  const before = entry(pending[0].id).description;
  say("hola");
  assert.equal(entry(pending[0].id).description, before);
  assert.match(sent(), /couldn't find an amount/);
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
  assert.match(text, /💳 ❓ not set — reply, for example, “account [^”]+”/);
});
