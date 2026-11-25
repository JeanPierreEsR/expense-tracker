// Forwarded bank e-mails (ForwardedEmail.gs, 2026-11-22): a bank e-mail forwarded to the app's Gmail is read like the bank's own, dated
// on the ORIGINAL e-mail's day, waiting in Needs review, with who forwarded it. Inline forwards (Gmail, iPhone Mail, Outlook; English and
// Spanish) and "Forward as attachment" (.eml). Made-up amounts, shops, addresses and operation numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, BCP_SENDER, bcpEmail } = require("./helpers");
const { TZ } = require("../harness/fake-google");

const OTHER = "eva.otra@example.org";
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
// A day `daysAgo` back, as the person's calendar shows it: { y, m, d, iso }.
function dayAgo(daysAgo) {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - daysAgo * 86400000));
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d, iso };
}
const bankBody = (amount, op) => ["Total del consumo: S/ " + amount, "Empresa: Tienda Prueba", "Número de Tarjeta de Débito: ****1234",
  "Número de operación: " + op].join("\n");
const SUBJECT = "Realizaste un consumo con tu tarjeta de débito BCP";

function gmailForward({ amount, op, daysAgo }) {
  const k = dayAgo(daysAgo);
  return ["Te reenvío esto.", "", "---------- Forwarded message ---------", "From: BCP <" + BCP_SENDER + ">",
    "Date: Sat, " + MONTHS_EN[k.m - 1] + " " + k.d + ", " + k.y + " at 12:44 PM", "Subject: " + SUBJECT, "To: <" + OTHER + ">", "",
    bankBody(amount, op)].join("\n");
}

function copies() {
  const owner = freshApp({ small: true }).rt;   // GmailApp
  const friend = freshApp({ small: true }).rt;  // the read-only Gmail service
  friend.svc.props.set("FEATURES", "gmail");
  return { owner, friend };
}
const scan = (rt) => { rt.svc.props.delete("EMAIL_SCAN_LAST_AT"); return JSON.parse(JSON.stringify(rt.run("scanEmailsGuarded_('timer')"))); };
const byOp = (rt, op) => rt.rows("Entries").filter((e) => String(e.external_id) === op);

for (const [name, pick] of [["owner's copy", (c) => c.owner], ["friend's copy", (c) => c.friend]]) {
  test(name + ": an inline Gmail forward of an old purchase is read, dated on the original day, waiting, with who sent it", () => {
    const rt = pick(copies());
    rt.svc.gmail.addEmail({ from: "Eva <" + OTHER + ">", subject: "Fwd: " + SUBJECT, body: gmailForward({ amount: "45.10", op: "990001", daysAgo: 40 }) });
    scan(rt);
    const made = byOp(rt, "990001");
    assert.equal(made.length, 1);
    assert.equal(made[0].status, "pending");
    assert.equal(Number(made[0].amount), 45.1);
    assert.equal(made[0].date, dayAgo(40).iso, "the original e-mail's day, not the forward's");
    assert.equal(made[0].forwarded_by, OTHER);
    scan(rt);
    assert.equal(byOp(rt, "990001").length, 1, "read once");
  });

  test(name + ": two e-mails forwarded as attachments make two entries", () => {
    const rt = pick(copies());
    const k1 = dayAgo(10), k2 = dayAgo(70);
    const eml1 = ["From: BCP <" + BCP_SENDER + ">", "To: " + OTHER, "Subject: =?UTF-8?B?" + Buffer.from(SUBJECT).toString("base64") + "?=",
      "Date: Mon, " + k1.d + " " + MONTHS_EN[k1.m - 1] + " " + k1.y + " 12:44:10 -0500", "MIME-Version: 1.0",
      "Content-Type: multipart/alternative; boundary=\"b1\"", "", "--b1", "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64", "",
      Buffer.from("<table><tr><td>Total del consumo:</td><td>S/ 12.30</td></tr><tr><td>Empresa:</td><td>Tienda Prueba</td></tr>" +
        "<tr><td>Número de Tarjeta de Débito:</td><td>****1234</td></tr><tr><td>Número de operación:</td><td>990011</td></tr></table>").toString("base64"),
      "--b1--", ""].join("\r\n");
    const eml2 = ["From: notificaciones BCP <" + BCP_SENDER + ">", "Subject: " + SUBJECT,
      "Date: Tue, " + k2.d + " " + MONTHS_EN[k2.m - 1] + " " + k2.y + " 09:05:00 -0500", "Content-Type: text/plain; charset=ISO-8859-1",
      "Content-Transfer-Encoding: quoted-printable", "",
      "Total del consumo: S/ 7.00", "Empresa: Tienda Prueba", "N=FAmero de Tarjeta de D=E9bito: ****1234", "N=FAmero de operaci=F3n: 990012", ""].join("\r\n");
    rt.svc.gmail.addEmail({ from: OTHER, subject: "Fwd: 2 messages", body: "", attachments: [
      { name: "Realizaste un consumo.eml", type: "message/rfc822", bytes: Buffer.from(eml1, "latin1") },
      { name: "otro.eml", type: "message/rfc822", bytes: Buffer.from(eml2, "latin1") }] });
    scan(rt);
    const a = byOp(rt, "990011"), b = byOp(rt, "990012");
    assert.equal(a.length, 1);
    assert.equal(Number(a[0].amount), 12.3);
    assert.equal(a[0].date, k1.iso);
    assert.equal(b.length, 1);
    assert.equal(Number(b[0].amount), 7);
    assert.equal(b[0].date, k2.iso);
  });
}

