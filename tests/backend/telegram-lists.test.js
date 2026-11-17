// Telegram gets WhatsApp's Edit lists and commands (owner, 2026-11-16): the same flow and items from the same code; Telegram shows
// each list on one page and removes a used list's buttons; WhatsApp pages 9 (8 friends + More + Someone else). Lists show the
// most used first, arranged A-Z, then the rest A-Z. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

function tgApp() {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let mid = 1000, upd = 5000;
  rt.state.fetchHandler = (url) => (/sendMessage/.test(String(url)) ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: true });
  const calls = (method) => rt.svc.fetchLog.filter((f) => String(f.url).endsWith("/" + method)).map((f) => JSON.parse(f.options.payload));
  const sent = () => calls("sendMessage");
  const say = (text, replyTo) => rt.rawPost(JSON.stringify({ update_id: ++upd, message: Object.assign({ chat: { id: chat }, message_id: ++mid, date: Math.floor(Date.now() / 1000), text }, replyTo ? { reply_to_message: { message_id: replyTo } } : {}) }));
  const tap = (data, messageId) => rt.rawPost(JSON.stringify({ update_id: ++upd, callback_query: { id: "cb" + upd, data, message: { chat: { id: chat }, message_id: messageId } } }));
  const lastWithButtons = () => { const s = sent().filter((m) => m.reply_markup); return s[s.length - 1]; };
  const entry = (id) => rt.rows("Entries").find((e) => e.id === id);
  const newest = () => rt.rows("Entries").filter((e) => e.source === "telegram").pop();
  const cardIdOf = (entryId) => Number(rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId).pop().message_id);
  return { rt, chat, sent, calls, say, tap, lastWithButtons, entry, newest, cardIdOf };
}

test("Telegram transaction messages have Confirm · Edit · Discard; Edit opens the same field list as WhatsApp", () => {
  const a = tgApp();
  a.say("25 almuerzo");
  const e = a.newest();
  const card = a.lastWithButtons();
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["confirm:" + e.id, "waedit:" + e.id, "discard:" + e.id]);
  a.tap("waedit:" + e.id, a.cardIdOf(e.id));
  const list = a.lastWithButtons();
  assert.deepEqual(list.reply_markup.inline_keyboard.map((r) => r[0].callback_data),
    ["category", "account", "amount", "description", "date"].map((f) => `wafield:${e.id}:${f}`).concat([`waconv:${e.id}:r`, `waconv:${e.id}:l`, `wahelp:${e.id}`]));
  assert.equal(a.calls("editMessageReplyMarkup").filter((c) => c.message_id === a.cardIdOf(e.id)).length, 0, "Edit on the card keeps the card's buttons");
});

test("Telegram pick list: one page with everything, the most used 9 A-Z then the rest A-Z; short codes; picking saves without confirming and the list's buttons go away", () => {
  const a = tgApp();
  a.say("25 almuerzo");
  const e = a.newest();
  a.tap(`wafield:${e.id}:category`, 4242);
  assert.ok(a.calls("editMessageReplyMarkup").some((c) => c.message_id === 4242), "the field list's buttons went away");
  const list = a.lastWithButtons();
  const buttons = list.reply_markup.inline_keyboard.map((r) => r[0]);
  const cats = a.rt.rows("Categories").filter((c) => c.type === "expense" && String(c.hidden || "") !== "yes");
  assert.equal(buttons.length, cats.length, "every category, no More…");
  const titles = buttons.map((b) => b.text);
  const firstNine = titles.slice(0, 9), rest = titles.slice(9);
  assert.deepEqual(firstNine, [...firstNine].sort((x, y) => x.localeCompare(y)));
  assert.deepEqual(rest, [...rest].sort((x, y) => x.localeCompare(y)));
  buttons.forEach((b) => assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data));
  const before = a.calls("editMessageReplyMarkup").length;
  a.tap(buttons[0].callback_data, 4343);
  assert.ok(a.entry(e.id).category_id, "category set");
  assert.equal(a.entry(e.id).status, "pending", "an Edit pick only saves");
  assert.ok(a.calls("editMessageReplyMarkup").slice(before).some((c) => c.message_id === 4343), "the pick list's buttons went away");
});

test("a Telegram list code older than 6 hours says so and changes nothing", () => {
  const a = tgApp();
  a.say("25 almuerzo");
  const e = a.newest();
  a.tap("k:doesnotexist", 4444);
  assert.equal(a.sent().pop().text, a.rt.run("tr_('bot.listExpired')"));
  assert.equal(a.entry(e.id).category_id || "", a.entry(e.id).category_id || "");
});

