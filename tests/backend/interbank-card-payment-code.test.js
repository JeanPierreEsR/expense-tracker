// Interbank card payments ("pagaste la deuda de tu …") print "Tu código de operación es:\n<number>". The label reader took "es:" as the
// operation code, so every such e-mail had the same id and, after the first one ever, each new card payment was dropped as a repeat
// (found 2026-11-10 on the owner's mailbox). Made-up text and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const js = (v) => JSON.stringify(v);
const scan = (rt) => { rt.svc.props.delete("EMAIL_SCAN_LAST_AT"); return rt.api("checkEmailsNow"); };
const FROM = "notificaciones@interbank.pe";
const SUBJECT = "ANA, te informamos sobre el Pago de la deuda de tu Interbank Visa Infinite";
const body = (code, amount) => "ANA,\npagaste la deuda de tu Interbank Visa Infinite\n\nTu solicitud se realizó desde el canal App Interbank.\n\n" +
  "Tu código de operación es:\n" + code + "\nCuenta cargo: 0001112223\nTarjeta de crédito: ************5738\nMonto pagado: " + amount + "\n";

test("the word 'es' after a label is part of the label, not the value", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.run(`afterLabel_(${js(body("111222", "US$ 10.00"))}, 'código de operación')`), "111222");
  assert.equal(rt.run(`afterLabel_("código de operación 55502", 'código de operación')`), "55502", "the older wording still reads");
  assert.equal(rt.run(`afterLabel_("Comercio: Estación Sur", 'Comercio')`), "Estación Sur", "a value starting with 'Es…' is untouched");
});

test("two card payments in the new wording are two entries, not one and a 'repeat'", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: FROM, subject: SUBJECT, body: body("111222", "US$ 10.00"), daysAgo: 1 });
  rt.svc.gmail.addEmail({ from: FROM, subject: SUBJECT, body: body("333444", "S/ 250.00"), daysAgo: 1 });
  scan(rt);
  const got = rt.rows("Entries").filter((e) => e.source === "email" && e.description === "Pago tarjeta Interbank");
  assert.deepEqual(got.map((e) => e.external_id).sort(), ["111222", "333444"]);
  assert.deepEqual(got.map((e) => e.currency).sort(), ["PEN", "USD"]);
});
