// "My bank isn't supported yet" (backend/BankSamples.gs + docs/bank-sample.js). Made-up names, addresses and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");
const BankSample = require("../../docs/bank-sample.js");

const SENDER = "alertas@examplebank.test";
const INSTALL = "0f8c1c5e-3333-4a2b-9c3d-cccccccccccc";
const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const send = (rt, payload) => post(rt, { action: "reportBankSample", payload: { install: INSTALL, label: "Ana", sender: SENDER, subject: "Compra con tarjeta", text: "Compra por S/ 99.50 en Corner Cafe con tarjeta ****9999", language: "es", app: "2026-10-20T00:00:00Z", how: "picked", ...payload } });
const telegramTexts = (rt) => rt.svc.fetchLog.map((f) => JSON.parse(f.options.payload).text).filter(Boolean);
const friend = (rt) => rt.svc.props.set("FEATURES", "gmail");
const errCode = (rt, call) => rt.run(`(function () { try { ${call}; return "no error"; } catch (e) { return e.code; } })()`);

// ---- the phone's redaction ----
test("every digit becomes 9 but amounts keep their shape", () => {
  const out = BankSample.redact("Total: S/ 1,234.50 el 12/10/2026 tarjeta ****4821", { sender: SENDER });
  assert.equal(out, "Total: S/ 9,999.99 el 99/99/9999 tarjeta ****9999");
});

test("e-mail addresses go, except the bank's own sender address", () => {
  const out = BankSample.redact(`De ${SENDER}\nEscríbenos a ana.perez@gmail.test o ayuda@examplebank.test`, { sender: SENDER });
  assert.ok(out.includes(SENDER));
  assert.ok(!out.includes("ana.perez") && !out.includes("ayuda@"));
  assert.equal((out.match(/\[email\]/g) || []).length, 2);
});

test("links keep only the site name", () => {
  const out = BankSample.redact("Mira https://pay.examplebank.test/r/abc123?token=secret&u=77 aquí", { sender: SENDER });
  assert.equal(out, "Mira https://pay.examplebank.test/[link] aquí");
});

test("names after greetings and labels are hidden", () => {
  const out = BankSample.redact("Estimado Juan Perez Gomez,\nBeneficiario: Rosa Quispe\nNombre: Luis\nMonto: S/ 10.00", { sender: SENDER });
  assert.equal(out, "Estimado [name],\nBeneficiario: [name]\nNombre: [name]\nMonto: S/ 99.99");
});

test("words the person adds are hidden, ignoring capitals and accents, and each word of a full name too", () => {
  const out = BankSample.redact("Transferencia de LOPEZ ANA a Jose. Gracias, Ana Lopez. Aná vive en Calle Sol 12", { sender: SENDER, hide: "Ana Lopez, Calle Sol" });
  assert.ok(!/ana|lopez|calle sol/i.test(out), out);
  assert.ok(out.includes("Jose"), "words nobody asked to hide stay");
  assert.ok(out.includes("Gracias"));
});

test("a word is not hidden inside a longer word", () => {
  const out = BankSample.redact("Banana y ana", { sender: SENDER, hide: "ana" });
  assert.equal(out, "Banana y [name]");
});

test("long reference codes go, long plain words stay", () => {
  const out = BankSample.redact("Ref: AB12CD34EF56GH78IJ internacionalizacion", { sender: SENDER });
  assert.equal(out, "Ref: [code] internacionalizacion");
});

test("the text is capped at what the backend accepts", () => {
  assert.equal(BankSample.redact("x".repeat(20000), { sender: SENDER }).length, BankSample.MAX_CHARS);
});

test("parseSender accepts an address or Name <address> and refuses anything else", () => {
  assert.equal(BankSample.parseSender("  Alertas@ExampleBank.test "), SENDER);
  assert.equal(BankSample.parseSender("Example Bank <alertas@examplebank.test>"), SENDER);
  assert.equal(BankSample.parseSender("not an address"), "");
  assert.equal(BankSample.parseSender("a@b"), "");
});

// ---- the owner's side ----
test("a sample needs no sign-in, is saved in the Bank Samples tab and reaches the owner on Telegram", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  const res = send(rt, {});
  assert.equal(res.ok, true);
  const rows = rt.rows("Bank Samples");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, SENDER);
  assert.equal(rows[0].label, "Ana");
  assert.equal(rows[0].language, "es");
  assert.match(String(rows[0].text), /Corner Cafe/);
  const tg = telegramTexts(rt).join("\n");
  assert.match(tg, /Bank sample from Ana|Muestra de banco de Ana/);
  assert.match(tg, /alertas@examplebank\.test/);
  assert.ok(!/Corner Cafe/.test(tg), "the body stays in the Sheet; Telegram gets only sender and subject");
});

test("the backend hides digits and addresses again even if the phone did not", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  send(rt, { text: "Pago de S/ 12.34 a nadie@gmail.test cuenta 0123456789 operación 4455", subject: "Op 778" });
  const row = rt.rows("Bank Samples")[0];
  assert.ok(!/[0-8]/.test(String(row.text)) && !/[0-8]/.test(String(row.subject)));
  assert.ok(!String(row.text).includes("nadie@"));
  assert.ok(!/[0-8]/.test(telegramTexts(rt).join("\n")));
});

