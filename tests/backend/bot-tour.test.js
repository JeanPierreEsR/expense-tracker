// The bot's own tour (BotTour.gs; plan "Bot tutorial - WhatsApp and Telegram", 2026-11-20): one message per step, moving on
// when the person really does the step, on both bots. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const PERSON = "51900000000";

function waApp(opts) {
  const { rt } = freshApp({ small: true });
  if (!(opts && opts.owner)) rt.svc.props.set("FEATURES", "base,gmail");   // a friend's copy
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_OWNER_NUMBER", PERSON);
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  const sent = [];
  let out = 0, inId = 0;
  rt.state.fetchHandler = (url, o) => {
    if (String(url).endsWith("/send")) { sent.push(JSON.parse(o.payload).message); return { messages: [{ id: "wamid.out" + (++out) }] }; }
    return { ok: true, result: { message_id: 1 } };
  };
  const post = (msg) => {
    rt.ctx.__body = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.in" + (++inId), from: PERSON, timestamp: Math.floor(Date.now() / 1000) }, msg), relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  };
  const bodyOf = (m) => (m.text && m.text.body) || (m.interactive && m.interactive.body.text) || "";
  const a = {
    rt, sent,
    text: (t, extra) => post(Object.assign({ type: "text", text: t }, extra || {})),
    tap: (id, contextId) => post({ type: "interactive", reply_id: id, context_id: contextId }),
    last: () => bodyOf(sent[sent.length - 1]),
    lastMsg: () => sent[sent.length - 1],
    said: () => sent.map(bodyOf).join("\n---\n"),
    tour: () => JSON.parse(rt.svc.props.get("BOT_TOUR") || "null"),
    done: () => rt.svc.props.get("BOT_TOUR_DONE") || "",
    entries: () => rt.rows("Entries").filter((e) => e.source === "whatsapp"),
    cardIdOf: (entryId) => rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId && /^wamid\./.test(m.message_id)).pop().message_id,
    lastRows: () => { const m = [...sent].reverse().find((x) => x.interactive && x.interactive.type === "list"); return m.interactive.action.sections[0].rows; }
  };
  return a;
}

