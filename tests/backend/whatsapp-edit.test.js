// WhatsApp Edit and conversions (owner's plan "WhatsApp Edit and conversions", 2026-11-16): Edit taps only save; replies in
// words still confirm and re-edit a confirmed transaction from any of its messages; typed values are checked; Repayment / Loan
// buttons convert straight away; unknown friends are added in the app. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const OWNER = "51900000000";

function waApp() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  const sent = [];
  let inId = 0;
  rt.state.fetchHandler = (url, opts) => {
    if (String(url).endsWith("/send")) { sent.push(JSON.parse(opts.payload).message); return { messages: [{ id: "wamid.out" + sent.length }] }; }
    return { ok: true };
  };
  const post = (msg) => {
    rt.ctx.__body = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.in" + (++inId), from: OWNER }, msg), relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  };
  const a = {
    rt, sent,
    text: (t, extra) => post(Object.assign({ type: "text", text: t }, extra || {})),
    tap: (id, contextId) => post({ type: "interactive", reply_id: id, context_id: contextId }),
    waEntries: () => rt.rows("Entries").filter((e) => e.source === "whatsapp"),
    entry: (id) => rt.rows("Entries").find((x) => x.id === id),
    cardIdOf: (entryId) => rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId && /^wamid\./.test(m.message_id)).pop().message_id,
    lastBody: () => { const m = sent[sent.length - 1]; return (m.text && m.text.body) || m.interactive.body.text; },
    lastRows: () => sent[sent.length - 1].interactive.action.sections[0].rows,
    idOf: (i) => "wamid.out" + (i + 1)
  };
  return a;
}

test("Edit taps only save: several fields, the message keeps its buttons, then one Confirm", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.tap(`wafield:${e.id}:category`);
  a.tap(a.lastRows().find((r) => r.id.startsWith("wapick:")).id);
  assert.ok(a.entry(e.id).category_id);
  assert.equal(a.entry(e.id).status, "pending", "a pick does not confirm");
  const card = a.sent[a.sent.length - 1];
  assert.deepEqual(card.interactive.action.buttons.map((b) => b.reply.id.split(":")[0]), ["confirm", "waedit", "discard"]);
  a.tap(`wafield:${e.id}:amount`);
  a.text("30.50");
  assert.equal(Number(a.entry(e.id).amount), 30.5);
  assert.equal(a.entry(e.id).status, "pending", "a typed value does not confirm");
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entry(e.id).status, "confirmed");
});

test("replies in words still confirm, and a confirmed transaction is re-edited by replying to its 'Confirmed' message", () => {
  const a = waApp();
  a.text("18 taxi transport");
  const [e] = a.waEntries();
  a.text("amount 20", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id).status, "confirmed", "a reply in words confirms a complete entry");
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  const answerIdx = a.sent.length - 1;
  assert.match(a.sent[answerIdx].text.body, /already/i);
  a.text("amount 99", { context_id: a.idOf(answerIdx) });
  assert.equal(Number(a.entry(e.id).amount), 99);
  assert.equal(a.entry(e.id).status, "confirmed");
});

test("a reply with edit words to a message that is not about a transaction edits nothing", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.text("ayuda");   // the general help is not about a transaction
  const helpIdx = a.sent.length - 1;
  a.text("amount 77", { context_id: a.idOf(helpIdx) });
  assert.equal(Number(a.entry(e.id).amount), 25);
  assert.equal(a.lastBody(), a.rt.run("tr_('bot.replyToACard')"));
});

