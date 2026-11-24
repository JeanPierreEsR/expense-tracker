// The bot says when a bank e-mail with a new wording could not be read (UnreadNotice.gs, owner 2026-11-24). On the owner's copy a
// heads-up (with who forwarded it); on a friend's copy the same plus "Show what JP gets" → a cleaned preview → "Send to JP", which
// posts the cleaned text to the owner's copy. Made-up senders, names, amounts and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, linkTelegram, BCP_SENDER } = require("./helpers");

const ROOT = path.join(__dirname, "..", "..");
const NEW_SUBJECT = "Constancia de algo nuevo 4821";
const BODY = ["Hola Zoe Prueba,", "Monto transferido: S/ 123.45", "Cuenta destino: 1234-5678", "Número de operación: 777888"].join("\n");

function app({ friend }) {
  const { rt } = freshApp({ small: true });
  if (friend) rt.svc.props.set("FEATURES", "gmail");
  rt.run("setSetting_('owner_names', 'Zoe Prueba Lima')");
  const chat = linkTelegram(rt);
  let mid = 2000, upd = 7000;
  const owner = [];
  rt.state.fetchHandler = (url, options) => {
    const u = String(url);
    if (u.includes("script.google.com")) { owner.push(JSON.parse(options.payload)); return { ok: true, data: { stored: true } }; }
    return /sendMessage/.test(u) ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: true };
  };
  const sent = () => rt.svc.fetchLog.filter((f) => String(f.url).endsWith("/sendMessage")).map((f) => JSON.parse(f.options.payload));
  const tap = (data) => rt.rawPost(JSON.stringify({ update_id: ++upd, callback_query: { id: "cb" + upd, data, message: { chat: { id: chat }, message_id: mid } } }));
  const scan = () => { rt.svc.props.delete("EMAIL_SCAN_LAST_AT"); return rt.run("scanEmailsGuarded_('timer')"); };
  return { rt, sent, tap, scan, owner };
}

test("BankSampleRedact.gs is an exact copy of docs/bank-sample.js (the bot cleans e-mails the same way the phone does)", () => {
  const gs = fs.readFileSync(path.join(ROOT, "backend", "BankSampleRedact.gs"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "docs", "bank-sample.js"), "utf8");
  assert.ok(gs.endsWith(js), "copy docs/bank-sample.js into backend/BankSampleRedact.gs again (below its 3-line header)");
});

test("owner's copy: one bot message per NEW wording no rule reads, naming who forwarded it; not again for the same wording", () => {
  const a = app({ friend: false });
  a.rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: NEW_SUBJECT, body: BODY });
  a.scan();
  let notes = a.sent().filter((m) => /can't read yet|aún no puedo leer/.test(m.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /constancia de algo nuevo #/);
  assert.equal(notes[0].reply_markup, undefined, "no Send button on the owner's own copy");
  a.rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Constancia de algo nuevo 9999", body: BODY });
  a.scan();
  assert.equal(a.sent().filter((m) => /can't read yet|aún no puedo leer/.test(m.text)).length, 1, "same wording: counted, not announced again");
  // A friend's forward of another new wording: announced with who forwarded it.
  a.rt.svc.gmail.addEmail({ from: "Eva <eva.otra@example.org>", subject: "Fwd: Aviso distinto",
    body: ["---------- Forwarded message ---------", "From: BCP <" + BCP_SENDER + ">", "Subject: Aviso distinto 55", "", BODY].join("\n") });
  a.scan();
  notes = a.sent().filter((m) => /can't read yet|aún no puedo leer/.test(m.text));
  assert.equal(notes.length, 2);
  assert.match(notes[1].text, /eva\.otra@example\.org/);
});

test("a first scan that finds many new wordings sends at most 3 messages and one line for the rest", () => {
  const a = app({ friend: false });
  for (let i = 0; i < 5; i++) a.rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Aviso tipo " + "abcde"[i], body: BODY });
  a.scan();
  assert.equal(a.sent().filter((m) => /can't read yet|aún no puedo leer/.test(m.text)).length, 3);
  assert.equal(a.sent().filter((m) => /2 more|2 correos más/.test(m.text)).length, 1);
});

test("friend's copy: Show → a cleaned preview → Send posts exactly that text to the owner's copy, once", () => {
  const a = app({ friend: true });
  a.rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: NEW_SUBJECT, body: BODY });
  a.scan();
  const note = a.sent().filter((m) => m.reply_markup).pop();
  const show = note.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(show, /^unrshow:/);
  assert.equal(a.owner.length, 0, "nothing leaves before the person asks");
  a.tap(show);
  const preview = a.sent().find((m) => /what JP would get|lo que recibiría JP/.test(m.text));
  assert.ok(preview);
  assert.doesNotMatch(preview.text, /123\.45|1234-5678|777888|Zoe|Prueba/, "digits and the person's names are hidden");
  assert.match(preview.text, /Monto transferido: S\/ 999\.99/, "the bank's wording stays");
  const ask = a.sent().filter((m) => m.reply_markup).pop();
  const send = ask.reply_markup.inline_keyboard[0].find((b) => /^unrsend:/.test(b.callback_data)).callback_data;
  a.tap(send);
  assert.equal(a.owner.length, 1);
  const p = a.owner[0].payload;
  assert.equal(a.owner[0].action, "reportBankSample");
  assert.equal(p.sender, BCP_SENDER);
  assert.equal(p.how, "bot");
  assert.ok(preview.text.endsWith(p.text), "what was sent is what was shown");
  assert.match(a.sent().pop().text, /Sent to JP|Enviado a JP/);
  a.tap(send);
  assert.equal(a.owner.length, 1, "a second tap does not send it again");
});

test("friend's copy: Don't send sends nothing", () => {
  const a = app({ friend: true });
  a.rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: NEW_SUBJECT, body: BODY });
  a.scan();
  const code = a.sent().filter((m) => m.reply_markup).pop().reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  a.tap("unrno:" + code);
  assert.equal(a.owner.length, 0);
  assert.match(a.sent().pop().text, /not sent|no se envió/);
});

test("the owner's copy files a bot-sent sample as how = bot", () => {
  const { rt } = freshApp({ small: true });
  const out = rt.run("reportBankSample_({ install: '0f8c1c5e-1111-4a2b-9c3d-aaaaaaaaaaaa', label: 'Eva', sender: '" + BCP_SENDER + "', subject: 'x', text: 'Monto transferido: S/ 999.99 y algo más', how: 'bot' })");
  assert.equal(out.stored, true);
  assert.equal(rt.rows("Bank Samples").pop().how, "bot");
});