test("a friend's first message to the WhatsApp bot starts the tour; the whole tour with a real expense", () => {
  const a = waApp();
  a.text("hola");
  assert.match(a.last(), /bot de tu app|your app's bot/i);
  assert.equal(a.tour().step, 1);
  assert.equal(a.entries().length, 0, "the greeting is the answer: no \"no amount\" for hola");
  assert.doesNotMatch(a.said(), /No encontr|couldn't find/);

  a.text("25 almuerzo");
  const [e] = a.entries();
  assert.equal(e.status, "pending");
  assert.doesNotMatch(a.said(), /Responde para editar|Reply to edit/, "no words hint on cards while the tour teaches the buttons");
  assert.equal(a.tour().step, 2);
  assert.match(a.last(), /Editar|Edit/);
  const quoted = a.lastMsg().context && a.lastMsg().context.message_id;
  assert.ok(a.rt.rows("Telegram Messages").some((m) => m.message_id === quoted && m.entry_id === e.id), "step 2 quotes the transaction");

  // Edit → Category → a pick: the change is saved, the tour moves on to Confirm.
  a.tap("waedit:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.tour().step, 2, "opening Edit is not a miss");
  assert.equal(a.tour().misses, 0);
  a.tap("wafield:" + e.id + ":category");
  const cat = a.lastRows().find((r) => /^wapick:/.test(r.id));
  a.tap(cat.id);
  assert.equal(a.tour().step, 3);
  assert.match(a.last(), /Confirmar|Confirm/);

  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.rt.rows("Entries").find((x) => x.id === e.id).status, "confirmed");
  assert.equal(a.tour().step, 4);
  assert.match(a.last(), /Responder|Reply/);
  assert.match(a.last(), /, (monto|amount) 30/, "the example combines two keywords");

  // Step 4: a reply in words to the step's message, two keywords at once.
  const stepMsg = a.lastMsg();
  a.text("descripción almuerzo con equipo, monto 30", { context_id: a.cardIdOf(e.id) });
  const changed = a.rt.rows("Entries").find((x) => x.id === e.id);
  assert.equal(changed.description, "almuerzo con equipo");
  assert.equal(Number(changed.amount), 30);
  assert.ok(stepMsg);
  assert.equal(a.tour().step, 5);
  assert.match(a.last(), /pendientes|"pending"/);

  a.text("pendientes");
  assert.equal(a.tour(), null, "finished");
  assert.ok(a.done(), "remembered as done");
  assert.match(a.last(), /ayuda|"help"/);
  assert.match(a.last(), /24/, "WhatsApp's 24-hour tip");
  assert.match(a.last(), /Responde para editar|Reply to edit/, "the last step says what that line is (short: step 4 taught replying)");
  assert.doesNotMatch(a.last(), /(monto|amount) 30/);
  a.text("12 taxi");
  assert.match(a.said().split("---").slice(-3).join(" "), /Responde para editar|Reply to edit/, "after the tour the hint comes back");

  // Done once: a later first-message situation never starts it again by itself.
  a.text("hola otra vez");
  assert.equal(a.tour(), null);
});

test("\"prueba\" makes a test transaction and step 3 asks to Discard it; nothing stays", () => {
  const a = waApp();
  a.text("hola");
  a.text("prueba");
  const [e] = a.entries();
  assert.equal(Number(e.amount), 1);
  assert.match(e.description, /Prueba|Test/);
  assert.equal(a.tour().test, true);
  assert.equal(a.tour().step, 2);
  a.text("saltar");
  assert.equal(a.tour().step, 3);
  assert.match(a.last(), /Descartar|Discard/);
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entries().length, 0, "the test is gone");
  assert.equal(a.tour().step, 5, "nothing left to reply to: the reply step is left out");
  assert.match(a.last(), /prueba ya no est|test is gone/);
  a.text("pendientes");
  assert.match(a.last(), /(monto|amount) 30/, "the full reply tip instead");
});

test("a first message that is already an expense is saved as usual and the tour starts at step 2", () => {
  const a = waApp();
  a.text("18 taxi");
  assert.equal(a.entries().length, 1);
  assert.equal(a.tour().step, 2);
});

test("two messages in a row that don't fit stop the tour; one repeats the step", () => {
  const a = waApp();
  a.text("hola");
  a.text("gracias");
  assert.equal(a.tour().step, 1);
  assert.equal(a.tour().misses, 1);
  assert.match(a.last(), /25 (almuerzo|lunch)/, "step 1 again");
  a.text("ok");
  assert.equal(a.tour(), null);
  assert.equal(a.done(), "", "lost is not done");
  assert.match(a.last(), /tutorial/);
});

test("\"salir\" stops it and counts as done; \"tutorial\" starts it again", () => {
  const a = waApp();
  a.text("hola");
  a.text("salir");
  assert.equal(a.tour(), null);
  assert.ok(a.done());
  a.text("tutorial");
  assert.equal(a.tour().step, 1);
});

test("never by itself on the owner's copy, nor for someone who already wrote to the bot; \"tutorial\" works there", () => {
  const o = waApp({ owner: true });
  o.text("hola");
  assert.equal(o.tour(), null);
  o.text("tutorial");
  assert.equal(o.tour().step, 1);

  const f = waApp();
  f.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 3600000));
  f.text("hola");
  assert.equal(f.tour(), null);
});

test("an old tour ends by itself after 24 hours", () => {
  const a = waApp();
  a.text("hola");
  const st = a.tour();
  st.at = Date.now() - 25 * 3600000;
  a.rt.svc.props.set("BOT_TOUR", JSON.stringify(st));
  a.text("25 almuerzo");
  assert.equal(a.tour(), null);
});

test("Telegram: \"tutorial\" runs the same tour with Telegram's buttons", () => {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let n = 0;
  const say = (body) => rt.rawPost(JSON.stringify(Object.assign({ update_id: 7000 + (++n) }, body)));
  const text = (t) => say({ message: { chat: { id: chat }, message_id: 800 + n, date: Math.floor(Date.now() / 1000), text: t } });
  const tap = (data, messageId) => say({ callback_query: { id: "cb" + n, data, message: { chat: { id: chat }, message_id: messageId } } });
  const sentTexts = () => rt.svc.fetchLog.filter((f) => /sendMessage/.test(f.url)).map((f) => JSON.parse(f.options.payload).text);
  const tour = () => JSON.parse(rt.svc.props.get("BOT_TOUR") || "null");

  text("tutorial");
  assert.equal(tour().step, 1);
  text("prueba");
  const e = rt.rows("Entries").filter((x) => x.source === "telegram").pop();
  assert.ok(e, "the test transaction was saved");
  assert.equal(tour().step, 2);
  text("saltar");
  assert.equal(tour().step, 3);
  const card = rt.rows("Telegram Messages").filter((m) => m.entry_id === e.id).pop().message_id;
  tap("discard:" + e.id, Number(card) || card);
  assert.equal(tour().step, 5);
  text("pendientes");
  assert.equal(tour(), null);
  const last = sentTexts().pop();
  assert.match(last, /ayuda|"help"/);
  assert.doesNotMatch(last, /24 horas|24 hours/, "no WhatsApp window tip on Telegram");
});