test("typed values: only the right shape is taken; a new purchase stays a purchase; taps cancel; late answers expire", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.tap(`wafield:${e.id}:amount`);
  a.text("abc");
  assert.equal(a.lastBody(), a.rt.run("tr_('whatsapp.ask.amount')"), "asked again");
  a.text("12 cena");
  assert.equal(Number(a.entry(e.id).amount), 25, "a new purchase is not taken as the amount");
  assert.ok(a.waEntries().some((x) => x.description === "Cena" && Number(x.amount) === 12), "it became its own purchase");
  a.text("30");
  assert.equal(Number(a.entry(e.id).amount), 30, "the question stayed open");

  a.tap(`wafield:${e.id}:amount`);
  a.tap(`waedit:${e.id}`);
  const before = a.waEntries().length;
  a.text("40 taxi");
  assert.equal(Number(a.entry(e.id).amount), 30, "another tap cancelled the question");
  assert.equal(a.waEntries().length, before + 1);

  a.tap(`wafield:${e.id}:date`);
  a.text("31/02/2026");
  assert.equal(a.lastBody(), a.rt.run("whatsappAskText_('date')"), "an impossible date is asked again");
  assert.match(a.lastBody(), /11\/15\/2026/, "the example follows this copy's date order (month first here)");
  a.text("11/15/2026");
  assert.equal(a.entry(e.id).date, "2026-11-15");

  a.tap(`wafield:${e.id}:amount`);
  const w = JSON.parse(a.rt.svc.props.get("WA_AWAIT"));
  a.rt.svc.props.set("WA_AWAIT", JSON.stringify(Object.assign(w, { at: Date.now() - 20 * 60000 })));
  const count = a.waEntries().length;
  a.text("55");
  assert.match(a.lastBody(), /expired/);
  assert.equal(a.waEntries().length, count, "no new entry from a late answer");
  assert.equal(Number(a.entry(e.id).amount), 30);
});

test("a choice deleted while its list was open says so", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.tap(`wapick:${e.id}:category:no-such-category`);
  assert.equal(a.lastBody(), a.rt.run("tr_('whatsapp.optionGone')"));
});

test("Repayment and Loan buttons: a friend list, converted straight away", () => {
  const a = waApp();
  a.text("60 cena");
  const [e] = a.waEntries();
  a.tap(`waedit:${e.id}`);
  const menuIds = a.lastRows().map((r) => r.id);
  assert.ok(menuIds.includes(`waconv:${e.id}:r`) && menuIds.includes(`waconv:${e.id}:l`));
  assert.ok(menuIds.length <= 10);
  a.tap(`waconv:${e.id}:l`);
  const list = a.lastRows();
  assert.ok(list.length <= 10);
  list.forEach((r) => assert.ok(r.title.length <= 24 && (!r.description || r.description.length <= 72)));
  assert.equal(list[list.length - 1].id, `wacvx:${e.id}`, "'Someone else' is the last row");
  const friendRow = list.find((r) => r.id.startsWith("wacv:"));
  const friendId = friendRow.id.split(":").pop();
  const loansBefore = a.rt.rows("Loans").length;
  a.tap(friendRow.id);
  assert.equal(a.entry(e.id), undefined, "the expense became a loan");
  const loan = a.rt.rows("Loans").slice(loansBefore).find((l) => l.friend_id === friendId);
  assert.ok(loan && Number(loan.amount) === 60 && loan.direction === "they_owe_me", JSON.stringify(loan));
  a.tap(`wacvx:${e.id}`);
  assert.match(a.lastBody(), /More → Friends/);
});

test("a repayment list puts the friends with an open debt in that direction first, with the amount", () => {
  const a = waApp();
  a.text("60 cena");
  const [e] = a.waEntries();
  a.tap(`waconv:${e.id}:r`);
  const rows = a.lastRows().filter((r) => r.id.startsWith("wacv:"));
  const withDebt = rows.map((r) => !!r.description);
  assert.deepEqual(withDebt, [...withDebt].sort((x, y) => y - x), "debts first");
  rows.filter((r) => r.description).forEach((r) => assert.match(r.description, /^you owe [A-Z]{3} \d/));
});

test("money coming in as a repayment from a friend who owes nothing is refused, nothing changes", () => {
  const a = waApp();
  a.text("ingreso 50 pago");
  const e = a.waEntries().find((x) => x.type === "income");
  a.rt.run("appendRowObject('Friends', { id: 'friend-owes-nothing', name: 'Nadia Test', notes: '' })");
  a.tap(`wacv:${e.id}:r:friend-owes-nothing`);
  assert.ok(a.entry(e.id), "the income is still there");
  assert.ok(!a.rt.rows("Loans").some((l) => l.friend_id === "friend-owes-nothing"), "no loan or repayment was made");
  assert.match(a.lastBody(), /Nadia Test|owe|debe/i, "the bot says why");
});

