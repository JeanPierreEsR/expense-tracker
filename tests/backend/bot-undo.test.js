// Undo on the bots (BotUndo.gs; plan "Undo on WhatsApp and Telegram", 2026-11-22): "deshacer" / "undo" on its own puts a bot
// action back (Confirm, edits, Discard, repayment, loan), for 30 days, on WhatsApp and Telegram. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

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
  return {
    rt, sent,
    text: (t, extra) => post(Object.assign({ type: "text", text: t }, extra || {})),
    tap: (id, contextId) => post({ type: "interactive", reply_id: id, context_id: contextId }),
    waEntries: () => rt.rows("Entries").filter((e) => e.source === "whatsapp"),
    entry: (id) => rt.rows("Entries").find((x) => x.id === id),
    cardIdOf: (entryId) => rt.rows("Telegram Messages").filter((m) => m.entry_id === entryId && /^wamid\./.test(m.message_id)).pop().message_id,
    lastId: () => "wamid.out" + sent.length,
    bodies: () => sent.map((m) => (m.text && m.text.body) || (m.interactive && m.interactive.body.text) || ""),
    lastBody: () => { const m = sent[sent.length - 1]; return (m.text && m.text.body) || m.interactive.body.text; },
    lastRows: () => sent[sent.length - 1].interactive.action.sections[0].rows
  };
}

// Everything an undo must put back, in an order that does not depend on where a row sits in the Sheet.
function world(rt) {
  const sorted = (rows) => rows.map((r) => { const c = Object.assign({}, r); delete c.updated_at; return JSON.stringify(c); }).sort();
  return {
    entries: sorted(rt.rows("Entries")), splits: sorted(rt.rows("Entry Splits")), tags: sorted(rt.rows("Entry Tags")),
    loans: sorted(rt.rows("Loans")), setts: sorted(rt.rows("Settlements"))
  };
}

// A waiting expense with a category, ready to confirm.
function readyExpense(a, text) {
  a.text(text || "25 almuerzo");
  const e = a.waEntries().pop();
  a.tap(`wafield:${e.id}:category`);
  a.tap(a.lastRows().find((r) => r.id.startsWith("wapick:")).id);
  return e;
}

test("Confirm, then 'deshacer' without replying: waiting again, and a second 'deshacer' stops", () => {
  const a = waApp();
  const e = readyExpense(a);
  const before = world(a.rt);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entry(e.id).status, "confirmed");
  a.text("deshacer");
  assert.equal(a.entry(e.id).status, "pending");
  assert.deepEqual(world(a.rt), before, "everything is as before the Confirm");
  assert.ok(a.bodies().some((b) => /Undone: almuerzo · PEN 25\.00 is waiting again/i.test(b)), a.bodies().join("\n"));
  const card = a.sent[a.sent.length - 1];
  assert.deepEqual(card.interactive.action.buttons.map((b) => b.reply.id.split(":")[0]), ["confirm", "waedit", "discard"], "the card comes again");
  a.text("deshacer");
  assert.equal(a.lastBody(), a.rt.run("tr_('botUndo.already')"));
  assert.equal(a.entry(e.id).status, "pending");
});

test("an edit by tap is undone field by field; a reply to the answer undoes that action", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap(`wafield:${e.id}:amount`);
  a.text("40");
  assert.equal(Number(a.entry(e.id).amount), 40);
  const answer = a.lastId();
  a.text("undo", { context_id: answer });
  assert.equal(Number(a.entry(e.id).amount), 25);
  assert.ok(a.bodies().some((b) => /the amount of almuerzo · PEN 25\.00 is back as it was/i.test(b)), a.bodies().slice(-3).join("\n"));
});

test("words that confirm and change: undone together, waiting again", () => {
  const a = waApp();
  const e = readyExpense(a);
  const before = world(a.rt);
  a.text("description cena, amount 30", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id).status, "confirmed");
  a.text("Deshacer.");
  assert.deepEqual(world(a.rt), before);
  assert.ok(a.bodies().some((b) => /amount and description|description and amount/.test(b) && /waiting again/.test(b)), a.bodies().slice(-3).join("\n"));
});