test("the reply step: one keyword gets one nudge to try two; without replying works too", () => {
  const a = waApp();
  a.text("hola");
  a.text("25 almuerzo");
  const [e] = a.entries();
  a.text("saltar");
  const cat = a.rt.rows("Categories").find((c) => c.type !== "income" && String(c.hidden || "") !== "yes");
  a.text("categoría " + cat.name, { context_id: a.cardIdOf(e.id) });   // a words reply at step 3 confirms a complete entry
  assert.equal(a.tour().step, 4);
  a.text("monto 40");   // not a reply: about the bot's last message, the step quoting the transaction
  assert.equal(Number(a.rt.rows("Entries").find((x) => x.id === e.id).amount), 40);
  assert.equal(a.tour().step, 4, "one keyword: asked to try two");
  assert.match(a.last(), /dos a la vez|two at once/);
  a.text("descripción taxi", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.tour().step, 5, "a second single change is accepted: nobody gets stuck");
});

test("the bot's examples are the person's own: their accounts, platform, friends and currency; never someone else's", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "Strings.gs"), "utf8");
  const botLines = src.split("\n").filter((l) => /^\s*"(bot|help|whatsapp|botTour)\./.test(l) || /^\s*(en|es): "Here is|^\s*(en|es): "Esto es/.test(l));
  // The owner's own banks, cards and apps must never be an example (owner, 2026-11-20: "too tailored to me").
  const owners = /\b(Interbank|Diners|Plin|Hapi|BCP|Scotiabank|BBVA|Yape)\b|S\/ \d/;
  const bad = botLines.filter((l) => owners.test(l) && !/"(bot|help|whatsapp)\.(photo|rail)/.test(l));
  assert.deepEqual(bad.map((l) => l.trim().slice(0, 80)), []);

  const a = waApp();
  const own = a.rt.rows("Payment Methods").filter((p) => p.type !== "investment" && String(p.hidden || "") !== "yes");
  const help = a.rt.run("tr_('help.o.paymentMethod')");
  assert.ok(own.some((p) => help.includes(`"account ${p.nickname}"`)), help);
  assert.match(a.rt.run("tr_('help.currency')"), /"currency (USD|EUR)"/);
});

test("too few accounts: transfer examples say (account) instead of naming one twice", () => {
  const a = waApp();
  a.rt.run(`(function () { var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payment Methods'); var rows = getAllRows('Payment Methods');
    var keep = rows.filter(function (p) { return p.type !== 'investment'; })[0].id;
    rows.forEach(function (p) { if (p.id !== keep && p.type !== 'investment') updateRowFields_('Payment Methods', p.id, { hidden: 'yes' }); }); })()`);
  a.rt.run("BOT_EXAMPLES_RUN_ = null; CacheService.getScriptCache().remove(BOT_EXAMPLES_CACHE_KEY_)");
  const t = a.rt.run("tr_('help.t.combine', null, 'en')");
  assert.match(t, /"from \(account\), to \(account\), amount 90"/);
});