test("a sample can never become a spreadsheet formula, and a bad report stores nothing", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  send(rt, { label: "=HYPERLINK(1)", text: "=SUM(A1:A9) y más texto de relleno para pasar" });
  const row = rt.rows("Bank Samples")[0];
  assert.ok(!String(row.label).includes("=") && !String(row.label).includes("("));
  for (const bad of [{ install: "nope" }, { sender: "not-an-address" }, { text: "short" }, { text: "" }]) {
    assert.equal(send(rt, bad).ok, false);
  }
  assert.equal(rt.rows("Bank Samples").length, 1);
});

test("at most 10 samples per phone per day", () => {
  const { rt } = freshApp({ small: true });
  for (let i = 0; i < 10; i++) assert.equal(send(rt, { text: "Texto de muestra número " + "x".repeat(i + 5) }).ok, true);
  const res = send(rt, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "sample_busy");
  assert.equal(send(rt, { install: "0f8c1c5e-4444-4a2b-9c3d-dddddddddddd" }).ok, true, "another phone is unaffected");
});

test("with no Telegram linked the sample is still kept; a long one is cut for Telegram only", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(send(rt, { text: "línea ".repeat(900) }).ok, true);
  assert.equal(rt.rows("Bank Samples").length, 1);

  const { rt: rt2 } = freshApp({ small: true });
  linkTelegram(rt2);
  send(rt2, { text: "palabra ".repeat(1000) });
  const sent = telegramTexts(rt2).pop();
  assert.ok(sent.length <= 4096, "fits one Telegram message");
  const kept = String(rt2.rows("Bank Samples")[0].text).length;
  assert.ok(kept > 5900 && kept <= 6000, "the Sheet keeps the full text (up to the 6,000 cap), not the Telegram cut");
});

test("a friend's own copy refuses samples", () => {
  const { rt } = freshApp({ small: true });
  friend(rt);
  const res = send(rt, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "sample_not_collected");
});

// ---- the friend's side: picking an e-mail from their own Gmail ----
test("listing shows subjects and dates of one sender only, never contents", () => {
  const { rt } = freshApp({ small: true });
  friend(rt);
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Compra con tarjeta", body: "Secreto 123", daysAgo: 2 });
  rt.svc.gmail.addEmail({ from: "otro@elsewhere.test", subject: "Hola", body: "x", daysAgo: 1 });
  const list = JSON.parse(JSON.stringify(rt.run(`listSampleEmails({ sender: "${SENDER}" })`)));
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, "Compra con tarjeta");
  assert.match(list[0].date, /^\d{4}-\d\d-\d\d$/);
  assert.ok(!JSON.stringify(list).includes("Secreto"));
});

test("getting an e-mail works only for the named sender", () => {
  const { rt } = freshApp({ small: true });
  friend(rt);
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Compra", body: "Compra por S/ 5.00", daysAgo: 1 });
  rt.svc.gmail.addEmail({ from: "otro@elsewhere.test", subject: "Privado", body: "no", daysAgo: 1 });
  const [mine] = JSON.parse(JSON.stringify(rt.run(`listSampleEmails({ sender: "${SENDER}" })`)));
  const got = JSON.parse(JSON.stringify(rt.run(`getSampleEmail({ id: "${mine.id}", sender: "${SENDER}" })`)));
  assert.match(got.body, /S\/ 5\.00/);
  assert.equal(errCode(rt, `getSampleEmail({ id: "${mine.id}", sender: "otro@elsewhere.test" })`), "sample_wrong_sender");
});

test("a bad sender address is refused before Gmail is touched; with e-mail reading off, a plain sentence", () => {
  const { rt } = freshApp({ small: true });
  friend(rt);
  assert.equal(errCode(rt, `listSampleEmails({ sender: "x y@z.test" })`), "sample_bad_sender");
  assert.equal(errCode(rt, `listSampleEmails({ sender: "a@b.test OR from:me" })`), "sample_bad_sender");
  rt.svc.props.set("FEATURES", "keepawake");
  assert.equal(errCode(rt, `listSampleEmails({ sender: "${SENDER}" })`), "feature_off");
});

// ---- from a row of More -> Not captured automatically: only the e-mails of that wording ----
test("listing with a wording shows only that kind of e-mail, found even beyond the newest 15", () => {
  const { rt } = freshApp({ small: true });
  friend(rt);
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Aviso especial 111", body: "uno", daysAgo: 100 });
  for (let i = 0; i < 20; i++) rt.svc.gmail.addEmail({ from: SENDER, subject: "Compra con tarjeta " + i, body: "x", daysAgo: 1 });
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Aviso especial 222", body: "dos", daysAgo: 50 });
  const run = (extra) => JSON.parse(JSON.stringify(rt.run(`listSampleEmails({ sender: "${SENDER}"${extra} })`)));
  const mine = run(', shape: "aviso especial #"');
  assert.equal(mine.length, 2);
  mine.forEach((m) => assert.match(m.subject, /^Aviso especial/));
  assert.equal(run(', shape: "nada parecido"').length, 0);
  assert.equal(run("").length, 15, "without a wording it is still the newest 15");
  // an older e-mail of that wording can be opened with the same wording, not without it
  const old = mine.find((m) => m.subject.endsWith("111"));
  const got = JSON.parse(JSON.stringify(rt.run(`getSampleEmail({ id: "${old.id}", sender: "${SENDER}", shape: "aviso especial #" })`)));
  assert.match(got.body, /uno/);
  assert.equal(errCode(rt, `getSampleEmail({ id: "${old.id}", sender: "${SENDER}" })`), "sample_wrong_sender");
});
