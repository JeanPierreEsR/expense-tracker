// Stage 2 of the friends & family rollout: reading e-mail through the read-only Gmail service
// (backend/GmailReader.gs) must give the bank rules the same text the old GmailApp gave.
// Made-up e-mails only. The fake Gmail serves them the way the real API does: messages,
// headers, bodies as base64url parts, attachments fetched separately.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail, BCP_SENDER } = require("./helpers");

const readonly = (rt) => rt.svc.props.set("GMAIL_READER", "readonly");
const q = (rt, code) => JSON.parse(JSON.stringify(rt.run(code)));

test("which way is used: FEATURES (installer copies) forces read-only; otherwise GMAIL_READER decides", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.delete("GMAIL_READER");   // (the suite can be run with GMAIL_READER=readonly; this test starts from "not switched")
  assert.equal(rt.run("gmailUsesReadonly_()"), false, "owner's copy keeps the old way until switched");
  readonly(rt);
  assert.equal(rt.run("gmailUsesReadonly_()"), true);
  const { rt: rt2 } = freshApp({ small: true });
  rt2.svc.props.set("FEATURES", "gmail");
  assert.equal(rt2.run("gmailUsesReadonly_()"), true, "a copy made by the installer never uses GmailApp");
});

test("a message read the new way has the same subject, sender, date and text as the old way", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "42.00", merchant: "Corner Cafe", op: "R-1" });
  const oldWay = q(rt, `(function () { var m = gmailSearchMessages_("from:${BCP_SENDER} newer_than:3d")[0];
    return { id: m.getId(), subject: m.getSubject(), from: m.getFrom(), to: m.getTo(), body: m.getPlainBody(), at: m.getDate().getTime() }; })()`);
  readonly(rt);
  const newWay = q(rt, `(function () { var m = gmailSearchMessages_("from:${BCP_SENDER} newer_than:3d")[0];
    return { id: m.getId(), subject: m.getSubject(), from: m.getFrom(), to: m.getTo(), body: m.getPlainBody(), at: m.getDate().getTime() }; })()`);
  assert.deepEqual(newWay, oldWay);
});

test("the content of a message is only downloaded when something asks for it", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "R-2" });
  readonly(rt);
  let gets = 0; const orig = rt.svc.gmail.advanced.Users.Messages.get;
  rt.svc.gmail.advanced.Users.Messages.get = (...a) => { gets++; return orig(...a); };
  rt.run(`var __ms = gmailSearchMessages_("from:${BCP_SENDER} newer_than:3d"); __ms[0].getId();`);
  assert.equal(gets, 0, "listing and reading the id costs no download");
  rt.run("__ms[0].getSubject(); __ms[0].getPlainBody();");
  assert.equal(gets, 1, "one download serves every field");
});

test("an e-mail that is only HTML is turned into readable text, with accents and entities", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: "x@example.com", subject: "html", html: "<div>Total del consumo:&nbsp;S/ 12.50</div><p>Empresa: Caf&eacute; &amp; Bar</p><table><tr><td>Operaci&#243;n</td><td>987654</td></tr></table><style>.a{color:red}</style>" });
  readonly(rt);
  const text = rt.run('gmailSearchMessages_("from:x@example.com newer_than:3d")[0].getPlainBody()');
  assert.match(text, /Total del consumo: S\/ 12\.50/);
  assert.match(text, /Empresa: Café & Bar/);
  assert.match(text, /Operación 987654/);
  assert.ok(!/color:red|<div/.test(text), "no markup or style text left");
});

test("when an e-mail has both a plain and an HTML version, the plain one is used (as GmailApp did)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: "x@example.com", subject: "both", body: "PLAIN VERSION", html: "<b>HTML VERSION</b>" });
  readonly(rt);
  assert.equal(rt.run('gmailSearchMessages_("from:x@example.com newer_than:3d")[0].getPlainBody()'), "PLAIN VERSION");
});

test("subjects that arrive as encoded words are decoded", () => {
  const { rt } = freshApp({ small: true });
  const enc = "=?UTF-8?B?" + Buffer.from("Realizaste un consumo", "utf8").toString("base64") + "?= =?UTF-8?Q?_con_tu_tarjeta_d=C3=A9bito?=";
  assert.equal(rt.run(`gmailDecodeMimeWords_(${JSON.stringify(enc)})`), "Realizaste un consumo con tu tarjeta débito");
  assert.equal(rt.run('gmailDecodeMimeWords_("Plain subject")'), "Plain subject");
});