test("a friend's name the app does not know: correct it or add the friend in the app", () => {
  const a = waApp();
  a.text("60 cena");
  const [e] = a.waEntries();
  a.text("loan Zzyzx", { context_id: a.cardIdOf(e.id) });
  assert.match(a.lastBody(), /Zzyzx[\s\S]*More → Friends/);
  assert.ok(a.entry(e.id));
});

test("general help: 'ayuda' / 'help' / 'menú' not replying says what the bot can do; as a reply, the transaction's own words", () => {
  const a = waApp();
  for (const word of ["ayuda", "help", "Menú", "?"]) {
    a.text(word);
    assert.equal(a.lastBody(), a.rt.run("tr_('whatsapp.help')"), word);
  }
  assert.match(a.lastBody(), /pendientes/);
  assert.equal(a.waEntries().length, 0, "help made no entry");
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.text("help", { context_id: a.cardIdOf(e.id) });
  assert.match(a.lastBody(), /^Reply to edit:/, "a reply 'help' is the transaction's own help");
  a.text("ayuda");
  assert.equal(a.lastBody(), a.rt.run("tr_('whatsapp.help')"), "with a transaction waiting, a plain 'ayuda' is still the general help");
});

test("a message without replying is about the transaction of the bot's last message (Telegram's rule)", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.text("Almuerzo con equipo");   // plain words: its description, as on Telegram
  assert.equal(a.entry(e.id).description, "Almuerzo con equipo");
  assert.equal(a.waEntries().length, 1, "no new entry");
  a.text("category restaurants");
  assert.ok(a.entry(e.id).category_id);
  a.text("30 cena");   // a text with an amount is still a new purchase
  assert.equal(a.waEntries().length, 2);
  assert.equal(Number(a.entry(e.id).amount), 25);
  // After the bot's "✅ Confirmed." about the first one, a plain edit is about that one, even confirmed.
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  a.text("amount 50");
  assert.equal(Number(a.entry(e.id).amount), 50);
  assert.equal(a.entry(e.id).status, "confirmed");
  // After a message that is not about a transaction (the help), plain words are read normally.
  a.text("ayuda");
  a.text("gracias");
  assert.match(a.lastBody(), /couldn't find an amount/);
  assert.equal(a.entry(e.id).description, "Almuerzo con equipo");
});

test("after the window closed, the message that brings the waiting cards is not about them", () => {
  const a = waApp();
  a.text("ayuda");   // opens the window; the bot's last message is the help
  a.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 25 * 3600000));
  a.rt.run("appendRowObject('Entries', { id: 'late-1', type: 'expense', date: '2026-11-16', amount: 12, currency: 'PEN', description: 'Late shop', status: 'pending', source: 'email', paid_by: 'me', created_at: '2999-06-01T10:00:00' })");
  a.text("hola");
  assert.ok(a.cardIdOf("late-1"), "its card came with the catch-up");
  assert.equal(a.entry("late-1").description, "Late shop", "'hola' did not become its description");
});

test("the example the help quotes works, in English and in Spanish", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.text("category restaurants, amount 45", { context_id: a.cardIdOf(e.id) });
  assert.equal(Number(a.entry(e.id).amount), 45);
  assert.equal(a.entry(e.id).status, "confirmed");
  a.text("26 cena");
  const e2 = a.waEntries().find((x) => x.description === "Cena");
  a.text("categoría restaurantes, monto 46", { context_id: a.cardIdOf(e2.id) });
  assert.equal(Number(a.entry(e2.id).amount), 46);
  assert.equal(a.entry(e2.id).category_id, a.entry(e.id).category_id);
  assert.equal(a.entry(e2.id).status, "confirmed");
});

// ---- catch-up (found live 2026-11-16: "came in while I couldn't write to you" with the window open) ----
const addWaiting = (a, id) => a.rt.run(`appendRowObject('Entries', { id: '${id}', type: 'expense', date: '2026-11-16', amount: 12, currency: 'PEN', description: 'Shop ${id}', status: 'pending', source: 'email', paid_by: 'me', created_at: '2999-06-01T10:00:00' })`);