test("Discard is in Recently deleted and comes back with 'deshacer'; restoring it in the app makes the bot's Undo 'already undone'", () => {
  const a = waApp();
  const e = readyExpense(a);
  const before = world(a.rt);
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entry(e.id), undefined);
  const list = a.rt.run("listDeletedEntries()");
  assert.ok(list.batches.some((b) => b.entries.some((x) => x.entry_id === e.id)), "the safety copy is in Recently deleted");
  const answer = a.lastId();
  a.text("deshacer", { context_id: answer });
  assert.deepEqual(world(a.rt), before);
  assert.equal(a.entry(e.id).status, "pending");
  assert.ok(!a.rt.run("listDeletedEntries()").batches.some((b) => b.entries.some((x) => x.entry_id === e.id)), "and it left Recently deleted");
  assert.ok(!a.rt.rows("Entry Deletions").some((d) => d.entry_id === e.id), "phones see it again");

  // The other way round: Discard again, restore in the app, then the bot's Undo.
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  const answer2 = a.lastId();
  a.rt.ctx.__ids = [e.id];
  a.rt.run("restoreDeletedEntries({ ids: __ids })");
  a.text("deshacer", { context_id: answer2 });
  assert.equal(a.lastBody(), a.rt.run("tr_('botUndo.already')"));
  assert.equal(a.rt.rows("Entries").filter((x) => x.id === e.id).length, 1, "never twice");
});

test("a loan made from the Edit list is undone: loan gone, the expense back as it was", () => {
  const a = waApp();
  const e = readyExpense(a, "60 cena");
  const before = world(a.rt);
  a.tap(`waconv:${e.id}:l`);
  const friendRow = a.lastRows().find((r) => r.id.startsWith("wacv:"));
  a.tap(friendRow.id);
  assert.equal(a.entry(e.id), undefined, "the expense became a loan");
  a.text("deshacer");
  assert.deepEqual(world(a.rt), before);
  assert.match(a.bodies().join("\n"), /the loan with .+ is removed and cena · PEN 60\.00 is back as it was/i);
});

test("a repayment by words is undone: the debt is owed again", () => {
  const a = waApp();
  const e = readyExpense(a, "20 pago");
  const before = world(a.rt);
  const friend = a.rt.rows("Friends")[0];
  a.text("repayment " + friend.name, { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id), undefined, "the expense became a repayment");
  a.text("undo");
  assert.deepEqual(world(a.rt), before);
  const answer = a.bodies().filter((b) => b.startsWith("↩️")).pop();
  assert.ok(answer.includes(friend.name), "the answer names the friend: " + answer);
});

test("refused when the transaction changed in the app after the bot action", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  const answer = a.lastId();
  a.rt.ctx.__id = e.id;
  a.rt.run("setEntryField_(__id, 'description', 'changed in the app')");
  a.text("deshacer", { context_id: answer });
  assert.match(a.lastBody(), /changed after that/);
  assert.equal(a.entry(e.id).status, "confirmed");
  assert.equal(a.entry(e.id).description, "changed in the app");
});

test("refused when a repayment was recorded on a loan the bot made", () => {
  const a = waApp();
  const e = readyExpense(a, "60 cena");
  a.tap(`waconv:${e.id}:l`);
  const friendRow = a.lastRows().find((r) => r.id.startsWith("wacv:"));
  a.tap(friendRow.id);
  const answer = a.lastId();
  const loan = a.rt.rows("Loans").find((l) => String(l.amount) === "60" && l.friend_id === friendRow.id.split(":").pop());
  a.rt.ctx.__s = { id: "sett-test-1", loan_id: loan.id, amount: 10, date: "2026-11-22" };
  a.rt.run("appendRowObject('Settlements', __s)");
  a.text("deshacer", { context_id: answer });
  assert.match(a.lastBody(), /debts .*changed after that/i);
  assert.ok(a.rt.rows("Loans").some((l) => l.id === loan.id), "the loan stays");
});

test("older than 30 days: 'more than 30 days ago'; nothing to undo after the help", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  const answer = a.lastId();
  const old = new Date(Date.now() - 31 * 86400000).toISOString();
  a.rt.ctx.__old = old;
  a.rt.run("var s = getSheet('Bot Actions'), h = getHeaders(s); s.getRange(2, h.indexOf('at') + 1, s.getLastRow() - 1, 1).setValue(__old);");
  a.text("deshacer", { context_id: answer });
  assert.equal(a.lastBody(), a.rt.run("tr_('botUndo.tooOld')"));
  a.text("help");
  a.text("deshacer");
  assert.equal(a.lastBody(), a.rt.run("tr_('botUndo.nothing')"));
});

