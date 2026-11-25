// Fixes from the testers' re-check of 2.69.2 (owner's go, 2026-11-24). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

// R2 (Valeria): a waiting repayment tied to Ana was flagged as a possible duplicate of another friend's repayment.
test("a waiting repayment tied to one friend is not a duplicate of another friend's repayment; the same friend's still is", () => {
  const { rt } = freshApp({ small: true });
  const ana = rt.api("addFriend", { name: "Ana Made" });
  rt.api("addFriend", { name: "Beto Made" });
  rt.run(`ensureEntriesRepayIntentColumn_();
    appendRowObject('Entries', { id: 'w1', type: 'income', date: '${today()}', amount: 100, currency: 'PEN', description: 'Waiting repay Ana', status: 'pending', source: 'email', repay_intent: JSON.stringify({ friend_id: ${JSON.stringify(ana.id)}, direction: 'they_owe_me' }) });
    appendRowObject('Entries', { id: 'c1', type: 'transfer', date: '${today()}', amount: 100, currency: 'PEN', description: 'Repayment from Beto Made', status: 'confirmed', source: 'manual' });
    appendRowObject('Entries', { id: 'c2', type: 'transfer', date: '${today()}', amount: 100, currency: 'PEN', description: 'Repayment from Ana Made', status: 'confirmed', source: 'manual' });
    ROWS_MEMO_ = null;`);
  const twins = run(rt, "findSameDayTwins_(getEntryById_('w1'), getAllRows('Entries')).map(function (t) { return t.id; })");
  assert.deepEqual(twins, ["c2"], "Beto's repayment is left out; Ana's own stays a possible duplicate");
});

// R3 (Lucho, Valeria): "X paid me" when X owes you: the card offers the repayment at once.
function tgApp() {
  const { rt } = freshApp({ small: true });
  const chat = linkTelegram(rt);
  let mid = 1000, upd = 5000;
  rt.state.fetchHandler = (url) => (/sendMessage/.test(String(url)) ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: true });
  const calls = (method) => rt.svc.fetchLog.filter((f) => String(f.url).endsWith("/" + method)).map((f) => JSON.parse(f.options.payload));
  const say = (text) => rt.rawPost(JSON.stringify({ update_id: ++upd, message: { chat: { id: chat }, message_id: ++mid, date: Math.floor(Date.now() / 1000), text } }));
  const tap = (data, messageId) => rt.rawPost(JSON.stringify({ update_id: ++upd, callback_query: { id: "cb" + upd, data, message: { chat: { id: chat }, message_id: messageId } } }));
  return { rt, calls, say, tap };
}
test("the card for 'Elmer paid me 37' has 'Repayment from Elmer' when Elmer owes you; one tap records it", () => {
  const a = tgApp();
  a.rt.ctx.__f = { name: "Elmer Made" };
  const elmer = a.rt.run("addFriend(__f)");
  a.rt.ctx.__l = { friend_id: elmer.id, direction: "they_owe_me", amount: 150, currency: "PEN", date: "2026-01-05" };
  a.rt.run("addLoan(__l)");
  a.say("Elmer Made paid me 37");
  const card = a.calls("sendMessage").filter((m) => m.reply_markup).pop();
  const rows = card.reply_markup.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.match(rows[1][0].text, /Repayment from Elmer Made/);
  const e = a.rt.rows("Entries").filter((x) => x.source === "telegram").pop();
  const cardId = Number(a.rt.rows("Telegram Messages").filter((m) => m.entry_id === e.id).pop().message_id);
  a.tap(rows[1][0].callback_data, cardId);
  const bal = a.rt.api("listLoanBalances", {}).find((b) => b.friend_id === elmer.id);
  assert.equal(bal.balances[0].net, 113);
});
test("no repayment button when the person named owes you nothing, or on an ordinary expense", () => {
  const a = tgApp();
  a.rt.ctx.__f = { name: "Nadia Made" };
  a.rt.run("addFriend(__f)");
  a.say("Nadia Made paid me 20");
  a.say("taxi 15");
  a.calls("sendMessage").filter((m) => m.reply_markup && /confirm:/.test(JSON.stringify(m.reply_markup))).forEach((m) => assert.equal(m.reply_markup.inline_keyboard.length, 1));
});

// Company copies.
function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
  return rt;
}
const ym = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 7); })();
const day = (n) => `${ym}-${String(n).padStart(2, "0")}`;
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const expCat = (rt) => rt.rows("Categories").find((c) => c.type === "expense").id;

