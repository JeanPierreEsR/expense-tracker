// Mail catch-up (MailCatchup.gs, 2026-11-20): once the pack rule for BCP credit-card purchases is in a friend's copy, the purchases it
// missed before (written down as handled, older than the scan's few days) are read ONCE into Needs review. Only that rule's e-mails:
// another kind of e-mail the person already dealt with never comes back. Made-up amounts, merchants and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp, BCP_SENDER } = require("./helpers");

const PACK = fs.readFileSync(path.join(__dirname, "../../docs/rules/email-rules.json"), "utf8");
const credit = (rt, { amount, op, daysAgo }) => rt.svc.gmail.addEmail({
  from: BCP_SENDER, subject: "Realizaste un consumo con tu Tarjeta de Crédito BCP - Servicio de Notificaciones BCP", daysAgo,
  body: ["Hola Eva,", "Realizaste un consumo con tu tarjeta.", "Total del consumo S/ " + amount, "Empresa TIENDA PRUEBA",
    "Número de Tarjeta de Crédito ************1234", "Número de operación " + op].join("\n")
});
const fromEmail = (rt, op) => rt.rows("Entries").filter((e) => e.source === "email" && String(e.external_id) === op);
const scan = (rt) => { rt.svc.props.delete("EMAIL_SCAN_LAST_AT"); return JSON.parse(JSON.stringify(rt.run("scanEmailsGuarded_('timer')"))); };

function friendCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "gmail");
  return rt;
}

test("a friend's copy: old credit-card purchases are read once the pack rule is there, and only once", () => {
  const rt = friendCopy();
  credit(rt, { amount: "45.10", op: "777001", daysAgo: 20 });
  credit(rt, { amount: "12.30", op: "777002", daysAgo: 2 });
  scan(rt);   // no pack yet: nothing reads them, the catch-up waits
  assert.equal(fromEmail(rt, "777001").length, 0);
  assert.equal(rt.svc.props.get("MAIL_CATCHUPS_DONE") || "", "");
  rt.api("setRulePack", { text: PACK });
  scan(rt);
  const old = fromEmail(rt, "777001"), recent = fromEmail(rt, "777002");
  assert.equal(old.length, 1, "the 20-day-old purchase is caught up");
  assert.equal(old[0].status, "pending");
  assert.equal(recent.length, 1, "the recent one once, not twice");
  assert.match(rt.svc.props.get("MAIL_CATCHUPS_DONE"), /bcp-credit-purchases/);
  rt.api("discardEntry", { id: old[0].id });
  scan(rt);
  assert.equal(fromEmail(rt, "777001").length, 0, "a purchase the person discarded never comes back");
});

test("the catch-up never brings back another kind of e-mail the person already dealt with", () => {
  const rt = friendCopy();
  rt.api("setRulePack", { text: PACK });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Constancia de Transferencia a Terceros BCP", daysAgo: 15,
    body: ["Monto transferido S/ 33.00", "Enviado a Ana Lopez Prueba", "Desde Clasica", "**** 0005", "Número de operación 888001"].join("\n") });
  rt.run("processEmails({ days: 30, senders: ['" + BCP_SENDER + "'] })");   // read once…
  const made = rt.rows("Entries").find((e) => String(e.external_id) === "888001");
  assert.ok(made);
  rt.api("discardEntry", { id: made.id });   // …and discarded by the person
  scan(rt);
  assert.equal(rt.rows("Entries").filter((e) => String(e.external_id) === "888001").length, 0);
});

test("the owner's copy never runs it", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: PACK });
  credit(rt, { amount: "45.10", op: "777003", daysAgo: 20 });
  scan(rt);
  assert.equal(fromEmail(rt, "777003").length, 0);
});
