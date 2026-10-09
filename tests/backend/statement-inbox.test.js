// Statements inbox scan (StatementInbox.gs): bank-sent PDFs and PDFs the owner mails himself.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const ME = "Owner <test@example.com>";
const scan = (rt) => JSON.parse(JSON.stringify(rt.run("scanStatementInbox_()")));
const inbox = (rt) => rt.rows("Statement Inbox").filter((r) => r.message_id !== "seed");
const sentText = (rt) => rt.svc.fetchLog.map((f) => JSON.stringify(f.options.payload)).join(" ");

// A first scan (empty inbox) is silent by design; seed one old row so later scans behave normally.
function warmUp(rt) {
  rt.run(`ensureStatementInboxSheet_(); appendRowsBulk_('Statement Inbox', [{ id: 'seed', message_id: 'seed', attachment_name: 'old.pdf', sender_key: 'x', bank_label: 'BCP',
    bank_keyword: 'bcp', received: '2026-01-01', status: 'processed', size_kb: 1, notified: 'true', created_at: '2026-01-01' }])`);
}

test("a PDF the owner mails himself named account_summary is noted as Interbank, with a nudge", () => {
  const { rt } = freshApp({ entries: 50 });
  linkTelegram(rt);
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: ME, subject: "estado", body: "", attachments: [{ name: "account_summary_0001.pdf" }] });
  assert.equal(scan(rt).found, 1);
  const row = inbox(rt)[0];
  assert.equal(row.bank_label, "Interbank");
  assert.equal(row.sender_key, "self");
  assert.match(sentText(rt), /New Interbank statement/);
});

test("a self-sent file named EECC... is BCP; a bank word in the subject also counts", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: ME, subject: "x", body: "", attachments: [{ name: "EECC_2026_09.pdf" }] });
  rt.svc.gmail.addEmail({ from: ME, subject: "Estado de cuenta Diners", body: "", attachments: [{ name: "scan001.pdf" }] });
  scan(rt);
  assert.deepEqual(inbox(rt).map((r) => r.bank_label).sort(), ["BCP", "Diners"]);
});

test("a self-sent PDF that matches no bank is ignored, and so is a non-PDF", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: ME, subject: "contrato", body: "", attachments: [{ name: "contract.pdf" }] });
  rt.svc.gmail.addEmail({ from: ME, subject: "x", body: "", attachments: [{ name: "account_summary.png" }] });
  assert.equal(scan(rt).found, 0);
});

test("someone else's email with an account_summary PDF is not taken, and a rescan does not add twice", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: "Stranger <x@evil.test>", subject: "hi", body: "", attachments: [{ name: "account_summary.pdf" }] });
  rt.svc.gmail.addEmail({ from: ME, subject: "s", body: "", attachments: [{ name: "account_summary.pdf" }] });
  assert.equal(scan(rt).found, 1);
  assert.equal(scan(rt).found, 0);
  assert.equal(inbox(rt).length, 1);
});

test("a statement from a bank address is still noted as before", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: "BCP <notificaciones@notificacionesbcp.com.pe>", subject: "Tu estado de cuenta", body: "", attachments: [{ name: "EECC_09.pdf" }] });
  assert.equal(scan(rt).found, 1);
  assert.equal(inbox(rt)[0].sender_key, "notificaciones@notificacionesbcp.com.pe");
});

test("an AhorraMás statement PDF from the SIP operations address is noted; an email without a PDF is not", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: "SIP <no-reply@operaciones.agora.pe>", subject: "Operación realizada", body: "sin adjunto" });
  rt.svc.gmail.addEmail({ from: "SIP <no-reply@operaciones.agora.pe>", subject: "Tu estado de cuenta", body: "", attachments: [{ name: "estado_cuenta_ahorramas.pdf" }] });
  assert.equal(scan(rt).found, 1);
  assert.equal(inbox(rt)[0].bank_label, "AhorraMás");
  assert.equal(inbox(rt)[0].bank_keyword, "sip");
});

test("IBK in a self-sent subject or file name means Interbank", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: ME, subject: "IBK setiembre", body: "", attachments: [{ name: "scan.pdf" }] });
  scan(rt);
  assert.equal(inbox(rt)[0].bank_label, "Interbank");
});
