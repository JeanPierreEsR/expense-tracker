// "Bank emails I couldn't read" (2026-11-22):
// - Apple's "Your recent download with your Apple Account" is a security notice, not a payment: no entry, not listed.
// - A "no rule" row logged before a rule for that wording existed is no longer listed (the SIP CTS and Interbank
//   "pago recurrente" rows stayed after their rules shipped). An "unreadable" row and a wording no rule reads stay.
// Made-up text; no real amount, name or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const APPLE = "no_reply@email.apple.com";
const SIP = "no-reply@servicioalcliente.sip.pe";
const IBK = "servicioalcliente@netinterbank.com.pe";
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const unread = (rt) => { try { return rt.rows("Unread Emails"); } catch (e) { return []; } };
const listed = (rt) => JSON.parse(JSON.stringify(rt.run("listUnreadEmails_('2000-01-01')")));

test("Apple's recent-download notice makes no entry and is not listed as unreadable", () => {
  const { rt } = freshApp({ entries: 200 });
  rt.svc.gmail.addEmail({ from: APPLE, subject: "Your recent download with your Apple Account",
    body: "Dear Ana,\nYour Apple Account was just used to download Some App on a computer or device that has not previously been used." });
  const res = run(rt);
  assert.equal(res.created || 0, 0);
  assert.equal(unread(rt).filter((r) => r.sender === APPLE).length, 0);
});

test("old 'no rule' rows a rule now covers are hidden; unreadable rows and real gaps stay", () => {
  const { rt } = freshApp({ entries: 200 });
  rt.api("setRulePack", { text: fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8") });   // "pago recurrente" lives in the pack
  rt.run("ensureUnreadEmailsSheet_()");
  const day = "2026-11-10";
  const row = (sender, subject, kind) => rt.run(`appendRowObject('Unread Emails', ${JSON.stringify({
    id: [sender, subject, kind].join("|"), sender, subject, kind, count: 1, first_seen: day, last_seen: day })})`);
  row(SIP, "envío automático - constancia de solicitud de retiro cts", "no_rule");
  row(SIP, "abono semestral cts", "no_rule");
  row(IBK, "ana, se ha realizado un pago recurrente a tu tarjeta", "no_rule");
  row(APPLE, "your recent download with your apple account", "no_rule");
  row(SIP, "algo nuevo de sip", "no_rule");
  row(SIP, "envío automático - constancia de solicitud de retiro cts", "unreadable");
  const subjects = listed(rt).map((r) => r.subject + "|" + r.kind).sort();
  assert.deepEqual(subjects, [
    "algo nuevo de sip|no_rule",
    "envío automático - constancia de solicitud de retiro cts|unreadable"
  ]);
});
