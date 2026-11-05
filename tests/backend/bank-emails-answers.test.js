// More → Bank emails, owner's points of 2026-11-05: the inbox address from a bank e-mail's To line (a heal that also runs on the owner's copy),
// the one-time catch-up of which kinds already arrived, statement e-mails kept out of "couldn't read", and "Why didn't an email come?".
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail, BCP_SENDER } = require("./helpers");

const js = (rt, code) => JSON.parse(rt.run("JSON.stringify(" + code + ")"));

// ---- 1. the inbox address ----
test("the first address of a To line is read, names and other addresses left out", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(js(rt, "firstAddressIn_('Ana Lo <Ana.Lo@Example.com>, b@example.com')"), "ana.lo@example.com");
  assert.equal(js(rt, "firstAddressIn_('')"), "");
  assert.equal(js(rt, "firstAddressIn_('undisclosed-recipients:;')"), "");
});

test("a copy that cannot ask Google for its address learns it once from a bank e-mail, on the owner's copy too", () => {
  const { rt } = freshApp({ small: true });   // the owner's copy: no installer FEATURES
  rt.run("Session.getEffectiveUser = function () { return { getEmail: function () { return ''; } }; };");   // what Google answers there
  rt.run("gmailUsesReadonly_ = function () { return false; };");   // the owner's copy reads with GmailApp: no Gmail profile to ask (also under ship.sh's second e-mail reader)
  rt.svc.props.delete("MAILBOX_ADDRESS");
  rt.svc.gmail.addEmail({ from: BCP_SENDER, to: "Test Person <test.person@example.com>", subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "Total del consumo: S/ 1.00" });
  rt.api("getMeta", {});
  assert.equal(rt.svc.props.get("MAILBOX_ADDRESS"), "test.person@example.com");
  assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("mailbox-address-to-line"));
  assert.ok(!rt.svc.props.get("HEALS_DONE").split(",").includes("sheet-time-zone"), "heals not marked for the owner still skip his copy");
  assert.equal(rt.api("getMeta", {}).emailInfo.address, "test.person@example.com");
});

test("an address already known is never replaced", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("MAILBOX_ADDRESS", "kept@example.com");
  rt.svc.gmail.addEmail({ from: BCP_SENDER, to: "other@example.com", subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "Total del consumo: S/ 1.00" });
  rt.run("healMailboxAddressFromToLine_()");
  assert.equal(rt.svc.props.get("MAILBOX_ADDRESS"), "kept@example.com");
});

// ---- 2. the catch-up of kinds that already arrived ----
test("the per-kind days merge keeps the newer day and adds what was missing", () => {
  const { rt } = freshApp({ small: true });
  const out = js(rt, "mergeBankKindDays_({ BCP: { purchase: '2026-11-04' } }, { BCP: { purchase: '2026-10-01', bill: '2026-09-02' }, SIP: { transfer_out: '2026-10-10' } })");
  assert.deepEqual(out, { BCP: { purchase: "2026-11-04", bill: "2026-09-02" }, SIP: { transfer_out: "2026-10-10" } });
});

test("once per copy, a scan fills in the kinds whose e-mails became entries before the days were kept", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "BACK-1", daysAgo: 1 });
  rt.run("noteBankKindSeen_ = function () {};");   // as before 2026-11-03: the entry is made, its kind's day is not
  rt.run("processEmails()");
  rt.run("setSetting_('bank_mail_seen_kinds', '{}')");
  rt.svc.props.delete("BANK_KINDS_BACKFILLED");
  rt.run("processEmails()");   // the next normal scan
  const day = rt.api("getMeta").emailInfo.coverage.BCP.kinds.find((k) => k.key === "purchase").seen;
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(rt.svc.props.get("BANK_KINDS_BACKFILLED"), "marked done");
  assert.equal(rt.api("getMeta").emailInfo.coverage.BCP.kinds.find((k) => k.key === "bill").seen, "", "a kind with no e-mail stays empty");
});

test("an e-mail whose entry was deleted does not count", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "BACK-2", daysAgo: 1 });
  rt.run("noteBankKindSeen_ = function () {};");
  rt.run("processEmails()");
  assert.ok(rt.rows("Entries").some((e) => String(e.external_id) === "BACK-2"), "the e-mail became an entry");
  rt.run("deleteRowsWhere_('Entries', function (r) { return String(r.external_id) === 'BACK-2'; })");
  rt.run("setSetting_('bank_mail_seen_kinds', '{}')");
  rt.svc.props.delete("BANK_KINDS_BACKFILLED");
  rt.run("backfillBankKindDaysOnce_(uniqueSenders_(), (function () { var m = {}; getAllRows('Entries').forEach(function (e) { if (e.external_id) m[e.external_id] = true; }); return m; })())");
  assert.equal(rt.api("getMeta").emailInfo.coverage.BCP.kinds.find((k) => k.key === "purchase").seen, "");
});

