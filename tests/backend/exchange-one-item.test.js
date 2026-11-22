// A waiting currency exchange is ONE item (owner, 2026-11-20): the exchange house's e-mail pairs its two sides (exchange_pair) and sends
// ONE bot message that shows both; Confirm / Discard on it act on both sides; "from" sets where the money left and "to" where it arrived,
// whichever side the message stands for. Also: "type investments" (a plural) is understood. Made-up amounts, codes and accounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const HOUSE = "no-reply@gmai.com";
const confirmation = (rt, code) => rt.svc.gmail.addEmail({
  from: "Cambio Mundial <" + HOUSE + ">", subject: "Confirmación de Operación - Cambio Mundial",
  body: ["*Gracias por realizar tus operaciones con Cambio Mundial*", "*Enviaste:*SOLES*S/ 3,500.00*", "*Recibirás:*DÓLARES*$ 1,000.00*",
    "El código de tu operación es:", code].join("\n")
});
const legs = (rt) => rt.rows("Entries").filter((e) => e.type === "transfer" && /^Currency exchange/.test(e.description || ""));
const sentTexts = (rt) => rt.svc.fetchLog.filter((f) => /sendMessage/.test(f.url)).map((f) => JSON.parse(f.options.payload));

function setup() {
  const { rt, data } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  return { rt, data, chat };
}
const cardFor = (rt) => {
  const msgs = rt.rows("Telegram Messages");
  const ids = new Set(legs(rt).map((e) => e.id));
  return msgs.filter((m) => ids.has(m.entry_id));
};

test("the house e-mail pairs both sides and sends ONE message that shows both", () => {
  const { rt } = setup();
  confirmation(rt, "05550001");
  rt.run("processEmails()");
  const [a, b] = legs(rt);
  assert.ok(a && b);
  assert.ok(a.exchange_pair && a.exchange_pair === b.exchange_pair, "one pair id");
  const cards = cardFor(rt);
  assert.equal(cards.length, 1, "one message for the exchange");
  const text = sentTexts(rt).map((p) => p.text).find((t) => /PEN 3,500\.00 → USD 1,000\.00/.test(t || ""));
  assert.ok(text, "the message shows both sides");
  assert.match(text, /Left from/);
  assert.match(text, /Arrived in/);
});

test("Confirm on that message confirms both sides; 'from' / 'to' reach the right side", () => {
  const { rt, data, chat } = setup();
  confirmation(rt, "05550002");
  rt.run("processEmails()");
  const card = cardFor(rt)[0];
  const [x, y] = data.pms.filter((p) => p.type !== "investment" && p.type !== "credit");
  rt.rawPost(JSON.stringify({ update_id: 9001, message: { chat: { id: chat }, message_id: 9101, text: `from ${x.nickname}, to ${y.nickname}`, reply_to_message: { message_id: Number(card.message_id) } } }));
  const out = legs(rt).find((e) => e.currency === "PEN"), inn = legs(rt).find((e) => e.currency === "USD");
  assert.equal(out.payment_method_id, x.id);
  assert.ok(!out.to_payment_method_id, "the soles side keeps no destination");
  assert.equal(inn.to_payment_method_id, y.id);
  assert.ok(!inn.payment_method_id, "the dollars side keeps no source");
  assert.deepEqual(legs(rt).map((e) => e.status), ["confirmed", "confirmed"], "a reply that completes it confirms both sides");
  const last = sentTexts(rt).map((p) => p.text).filter(Boolean).pop();
  assert.match(last, /PEN 3,500\.00 → USD 1,000\.00/, "the refreshed message still shows the whole exchange");
});

test("the Confirm button confirms both sides", () => {
  const { rt, chat } = setup();
  confirmation(rt, "05550004");
  rt.run("processEmails()");
  const card = cardFor(rt)[0];
  rt.rawPost(JSON.stringify({ update_id: 9006, callback_query: { id: "cb3", data: "confirm:" + card.entry_id, message: { chat: { id: chat }, message_id: Number(card.message_id) } } }));
  assert.deepEqual(legs(rt).map((e) => e.status), ["confirmed", "confirmed"]);
});

test("Discard on that message discards both sides", () => {
  const { rt, chat } = setup();
  confirmation(rt, "05550003");
  rt.run("processEmails()");
  const card = cardFor(rt)[0];
  rt.rawPost(JSON.stringify({ update_id: 9003, callback_query: { id: "cb2", data: "discard:" + card.entry_id, message: { chat: { id: chat }, message_id: Number(card.message_id) } } }));
  assert.equal(legs(rt).filter((e) => e.status === "pending").length, 0);
});

test("'type investments' (plural) and 'platform …' in one reply turn an expense into an investment", () => {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense");
  const made = rt.api("addPaymentMethod", { nickname: "Fondo Prueba", type: "investment" });
  const platform = { id: made.id || (made.paymentMethod && made.paymentMethod.id), nickname: "Fondo Prueba" };
  rt.run(`appendRowObject('Telegram Messages', { message_id: '700', entry_id: ${JSON.stringify(pending.id)}, created_at: 'x' });`);
  rt.rawPost(JSON.stringify({ update_id: 9004, message: { chat: { id: chat }, message_id: 9104, text: `type investments, platform ${platform.nickname}`, reply_to_message: { message_id: 700 } } }));
  const e = rt.rows("Entries").find((x) => x.id === pending.id);
  assert.equal(e.type, "investment");
  assert.equal(e.to_payment_method_id, platform.id);
  rt.rawPost(JSON.stringify({ update_id: 9005, message: { chat: { id: chat }, message_id: 9105, text: "tipo gastos", reply_to_message: { message_id: 700 } } }));
  assert.equal(rt.rows("Entries").find((x) => x.id === pending.id).type, "expense");
});
