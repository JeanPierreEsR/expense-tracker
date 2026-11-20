// The bot's own tour (BotTour.gs; plan "Bot tutorial - WhatsApp and Telegram", 2026-11-20): one message per step, moving on
// when the person really does the step, on both bots. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const PERSON = "51900000000";

function waApp(opts) {
  const { rt } = freshApp({ small: true });
  if (!(opts && opts.owner)) rt.svc.props.set("FEATURES", "base,gmail");   // a friend's copy
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_OWNER_NUMBER", PERSON);
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  const sent = [];
  let out = 0, inId = 0;
  rt.state.fetchHandler = (url, o) => {
    if (String(url).endsWith("/send")) { sent.push(JSON.parse(o.payload).message); return { messages: [{ id: "wamid.out" + (++out) }] }; }
    return { ok: true, result: { message_id: 1 } };
  };
  const post = (msg) => {
    rt.ctx.__body = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.in" + (++inId), from: PERSON, timestamp: Math.floor(Date.now() / 1000) }, msg), relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  };
  const bodyOf = (m) => (m.text && m.text.body) || (m.interactive && m.interactive.body.text) || "";
  const a = {
    rt, sent,
    text: (t, extra) => post(Object.assign({ type: "text", text: t }, extra || {})),
    tap: (id, contextId) => post({ type: "interactive", reply_id: id, context_id: contextId }),
    last: () => bodyOf(sent[sent.length - 1]),
    lastMsg: () => sent[sent.length - 1],
    said: () => sent.map(bodyOf).join("\n---\n"),
    tour: () => JSON.parse(rt.svc.props.get("BOT_TOUR") || "null"),
    done: () => rt.svc.props.get("BOT_TOUR_DONE") || "",
    entries: () => rt.rows("Entries").filter((e) => e.source === "whatsapp"),
    cardIdOf: (entryId) => rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId && /^wamid\./.test(m.message_id)).pop().message_id,
    lastRows: () => { const m = [...sent].reverse().find((x) => x.interactive && x.interactive.type === "list"); return m.interactive.action.sections[0].rows; }
  };
  return a;
}

