// Interbank "Constancia de transferencia" comes in two layouts (2026-11-20): "Cuenta a cargo" / "Cuenta destino" and, for some
// payees (an investment fund), "Cuenta cargo" / "Destinatario". Both give the description and the account it left. A transfer to the
// person's own account at another bank names it by its CCI: To = the account with those digits. The pack twin reads it the same.
// Made-up names, numbers and amounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const IBK = "servicioalcliente@netinterbank.com.pe";
const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const usual = ({ to = "Ana Lopez Prueba", dest = "01100000000000000099", op = "00100001", amount = "US$ 80.00" } = {}) => [
  "Hola EVA, te enviamos tu", "Constancia de transferencia", "Código de operación", op, "Fecha y hora", "01 Feb 2026 10:32 AM",
  "Cuenta a cargo", "Cuenta Simple", "898 0000001111", "Cuenta destino", to, dest, "Tipo de operación", "Transferencia inmediata",
  "Monto y moneda", amount, "Comisión", "US$ 0.00", "Monto total", amount
].join("\n");
const other = ({ op = "00200002" } = {}) => [
  "Hola EVA, te enviamos tu", "Constancia de transferencia", "Código de operación", op, "Fecha y hora", "01 Feb 2026", "11:34 AM",
  "Cuenta cargo", "Cuenta Simple", "Dólares", "898 0000001111", "Destinatario", "FONDO PRUEBA SOC** AGE**", "0570000000000",
  "Moneda y monto", "US$ 1,450.00"
].join("\n");
const byOp = (rt, op) => rt.rows("Entries").find((e) => e.source === "email" && String(e.external_id) === op);
const run = (rt) => rt.run("processEmails()");

function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const ibk = (rt.rows("Banks").find((b) => b.name === "Interbank") || {}).id;
  const pid = (x) => x.id || (x.paymentMethod && x.paymentMethod.id);
  const usd = pid(rt.api("addPaymentMethod", { nickname: "IBK prueba usd", type: "debit", bank_id: ibk, last_4: "1111" }));
  const dest = pid(rt.api("addPaymentMethod", { nickname: "Otro banco prueba", type: "debit", last_4: "4321" }));
  return { rt, usd, dest };
}

test("the 'Cuenta cargo' / 'Destinatario' layout gets its description and the account it left", () => {
  const { rt, usd } = setup();
  rt.svc.gmail.addEmail({ from: IBK, subject: "Constancia de transferencia", body: other({ op: "00200002" }) });
  run(rt);
  const e = byOp(rt, "00200002");
  assert.ok(e);
  assert.equal(e.description, "FONDO PRUEBA SOC AGE");
  assert.equal(e.payment_method_id, usd);
  assert.equal(Number(e.amount), 1450);
});

test("to the person's own account at another bank: To from the CCI", () => {
  const { rt, usd, dest } = setup();
  rt.svc.gmail.addEmail({ from: IBK, subject: "Constancia de transferencia", body: usual({ to: "Eva Carla Ramos Torres", dest: "00211112345678432155", op: "00300003" }) });
  run(rt);
  const e = byOp(rt, "00300003");
  assert.equal(e.type, "transfer");
  assert.equal(e.payment_method_id, usd);
  assert.equal(e.to_payment_method_id, dest);
});

test("the usual layout to someone else is unchanged: an expense, no To", () => {
  const { rt, usd } = setup();
  rt.svc.gmail.addEmail({ from: IBK, subject: "Constancia de transferencia", body: usual({ op: "00400004" }) });
  run(rt);
  const e = byOp(rt, "00400004");
  assert.equal(e.type, "expense");
  assert.equal(e.description, "Ana Lopez Prueba");
  assert.equal(e.payment_method_id, usd);
  assert.ok(!e.to_payment_method_id);
});

test("the pack twin reads every layout exactly like the code rule", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/rules/email-rules.json"), "utf8"));
  assert.ok(plain(rt.run(`rulePackValidate_(${js(js(pack))}, { strict: true })`)).ok);
  const twin = pack.rules.find((r) => r.id === "interbank-transferencia");
  for (const b of [usual({}), other({}), usual({ to: "Eva Carla Ramos Torres", dest: "00211112345678432155" })]) {
    const code = plain(rt.run(`EMAIL_RULES.filter(function (r) { return r.sender === '${IBK}' && r.label === 'Transferencia'; })[0].extract('Constancia de transferencia', ${js(b)})`));
    const fromPack = plain(rt.run(`rulePackCompile_(${js(twin)}).extract('Constancia de transferencia', ${js(b)})`));
    assert.deepEqual(fromPack, code);
  }
});