// ---- 5. not payments ----
test("statement e-mails and the password notice are not 'couldn't read'; a real unknown wording still is", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(js(rt, "unreadIsNotPayment_('no-reply@operaciones.agora.pe', 'test person, aquí están tus movimientos con ahorramás soles')"), true);
  assert.equal(js(rt, "unreadIsNotPayment_('notificaciones@notificacionesbcp.com.pe', 'constancia de configuración de clave - servicio de notificac')"), true);
  assert.equal(js(rt, "unreadIsNotPayment_('servicioalcliente@netinterbank.com.pe', 'test person, se ha realizado un pago recurrente a tu tarjeta')"), false);
  rt.run("logUnreadEmail_('no-reply@operaciones.agora.pe', 'Test person, aquí están tus movimientos con AhorraMás dólares', 'no_rule', '2026-11-03')");
  rt.run("logUnreadEmail_('servicioalcliente@netinterbank.com.pe', 'Test person, se ha realizado un pago recurrente a tu tarjeta', 'no_rule', '2026-11-03')");
  const unread = rt.api("getManualGaps", {}).unread.map((u) => u.sender);
  assert.deepEqual(unread, ["servicioalcliente@netinterbank.com.pe"]);
});

test("a row logged before the list existed disappears from the screen", () => {
  const { rt } = freshApp({ small: true });
  rt.run("ensureUnreadEmailsSheet_()");
  rt.run("appendRowObject('Unread Emails', { id: 'x', sender: 'notificaciones@notificacionesbcp.com.pe', subject: 'constancia de configuración de clave - servicio de notificac', kind: 'no_rule', count: 1, first_seen: '" + new Date().toISOString().slice(0, 10) + "', last_seen: '" + new Date().toISOString().slice(0, 10) + "' })");
  assert.equal(rt.api("getManualGaps", {}).unread.length, 0);
});

// ---- 4. "Why didn't an email come?" ----
test("an answer is kept on the copy and comes back with the list; changing it to nothing removes it", () => {
  const { rt } = freshApp({ small: true });
  assert.ok(rt.api("getMeta", {}).capabilities.gapReasons);
  rt.api("saveGapReason", { kind: "plin_out", reason: "whatsapp" });
  rt.api("saveGapReason", { kind: "other_manual", reason: "other", note: "Paid with a gift card, call 987654321 a@b.com" });
  const reasons = rt.api("getManualGaps", {}).reasons;
  assert.equal(reasons.plin_out.reason, "whatsapp");
  assert.equal(reasons.other_manual.reason, "other");
  assert.match(reasons.other_manual.note, /gift card/);
  assert.ok(!/987654321|a@b\.com/.test(reasons.other_manual.note), "digits and addresses are hidden as in feedback");
  rt.api("saveGapReason", { kind: "plin_out", reason: "" });
  assert.ok(!rt.api("getManualGaps", {}).reasons.plin_out);
});

test("answers that make no sense are refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("saveGapReason", { kind: "cash", reason: "alert_off" }));
  assert.throws(() => rt.api("saveGapReason", { kind: "yape_out", reason: "whatsapp" }), "WhatsApp is a Plin answer only");
  assert.throws(() => rt.api("saveGapReason", { kind: "plin_out", reason: "made_up" }));
  assert.throws(() => rt.api("saveGapReason", { kind: "plin_out", reason: "other", note: "  " }), "Other needs words");
});

test("the owner's copy collects the answers as feedback notes of their own kind", () => {
  const { rt } = freshApp({ small: true });
  const res = rt.rawPost(JSON.stringify({ action: "reportFeedback", payload: { install: "0123456789abcdef0123", label: "Test", kind: "email_gap", screen: "bank_emails", language: "es", app: "1.0.0", device: "iPhone", text: "[plin_out] whatsapp" } }));
  assert.ok(res.ok, JSON.stringify(res));
  const row = rt.rows("Feedback").pop();
  assert.equal(row.kind, "email_gap");
  assert.equal(row.text, "[plin_out] whatsapp");
});

test("the phone asks only where the reason is unknown, sends each answer to JP, and a WhatsApp Plin joins its group", () => {
  const fs = require("node:fs"), path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.match(app, /const BE_WHY_KINDS_ = \["yape_in", "yape_out", "plin_out", "other_manual"\];/);
  assert.match(app, /kind: "email_gap", screen: "bank_emails"/);
  assert.match(app, /wallet\("be\.wallet\.plin", [^\n]*\["plin_whatsapp"\]\)/);
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  const screen = html.slice(html.indexOf('id="screen-bank-emails"'), html.indexOf('id="screen-export"'));
  assert.ok(!screen.includes("bankMail.notCoveredTitle"), "the 'What emails do not cover' note left the screen");
  assert.ok(screen.includes('data-i18n="bankMail.nc4"'), "its statement line stays, in By transaction");
});