test("a friend's first message to the WhatsApp bot starts the tour; the whole tour with a real expense", () => {
  const a = waApp();
  a.text("hola");
  assert.match(a.last(), /bot de tu app|your app's bot/i);
  assert.equal(a.tour().step, 1);
  assert.equal(a.entries().length, 0, "the greeting is the answer: no \"no amount\" for hola");
  assert.doesNotMatch(a.said(), /No encontr|couldn't find/);

  a.text("25 almuerzo");
  const [e] = a.entries();
  assert.equal(e.status, "pending");
  assert.equal(a.tour().step, 2);
  assert.match(a.last(), /Editar|Edit/);
  const quoted = a.lastMsg().context && a.lastMsg().context.message_id;
  assert.ok(a.rt.rows("Telegram Messages").some((m) => m.message_id === quoted && m.entry_id === e.id), "step 2 quotes the transaction");

  // Edit → Category → a pick: the change is saved, the tour moves on to Confirm.
  a.tap("waedit:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.tour().step, 2, "opening Edit is not a miss");
  assert.equal(a.tour().misses, 0);
  a.tap("wafield:" + e.id + ":category");
  const cat = a.lastRows().find((r) => /^wapick:/.test(r.id));
  a.tap(cat.id);
  assert.equal(a.tour().step, 3);
  assert.match(a.last(), /Confirmar|Confirm/);

  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.rt.rows("Entries").find((x) => x.id === e.id).status, "confirmed");
  assert.equal(a.tour().step, 4);
  assert.match(a.last(), /pendientes/);

  a.text("pendientes");
  assert.equal(a.tour(), null, "finished");
  assert.ok(a.done(), "remembered as done");
  assert.match(a.last(), /ayuda/);
  assert.match(a.last(), /24/, "WhatsApp's 24-hour tip");

  // Done once: a later first-message situation never starts it again by itself.
  a.text("hola otra vez");
  assert.equal(a.tour(), null);
});

test("\"prueba\" makes a test transaction and step 3 asks to Discard it; nothing stays", () => {
  const a = waApp();
  a.text("hola");
  a.text("prueba");
  const [e] = a.entries();
  assert.equal(Number(e.amount), 1);
  assert.match(e.description, /Prueba|Test/);
  assert.equal(a.tour().test, true);
  assert.equal(a.tour().step, 2);
  a.text("saltar");
  assert.equal(a.tour().step, 3);
  assert.match(a.last(), /Descartar|Discard/);
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entries().length, 0, "the test is gone");
  assert.equal(a.tour().step, 4);
  assert.match(a.last(), /prueba ya no est|test is gone/);
});

test("a first message that is already an expense is saved as usual and the tour starts at step 2", () => {
  const a = waApp();
  a.text("18 taxi");
  assert.equal(a.entries().length, 1);
  assert.equal(a.tour().step, 2);
});

test("two messages in a row that don't fit stop the tour; one repeats the step", () => {
  const a = waApp();
  a.text("hola");
  a.text("gracias");
  assert.equal(a.tour().step, 1);
  assert.equal(a.tour().misses, 1);
  assert.match(a.last(), /25 almuerzo/, "step 1 again");
  a.text("ok");
  assert.equal(a.tour(), null);
  assert.equal(a.done(), "", "lost is not done");
  assert.match(a.last(), /tutorial/);
});

test("\"salir\" stops it and counts as done; \"tutorial\" starts it again", () => {
  const a = waApp();
  a.text("hola");
  a.text("salir");
  assert.equal(a.tour(), null);
  assert.ok(a.done());
  a.text("tutorial");
  assert.equal(a.tour().step, 1);
});

test("never by itself on the owner's copy, nor for someone who already wrote to the bot; \"tutorial\" works there", () => {
  const o = waApp({ owner: true });
  o.text("hola");
  assert.equal(o.tour(), null);
  o.text("tutorial");
  assert.equal(o.tour().step, 1);

  const f = waApp();
  f.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 3600000));
  f.text("hola");
  assert.equal(f.tour(), null);
});

test("an old tour ends by itself after 24 hours", () => {
  const a = waApp();
  a.text("hola");
  const st = a.tour();
  st.at = Date.now() - 25 * 3600000;
  a.rt.svc.props.set("BOT_TOUR", JSON.stringify(st));
  a.text("25 almuerzo");
  assert.equal(a.tour(), null);
});

test("Telegram: \"tutorial\" runs the same tour with Telegram's buttons", () => {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let n = 0;
  const say = (body) => rt.rawPost(JSON.stringify(Object.assign({ update_id: 7000 + (++n) }, body)));
  const text = (t) => say({ message: { chat: { id: chat }, message_id: 800 + n, date: Math.floor(Date.now() / 1000), text: t } });
  const tap = (data, messageId) => say({ callback_query: { id: "cb" + n, data, message: { chat: { id: chat }, message_id: messageId } } });
  const sentTexts = () => rt.svc.fetchLog.filter((f) => /sendMessage/.test(f.url)).map((f) => JSON.parse(f.options.payload).text);
  const tour = () => JSON.parse(rt.svc.props.get("BOT_TOUR") || "null");

  text("tutorial");
  assert.equal(tour().step, 1);
  text("prueba");
  const e = rt.rows("Entries").filter((x) => x.source === "telegram").pop();
  assert.ok(e, "the test transaction was saved");
  assert.equal(tour().step, 2);
  text("saltar");
  assert.equal(tour().step, 3);
  const card = rt.rows("Telegram Messages").filter((m) => m.entry_id === e.id).pop().message_id;
  tap("discard:" + e.id, Number(card) || card);
  assert.equal(tour().step, 4);
  text("pendientes");
  assert.equal(tour(), null);
  const last = sentTexts().pop();
  assert.match(last, /ayuda/);
  assert.doesNotMatch(last, /24 horas|24 hours/, "no WhatsApp window tip on Telegram");
});
