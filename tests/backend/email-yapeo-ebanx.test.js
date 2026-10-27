// BCP "Recepción de Yapeo" (money in) and EBANX "Pago confirmado del pedido" -> pending entries (EmailParser.gs).
// Built from a friend's forwarded copies (full text seen 2026-10-26); the emails here are MADE UP but keep the real labels and layout.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, BCP_SENDER } = require("./helpers");

const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const fromEmail = (rt) => rt.rows("Entries").filter((e) => e.source === "email");

const yapeo = (rt, { amount = "250.00", who = "Tienda Ejemplo S.a.c." } = {}) => rt.svc.gmail.addEmail({
  from: BCP_SENDER,
  subject: "Constancia de recepción de Yapeo a celular BCP - Servicio de Notificaciones BCP",
  body: ["Hola Eva,", "", "Recibiste un yapeo de S/ " + amount + " de " + who.split(" ")[0], who.split(" ").slice(1).join(" ") + ".", "",
    "Por tu seguridad te enviamos los datos de tu yapeo.", "", "Monto", "", "Monto recibido                S/ " + amount, "",
    "Datos de la operación", "", "Operación realizada                Yapeo a celular", "",
    "Fecha y hora                26 de octubre de 2026 - 06:00 PM", "Enviado por                " + who, ""].join("\n")
});

test("a Yapeo received is a pending INCOME with the sender's name, and is not saved twice", () => {
  const { rt } = freshApp({ small: true });
  yapeo(rt);
  run(rt);
  const [e] = fromEmail(rt).filter((x) => x.description === "Yape de Tienda Ejemplo S.a.c.");
  assert.ok(e, "an entry was created");
  assert.equal(e.type, "income");
  assert.equal(e.status, "pending");
  assert.equal(Number(e.amount), 250);
  assert.equal(e.currency, "PEN");
  const n = rt.rows("Entries").length;
  run(rt);
  assert.equal(rt.rows("Entries").length, n);
});

test("two Yapeos of the same amount from the same person are two entries (the email has no operation number)", () => {
  const { rt } = freshApp({ small: true });
  yapeo(rt, { amount: "30.50", who: "Ana Lopez" });
  yapeo(rt, { amount: "30.50", who: "Ana Lopez" });
  run(rt);
  const rows = fromEmail(rt).filter((e) => e.description === "Yape de Ana Lopez");
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].amount), 30.5);
});

const ebanx = (rt, last4, final = "S/ 24.19") => rt.svc.gmail.addEmail({
  from: "EBANX/Adobe - Braintree <payments@ebanx.com>",
  subject: "Pago confirmado del pedido BL0000000001 de Adobe - Braintree",
  body: ["Hola, Eva", "", "El pago de tu pedido en Adobe - Braintree ha sido confirmado. =)", "",
    "En el estado de cuenta, tu compra aparecerá como:", "EBN*ADOBE", "",
    "Pago vía Tarjeta de Crédito.", "Código BL0000000001 del Pedido Adobe - Braintree", "24/10/2026 | 07:32", "",
    "PIN                                    abcd1234", "Últimos dígitos tarjeta de crédito          " + last4,
    "Valor original en PEN                    S/ 24.19", "", "Valor final en PEN                   " + final, ""].join("\n")
});

test("an EBANX payment is a pending expense for the shop, on the account whose last 4 digits it names", () => {
  const { rt } = freshApp({ small: true });
  const pms = rt.rows("Payment Methods").filter((p) => p.last_4);
  const pm = pms.find((p) => pms.filter((q) => String(q.last_4) === String(p.last_4)).length === 1);
  assert.ok(pm, "the test data has an account with its own last 4 digits");
  ebanx(rt, pm.last_4);
  run(rt);
  const [e] = fromEmail(rt).filter((x) => x.external_id === "ebanx-BL0000000001");
  assert.ok(e, "an entry was created");
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 24.19);
  assert.equal(e.currency, "PEN");
  assert.equal(e.description, "Adobe");
  assert.equal(e.payment_method_id, pm.id);
});

test("an EBANX payment with digits no account has leaves the account blank for review", () => {
  const { rt } = freshApp({ small: true });
  ebanx(rt, "0000");
  run(rt);
  const [e] = fromEmail(rt).filter((x) => x.external_id === "ebanx-BL0000000001");
  assert.ok(e);
  assert.equal(e.payment_method_id, "");
});

test("an EBANX email with no amount makes no entry (it is listed as unread instead)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: "EBANX <payments@ebanx.com>", subject: "Pago confirmado del pedido BL0000000002 de Adobe - Braintree",
    body: "El pago de tu pedido en Adobe - Braintree ha sido confirmado." });
  run(rt);
  assert.equal(fromEmail(rt).filter((x) => /ebanx/.test(x.external_id || "")).length, 0);
});
