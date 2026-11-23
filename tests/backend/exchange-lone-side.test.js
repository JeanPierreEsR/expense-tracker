// One side of a currency exchange holds ONE account (owner, 2026-11-23). A dollars side whose partner was not linked showed in Needs
// review with a From AND a To box; filling both saved one USD entry "from the soles account to the dollars account", read as dollars
// leaving the soles account. Now the server refuses that, and the bot's "from" / "to" on such a side only fill its own end.
// Made-up amounts, codes and accounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const confirmation = (rt, code) => rt.svc.gmail.addEmail({
  from: "Cambio Mundial <no-reply@gmai.com>", subject: "Confirmación de Operación - Cambio Mundial",
  body: ["*Enviaste:*SOLES*S/ 3,500.00*", "*Recibirás:*DÓLARES*$ 1,000.00*", "El código de tu operación es:", code].join("\n")
});
const legs = (rt) => rt.rows("Entries").filter((e) => e.type === "transfer" && /^Currency exchange/.test(e.description || ""));
const accounts = (data) => data.pms.filter((p) => p.type !== "investment" && p.type !== "credit");

// Two sides as an older run left them: not linked to each other.
function loneSides() {
  const { rt, data } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  confirmation(rt, "05551001");
  rt.run("processEmails()");
  legs(rt).forEach((e) => rt.run(`updateRowFields_('Entries', ${JSON.stringify(e.id)}, { exchange_pair: '' })`));
  return { rt, data, chat };
}

test("an edit that leaves an exchange side with two accounts is refused", () => {
  const { rt, data } = loneSides();
  const usd = legs(rt).find((e) => e.currency === "USD");
  const [x, y] = accounts(data);
  assert.throws(() => rt.api("updateEntry", { id: usd.id, fields: { payment_method_id: x.id, to_payment_method_id: y.id } }), /only one account/);
  rt.api("updateEntry", { id: usd.id, fields: { payment_method_id: "", to_payment_method_id: y.id } });
  assert.equal(legs(rt).find((e) => e.id === usd.id).to_payment_method_id, y.id, "its own account alone is saved");
  // "Not an exchange: my own transfer" clears the marker, so both accounts are fine then.
  rt.api("updateEntry", { id: usd.id, fields: { exchange: "", payment_method_id: x.id, to_payment_method_id: y.id } });
  assert.equal(rt.rows("Entries").find((e) => e.id === usd.id).payment_method_id, x.id);
});

test("on a lone dollars side the bot's 'from' is refused and 'to' fills only its end", () => {
  const { rt, data, chat } = loneSides();
  const usd = legs(rt).find((e) => e.currency === "USD");
  rt.run(`appendRowObject('Telegram Messages', { message_id: '701', entry_id: ${JSON.stringify(usd.id)}, created_at: 'x' });`);
  const [x, y] = accounts(data);
  rt.rawPost(JSON.stringify({ update_id: 9201, message: { chat: { id: chat }, message_id: 9301, text: `from ${x.nickname}, to ${y.nickname}`, reply_to_message: { message_id: 701 } } }));
  const after = rt.rows("Entries").find((e) => e.id === usd.id);
  assert.equal(after.to_payment_method_id, y.id);
  assert.ok(!after.payment_method_id, "the dollars side never gets the soles account");
});