test("window open: a waiting transaction that never got its message is sent, without the 'couldn't write to you' sentence", () => {
  const a = waApp();
  a.text("ayuda");
  addWaiting(a, "missed-1");
  a.text("ayuda");
  assert.ok(a.cardIdOf("missed-1"), "its message was sent");
  assert.ok(!a.sent.some((m) => m.text && /couldn't write to you/.test(m.text.body)), "no 'couldn't write' sentence");
});

test("window closed: the sentence comes, then the transaction", () => {
  const a = waApp();
  a.text("ayuda");
  a.rt.svc.props.set("WA_LAST_IN", String(Date.now() - 25 * 3600000));
  addWaiting(a, "missed-2");
  a.text("ayuda");
  assert.ok(a.sent.some((m) => m.text && /1 transaction came in while I couldn't write to you/.test(m.text.body)));
  assert.ok(a.cardIdOf("missed-2"));
});

test("a transaction WhatsApp keeps refusing is tried 3 times, then left in Needs review", () => {
  const a = waApp();
  a.text("ayuda");
  addWaiting(a, "refused-1");
  const handler = a.rt.state.fetchHandler;
  let tries = 0;
  a.rt.state.fetchHandler = (url, opts) => {
    if (String(url).endsWith("/send") && /Shop refused-1/.test(opts.payload)) { tries++; return { error: { message: "refused" } }; }
    return handler(url, opts);
  };
  for (let i = 0; i < 5; i++) a.text("ayuda");
  assert.equal(tries, 3);
  assert.equal(a.entry("refused-1").status, "pending");
});

test("a repayment by buttons that pays more than was owed: its extra waits in Needs review and gets its own message", () => {
  const a = waApp();
  a.rt.run("appendRowObject('Friends', { id: 'friend-no-debt', name: 'Olga Test', notes: '' })");
  a.rt.svc.props.set("WA_SWITCH_AT", a.rt.run(`Utilities.formatDate(new Date(Date.now() - 60000), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd'T'HH:mm:ss")`));
  a.text("80 test repago");
  const e = a.waEntries().find((x) => x.description === "Test repago");
  const before = a.rt.rows("Entries").filter((x) => x.status === "pending").map((x) => x.id);
  a.tap(`wacv:${e.id}:r:friend-no-debt`);
  const extra = a.rt.rows("Entries").filter((x) => x.status === "pending" && !before.includes(x.id));
  assert.ok(extra.length >= 1, "paying someone who is owed nothing leaves an extra in Needs review");
  a.text("ayuda");
  extra.forEach((x) => assert.ok(a.cardIdOf(x.id), "the extra got its message: " + x.description));
  assert.ok(!a.sent.some((m) => m.text && /couldn't write to you/.test(m.text.body)));
});

test("'Other changes' lists only what the Edit list does not offer; 'help' as a reply still lists everything", () => {
  const a = waApp();
  a.text("25 almuerzo");
  const [e] = a.waEntries();
  a.tap(`wahelp:${e.id}`);
  const other = a.lastBody();
  assert.match(other, /^Other changes — reply to the transaction's message with:/);
  assert.match(other, /paid by/);
  assert.match(other, /currency/);
  assert.match(other, /tag/);
  assert.match(other, /split/);
  for (const listed of ["\"category groceries\"", "\"amount 45.50\"", "description", "\"account Interbank\"", "\"date ", "repayment", "loan Ana"]) {
    assert.ok(!other.includes(listed), "not repeated: " + listed);
  }
  a.text("help", { context_id: a.cardIdOf(e.id) });
  assert.match(a.lastBody(), /"category groceries"/, "the full help as a reply");
  // A transfer: from / to / amount / description / date are rows; currency, category, tag, type are not.
  a.rt.run(`appendRowObject('Entries', { id: 'tr-1', type: 'transfer', date: '2026-11-16', amount: 50, currency: 'PEN', description: 'Move', status: 'pending', source: 'email', paid_by: 'me', created_at: '2999-06-01T10:00:00' })`);
  a.tap("wahelp:tr-1");
  const t = a.lastBody();
  assert.match(t, /currency/);
  assert.match(t, /category/);
  assert.ok(!/"from Plin"|"amount 90"|repayment/.test(t));
});