test("'deshacer la comida' is not an undo; 'deshacer' during an open amount question undoes and closes it", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  a.text("deshacer la comida");
  assert.equal(a.entry(e.id).status, "confirmed", "a sentence is not the word");
  a.tap(`wafield:${e.id}:description`);
  a.text("deshacer");
  assert.notEqual(a.entry(e.id).description, "deshacer", "never a description");
  assert.equal(a.rt.svc.props.get("WA_AWAIT") || "", "", "the question is closed");
});

test("Telegram: Confirm tap, then 'undo' as a reply to the answer", () => {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let next = 1000;
  const sent = [];
  rt.state.fetchHandler = (url, opts) => {
    if (/sendMessage/.test(url)) { const id = ++next; sent.push(Object.assign({ id }, JSON.parse(opts.payload))); return { ok: true, result: { message_id: id } }; }
    return { ok: true, result: true };
  };
  const update = (u) => { rt.ctx.__u = u; rt.run("handleTelegramUpdate_(__u)"); };
  const cat = rt.rows("Categories").find((c) => c.type === "expense");
  rt.ctx.__e = { id: "tg-undo-1", type: "expense", amount: 12, currency: "PEN", date: "2026-11-20", description: "cafe", category_id: cat.id, status: "pending", paid_by: "me", source: "email", created_at: "2026-11-20T10:00:00" };
  rt.run("appendRowObject('Entries', __e); sendTelegramEntryNotification_(__e)");
  const card = sent[sent.length - 1].id;
  update({ callback_query: { id: "cb1", data: "confirm:tg-undo-1", message: { chat: { id: chat }, message_id: card } } });
  assert.equal(rt.rows("Entries").find((x) => x.id === "tg-undo-1").status, "confirmed");
  const answer = sent.find((m) => /Confirmed/.test(m.text)).id;
  update({ message: { chat: { id: chat }, message_id: 77, text: "undo", reply_to_message: { message_id: answer } } });
  assert.equal(rt.rows("Entries").find((x) => x.id === "tg-undo-1").status, "pending");
  assert.ok(sent.some((m) => /Undone: cafe · PEN 12\.00 is waiting again/.test(m.text)), sent.map((m) => m.text).join("\n"));
});

test("a confirmed expense split with a friend by words: undone, the friend's share and debt go back", () => {
  const a = waApp();
  const e = readyExpense(a, "80 cena");
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  const before = world(a.rt);
  const friend = a.rt.rows("Friends")[0];
  a.text("split " + friend.name + " 40", { context_id: a.cardIdOf(e.id) });
  assert.ok(a.rt.rows("Entry Splits").some((s) => s.entry_id === e.id), "the split was saved: " + a.lastBody());
  a.text("deshacer");
  assert.deepEqual(world(a.rt), before);
});

test("every undo text exists in both languages", () => {
  const { rt } = freshApp({ small: true });
  const keys = rt.run("Object.keys(BACKEND_STRINGS_).filter(function (k) { return /^botUndo\\.|^help\\.undo$/.test(k); })");
  assert.ok(keys.length > 20);
  keys.forEach((k) => { rt.ctx.__k = k; const s = rt.run("BACKEND_STRINGS_[__k]"); assert.ok(s.en && s.es, k); });
});

test("an entry another save writes during the bot action is never part of it (a bank e-mail landing at that moment)", () => {
  const a = waApp();
  const e = readyExpense(a);
  // Another run writes straight to the Sheet while the bot is answering the Confirm (not through this run's helpers).
  const handler = a.rt.state.fetchHandler;
  let once = false;
  a.rt.state.fetchHandler = (url, opts) => {
    if (!once && String(url).endsWith("/send")) {
      once = true;
      a.rt.run("var s = getSheet('Entries'), h = getHeaders(s); s.appendRow(h.map(function (k) { return { id: 'other-run-1', type: 'expense', amount: 9, currency: 'PEN', date: '2026-11-22', description: 'bank email', status: 'pending', paid_by: 'me', source: 'email' }[k] || ''; }));");
    }
    return handler(url, opts);
  };
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  a.rt.state.fetchHandler = handler;
  a.text("deshacer");
  assert.equal(a.entry(e.id).status, "pending");
  assert.ok(a.entry("other-run-1"), "the other save is still there");
});

