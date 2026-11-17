// A new purchase in one WhatsApp message (owner, 2026-11-16): amount and description without commas, every other field after
// a comma with Telegram's own keyword, applied by the same engine as a reply (so Telegram's confirm rules apply). Made-up values.
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
  const text = (t) => {
    rt.ctx.__body = JSON.stringify({ whatsapp: { id: "wamid.in" + (++inId), from: OWNER, type: "text", text: t }, relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  };
  const pm = rt.rows("Payment Methods").find((p) => p.type !== "investment" && String(p.hidden || "") !== "yes");
  const pm2 = rt.rows("Payment Methods").find((p) => p.type !== "investment" && String(p.hidden || "") !== "yes" && p.id !== pm.id);
  const cat = (name) => rt.rows("Categories").find((c) => c.type === "expense" && c.name === name);
  const newest = () => rt.rows("Entries").filter((e) => e.source === "whatsapp").pop();
  const bodies = () => sent.map((m) => (m.text && m.text.body) || m.interactive.body.text);
  return { rt, sent, text, pm, pm2, cat, newest, bodies };
}

test("'25 almuerzo, account X': the account is set; with no category it waits, and the bot says why", () => {
  const a = waApp();
  a.text(`25 almuerzo, account ${a.pm.nickname}`);
  const e = a.newest();
  assert.equal(e.description, "Almuerzo");
  assert.equal(Number(e.amount), 25);
  assert.equal(e.payment_method_id, a.pm.id);
  assert.equal(e.status, "pending");
  assert.ok(a.bodies().some((b) => /Not confirmed yet/.test(b)), "says it is not confirmed and why");
  const card = a.sent.find((m) => m.interactive && m.interactive.action.buttons);
  assert.ok(card, "its message has the buttons");
});

test("complete in one line: confirmed straight away, like a reply in words", () => {
  const a = waApp();
  a.text(`25 almuerzo, account ${a.pm.nickname}, category restaurants, date 2026-11-14`);
  const e = a.newest();
  assert.equal(e.category_id, a.cat("Restaurants").id);
  assert.equal(e.payment_method_id, a.pm.id);
  assert.equal(e.date, "2026-11-14");
  assert.equal(e.status, "confirmed");
});

test("the same in Spanish", () => {
  const a = waApp();
  a.text(`30 cena, cuenta ${a.pm.nickname}, categoría restaurantes, fecha 2026-11-14`);
  const e = a.newest();
  assert.equal(e.description, "Cena");
  assert.equal(e.category_id, a.cat("Restaurants").id);
  assert.equal(e.status, "confirmed");
});

test("a keyword that cannot be applied: the rest is kept, it waits, and the bot names the part", () => {
  const a = waApp();
  a.text("25 almuerzo, account Nowhere Bank, category restaurants");
  const e = a.newest();
  assert.equal(e.category_id, a.cat("Restaurants").id);
  assert.equal(e.payment_method_id, "");
  assert.equal(e.status, "pending");
  assert.ok(a.bodies().some((b) => /account Nowhere Bank/.test(b)));
});

test("a comma not followed by a keyword stays in the description", () => {
  const a = waApp();
  a.text("25 almuerzo, postre y café");
  const e = a.newest();
  assert.equal(e.description, "Almuerzo, postre y café");
  assert.equal(a.rt.rows("Entries").filter((x) => x.source === "whatsapp").length, 1);
});

test("a transfer in one line: type transfer, from, to", () => {
  const a = waApp();
  a.text(`100 pase a ahorros, type transfer, from ${a.pm.nickname}, to ${a.pm2.nickname}`);
  const e = a.newest();
  assert.equal(e.type, "transfer");
  assert.equal(e.payment_method_id, a.pm.id);
  assert.equal(e.to_payment_method_id, a.pm2.id);
});

test("income in one line", () => {
  const a = waApp();
  a.text(`ingreso 1500 sueldo, account ${a.pm.nickname}`);
  const e = a.newest();
  assert.equal(e.type, "income");
  assert.equal(e.payment_method_id, a.pm.id);
});