test("an iPhone Mail forward in Spanish, as HTML", () => {
  const { friend: rt } = copies();
  const k = dayAgo(5);
  const html = "<div>Mira</div><div><br><blockquote type=\"cite\"><b>De:</b> BCP &lt;" + BCP_SENDER + "&gt;<br><b>Fecha:</b> " + k.d + " de " +
    MONTHS_ES[k.m - 1] + " de " + k.y + ", 12:44:10 p.m. GMT-5<br><b>Para:</b> " + OTHER + "<br><b>Asunto:</b> " + SUBJECT + "<br></blockquote></div>" +
    "<blockquote type=\"cite\"><p>Total del consumo: S/ 33.00</p><p>Empresa: Tienda Prueba</p><p>Número de Tarjeta de Débito: ****1234</p>" +
    "<p>Número de operación: 990021</p></blockquote>";
  rt.svc.gmail.addEmail({ from: OTHER, subject: "Fwd: " + SUBJECT, body: "", html });
  scan(rt);
  const made = byOp(rt, "990021");
  assert.equal(made.length, 1);
  assert.equal(made[0].date, k.iso);
});

test("a purchase both sent by the bank and forwarded is one entry; a message that only mentions the bank is ignored", () => {
  const { friend: rt } = copies();
  bcpEmail(rt, { amount: "20.00", op: "990031", daysAgo: 1 });
  rt.svc.gmail.addEmail({ from: OTHER, subject: "Fwd", body: gmailForward({ amount: "20.00", op: "990031", daysAgo: 1 }) });
  rt.svc.gmail.addEmail({ from: OTHER, subject: "hola", body: "Mi banco me escribe desde " + BCP_SENDER + " y no sé por qué." });
  const before = rt.rows("Entries").length;
  scan(rt);
  assert.equal(byOp(rt, "990031").length, 1);
  assert.equal(rt.rows("Entries").length, before + 1);
});

test("the person's other addresses: kept, checked, and sent to the app", () => {
  const { friend: rt } = copies();
  assert.deepEqual(rt.api("setForwardAddresses", { addresses: [" Eva.Otra@Example.org ", OTHER] }).addresses, [OTHER]);
  assert.deepEqual(JSON.parse(JSON.stringify(rt.run("getEmailInfo_()"))).forwardFrom, [OTHER]);
  assert.throws(() => rt.api("setForwardAddresses", { addresses: ["not an address"] }), /not an email address|no es una direcci/);
  assert.equal(rt.run("getCapabilities_()").forwardedEmails, true);
});