test("a touch that changes no real value does not block the undo", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  const answer = a.lastId();
  a.rt.ctx.__id = e.id;
  a.rt.run("touchEntriesById_([__id])");
  a.text("deshacer", { context_id: answer });
  assert.equal(a.entry(e.id).status, "pending");
});

test("Discard of an entry with a receipt photo too big for any copy: the entry comes back and the answer says the photo did not", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.rt.ctx.__bill = { entry_id: e.id, bill_json: JSON.stringify({ img: "x".repeat(46000) }), updated_at: "2026-11-22T10:00:00Z" };
  a.rt.run("ensureEntryBillsSheet_(); appendRowObject('Entry Bills', __bill)");
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  assert.ok(!a.rt.rows("Entry Bills").some((b) => b.entry_id === e.id));
  a.text("deshacer");
  assert.equal(a.entry(e.id).status, "pending");
  // Too big for both copies (a cell holds 50,000 characters): the entry is back and the answer says the photo is not.
  assert.match(a.bodies().join("\n"), /receipt photo could not come back/);
});

test("old copies are deleted by the hourly job even when the bot is quiet", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.ok(a.rt.rows("Bot Actions").length >= 1);
  a.rt.ctx.__old = new Date(Date.now() - 31 * 86400000).toISOString();
  a.rt.run("var s = getSheet('Bot Actions'), h = getHeaders(s); s.getRange(2, h.indexOf('at') + 1, s.getLastRow() - 1, 1).setValue(__old); purgeOldBotActionsIfAny_();");
  assert.equal(a.rt.rows("Bot Actions").length, 0);
});

test("'deshacer' on WhatsApp while Telegram is the review bot says where undo works", () => {
  const a = waApp();
  a.rt.svc.props.set("REVIEW_BOT", "");
  a.rt.ctx.__body = JSON.stringify({ whatsapp: { id: "wamid.x1", from: OWNER, type: "text", text: "deshacer" }, relay_secret: SECRET });
  const out = JSON.parse(a.rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  assert.match(JSON.stringify(out), /review bot \(Telegram\)/);
});

test("what a loan made by the bot taught (Payee Habits) is taken back with the undo", () => {
  const a = waApp();
  const e = readyExpense(a, "60 cena");
  const habitsBefore = a.rt.run("payeeHabitRows_()").length;
  a.tap(`waconv:${e.id}:l`);
  a.tap(a.lastRows().find((r) => r.id.startsWith("wacv:")).id);
  assert.ok(a.rt.run("payeeHabitRows_()").length > habitsBefore, "the conversion taught something");
  a.text("deshacer");
  assert.equal(a.rt.run("payeeHabitRows_()").length, habitsBefore);
});

test("a company copy: a bot edit that drops the entry's split between projects is undone with it", () => {
  const a = waApp();
  const e = readyExpense(a, "500 materiales");
  a.rt.ctx.__ps = [{ id: "ps-1", entry_id: e.id, project_id: "proj-a", amount: 300 }, { id: "ps-2", entry_id: e.id, project_id: "proj-b", amount: 200 }];
  a.rt.run("var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.insertSheet('Project Splits'); sh.getRange(1, 1, 1, 4).setValues([['id', 'entry_id', 'project_id', 'amount']]); __ps.forEach(function (r) { appendRowObject('Project Splits', r); });");
  const before = world(a.rt), splits = a.rt.rows("Project Splits").map((r) => JSON.stringify(r)).sort();
  a.tap(`wafield:${e.id}:amount`);
  // While the edit runs, the split no longer fits the new amount and is dropped (ProjectSplits.gs does this when it applies).
  const handler = a.rt.state.fetchHandler;
  let once = false;
  a.rt.state.fetchHandler = (url, opts) => {
    if (!once && String(url).endsWith("/send")) { once = true; a.rt.ctx.__id = e.id; a.rt.run("deleteRowsWhere_('Project Splits', function (r) { return r.entry_id === __id; })"); }
    return handler(url, opts);
  };
  a.text("600");
  a.rt.state.fetchHandler = handler;
  assert.equal(a.rt.rows("Project Splits").length, 0);
  a.text("deshacer");
  assert.deepEqual(world(a.rt), before);
  assert.deepEqual(a.rt.rows("Project Splits").map((r) => JSON.stringify(r)).sort(), splits);
});

test("'Delete for good' in Recently deleted after a bot Discard: 'deshacer' cannot bring it back, and the bot's copy is gone too", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  const answer = a.lastId();
  assert.ok(a.rt.rows("Bot Actions").some((r) => r.kind === "discard"), "the bot kept its copy");
  a.rt.ctx.__ids = [e.id];
  a.rt.run("forgetDeletedEntries({ ids: __ids })");
  assert.ok(!a.rt.rows("Bot Actions").some((r) => r.kind === "discard" && String(r.entry_ids).includes(e.id)), "deleted for good means the bot's copy too");
  a.text("deshacer", { context_id: answer });
  assert.equal(a.entry(e.id), undefined, "the entry stays deleted");
});

