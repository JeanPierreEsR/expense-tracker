// SIP "Transferencia a otro banco" (2026-11-20): SIP names the account the money left only by its product name ("Origen: Cuenta
// <name> Soles", no digits) and the person's own account at the other bank by its CCI (20 digits; the account's last four are the
// four before the two check digits). From = the person's account with that name, To = the account with those digits.
// The pack twin reads it exactly like the code rule. Made-up names, numbers and amounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const SIP = "no-reply@operaciones.agora.pe";
const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const body = ({ amount = "S/ 1234.00", origin = "Cuenta Prueba Plus Soles", to = "Eva Carla Ramos Torres", cci = "002-111-123456784321-99", op = "900001" } = {}) => [
  "Hola Eva", "Por tu seguridad, te enviamos", "los datos de tu operación.", "",
  "Operación realizada: Transferencia a otro banco", "", "Monto", amount, "Origen", origin, "Destino", to, "banco Prueba Del Perú", cci,
  "Fecha y Hora", "01/02/2026 - 10:33", "ITF", "Gratis", "Nro. de Operación", op
].join("\n");
const run = (rt) => plain(rt.run("processEmails()"));
const byOp = (rt, op) => rt.rows("Entries").find((e) => e.source === "email" && String(e.external_id) === op);

function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const sip = (rt.rows("Banks").find((b) => b.name === "SIP") || {}).id;
  const pid = (x) => x.id || (x.paymentMethod && x.paymentMethod.id);
  const plus = pid(rt.api("addPaymentMethod", { nickname: "PruebaPlus", type: "debit", last_4: "" }));
  rt.api("addPaymentMethod", { nickname: "SIP tarjeta prueba", type: "credit", bank_id: sip, last_4: "7777" });
  rt.api("addPaymentMethod", { nickname: "CTS prueba", type: "debit", bank_id: sip, last_4: "8888" });
  const dest = pid(rt.api("addPaymentMethod", { nickname: "Destino prueba", type: "debit", last_4: "4321" }));
  return { rt, plus, dest };
}

test("own transfer: From = the account named under 'Origen', To = the account whose digits are in the CCI", () => {
  const { rt, plus, dest } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: "Realizaste una operación", body: body({ op: "900001" }) });
  run(rt);
  const e = byOp(rt, "900001");
  assert.ok(e, "entry created");
  assert.equal(e.type, "transfer");
  assert.equal(Number(e.amount), 1234);
  assert.equal(e.payment_method_id, plus);
  assert.equal(e.to_payment_method_id, dest);
});

test("own transfer to an account the app does not have: still a transfer, To blank", () => {
  const { rt, plus } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: "Realizaste una operación", body: body({ cci: "002-111-123456785555-99", op: "900002" }) });
  run(rt);
  const e = byOp(rt, "900002");
  assert.equal(e.type, "transfer");
  assert.equal(e.payment_method_id, plus);
  assert.ok(!e.to_payment_method_id);
});

test("a name that fits no account (or fits two) leaves From blank; someone else's CCI stays an expense", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SIP, subject: "Realizaste una operación", body: body({ origin: "Cuenta Otra Soles", to: "Ana Lopez Prueba", op: "900003" }) });
  run(rt);
  const e = byOp(rt, "900003");
  assert.equal(e.type, "expense");
  assert.ok(!e.payment_method_id);
  assert.ok(!e.to_payment_method_id);
});

test("the pack twin reads SIP's e-mail exactly like the code rule (own and someone else's)", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/rules/email-rules.json"), "utf8"));
  const twin = pack.rules.find((r) => r.id === "sip-transferencia-otro-banco");
  assert.ok(plain(rt.run(`rulePackValidate_(${js(js(pack))}, { strict: true })`)).ok);
  for (const b of [body({ op: "900004" }), body({ to: "Ana Lopez Prueba", op: "900005" })]) {
    const code = plain(rt.run(`EMAIL_RULES.filter(function (r) { return r.label === 'Transferencia a otro banco'; })[0].extract('Realizaste una operación', ${js(b)})`));
    const fromPack = plain(rt.run(`rulePackCompile_(${js(twin)}).extract('Realizaste una operación', ${js(b)})`));
    assert.deepEqual(fromPack, code);
  }
  const own = plain(rt.run(`rulePackCompile_(${js(twin)}).extract('x', ${js(body({}))})`));
  assert.equal(own.toLast4, "4321");
  assert.equal(own.accountName, "Cuenta Prueba Plus Soles");
});
