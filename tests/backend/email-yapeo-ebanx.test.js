// BCP "Recepción de Yapeo" (money in) and EBANX "Pago confirmado del pedido" -> pending entries (EmailParser.gs).
// Built from a friend's forwarded copies; the emails here are MADE UP and only follow the lines that were visible.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, BCP_SENDER } = require("./helpers");

const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const fromEmail = (rt) => rt.rows("Entries").filter((e) => e.source === "email");

const yapeo = (rt, { amount = "250.00", who = "Tienda Ejemplo S.a.c.", op } = {}) => rt.svc.gmail.addEmail({
  from: BCP_SENDER,
  subject: "Constancia de recepción de Yapeo a celular BCP - Servicio de Notificaciones BCP",
  body: ["Hola *Eva,*", "", "Recibiste un yapeo de *S/ " + amount + "* de " + who + ".", "",
    "Por tu seguridad te enviamos los datos de tu yapeo.", "", "*Monto*", "", "Monto recibido *S/ " + amount + "* ", "",
    op ? "Número de operación *" + op + "* " : ""].join("\n")
});

test("a Yapeo received is a pending INCOME with the sender's name, and is not saved twice", () => {
  const { rt } = freshApp({ small: true });
  yapeo(rt, { op: "YAPE-IN-1" });
  run(rt);
  const [e] = fromEmail(rt).filter((x) => x.external_id === "YAPE-IN-1");
  assert.ok(e, "an entry was created");
  assert.equal(e.type, "income");
  assert.equal(e.status, "pending");
  assert.equal(Number(e.amount), 250);
  assert.equal(e.currency, "PEN");
  assert.equal(e.description, "Yape de Tienda Ejemplo S.a.c.");
  const n = rt.rows("Entries").length;
  run(rt);
  assert.equal(rt.rows("Entries").length, n);
});

test("a Yapeo received without a readable operation number still lands once (generated id)", () => {
  const { rt } = freshApp({ small: true });
  yapeo(rt, { amount: "30.50", who: "Ana Lopez" });
  run(rt);
  run(rt);
  const rows = fromEmail(rt).filter((e) => e.description === "Yape de Ana Lopez");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 30.5);
});

const ebanx = (rt, body) => rt.svc.gmail.addEmail({
  from: "EBANX/Adobe - Braintree <payments@ebanx.com>",
  subject: "Pago confirmado del pedido BL0000000001 de Adobe - Braintree",
  body
});

test("an EBANX payment is a pending expense for the shop, with no account chosen", () => {
  const { rt } = freshApp({ small: true });
  ebanx(rt, ["Hola, Eva", "El pago de tu pedido en Adobe - Braintree ha sido confirmado.", "En el estado de cuenta, tu compra aparecerá como:", "EBN*ADOBE", "Total: US$ 54.99"].join("\n"));
  run(rt);
  const [e] = fromEmail(rt).filter((x) => x.external_id === "ebanx-BL0000000001");
  assert.ok(e, "an entry was created");
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 54.99);
  assert.equal(e.currency, "USD");
  assert.equal(e.description, "Adobe");
  assert.equal(e.payment_method_id, "");
});

test("an EBANX payment whose amount cannot be found makes no entry (it is listed as unread instead)", () => {
  const { rt } = freshApp({ small: true });
  ebanx(rt, "El pago de tu pedido en Adobe - Braintree ha sido confirmado.");
  run(rt);
  assert.equal(fromEmail(rt).filter((x) => /ebanx/.test(x.external_id || "")).length, 0);
});
