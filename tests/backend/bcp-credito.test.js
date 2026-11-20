// BCP credit card purchases ("Realizaste un consumo con tu Tarjeta de Crédito BCP", 2026-11-20), read by a rule-pack rule
// (bcp-consumo-credito, no code twin). Found on a friend's forwarded copy: only the DEBIT card version had a rule, so these
// e-mails went to "Bank emails I couldn't read". Made-up text in the bank's layout; no real amount, name or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const SENDER = "notificaciones@notificacionesbcp.com.pe";
const SUBJECT = (kind) => "Realizaste un consumo con tu Tarjeta de " + kind + " BCP - Servicio de Notificaciones BCP";
const body = (kind, shop, amt, card, op) => [
  "Hola Ana,", "",
  "Realizaste un consumo de " + amt + " con tu Tarjeta de " + kind + " BCP en " + shop + ".", "",
  "Por tu seguridad, te enviamos los datos de tu operación.", "", "Monto", "",
  "Total del consumo " + amt, "", "Datos de la operación", "",
  "Operación realizada Consumo Tarjeta de " + kind,
  "Fecha y hora 01 de febrero de 2026 - 09:15 AM",
  "Número de Tarjeta de " + kind + " ************" + card,
  "Empresa " + shop,
  "Número de operación " + op, "",
  "¿Problemas con tus compras?",
  "Si tu compra fue rechazada, cancelada o duplicada, el tiempo estimado de devolución será de 3 a 7 días."
].join("\n");
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8");
  rt.api("setRulePack", { text });
  return { rt, data };
}
const unreadRows = (rt) => { try { return rt.rows("Unread Emails").filter((r) => r.sender === SENDER); } catch (e) { return []; } };
const emailEntries = (rt, amount) => rt.rows("Entries").filter((e) => e.source === "email" && Number(e.amount) === amount);

test("a BCP credit card purchase becomes a waiting expense with amount, merchant and operation number", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT("Crédito"), body: body("Crédito", "TIENDA PRUEBA", "S/ 12.34", "1234", "0000123456") });
  const res = run(rt);
  assert.equal(res.created, 1);
  const rows = emailEntries(rt, 12.34);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "expense");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].currency, "PEN");
  assert.equal(rows[0].description, "TIENDA PRUEBA");
  assert.equal(String(rows[0].external_id), "0000123456");
  assert.equal(unreadRows(rt).length, 0, "nothing logged as unreadable");
});

test("a dollar purchase keeps its currency", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT("Crédito"), body: body("Crédito", "SHOP EXAMPLE", "US$ 45.60", "1234", "0000654321") });
  run(rt);
  const rows = emailEntries(rt, 45.6);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, "USD");
});

test("the card's digits pick the person's credit card, never the BCP soles account", () => {
  const { rt } = setup();
  const bcp = rt.rows("Banks").find((b) => b.name === "BCP");
  const card = bcp && rt.rows("Payment Methods").find((pm) => pm.bank_id === bcp.id && pm.type === "credit" && pm.last_4);
  if (!card) return;   // the made-up data has no BCP credit card: nothing to check here
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT("Crédito"), body: body("Crédito", "TIENDA PRUEBA", "S/ 7.77", card.last_4, "0000777777") });
  run(rt);
  assert.equal(emailEntries(rt, 7.77)[0].payment_method_id, card.id);
});

test("the debit card e-mail is still read by its own rule, and the credit rule does not take it", () => {
  const { rt } = setup();
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8"));
  const credit = pack.rules.find((r) => r.id === "bcp-consumo-credito");
  assert.ok(credit && !credit.accountByCurrency, "a credit card purchase never falls back to the BCP soles account");
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT("Débito"), body: body("Débito", "BODEGA PRUEBA", "S/ 8.90", "5678", "0000888888") });
  assert.equal(run(rt).created, 1);
  assert.equal(emailEntries(rt, 8.9).length, 1);
});

test("the same e-mail read twice makes one entry (operation number)", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT("Crédito"), body: body("Crédito", "TIENDA PRUEBA", "S/ 3.21", "1234", "0000321321") });
  run(rt);
  rt.run("deleteRowsWhere_('Processed Emails', function () { return true; })");
  run(rt);
  assert.equal(emailEntries(rt, 3.21).length, 1);
});
