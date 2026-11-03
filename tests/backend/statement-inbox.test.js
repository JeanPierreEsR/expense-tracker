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
  rt.svc.gmail.addEmail({ from: "Stranger <x@evil.test>", to: ME, subject: "hi", body: "", attachments: [{ name: "account_summary.pdf" }] });
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

test("a forwarded bank email is recognized by the original sender address quoted in its body", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: ME, subject: "Fwd: Tu estado de cuenta", attachments: [{ name: "20260930_0001.pdf" }],
    body: "---------- Forwarded message ---------\nDe: Banco <tarjetasdecredito@eecc.interbank.pe>\n" });
  assert.equal(scan(rt).found, 1);
  assert.equal(inbox(rt)[0].bank_keyword, "interbank");
});

test("the owner's real-looking case: forwarded 'IBK dolares' mail with a misspelled account_sumary file is noted", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  rt.svc.gmail.addEmail({ from: "Owner Name <test@example.com>", subject: "Fwd: IBK dolares septiembre 2026", body: "---------- Forwarded message ---------", attachments: [{ name: "account_sumary_0001.pdf" }] });
  rt.svc.gmail.addEmail({ from: "Owner Name <test@example.com>", subject: "x", body: "", attachments: [{ name: "account_sumary_0002.pdf" }] });
  assert.equal(scan(rt).found, 2);
  assert.deepEqual(inbox(rt).map((r) => r.bank_label), ["Interbank", "Interbank"]);
});

// SIP's AhorraMás "movimientos" come with a download link instead of a PDF (2026-11-03).
const SIP_OPS = "Débito Sip <no-reply@operaciones.agora.pe>";
const TRACK = "https://tracking.operaciones.agora.pe/tracking/1/click/abc123";
const STORE = "https://storage.googleapis.com/agora_savings/prod/Movements_Savings_1_2026_NOVEMBER_3.pdf?Expires=1&Signature=x";
const linkMail = (cur) => `<p>Te enviamos los movimientos de tu cuenta AhorraMás ${cur}.</p><a href="https://sip.pe/ayuda">Ayuda</a>
  <a style="x" href="${TRACK}&amp;u=1"><span>DESCARGA AQUÍ</span></a>`;
const PDF = [37, 80, 68, 70, 45, 49, 46, 55];   // "%PDF-1.7"

function addLinkMail(rt, cur) {
  rt.svc.gmail.addEmail({ from: SIP_OPS, subject: `Ana, aquí están tus movimientos con AhorraMás ${cur}`, body: "", html: linkMail(cur) });
}

test("an AhorraMás download-link e-mail is noted per currency, keeps no link, and nudges", () => {
  const { rt } = freshApp({ entries: 50 });
  linkTelegram(rt);
  warmUp(rt);
  addLinkMail(rt, "soles");
  addLinkMail(rt, "dólares");
  rt.svc.gmail.addEmail({ from: SIP_OPS, subject: "Operación realizada", body: "", html: "<a href='https://sip.pe'>Ver</a>" });
  assert.equal(scan(rt).found, 2);
  assert.deepEqual(inbox(rt).map((r) => r.bank_label).sort(), ["AhorraMás dólares", "AhorraMás soles"]);
  assert.ok(inbox(rt).every((r) => r.attachment_name === "(link)" && r.bank_keyword === "sip" && !JSON.stringify(r).includes("tracking")));
  assert.match(sentText(rt), /AhorraMás soles/);
  assert.equal(scan(rt).found, 0);   // a rescan adds nothing
  const listed = rt.api("listStatementInbox").items.filter((i) => i.link);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((i) => i.size_kb === null && i.file_name === ""));
});

test("Open follows the link's redirects to the PDF; every hop must stay on the bank's or Google's storage hosts", () => {
  const { rt } = freshApp({ entries: 50 });
  warmUp(rt);
  addLinkMail(rt, "soles");
  scan(rt);
  const id = inbox(rt)[0].id;
  const seen = [];
  rt.state.fetchHandler = (url, opts) => {
    seen.push(url);
    assert.equal(opts.followRedirects, false);
    if (url.startsWith(TRACK)) return { http: 302, headers: { Location: STORE } };
    if (url === STORE) return { http: 200, bytes: PDF };
    return { http: 500 };
  };
  const got = rt.api("getStatementAttachment", { id });
  assert.equal(got.name, "Movements_Savings_1_2026_NOVEMBER_3.pdf");
  assert.deepEqual([...Buffer.from(got.base64, "base64")], PDF);
  assert.equal(seen[0], TRACK + "&u=1");   // &amp; decoded

  rt.state.fetchHandler = () => ({ http: 302, headers: { Location: "https://evil.test/x.pdf" } });
  assert.throws(() => rt.api("getStatementAttachment", { id }), /did not give a PDF/);
  rt.state.fetchHandler = (url) => (url.startsWith(TRACK) ? { http: 302, headers: { Location: STORE } } : { http: 400 });
  assert.throws(() => rt.api("getStatementAttachment", { id }), /expired/);
  rt.state.fetchHandler = (url) => (url.startsWith(TRACK) ? { http: 302, headers: { Location: STORE } } : { http: 200, bytes: [60, 104, 116, 109, 108] });
  assert.throws(() => rt.api("getStatementAttachment", { id }), /did not give a PDF/);
});

test("friends' copies (read-only Gmail service) find the download link in the e-mail's HTML too", () => {
  const { rt } = freshApp({ entries: 50 });
  rt.run("PropertiesService.getScriptProperties().setProperty('GMAIL_READER', 'readonly')");
  warmUp(rt);
  addLinkMail(rt, "dólares");
  assert.equal(scan(rt).found, 1);
  rt.state.fetchHandler = (url) => (url.startsWith(TRACK) ? { http: 302, headers: { location: STORE } } : { http: 200, bytes: PDF });
  assert.equal(rt.api("getStatementAttachment", { id: inbox(rt)[0].id }).name, "Movements_Savings_1_2026_NOVEMBER_3.pdf");
});