test("a Discard whose Recently deleted copy is gone (bot copy kept) is refused with 'deleted for good'", () => {
  const a = waApp();
  const e = readyExpense(a);
  a.tap("discard:" + e.id, a.cardIdOf(e.id));
  const answer = a.lastId();
  a.rt.run("deleteRowsWhere_('Deleted Entries', function () { return true; })");
  a.text("deshacer", { context_id: answer });
  assert.equal(a.entry(e.id), undefined);
  assert.match(a.lastBody(), /deleted for good|definitivamente/);
});

test("'borrar' on a confirmed entry's card deletes it with a Recently deleted copy; 'deshacer' brings it back", () => {
  const a = waApp();
  const e = readyExpense(a, "500 taxi");
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(a.entry(e.id).status, "confirmed");
  const before = world(a.rt);
  a.text("borrar", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id), undefined, "deleted");
  assert.ok(a.rt.run("listDeletedEntries()").batches.some((b) => b.entries.some((x) => x.entry_id === e.id)), "in Recently deleted");
  a.text("deshacer", { context_id: a.lastId() });
  assert.deepEqual(world(a.rt), before);
  assert.equal(a.entry(e.id).status, "confirmed");
  assert.ok(!a.rt.run("listDeletedEntries()").batches.some((b) => b.entries.some((x) => x.entry_id === e.id)), "and left Recently deleted");
});

test("'delete' on a waiting card discards it; 'borrar' with no card asks which", () => {
  const a = waApp();
  a.text("borrar");
  assert.match(a.lastBody(), /tarjeta del movimiento|card of the transaction/);
  const e = readyExpense(a, "12 snack");
  a.text("delete", { context_id: a.cardIdOf(e.id) });
  assert.equal(a.entry(e.id), undefined);
});

test("an undo that leaves the entry confirmed says it is still there and sends its card again", () => {
  const a = waApp();
  const e = readyExpense(a, "500 taxi");
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  const pm = a.rt.rows("Payment Methods")[0];
  a.text("cuenta " + pm.nickname, { context_id: a.cardIdOf(e.id) });
  const n = a.bodies().length;
  a.text("deshacer");
  const after = a.bodies().slice(n);
  assert.ok(after.some((b) => /sigue en tu historial|still in your history/.test(b)), after.join(" | "));
  assert.ok(after.some((b) => b.includes("500")), "the card again");
  assert.ok(a.cardIdOf(e.id), "a plain message now refers to it");
});

test("a bot Confirm that crosses a budget alerts at once, and its 'deshacer' takes the notice away", () => {
  const a = waApp();
  const e = readyExpense(a, "90 zapatillas");
  a.rt.run("appendRowObject('Categories', { id: 'cat-shoes', name: 'Shoes test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });");
  a.rt.ctx.__id = e.id;
  a.rt.run("setEntryField_(__id, 'category_id', 'cat-shoes')");
  const cat = "cat-shoes";
  a.rt.api("addBudget", { category_id: cat, amount: 100, currency: "PEN", period_type: "monthly", thresholds: "75" });
  a.rt.run("checkBudgets()");   // the first check only records a baseline (Budgets.gs): it never alerts on what was already spent
  a.rt.svc.props.delete("ALERT_CHECK_LAST_AT");
  const open = () => a.rt.api("listNotices").notices.filter((n) => n.kind === "budget");
  const already = open().length;
  a.tap("confirm:" + e.id, a.cardIdOf(e.id));
  assert.equal(open().length, already + 1, "the alert came with the action, not an hour later");
  a.text("deshacer");
  assert.equal(open().length, already, "the notice went with the undo");
});