test("quoted dates as mail programs write them", () => {
  const { owner: rt } = copies();
  const day = (s) => { const d = rt.run("forwardParseDate_(" + JSON.stringify(s) + ")"); return d ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) : null; };
  assert.equal(day("Sat, Mar 21, 2026 at 12:44 PM"), "2026-03-21, 12:44");
  assert.equal(day("mar, 17 mar 2026 a las 9:05"), "2026-03-17, 09:05");
  assert.equal(day("sábado, 21 de marzo de 2026 23:10"), "2026-03-21, 23:10");
  assert.equal(day("March 21, 2026 at 12:44:10 AM GMT-5"), "2026-03-21, 00:44");
  assert.equal(day("21 de marzo de 2026, 12:44:10 p. m. GMT-5"), "2026-03-21, 12:44");
  assert.equal(day("Sat, 21 Mar 2026 12:44:10 -0500"), "2026-03-21, 12:44");
  assert.equal(day("21/03/2026 08:00"), "2026-03-21, 08:00");
  assert.equal(day("not a date"), null);
  assert.equal(day("Sat, Mar 21, 2099 at 12:44 PM"), null, "never a future date");
});

test("the bots' card (WhatsApp and Telegram share it) says who forwarded it, unless it is one of the person's addresses", () => {
  const { friend: rt } = copies();
  rt.svc.gmail.addEmail({ from: "Eva <" + OTHER + ">", subject: "Fwd: " + SUBJECT, body: gmailForward({ amount: "45.10", op: "990041", daysAgo: 3 }) });
  scan(rt);
  const id = byOp(rt, "990041")[0].id;
  const card = () => rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(id)}), null, null, {})`);
  assert.match(card(), new RegExp("Forwarded by " + OTHER.replace(/\./g, "\\.")));
  rt.api("setForwardAddresses", { addresses: [OTHER] });
  assert.doesNotMatch(card(), /Forwarded by/);
  rt.api("setForwardAddresses", { addresses: [] });
  rt.run(`setEntryField_(${JSON.stringify(id)}, 'status', 'confirmed')`);
  assert.doesNotMatch(card(), /Forwarded by/, "only while it waits");
});

test("a sender name that hides the person's own address does not hide 'Forwarded by'; an unreadable sender says 'unknown'", () => {
  const { friend: rt } = copies();
  const own = String(rt.run("mailboxAddress_()") || "").toLowerCase();
  assert.ok(own, "the copy has an address");
  rt.svc.gmail.addEmail({ from: '"x<' + own + '>" <spoof@evil.example>', subject: "Fwd: " + SUBJECT, body: gmailForward({ amount: "14.50", op: "990051", daysAgo: 1 }) });
  rt.svc.gmail.addEmail({ from: own + " (spoof2@evil.example) <spoof2@evil.example>", subject: "Fwd: " + SUBJECT, body: gmailForward({ amount: "14.60", op: "990052", daysAgo: 1 }) });
  rt.svc.gmail.addEmail({ from: "Nobody <not-an-address>", subject: "Fwd: " + SUBJECT, body: gmailForward({ amount: "14.70", op: "990053", daysAgo: 1 }) });
  scan(rt);
  assert.equal(byOp(rt, "990051")[0].forwarded_by, "spoof@evil.example");
  assert.equal(byOp(rt, "990052")[0].forwarded_by, "spoof2@evil.example");
  const unknown = byOp(rt, "990053")[0];
  assert.equal(unknown.forwarded_by, "?");
  const card = rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(unknown.id)}), null, null, {})`);
  assert.match(card, /Forwarded by an unknown sender|Reenviado por un remitente desconocido/);
  assert.equal(rt.run("forwardAddressOf_('Eva <eva@example.org>')"), "eva@example.org");
  assert.equal(rt.run("forwardAddressOf_('eva@example.org')"), "eva@example.org");
});

