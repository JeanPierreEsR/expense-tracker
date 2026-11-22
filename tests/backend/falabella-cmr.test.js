// Banco Falabella CMR card purchases ("Notificación de Operaciones CMR", 2026-11-22), read by a rule-pack rule (falabella-cmr-consumo,
// no code twin). Found on a friend's forwarded copy: no rule read Banco Falabella's e-mails at all. Made-up text in the bank's layout;
// no real amount, name or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const SENDER = "notificaciones@pe.notificaciones.bancofalabella.com";
const SUBJECT = "Notificación de Operaciones CMR";
const body = (shop, amt, card, op) => [
  "Hola Ana", "",
  "Te informamos que se ha realizado un consumo con tu Tarjeta CMR, te adjuntamos el detalle:", "",
  "Realizado por: Ana Lopez Ruiz",
  "Tarjeta: 400000******" + card,
  "Fecha: 01-febrero-2026",
  "Hora: 09:15",
  "Comercio: " + shop,
  "Monto: " + amt,
  "Número de operación: " + op, "",
  "Información Importante:",
  "Si compraste en comercios electrónicos, el monto de tu compra podría variar de acuerdo a la disponibilidad de los productos.", "",
  "¡Gracias!"
].join("\n");
const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8");
  rt.api("setRulePack", { text });
  return { rt, data };
}
const unreadRows = (rt) => { try { return rt.rows("Unread Emails").filter((r) => r.sender === SENDER); } catch (e) { return []; } };
const emailEntries = (rt, amount) => rt.rows("Entries").filter((e) => e.source === "email" && Number(e.amount) === amount);

test("a CMR card purchase becomes a waiting expense with amount, merchant and operation number", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("Tienda Prueba Pe", "S/ 12.34", "1234", "000000001111") });
  const res = run(rt);
  assert.equal(res.created, 1);
  const rows = emailEntries(rt, 12.34);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "expense");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].currency, "PEN");
  assert.equal(rows[0].description, "Tienda Prueba Pe");
  assert.equal(String(rows[0].external_id), "000000001111");
  assert.equal(unreadRows(rt).length, 0, "nothing logged as unreadable");
});

test("the card's digits pick the person's CMR card", () => {
  const { rt } = setup();
  const bank = post(rt, "addBank", { name: "Banco Falabella" }).data;
  const card = post(rt, "savePaymentMethod", { nickname: "Test CMR", type: "credit", bank_id: bank.id, last_4: "4321" }).data;
  assert.ok(card && card.id, "the made-up card was saved");
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("Shop Example", "S/ 7.77", "4321", "000000007777") });
  run(rt);
  assert.equal(emailEntries(rt, 7.77)[0].payment_method_id, card.id);
});

test("the same e-mail read twice makes one entry (operation number)", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("Tienda Prueba Pe", "S/ 3.21", "1234", "000000003210") });
  run(rt);
  rt.run("deleteRowsWhere_('Processed Emails', function () { return true; })");
  run(rt);
  assert.equal(emailEntries(rt, 3.21).length, 1);
});