test("statement PDFs: attachments are listed with name and size, and the bytes are fetched on demand", () => {
  const { rt } = freshApp({ small: true });
  const bytes = [37, 80, 68, 70, 45, 49];   // "%PDF-1"
  rt.svc.gmail.addEmail({ from: "Owner <test@example.com>", to: "Owner <test@example.com>", subject: "estado", body: "", attachments: [{ name: "account_summary_0001.pdf", size: 3000, bytes }] });
  readonly(rt);
  const out = q(rt, `(function () { var m = gmailSearchMessages_("from:me to:me has:attachment newer_than:75d")[0];
    var a = m.getAttachments({ includeInlineImages: false })[0]; return { n: m.getAttachments().length, name: a.getName(), size: a.getSize(), bytes: a.getBytes().map(function (b) { return b & 255; }) }; })()`);
  assert.deepEqual(out, { n: 1, name: "account_summary_0001.pdf", size: 3000, bytes });
});

test("a long search is read in pages and stops at the cap", () => {
  const { rt } = freshApp({ small: true });
  for (let i = 0; i < 7; i++) bcpEmail(rt, { op: "PG-" + i, daysAgo: i * 0.01 });
  readonly(rt);
  assert.equal(rt.run(`gmailSearchMessages_("from:${BCP_SENDER} newer_than:3d").length`), 7);
  assert.equal(rt.run(`gmailSearchMessages_("from:${BCP_SENDER} newer_than:3d", { max: 3 }).length`), 3);
});

test("the side-by-side check reports the two ways agree on made-up bank e-mails", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "10.00", merchant: "Cafe One", op: "C-1" });
  bcpEmail(rt, { amount: "20.00", merchant: "Cafe Two", op: "C-2" });
  bcpEmail(rt, { subject: "Promociones de verano", amount: "0", op: "" });
  const s = q(rt, "compareGmailReaders({ days: 7 })");
  assert.equal(s.messagesCompared, 3);
  assert.equal(s.onlyOld + s.onlyNew, 0);
  assert.equal(s.bodiesIdentical, 3);
  assert.equal(s.extractionDiffers.length, 0);
  assert.ok(s.ruleMatchedBoth >= 2 && s.extractionSame === s.ruleMatchedBoth);
  assert.ok(!/Cafe One|Cafe Two/.test(JSON.stringify(s)), "the report carries no e-mail content");
});

test("without the e-mail approval, asking for a statement PDF still says so plainly after the switch", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "keepawake");
  assert.throws(() => rt.run('requireFeature_("gmail", "feature.gmailOff")'), /not turned on/);
});

// ---- Google's decoders are strict: the same e-mail text can arrive padded, line-wrapped or in the other alphabet ----
// (A friend's first Yape was never read: every e-mail of hers failed with "Could not decode string".)
const withBodyData = (rt, transform) => {
  const orig = rt.svc.gmail.advanced.Users.Messages.get;
  rt.svc.gmail.advanced.Users.Messages.get = (...a) => {
    const r = orig(...a);
    const walk = (p) => { if (p.body && p.body.data) p.body.data = transform(p.body.data); (p.parts || []).forEach(walk); };
    walk(r.payload);
    return r;
  };
  return orig;
};
const bodyOf = (rt) => rt.run(`gmailSearchMessages_("from:${BCP_SENDER} newer_than:3d")[0].getPlainBody()`);

test("e-mail text is read whether Gmail pads it, wraps its lines, or uses the standard alphabet", () => {
  const variants = {
    padded: (d) => d + "=".repeat((4 - (d.length % 4)) % 4),
    "line-wrapped": (d) => d.replace(/(.{20})/g, "$1\r\n"),
    "standard alphabet": (d) => d.replace(/-/g, "+").replace(/_/g, "/"),
  };
  Object.entries(variants).forEach(([name, transform]) => {
    const { rt } = freshApp({ small: true });
    bcpEmail(rt, { amount: "42.00", merchant: "Corner Cafe", op: "DEC-" + name });
    readonly(rt);
    const plain = bodyOf(rt);
    withBodyData(rt, transform);
    assert.equal(bodyOf(rt), plain, name + " text decodes to the same words");
  });
});

test("text that cannot be decoded fails with a message naming the part, with no e-mail words in it", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "DEC-BAD" });
  readonly(rt);
  withBodyData(rt, () => "A");   // one character is not valid base64 in any form
  assert.throws(() => bodyOf(rt), /Could not read the text\/plain part of an e-mail \(1 characters, 0 unexpected characters\)/);
});

test("an e-mail whose text cannot be read is not marked handled, so the next scan tries it again", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "DEC-RETRY" });
  readonly(rt);
  const orig = withBodyData(rt, () => "A");
  const first = JSON.parse(JSON.stringify(rt.run("processEmails()")));
  assert.equal(first.errors, 1);
  assert.equal(first.created, 0);
  rt.svc.gmail.advanced.Users.Messages.get = orig;   // Gmail now answers normally
  const second = JSON.parse(JSON.stringify(rt.run("processEmails()")));
  assert.equal(second.created, 1, "the same e-mail becomes an entry on the retry");
});
