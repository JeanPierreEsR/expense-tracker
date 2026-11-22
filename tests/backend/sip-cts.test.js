// Sip CTS e-mails (2026-11-20) and statement e-mails in "Bank emails I couldn't read".
// - "Constancia de Solicitud de Retiro CTS": a transfer from the CTS account to the person's own account; the amount has no currency sign.
// - "Abono semestral CTS": no amount in the e-mail, ignored on purpose (not listed as unreadable).
// - "estado de cuenta" e-mails from a bank the Statements inbox watches are not listed as unreadable (the inbox takes the PDF).
// Made-up text in the bank's layout; no real amount, name or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const SIP = "no-reply@servicioalcliente.sip.pe";
const BCP = "notificaciones@notificacionesbcp.com.pe";
const RETIRO = "Envío Automático - Constancia de Solicitud de Retiro CTS";
const retiroBody = (amount, from, to, request, extra) => [
  "Hola, ANA.", "", "Tu solicitud de retiro de CTS", "está siendo procesada.", "",
  "Número de solicitud:\t" + request, "Fecha de solicitud:\t01/02/2026", "Modalidad de retiro:\tTRANSFERENCIA",
  "Entidad financiera:\tBANCO PRUEBA", "Cuenta de cargo:\t" + from, "Cuenta de destino:\t" + to, "Monto de retiro:\t" + amount, "",
  "Su abono se está procesando y puede tardar", "hasta 2 días útiles en verlo reflejado en su cuenta.", extra || ""
].join("\n");
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const unread = (rt) => { try { return rt.rows("Unread Emails"); } catch (e) { return []; } };
const sipBankId = (rt) => (rt.rows("Banks").find((b) => b.name === "SIP") || {}).id;

function setup() {
  const { rt, data } = freshApp({ entries: 200 });
  const cts = rt.api("addPaymentMethod", { nickname: "CTS prueba", type: "debit", bank_id: sipBankId(rt), last_4: "1111" });
  const dest = rt.api("addPaymentMethod", { nickname: "Destino prueba", type: "debit", last_4: "2222" });
  return { rt, data, cts, dest };
}
const id = (x) => x.id || (x.paymentMethod && x.paymentMethod.id) || (x.item && x.item.id);

test("a CTS withdrawal becomes a waiting transfer from the CTS account to the destination, in soles", () => {
  const { rt, cts, dest } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: RETIRO, body: retiroBody("1234.56", "110000001111", "8980000002222", "5550001") });
  const res = run(rt);
  assert.equal(res.created, 1);
  const e = rt.rows("Entries").find((x) => x.source === "email" && Number(x.amount) === 1234.56);
  assert.ok(e, "entry created");
  assert.equal(e.type, "transfer");
  assert.equal(e.status, "pending");
  assert.equal(e.currency, "PEN");
  assert.equal(e.description, "Retiro CTS");
  assert.equal(e.payment_method_id, id(cts));
  assert.equal(e.to_payment_method_id, id(dest));
  assert.equal(String(e.external_id), "cts-5550001");
  assert.equal(unread(rt).filter((r) => r.sender === SIP).length, 0);
});

test("an e-mail that says dollars is read in dollars; a thousands comma is understood", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: RETIRO, body: retiroBody("2,345.60", "110000001111", "8980000002222", "5550002", "Moneda: Dólares") });
  run(rt);
  const e = rt.rows("Entries").find((x) => x.source === "email" && Number(x.amount) === 2345.6);
  assert.ok(e);
  assert.equal(e.currency, "USD");
});

test("a destination that is not one of the person's accounts stays a transfer with To blank (never an expense)", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: RETIRO, body: retiroBody("301.37", "110000001111", "8980000009999", "5550003") });
  run(rt);
  const e = rt.rows("Entries").find((x) => x.source === "email" && Number(x.amount) === 301.37 && x.description === "Retiro CTS");
  assert.ok(e);
  assert.equal(e.type, "transfer");
  assert.ok(!e.to_payment_method_id);
});

test("the same withdrawal e-mail read twice makes one entry (request number)", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: RETIRO, body: retiroBody("77.70", "110000001111", "8980000002222", "5550004") });
  run(rt);
  rt.run("deleteRowsWhere_('Processed Emails', function () { return true; })");
  run(rt);
  assert.equal(rt.rows("Entries").filter((x) => x.source === "email" && Number(x.amount) === 77.7).length, 1);
});

test("the CTS deposit notice (no amount) makes no entry and is not listed as unreadable", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: "Abono semestral CTS",
    body: "Hola, ANA.\nTe comunicamos que tu empleador ya\nrealizó el abono semestral a tu cuenta CTS:\n110000001111\nConsulta de saldos." });
  const res = run(rt);
  assert.equal(res.created || 0, 0);
  assert.equal(unread(rt).filter((r) => r.sender === SIP).length, 0);
});

test("statement e-mails of watched banks are not listed as unreadable; another unknown SIP e-mail still is", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: "ANA, llegó el estado de cuenta de tu Tarjeta de Crédito Sip", body: "Adjuntamos tu estado de cuenta." });
  rt.svc.gmail.addEmail({ from: SIP, subject: "Envío de Estado de Cuenta", body: "Adjuntamos tu estado de cuenta." });
  rt.svc.gmail.addEmail({ from: BCP, subject: "Constancia de envío de Estado de Cuenta - Servicio de Notificaciones BCP", body: "Adjuntamos tu estado de cuenta." });
  rt.svc.gmail.addEmail({ from: SIP, subject: "Algo nuevo de Sip", body: "Monto S/ 10.00" });
  run(rt);
  const rows = unread(rt);
  assert.equal(rows.filter((r) => /estado de cuenta/i.test(r.subject)).length, 0);
  assert.equal(rows.filter((r) => r.sender === SIP && /algo nuevo/i.test(r.subject)).length, 1, "a real gap is still listed");
  // Rows logged before this change disappear from the list too (it filters on read).
  assert.equal(JSON.parse(JSON.stringify(rt.run(`unreadIsNotPayment_('${BCP}', 'constancia de envío de estado de cuenta - servicio de notifi')`))), true);
  assert.equal(JSON.parse(JSON.stringify(rt.run(`unreadIsNotPayment_('someone@example.com', 'estado de cuenta')`))), false, "only banks the inbox watches");
});