test("Telegram amount question: the next message is the amount, only if it is one", () => {
  const a = tgApp();
  a.say("25 almuerzo");
  const e = a.newest();
  a.tap(`wafield:${e.id}:amount`, 4545);
  assert.equal(a.sent().pop().text, a.rt.run("tr_('whatsapp.ask.amount')"));
  a.say("abc");
  assert.equal(a.sent().pop().text, a.rt.run("tr_('whatsapp.ask.amount')"), "asked again");
  a.say("30.50");
  assert.equal(Number(a.entry(e.id).amount), 30.5);
  assert.equal(a.entry(e.id).status, "pending");
});

test("Telegram Repayment / Loan: one page with every friend, 'Someone else' last; a tap converts", () => {
  const a = tgApp();
  a.say("60 cena");
  const e = a.newest();
  a.tap(`waconv:${e.id}:l`, 4646);
  const rows = a.lastWithButtons().reply_markup.inline_keyboard.map((r) => r[0]);
  const friends = a.rt.rows("Friends").filter((f) => !f.trip_id);
  assert.equal(rows.length, friends.length + 1, "every friend + Someone else, no More…");
  assert.equal(rows[rows.length - 1].text, a.rt.run("tr_('whatsapp.someoneElse')"));
  a.tap(rows[0].callback_data, 4747);
  assert.equal(a.entry(e.id), undefined, "converted into a loan");
});

test("Telegram commands: ayuda, pendientes, nuevo (not as a reply)", () => {
  const a = tgApp();
  a.say("ayuda");
  assert.equal(a.sent().pop().text, a.rt.run("tr_('bot.helpGeneral')"));
  a.say("nuevo");
  assert.equal(a.sent().pop().text, a.rt.run("tr_('whatsapp.newHow')"));
  const waiting = a.rt.rows("Entries").filter((e) => e.status === "pending").length;
  const before = a.sent().length;
  a.say("pendientes");
  const cards = a.sent().slice(before).filter((m) => m.reply_markup && m.reply_markup.inline_keyboard[0].some((b) => /^confirm:/.test(b.callback_data)));
  assert.equal(cards.length, Math.min(5, waiting));
});

// ---- WhatsApp: the same sorting, and 8 friends a page ----
function waApp() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", "test-relay-secret-0123456789abcdef");
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  const sent = [];
  rt.state.fetchHandler = (url, opts) => (String(url).endsWith("/send") ? (sent.push(JSON.parse(opts.payload).message), { messages: [{ id: "wamid.o" + sent.length }] }) : { ok: true });
  let n = 0;
  const post = (m) => { rt.ctx.__b = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.i" + (++n), from: "51900000000" }, m), relay_secret: "test-relay-secret-0123456789abcdef" }); rt.run("doPost({ postData: { contents: __b } })"); };
  return { rt, sent, post, rows: () => sent[sent.length - 1].interactive.action.sections[0].rows };
}

test("WhatsApp pick list: the most used 9 A-Z, then More… (the rest A-Z on the next pages)", () => {
  const a = waApp();
  a.post({ type: "text", text: "25 almuerzo" });
  const e = a.rt.rows("Entries").filter((x) => x.source === "whatsapp").pop();
  a.post({ type: "interactive", reply_id: `wafield:${e.id}:category` });
  const rows = a.rows();
  const nine = rows.slice(0, 9).map((r) => r.title);
  assert.deepEqual(nine, [...nine].sort((x, y) => x.localeCompare(y)));
  assert.match(rows[9].id, /^wapage:/);
  a.post({ type: "interactive", reply_id: rows[9].id });
  const page2 = a.rows().filter((r) => r.id.startsWith("wapick:")).map((r) => r.title);
  assert.deepEqual(page2, [...page2].sort((x, y) => x.localeCompare(y)));
});

test("WhatsApp friends: 8 a page + More… + Someone else on every page", () => {
  const a = waApp();
  a.post({ type: "text", text: "60 cena" });
  const e = a.rt.rows("Entries").filter((x) => x.source === "whatsapp").pop();
  a.post({ type: "interactive", reply_id: `waconv:${e.id}:l` });
  const rows = a.rows();
  const friends = a.rt.rows("Friends").filter((f) => !f.trip_id).length;
  assert.ok(friends > 8, "the made-up data has more than 8 friends");
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((r) => r.id.startsWith("wacv:")).length, 8);
  assert.match(rows[8].id, /^wafp:/);
  assert.match(rows[9].id, /^wacvx:/);
});