test("English copy: the tour asks for the English words; a change other than the category moves on and says Confirm needs one", () => {
  const a = waApp();
  a.rt.run("setSetting_('language', 'en')");
  a.text("hola");
  assert.match(a.last(), /Write "test"/);
  assert.match(a.last(), /Write "exit"/);
  assert.doesNotMatch(a.last(), /prueba|salir/);
  a.text("test");
  const [e] = a.entries();
  assert.equal(a.tour().step, 2);
  assert.match(a.last(), /"skip"/);
  a.tap("waedit:" + e.id, a.cardIdOf(e.id));
  a.tap("wafield:" + e.id + ":account");
  const acc = a.lastRows().find((r) => /^wapick:/.test(r.id));
  a.tap(acc.id);
  assert.equal(a.tour().step, 3, "any change through Edit counts");
  assert.match(a.last(), /Discard/, "test mode: Discard needs no category");

  const b = waApp();
  b.rt.run("setSetting_('language', 'en')");
  b.text("hola");
  b.text("25 snack");
  const [f] = b.entries();
  b.rt.run(`updateRowFields_('Entries', ${JSON.stringify(f.id)}, { category_id: '' })`);
  b.tap("waedit:" + f.id, b.cardIdOf(f.id));
  b.tap("wafield:" + f.id + ":account");
  b.tap(b.lastRows().find((r) => /^wapick:/.test(r.id)).id);
  assert.equal(b.tour().step, 3);
  assert.match(b.last(), /still has no category/);
  b.text("exit");
  assert.equal(b.tour(), null);
});

test("the tour's words never rename a transaction: \"saltar\" at every step moves on, the confirmed expense keeps its name", () => {
  const a = waApp();
  a.text("hola");
  a.text("25 almuerzo");
  const [e] = a.entries();
  assert.equal(a.tour().step, 2);
  a.text("saltar");
  assert.equal(a.tour().step, 3);
  a.tap("waedit:" + e.id, a.cardIdOf(e.id));               // Confirm needs a category
  a.tap("wafield:" + e.id + ":category");
  a.tap(a.lastRows().find((r) => /^wapick:/.test(r.id)).id);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.tour().step, 4);
  a.text("saltar");                                        // plain: was the confirmed expense's new description (testers, 2026-11-20)
  assert.equal(a.tour().step, 5);
  a.text("saltar", { context_id: a.cardIdOf(e.id) });      // as a reply to the card too
  assert.equal(a.tour(), null, "skipping the last step finishes the tour");
  assert.ok(a.done(), "and counts it as done");
  const after = a.rt.rows("Entries").find((x) => x.id === e.id);
  assert.equal(after.status, "confirmed");
  assert.match(after.description, /almuerzo/i);
  assert.doesNotMatch(after.description, /saltar/i);
});

test("a word that does not fit the step repeats it, and is not counted as a miss", () => {
  const a = waApp();
  a.text("hola");
  a.text("25 almuerzo");
  const [e] = a.entries();
  a.text("prueba");                                        // the test word after step 1
  assert.equal(a.tour().step, 2);
  assert.equal(a.tour().misses, 0);
  assert.match(a.rt.rows("Entries").find((x) => x.id === e.id).description, /almuerzo/i);
});

test("\"ok\", \"gracias\", \"exit\"… on their own never rename the last transaction, outside the tour, on both bots", () => {
  const a = waApp({ owner: true });
  a.text("25 cafe");
  const [e] = a.entries();
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  for (const w of ["ok", "Gracias!", "exit", "listo", "skip"]) {
    a.text(w);
    assert.match(a.last(), /No cambié nada|Nothing changed/, w + " gets the hint");
  }
  a.text("ok", { context_id: a.cardIdOf(e.id) });          // as a reply to the card too
  assert.match(a.rt.rows("Entries").find((x) => x.id === e.id).description, /cafe/i);
  a.text("descripción café con Ana");                       // real words still edit it (the last-message rule stays)
  assert.match(a.rt.rows("Entries").find((x) => x.id === e.id).description, /Ana/);

  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let n = 0;
  const text = (t, replyTo) => rt.rawPost(JSON.stringify({ update_id: 9000 + (++n), message: Object.assign({ chat: { id: chat }, message_id: 900 + n, date: Math.floor(Date.now() / 1000), text: t }, replyTo ? { reply_to_message: { message_id: replyTo } } : {}) }));
  const sentTexts = () => rt.svc.fetchLog.filter((f) => /sendMessage/.test(f.url)).map((f) => JSON.parse(f.options.payload).text);
  text("25 cafe");
  const te = rt.rows("Entries").filter((x) => x.source === "telegram").pop();
  const card = rt.rows("Telegram Messages").filter((m) => m.entry_id === te.id).pop().message_id;
  text("ok");
  assert.match(sentTexts().pop(), /No cambié nada|Nothing changed/);
  text("gracias", Number(card) || card);
  assert.match(sentTexts().pop(), /No cambié nada|Nothing changed/);
  assert.match(rt.rows("Entries").find((x) => x.id === te.id).description, /cafe/i);
});
