// BCP "Constancia de Transferencia a Otros Bancos" -> pending entry (EmailParser.gs). Emails are made up; the shape is the real one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, BCP_SENDER } = require("./helpers");

const email = (rt, { to, amount = "300.00", op = "00123456", daysAgo = 0 }) => rt.svc.gmail.addEmail({
  from: BCP_SENDER,
  subject: "Constancia de Transferencia a Otros Bancos - Servicio de Notificaciones BCP",
  daysAgo,
  body: [
    "Hola *Eva Carla,*", "", "Realizaste una transferencia de *S/ " + amount + "* desde tu *Clasica.*", "",
    "A continuación, te enviamos los datos de tu operación.", "", "*Montos*", "",
    "Monto enviado *S/ " + amount + "* ", "Comisión *S/ 0.00* ", "*Total cobrado* *S/ " + amount + "* ", "",
    "*Datos de la operación*", "", "Operación realizada *Transferencia a otros bancos* ",
    "Fecha y hora *01 de Septiembre de 2026 - 01:44 PM* ",
    "Enviado a *" + to + "*", "**** 4044 ", "Banco destino *Interbank* ", "Moneda *Soles* ", "Tipo de envío *Inmediato* ",
    "Desde *Clasica*", "**** 0005 ", "Mensaje ", "Canal *Banca Móvil BCP* ", "Número de operación *" + op + "* <#> "
  ].join("\n")
});
const pending = (rt, op) => rt.rows("Entries").filter((e) => e.source === "email" && e.status === "pending" && e.external_id === op);
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));

test("a transfer to the owner's own name at another bank is a transfer", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  email(rt, { to: "Eva Carla Ramos T.", op: "OTB-1" });
  run(rt);
  const [e] = pending(rt, "OTB-1");
  assert.ok(e, "an entry was created");
  assert.equal(e.type, "transfer");
  assert.equal(Number(e.amount), 300);
  assert.equal(e.currency, "PEN");
});

test("a transfer to someone else is an expense waiting for review, and the same email is not saved twice", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  email(rt, { to: "Ana Ramos Torres", op: "OTB-2", amount: "45.50" });
  run(rt);
  const [e] = pending(rt, "OTB-2");
  assert.ok(e);
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 45.5);
  const n = rt.rows("Entries").length;
  run(rt);
  assert.equal(rt.rows("Entries").length, n);
});
