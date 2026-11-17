// WhatsApp as the review bot (WhatsAppBot.gs): the Telegram engine's cards, taps and replies, delivered on WhatsApp; Edit
// tap-lists; the 24-hour window with its catch-up and "keep it open" message; one bot at a time. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail, linkTelegram } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const OWNER = "51900000000";

function waApp() {
  const { rt, data } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_SWITCH_AT", rt.run(`Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")`));
  const sent = [];
  let out = 0, inId = 0;
  rt.state.fetchHandler = (url, opts) => {
    if (String(url) === "https://whatsapp-relay.jper75.workers.dev/send") {
      // The app sends through the relay with the relay key, never with a WhatsApp token of its own.
      assert.equal(opts.headers["X-Relay-Secret"], SECRET);
      assert.ok(!/Bearer/.test(JSON.stringify(opts)));
      sent.push(JSON.parse(opts.payload).message);
      return { messages: [{ id: "wamid.out" + (++out) }] };
    }
    assert.ok(!String(url).includes("graph.facebook.com"), "the app never calls Meta directly");
    return { ok: true, result: { message_id: 1 } };
  };
  const post = (msg) => {
    rt.ctx.__body = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.in" + (++inId), from: OWNER, timestamp: Math.floor(Date.now() / 1000) }, msg), relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  };
  const text = (t, extra) => post(Object.assign({ type: "text", text: t }, extra || {}));
  const tap = (id, contextId) => post({ type: "interactive", reply_id: id, context_id: contextId });
  const lastCard = () => [...sent].reverse().find((m) => m.type === "interactive" && m.interactive.type === "button" && m.interactive.action.buttons.some((b) => /^confirm:/.test(b.reply.id)));
  const cardIdOf = (entryId) => rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId && /^wamid\./.test(m.message_id)).pop().message_id;
  const waEntries = () => rt.rows("Entries").filter((e) => e.source === "whatsapp");
  const telegramCalls = () => rt.svc.fetchLog.filter((f) => String(f.url).includes("api.telegram.org"));
  const said = () => sent.map((m) => (m.text && m.text.body) || (m.interactive && m.interactive.body.text) || "").join("\n");
  return { rt, data, sent, post, text, tap, lastCard, cardIdOf, waEntries, telegramCalls, said };
}

test("a typed expense comes back as a card with Confirm · Edit · Discard, and nothing goes to Telegram", () => {
  const a = waApp();
  linkTelegram(a.rt);
  const res = a.text("25 almuerzo");
  assert.equal(res.ok, true, JSON.stringify(res));
  const [e] = a.waEntries();
  assert.equal(e.status, "pending");
  const card = a.lastCard();
  assert.ok(card, "a card was sent");
  assert.equal(card.to, OWNER);
  assert.deepEqual(card.interactive.action.buttons.map((b) => b.reply.id), ["confirm:" + e.id, "waedit:" + e.id, "discard:" + e.id]);
  assert.match(card.interactive.body.text, /PEN 25\.00/);
  assert.match(a.cardIdOf(e.id), /^wamid\.out/);
  assert.equal(a.telegramCalls().length, 0, "Telegram gets nothing while WhatsApp is the review bot");
});

test("Confirm needs a category first; with one it confirms", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  const card = a.cardIdOf(e.id);
  a.tap("confirm:" + e.id, card);
  assert.equal(a.rt.rows("Entries").find((x) => x.id === e.id).status, "pending");
  const answer = a.sent[a.sent.length - 1];
  assert.equal(answer.text.body, a.rt.run("tr_('bot.needCategoryFirst')"));
  assert.equal(answer.context.message_id, card, "the answer quotes the card");

  a.text("18 taxi");
  const taxi = a.waEntries().find((x) => x.description.startsWith("Taxi"));
  const transport = a.rt.rows("Categories").find((c) => c.type === "expense" && c.name === "Transport");
  a.tap(`wapick:${taxi.id}:category:${transport.id}`);   // an Edit pick: saved, still waiting
  assert.equal(a.rt.rows("Entries").find((x) => x.id === taxi.id).status, "pending");
  a.tap("confirm:" + taxi.id, a.cardIdOf(taxi.id));
  assert.equal(a.rt.rows("Entries").find((x) => x.id === taxi.id).status, "confirmed");
  // A late second tap on the same card: the engine's own answer, nothing changes.
  a.tap("confirm:" + taxi.id, a.cardIdOf(taxi.id));
  assert.match(a.sent[a.sent.length - 1].text.body, /already/i);
});

test("Discard removes a waiting entry", () => {
  const a = waApp();
  a.text("9 coffee");
  const [e] = a.waEntries();
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.rt.rows("Entries").find((x) => x.id === e.id), undefined);
});

test("Edit: a tap-list of fields, then a tap-list of categories, then the card again", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.tap("waedit:" + e.id, a.cardIdOf(e.id));
  const menu = a.sent[a.sent.length - 1];
  assert.equal(menu.interactive.type, "list");
  const fields = menu.interactive.action.sections[0].rows.map((r) => r.id);
  assert.deepEqual(fields, ["category", "account", "amount", "description", "date"].map((f) => `wafield:${e.id}:${f}`)
    .concat([`waconv:${e.id}:r`, `waconv:${e.id}:l`, `wahelp:${e.id}`]));

  a.tap(`wafield:${e.id}:category`);
  const list = a.sent[a.sent.length - 1];
  const rows = list.interactive.action.sections[0].rows;
  assert.ok(rows.length >= 2 && rows.length <= 10);
  rows.forEach((r) => assert.ok(r.title.length <= 24, r.title));
  const pick = rows.find((r) => r.id.startsWith("wapick:"));
  const catId = pick.id.split(":").pop();
  a.tap(pick.id);
  assert.equal(a.rt.rows("Entries").find((x) => x.id === e.id).category_id, catId);
  assert.ok(a.lastCard(), "the updated card was sent");
});

test("Edit amount: the bot asks, the next message is the amount; a reply to a card edits it too", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.tap(`wafield:${e.id}:amount`);
  assert.match(a.sent[a.sent.length - 1].text.body, /amount/i);
  a.text("30.50");
  assert.equal(Number(a.rt.rows("Entries").find((x) => x.id === e.id).amount), 30.5);
  a.text("amount 40", { context_id: a.cardIdOf(e.id) });
  assert.equal(Number(a.rt.rows("Entries").find((x) => x.id === e.id).amount), 40);
  assert.equal(a.waEntries().length, 1, "no new entry was made from those messages");
});

test("Meta delivering the same tap twice runs it once", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.rt.ctx.__body = JSON.stringify({ whatsapp: { id: "wamid.same-tap", from: OWNER, type: "interactive", reply_id: "discard:" + e.id }, relay_secret: SECRET });
  a.rt.run("doPost({ postData: { contents: __body } })");
  const before = a.sent.length;
  const again = JSON.parse(a.rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  assert.equal(again.data.duplicate, true);
  assert.equal(a.sent.length, before);
});

test("the 24-hour window: a bank e-mail's card waits while it is closed and comes when the person writes", () => {
  const a = waApp();
  a.text("hola");   // learns the number, opens the window
  a.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 25 * 3600000));
  const before = a.sent.length;
  bcpEmail(a.rt, { amount: "41.30", merchant: "Corner Grocer", op: "555111" });
  a.rt.run("processEmails()");
  const mail = a.rt.rows("Entries").find((x) => x.external_id === "555111");
  assert.ok(mail && mail.status === "pending");
  assert.equal(a.sent.length, before, "nothing sent while the window is closed");
  assert.equal(a.telegramCalls().length, 0, "and nothing to Telegram");

  a.text("hola");
  assert.match(a.said(), /came in while I couldn't write to you/);
  assert.ok(a.cardIdOf(mail.id), "its card was sent");
  // Window open: the next e-mail's card goes at once.
  bcpEmail(a.rt, { amount: "12.00", merchant: "Other Shop", op: "555222" });
  a.rt.run("processEmails()");
  const mail2 = a.rt.rows("Entries").find((x) => x.external_id === "555222");
  assert.ok(a.cardIdOf(mail2.id));
});

test("'pendientes' sends the waiting entries 5 at a time with Show more", () => {
  const a = waApp();
  for (let i = 1; i <= 7; i++) a.text(`${i} item ${i}`);
  const waiting = a.rt.rows("Entries").filter((e) => e.status === "pending").length;
  const before = a.sent.length;
  a.text("pendientes");
  const newMsgs = a.sent.slice(before);
  assert.equal(newMsgs.filter((m) => m.type === "interactive" && m.interactive.action.buttons && m.interactive.action.buttons[0].reply.id.startsWith("confirm:")).length, Math.min(5, waiting));
  if (waiting > 5) {
    const more = newMsgs[newMsgs.length - 1];
    assert.equal(more.interactive.action.buttons[0].reply.id, "wamore:pend:5");
  }
});

test("the 'keep it open' message goes once, between 22.5 h and 23.75 h after the last message", () => {
  const a = waApp();
  a.text("hola");
  a.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 20 * 3600000));
  a.rt.run("whatsappNudgeIfDue_()");
  const before = a.sent.length;
  a.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 23 * 3600000));
  a.rt.run("whatsappNudgeIfDue_()");
  assert.equal(a.sent.length, before + 1);
  assert.match(a.sent[a.sent.length - 1].text.body, /Reply anything/);
  a.rt.run("whatsappNudgeIfDue_()");
  assert.equal(a.sent.length, before + 1, "only once per window");
});

test("switched back to Telegram: cards go to Telegram and WhatsApp only answers what it is sent", () => {
  const a = waApp();
  a.text("hola");
  a.rt.svc.props.delete("REVIEW_BOT");
  linkTelegram(a.rt);
  const res = a.text("25 almuerzo");
  assert.match(res.data.reply, /Saved for review/);
  bcpEmail(a.rt, { amount: "41.30", merchant: "Corner Grocer", op: "555333" });
  a.rt.run("processEmails()");
  assert.ok(a.telegramCalls().some((f) => /sendMessage/.test(f.url)));
});
