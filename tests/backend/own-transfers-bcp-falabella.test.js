// Three kinds of e-mail first seen on a friend's forwards (2026-11-23), read by rule-pack rules only (no code twin):
// BCP "Constancia de Pago de Tarjeta de Crédito Propia" (an account pays the person's own BCP card), BCP "Constancia de
// Transferencia Entre mis Cuentas" (between two of the person's BCP accounts) and Banco Falabella "has realizado una transferencia"
// (Transferencia a terceros, a transfer to a CCI; the person's own account at another bank when the payee is the person).
// Made-up text in each bank's layout; no real name, amount or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const BCP = "notificaciones@notificacionesbcp.com.pe";
const FAL = "notificaciones@pe.notificaciones.bancofalabella.com";
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const run = (rt) => plain(rt.run("processEmails()"));
const byOp = (rt, op) => rt.rows("Entries").filter((e) => e.source === "email" && String(e.external_id) === op);
const pid = (x) => x.id || (x.paymentMethod && x.paymentMethod.id);
const unread = (rt) => { try { return rt.rows("Unread Emails").filter((r) => r.sender === BCP || r.sender === FAL); } catch (e) { return []; } };

const payBody = (amt, from, to, op) => [
  "Hola Eva,", "", "Realizaste un pago a tu tarjeta de " + amt + " desde tu Cuenta digital.", "",
  "A continuación, te enviamos los datos de tu operación.", "", "Montos", "", "Monto pagado " + amt, "", "Datos de la operación", "",
  "Operación realizada Pago de tarjeta propia BCP", "Fecha y hora 01 de Febrero de 2026 - 07:46 AM", "Pagado a VISA Prueba", "**** " + to,
  "Tipo de pago Pago total", "Desde Cuenta digital", "**** " + from, "Moneda Soles", "Canal Banca Móvil BCP", "Número de operación " + op
].join("\n");
const ownBody = (amt, from, to, op) => [
  "Hola Eva,", "", "Realizaste una transferencia de " + amt + " desde tu Cuenta corriente.", "",
  "Por tu seguridad, te enviamos los datos de tu operación.", "", "Montos", "", "Monto transferido " + amt, "", "Datos de la operación", "",
  "Operación realizada Transferencia entre mis cuentas", "Fecha y hora 01 de Febrero de 2026 - 07:42 AM", "Desde Cuenta corriente", "**** " + from,
  "Enviado a Clasica", "**** " + to, "Canal Banca Móvil BCP", "Número de operación " + op
].join("\n");
const falBody = (name, cci, amt, op) => [
  "Transferencia a terceros", "", "Hola, EVA Ramos", "De acuerdo con tu instrucción la operación se realizo con éxito", "Detalles de la transferencia", "",
  "Origen EVA Ramos", "Destinatario " + name, "Asunto", "Cuenta destino " + cci, "Tipo de moneda Soles", "Monto de transferencia " + amt,
  "Comisión Gratis", "Tipo de transferencia Inmediata", "Fecha 01/02/2026", "Hora 07:45", "Nro. de transacción " + op
].join("\n");

function setup() {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8") });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const bcp = (rt.rows("Banks").find((b) => b.name === "BCP") || {}).id;
  const digital = pid(rt.api("addPaymentMethod", { nickname: "Prueba digital", type: "debit", bank_id: bcp, last_4: "1111" }));
  const current = pid(rt.api("addPaymentMethod", { nickname: "Prueba corriente", type: "debit", bank_id: bcp, last_4: "3333" }));
  const card = pid(rt.api("addPaymentMethod", { nickname: "Prueba Visa", type: "credit", bank_id: bcp, last_4: "2222" }));
  return { rt, digital, current, card };
}

test("a BCP payment to the person's own card: a waiting transfer from the account to the card", () => {
  const { rt, digital, card } = setup();
  rt.svc.gmail.addEmail({ from: BCP, subject: "Constancia de Pago de Tarjeta de Crédito Propia - Servicio de Notificaciones BCP", body: payBody("S/ 345.60", "1111", "2222", "00111222") });
  assert.equal(run(rt).created, 1);
  const e = byOp(rt, "00111222");
  assert.equal(e.length, 1);
  assert.equal(e[0].type, "transfer");
  assert.equal(e[0].status, "pending");
  assert.equal(Number(e[0].amount), 345.6);
  assert.equal(e[0].payment_method_id, digital);
  assert.equal(e[0].to_payment_method_id, card);
  assert.equal(unread(rt).length, 0);
});

test("a BCP transfer between the person's accounts: a waiting transfer from one to the other", () => {
  const { rt, digital, current } = setup();
  rt.svc.gmail.addEmail({ from: BCP, subject: "Constancia de Transferencia Entre mis Cuentas - Servicio de Notificaciones BCP", body: ownBody("S/ 1,200.00", "3333", "1111", "00555666") });
  assert.equal(run(rt).created, 1);
  const e = byOp(rt, "00555666");
  assert.equal(e[0].type, "transfer");
  assert.equal(Number(e[0].amount), 1200);
  assert.equal(e[0].payment_method_id, current);
  assert.equal(e[0].to_payment_method_id, digital);
});

test("a Banco Falabella transfer to the person's own account elsewhere is a transfer into it; to someone else, an expense to review", () => {
  const { rt, digital } = setup();
  // CCI: bank 3 + branch 3 + account 12 + check 2; the account's last four ("1111") are the four before the check digits.
  rt.svc.gmail.addEmail({ from: FAL, subject: "EVA has realizado una transferencia", body: falBody("EVA CARLA RAMOS TORRES", "00211100000000111199", "S/1,500.00", "000000003333") });
  rt.svc.gmail.addEmail({ from: FAL, subject: "EVA has realizado una transferencia", body: falBody("PERSONA PRUEBA", "00211100000000999999", "S/40.00", "000000004444") });
  assert.equal(run(rt).created, 2);
  const own = byOp(rt, "000000003333")[0];
  assert.equal(own.type, "transfer");
  assert.equal(Number(own.amount), 1500);
  assert.equal(own.to_payment_method_id, digital);
  const other = byOp(rt, "000000004444")[0];
  assert.equal(other.type, "expense");
  assert.equal(other.status, "pending");
  assert.ok(!other.to_payment_method_id);
});

test("each e-mail read twice still makes one entry, and Bank emails lists the new kinds", () => {
  const { rt } = setup();
  const b = payBody("S/ 10.00", "1111", "2222", "00999888");
  rt.svc.gmail.addEmail({ from: BCP, subject: "Constancia de Pago de Tarjeta de Crédito Propia - Servicio de Notificaciones BCP", body: b });
  run(rt);
  rt.svc.gmail.addEmail({ from: BCP, subject: "Constancia de Pago de Tarjeta de Crédito Propia - Servicio de Notificaciones BCP", body: b });
  run(rt);
  assert.equal(byOp(rt, "00999888").length, 1);
  const cov = plain(rt.run("bankCoverage_()"));
  const keys = (bank) => cov[bank].kinds.map((k) => k.key);
  assert.deepEqual(keys("Banco Falabella"), ["purchase", "transfer_out", "card_payment"]);
  assert.ok(keys("BCP").includes("card_payment"));
});