// Owner, 2026-11-24: a friend's forward of a bank e-mail no rule knows belongs in "Bank emails I couldn't read" (that is how rules get
// built), but the name it was sent to is the friend's: never learned as the person's own. Their own forward teaches names as before.
test("someone else's forward of an unknown bank e-mail is logged as unread, but its To: name is not learned", () => {
  const rt = freshApp({ small: true }).rt;
  const k = dayAgo(3);
  const fwd = (to, n) => ["---------- Forwarded message ---------", "From: BCP <" + BCP_SENDER + ">",
    "Date: Sat, " + MONTHS_EN[k.m - 1] + " " + k.d + ", " + k.y + " at 12:44 PM", "Subject: Constancia de algo nuevo " + n, "To: " + to, "",
    "Un texto que ninguna regla conoce."].join("\n");
  const unread = () => { try { return rt.rows("Unread Emails"); } catch (e) { return []; } };
  const settings = () => JSON.stringify(rt.run("getSettingsMap()"));
  rt.svc.gmail.addEmail({ from: "Eva <" + OTHER + ">", subject: "Fwd: Constancia de algo nuevo 123", body: fwd("Zoe Prueba Lima <zoe@example.org>", 123) });
  scan(rt);
  assert.equal(unread().length, 1, "the wording no rule knows is listed, whoever forwarded it");
  assert.equal(unread()[0].kind, "no_rule");
  assert.ok(!settings().includes("Zoe"), "the name it was sent to is the friend's, not learned as the person's");
  // Forwarded by one of the person's own addresses: their mail, so its name is learned as before.
  rt.run("setForwardAddresses({ addresses: ['" + OTHER + "'] })");
  rt.svc.gmail.addEmail({ from: "Eva <" + OTHER + ">", subject: "Fwd: Constancia de algo nuevo 456", body: fwd("Ivo Prueba Sur <" + OTHER + ">", 456) });
  scan(rt);
  assert.ok(settings().includes("Ivo"), "their own forward teaches their name");
});

// Owner, 2026-11-25: a forwarded THREAD (Gmail's "Forward all" on a conversation) quotes several e-mails one after another; each bank
// e-mail in it is its own entry, dated on its own day, and a message in the thread that is not the bank's is skipped.
function quoted({ from, amount, op, daysAgo, body }) {
  const k = dayAgo(daysAgo);
  return ["---------- Forwarded message ---------", "From: " + from,
    "Date: Sat, " + MONTHS_EN[k.m - 1] + " " + k.d + ", " + k.y + " at 12:44 PM", "Subject: " + SUBJECT, "To: <" + OTHER + ">", "",
    body || bankBody(amount, op), ""].join("\n");
}

test("a forwarded thread: every bank e-mail in it is read, each on its own day; a reply in between is skipped", () => {
  const { friend: rt } = copies();
  const bank = "BCP <" + BCP_SENDER + ">";
  const body = ["Te reenvío todo el hilo.", "",
    quoted({ from: bank, amount: "11.10", op: "990061", daysAgo: 30 }),
    quoted({ from: "Eva <" + OTHER + ">", daysAgo: 25, body: "¿Esto es tuyo? Total del consumo: S/ 999.00" }),
    quoted({ from: bank, amount: "22.20", op: "990062", daysAgo: 20 }),
    quoted({ from: bank, amount: "33.30", op: "990063", daysAgo: 10 })].join("\n");
  rt.svc.gmail.addEmail({ from: "Eva <" + OTHER + ">", subject: "Fwd: " + SUBJECT, body });
  const before = rt.rows("Entries").length;
  scan(rt);
  for (const [op, amount, daysAgo] of [["990061", 11.1, 30], ["990062", 22.2, 20], ["990063", 33.3, 10]]) {
    const made = byOp(rt, op);
    assert.equal(made.length, 1, op);
    assert.equal(Number(made[0].amount), amount, op + ": its own amount, not the next e-mail's");
    assert.equal(made[0].date, dayAgo(daysAgo).iso, op + ": its own day");
    assert.equal(made[0].status, "pending");
  }
  assert.equal(rt.rows("Entries").length, before + 3, "nothing from Eva's reply");
  scan(rt);
  assert.equal(rt.rows("Entries").length, before + 3, "read once");
});

test("a bank e-mail's own 'De: / Para:' lines do not cut it short", () => {
  const { owner: rt } = copies();
  const lines = ["Te reenvío esto.", "", "---------- Forwarded message ---------", "From: BCP <" + BCP_SENDER + ">",
    "Date: Sat, Mar 21, 2026 at 12:44 PM", "Subject: Constancia", "", "De: Ana Lo*", "Para: Ivo Su*", "Monto: S/ 10.00", "Número de operación: 1"];
  const all = rt.run("forwardUnwrapAll_(" + JSON.stringify(lines.join("\n")) + ", ['" + BCP_SENDER.toLowerCase() + "'])");
  assert.equal(all.length, 1);
  assert.match(all[0].body, /^De: Ana Lo\nPara: Ivo Su\nMonto: S\/ 10\.00\nNúmero de operación: 1$/);
});
