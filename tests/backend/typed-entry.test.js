// Typed transactions (TypedEntry.gs): ONE building block for WhatsApp and Telegram (owner, 2026-11-16). The same message typed
// on either bot must save the same transaction, with the same confirm rule. Made-up values.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";

function telegramApp() {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let n = 0;
  const say = (text, extra) => rt.rawPost(JSON.stringify({ update_id: 7000 + (++n), message: Object.assign({ chat: { id: chat }, message_id: 800 + n, date: Math.floor(Date.now() / 1000), text }, extra || {}) }));
  const sentTexts = () => rt.svc.fetchLog.filter((f) => /sendMessage/.test(f.url)).map((f) => JSON.parse(f.options.payload).text);
  return { rt, say, sentTexts, newest: () => rt.rows("Entries").filter((e) => e.source === "telegram").pop() };
}

function whatsappApp() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  let out = 0, n = 0;
  rt.state.fetchHandler = (url) => (String(url).endsWith("/send") ? { messages: [{ id: "wamid.o" + (++out) }] } : { ok: true });
  const say = (text) => rt.rawPost(JSON.stringify({ whatsapp: { id: "wamid.i" + (++n), from: "51900000000", type: "text", text }, relay_secret: SECRET }));
  return { rt, say, newest: () => rt.rows("Entries").filter((e) => e.source === "whatsapp").pop() };
}

const shape = (rt, e) => ({
  type: e.type, amount: Number(e.amount), currency: e.currency, description: e.description, date: e.date, status: e.status,
  category: (rt.rows("Categories").find((c) => c.id === e.category_id) || {}).name || "",
  account: (rt.rows("Payment Methods").find((p) => p.id === e.payment_method_id) || {}).nickname || "",
  to: (rt.rows("Payment Methods").find((p) => p.id === e.to_payment_method_id) || {}).nickname || ""
});

test("the same typed messages save the same transactions on Telegram and on WhatsApp", () => {
  const tg = telegramApp(), wa = whatsappApp();
  const accounts = tg.rt.rows("Payment Methods").filter((p) => p.type !== "investment" && String(p.hidden || "") !== "yes");
  const [a1, a2] = accounts;
  const messages = [
    "25 almuerzo",
    "S/ 12.50 taxi",
    "USD 10 Netflix",
    "ingreso 1500 sueldo",
    `25 almuerzo, account ${a1.nickname}`,
    `30 cena, account ${a1.nickname}, category restaurants, date 2026-11-14`,
    `31 cena, cuenta ${a1.nickname}, categoría restaurantes`,
    "25 almuerzo, account Nowhere Bank, category restaurants",
    "25 almuerzo, postre y café",
    `100 pase a ahorros, type transfer, from ${a1.nickname}, to ${a2.nickname}`
  ];
  for (const m of messages) {
    tg.say(m);
    wa.say(m);
    assert.deepEqual(shape(tg.rt, tg.newest()), shape(wa.rt, wa.newest()), m);
  }
  assert.equal(shape(tg.rt, tg.newest()).type, "transfer");
});

test("Telegram: a typed transaction gets its card; confirmed when the keywords complete it", () => {
  const tg = telegramApp();
  const acc = tg.rt.rows("Payment Methods").find((p) => p.type !== "investment");
  tg.say(`30 cena, account ${acc.nickname}, category restaurants`);
  const e = tg.newest();
  assert.equal(e.status, "confirmed");
  assert.ok(tg.rt.rows("Telegram Messages").some((m) => m.entry_id === e.id), "its card was sent and linked");
  tg.say("25 almuerzo");
  assert.equal(tg.newest().status, "pending");
});

test("Telegram keeps its other rules: plain words edit the last waiting card; a reply edits that card", () => {
  const tg = telegramApp();
  tg.say("25 almuerzo");
  const e = tg.newest();
  tg.say("Almuerzo con equipo");   // not an amount first: the last card's description, as before
  assert.equal(tg.rt.rows("Entries").find((x) => x.id === e.id).description, "Almuerzo con equipo");
  const card = tg.rt.rows("Telegram Messages").filter((m) => m.entry_id === e.id).pop().message_id;
  tg.say("amount 40", { reply_to_message: { message_id: Number(card) || card } });
  assert.equal(Number(tg.rt.rows("Entries").find((x) => x.id === e.id).amount), 40);
  assert.equal(tg.rt.rows("Entries").filter((x) => x.source === "telegram").length, 1, "no new transaction from those");
});

test("Telegram: the same message delivered twice is saved once", () => {
  const tg = telegramApp();
  const body = JSON.stringify({ update_id: 9999, message: { chat: { id: 555 }, message_id: 42, date: Math.floor(Date.now() / 1000), text: "9 coffee" } });
  tg.rt.rawPost(body);
  tg.rt.rawPost(body);
  assert.equal(tg.rt.rows("Entries").filter((x) => x.source === "telegram").length, 1);
});
