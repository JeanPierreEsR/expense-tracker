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
