// Which account paid a Diners card bill (DinersPaidFrom.gs, 2026-11-26), and amounts printed with one decimal (EmailParser.gs).
// E-mails are made up; the shapes are the real ones.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const DINERS = "dinersenlinea@dinersclub.com.pe";
const INTERBANK = "servicioalcliente@netinterbank.com.pe";
const js = JSON.stringify;
const pmByNick = (rt, nick) => rt.rows("Payment Methods").find((p) => p.nickname === nick);
const scan = (rt) => { rt.svc.props.delete("EMAIL_SCAN_LAST_AT"); return rt.api("checkEmailsNow"); };
const entryWith = (rt, op) => rt.rows("Entries").find((e) => e.source === "email" && e.external_id === op);
const NOW = Date.now() - 3600000;

function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`updateRowFields_('Payment Methods', ${js(pmByNick(rt, "Shop card").id)}, { last_4: '3458' })`);
  rt.run(`updateRowFields_('Payment Methods', ${js(pmByNick(rt, "Daily debit").id)}, { last_4: '1111' })`);
  rt.run(`updateRowFields_('Payment Methods', ${js(pmByNick(rt, "Backup debit").id)}, { last_4: '2222' })`);
  return rt;
}
const dinersMail = (rt, { amount, op, at }) => rt.svc.gmail.addEmail({ from: DINERS, sentAt: at,
  subject: "Notificación Diners en Línea – COMPROBANTE DE PAGO PROCESADO",
  body: ["CONSTANCIA DE OPERACIÓN", "Estimado(a)", "ANA PRUEBA", "Datos de la operación", "N° Operación: " + op, "Usuario de tarjeta: ANA PRUEBA",
    "Fecha y hora: 26/11/2026 12:25", "Monto: " + amount, "Tarjeta: **** ****** 3458", "Usted podrá visualizar el pago realizado"].join("\n") });
const interbankMail = (rt, { amount, last4 = "1111", at }) => rt.svc.gmail.addEmail({ from: INTERBANK, sentAt: at,
  subject: "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Débito Clásica",
  body: ["Ana, realizaste un consumo con tu Tarjeta Interbank Visa Débito Clásica", "Conoce el detalle:", "Tarjeta: ****" + last4,
    "Comercio: Diners Club", "Monto: " + amount, "Fecha: 26/11/2026", "Hora: 12:25 PM"].join("\n") });

test("an amount with one decimal keeps it: '$ 85.5' is 85.50, not 85", () => {
  const rt = setup();
  assert.deepEqual(JSON.parse(js(rt.run(`extractAmount_('Monto: $ 85.5')`))), { amount: 85.5, currency: "USD" });
  assert.deepEqual(JSON.parse(js(rt.run(`extractAmount_('Monto: S/. 640.25')`))), { amount: 640.25, currency: "PEN" });
  assert.deepEqual(JSON.parse(js(rt.run(`extractAmount_('Monto: S/ 1,234')`))), { amount: 1234, currency: "PEN" });
  dinersMail(rt, { amount: "$ 85.5", op: "DP-1", at: NOW });
  scan(rt);
  assert.equal(Number(entryWith(rt, "DP-1").amount), 85.5);
});

test("Diners first: the Interbank e-mail for the same payment fills From, and still makes no entry of its own", () => {
  const rt = setup();
  dinersMail(rt, { amount: "$ 85.5", op: "DP-2", at: NOW });
  scan(rt);
  assert.equal(entryWith(rt, "DP-2").payment_method_id, "", "the Diners e-mail alone does not know");
  const n = rt.rows("Entries").length;
  interbankMail(rt, { amount: "$ 85.50", at: NOW + 60000 });
  scan(rt);
  const e = entryWith(rt, "DP-2");
  assert.equal(e.payment_method_id, pmByNick(rt, "Daily debit").id, "the Interbank card ending 1111");
  assert.equal(e.to_payment_method_id, pmByNick(rt, "Shop card").id);
  assert.equal(e.type, "transfer");
  assert.equal(rt.rows("Entries").length, n, "no purchase at Diners Club");
});

test("Interbank first: the Diners payment takes the account when it arrives; each payment gets its own account", () => {
  const rt = setup();
  interbankMail(rt, { amount: "S/. 640.25", last4: "2222", at: NOW });
  interbankMail(rt, { amount: "$ 85.50", last4: "1111", at: NOW + 1000 });
  scan(rt);
  dinersMail(rt, { amount: "S/ 640.25", op: "DP-3", at: NOW + 30000 });
  dinersMail(rt, { amount: "$ 85.5", op: "DP-4", at: NOW + 40000 });
  scan(rt);
  assert.equal(entryWith(rt, "DP-3").payment_method_id, pmByNick(rt, "Backup debit").id);
  assert.equal(entryWith(rt, "DP-4").payment_method_id, pmByNick(rt, "Daily debit").id);
  assert.equal(rt.run(`dinersPaidFromLoad_().length`), 0, "nothing left waiting");
});

test("no join: a different amount, more than 12 hours apart, or a From the person already picked", () => {
  const rt = setup();
  dinersMail(rt, { amount: "S/ 100.00", op: "DP-5", at: NOW - 20 * 3600000 });
  dinersMail(rt, { amount: "S/ 200.00", op: "DP-6", at: NOW });
  dinersMail(rt, { amount: "S/ 300.00", op: "DP-7", at: NOW });
  scan(rt);
  const picked = pmByNick(rt, "Main debit").id;
  rt.run(`updateRowFields_('Entries', ${js(entryWith(rt, "DP-7").id)}, { payment_method_id: ${js(picked)} })`);
  interbankMail(rt, { amount: "S/. 100.00", at: NOW });
  interbankMail(rt, { amount: "S/. 201.00", at: NOW });
  interbankMail(rt, { amount: "S/. 300.00", at: NOW });
  scan(rt);
  assert.equal(entryWith(rt, "DP-5").payment_method_id, "", "20 hours apart");
  assert.equal(entryWith(rt, "DP-6").payment_method_id, "", "another amount");
  assert.equal(entryWith(rt, "DP-7").payment_method_id, picked, "never replaced");
});