// R4 (Lucho): a distribution opened from Home is edited in its own window.
test("changeDistribution: new net, withholding and partner; gross = net + withholding", () => {
  const rt = companyCopy();
  rt.run(`appendRowObject('Entries', { id: 'd1', type: 'expense', date: '${today()}', amount: 1700, currency: 'PEN', category_id: '', description: 'Pago socio', payment_method_id: ${JSON.stringify(pm(rt))}, paid_by: 'me', status: 'pending', source: 'email' }); ROWS_MEMO_ = null;`);
  const out = rt.api("recordDistribution", { entry_id: "d1", partner_name: "Socio Uno", withholding: 85 });
  const res = rt.api("changeDistribution", { id: out.distribution.id, net: 1500, withholding: 100, partner_name: "Socio Dos" });
  assert.equal(res.distribution.gross, 1600);
  const entry = rt.rows("Entries").find((e) => e.id === "d1");
  assert.equal(Math.abs(Number(entry.amount)), 1500);
  assert.match(entry.description, /Socio Dos/);
  const row = rt.rows("Distributions").find((r) => r.id === out.distribution.id);
  assert.equal(Number(row.withholding), 100);
  assert.equal(rt.rows("Friends").find((f) => f.id === row.partner_id).name, "Socio Dos");
  assert.throws(() => rt.api("changeDistribution", { id: out.distribution.id, net: 0, withholding: 0 }));
  assert.throws(() => rt.api("changeDistribution", { id: "no-such", net: 10 }));
});

// R5 + R6 (Carlos, Ingrid): a receipt-only change shows; the hand-edited row is named.
test("after the package was sent, changing only a receipt number marks the month changed", () => {
  const rt = companyCopy();
  const e = rt.api("createEntry", { type: "expense", date: day(5), amount: 1200, currency: "PEN", category_id: expCat(rt), description: "Cemento Sol",
    payment_method_id: pm(rt), paid_by: "me", pay_method: "transfer", receipt_type: "factura", receipt_no: "F001-124", receipt_date: day(5) });
  rt.api("closeMonth", { month: ym, bank: [] });
  rt.api("sendAccountantPackage", { month: ym, to: "contador@example.com" });
  assert.equal(rt.api("getMonthClose", { month: ym }).package.changed_since, false);
  rt.api("updateEntry", { id: e.id, fields: { receipt_no: "F001-125" } });
  assert.equal(rt.api("getMonthClose", { month: ym }).package.changed_since, true);
});
test("hand-edited rows carry a readable line: date, description, amount", () => {
  const rt = companyCopy();
  const a = rt.api("createEntry", { type: "expense", date: day(10), amount: 300, currency: "PEN", category_id: expCat(rt), description: "Cemento", payment_method_id: pm(rt), paid_by: "me" });
  rt.api("closeMonth", { month: ym, bank: [] });
  const sheet = rt.sheet("Entries"), h = sheet.rows[0];
  sheet.rows.find((r) => r[h.indexOf("id")] === a.id)[h.indexOf("amount")] = 333;
  rt.run("ROWS_MEMO_ = null;");
  const s = rt.api("getMonthClose", { month: ym });
  assert.equal(s.hand_rows.length, 1);
  assert.match(s.hand_rows[0].label, new RegExp(`^${day(10)} · Cemento · `));
  assert.match(s.hand_rows[0].label, /333/);
});

test("a distribution changed in the app after its month closed is logged, never called a hand edit", () => {
  const rt = companyCopy();
  rt.run(`appendRowObject('Entries', { id: 'd2', type: 'expense', date: '${day(8)}', amount: 900, currency: 'PEN', category_id: '', description: 'Pago socio', payment_method_id: ${JSON.stringify(pm(rt))}, paid_by: 'me', status: 'pending', source: 'email' }); ROWS_MEMO_ = null;`);
  const out = rt.api("recordDistribution", { entry_id: "d2", partner_name: "Socio Uno", withholding: 50 });
  rt.api("closeMonth", { month: ym, bank: [] });
  rt.api("changeDistribution", { id: out.distribution.id, net: 800, withholding: 60 });
  const s = rt.api("getMonthClose", { month: ym });
  assert.equal(s.changed, true);
  assert.equal(s.hand_edited, false, JSON.stringify(s.hand_rows));
  assert.ok(s.changes.some((l) => l.field === "amount"));
});
