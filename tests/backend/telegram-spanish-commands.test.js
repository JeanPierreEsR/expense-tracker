// What the owner TYPES to the bot (step 6b): every command word works in
// Spanish and in English, always; typed amounts accept a decimal comma. The bot
// itself still answers in English here — its own texts are step 6a.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense");
  rt.run(`appendRowObject('Telegram Messages', { message_id: '700', entry_id: ${JSON.stringify(pending.id)}, created_at: 'x' });`);
  let n = 0;
  const reply = (text) => rt.rawPost(JSON.stringify({ update_id: 5000 + (++n), message: { chat: { id: chat }, message_id: 800 + n, text, reply_to_message: { message_id: 700 } } }));
  const entry = () => rt.rows("Entries").find((e) => e.id === pending.id);
  const sent = () => rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n");
  return { rt, data, reply, entry, sent, pending };
}
const catId = (rt, name, type = "expense") => rt.rows("Categories").find((c) => c.name === name && c.type === type).id;

test("Spanish keywords edit a pending entry (category by its Spanish name, decimal comma, accents optional)", () => {
  const { rt, data, reply, entry } = setup();
  reply("categoría supermercado, monto 48,50, descripción Café del barrio");
  const e = entry();
  assert.equal(e.category_id, catId(rt, "Groceries"));
  assert.equal(Number(e.amount), 48.5);
  assert.equal(e.description, "Café del barrio");
  reply("categoria restaurantes, descripcion Almuerzo");     // no accents
  assert.equal(entry().category_id, catId(rt, "Restaurants"));
  assert.equal(entry().description, "Almuerzo");
  reply("moneda usd, fecha 2026-09-12");
  assert.equal(entry().currency, "USD");
  assert.equal(entry().date, "2026-09-12");
  const friend = data.friends[0];
  reply(`pagado por ${friend.name}`);
  assert.equal(entry().paid_by, friend.id);
  reply("pagado por yo");
  assert.equal(entry().paid_by, "me");
});

test("the same commands in English still work (nothing was taken away)", () => {
  const { rt, reply, entry } = setup();
  reply("category groceries, amount 1,234.50, description Market");
  assert.equal(entry().category_id, catId(rt, "Groceries"));
  assert.equal(Number(entry().amount), 1234.5);
  assert.equal(entry().description, "Market");
  reply("category deporte");   // a Spanish value inside an English command
  assert.equal(entry().category_id, catId(rt, "Sports"));
});

test("a combined reply with commas is split on Spanish keywords too", () => {
  const { rt, reply, entry } = setup();
  reply("monto 20, categoría transporte, descripción Taxi, Lima");
  assert.equal(Number(entry().amount), 20);
  assert.equal(entry().category_id, catId(rt, "Transport"));
  assert.equal(entry().description, "Taxi, Lima", "a comma inside the description is not a boundary");
});

test("split, labels, payment method in Spanish", () => {
  const { rt, data, reply, entry } = setup();
  reply("monto 90");
  const f = data.friends[0];
  reply(`repartir igual ${f.name}`);
  const splits = rt.rows("Entry Splits").filter((s) => s.entry_id === entry().id);
  assert.equal(splits.length, 1);
  assert.equal(Number(splits[0].amount), 45);
  reply("repartir ninguno");
  assert.equal(rt.rows("Entry Splits").filter((s) => s.entry_id === entry().id).length, 0);
  const pm = data.pms[3];
  reply(`medio de pago ${pm.nickname}`);
  assert.equal(entry().payment_method_id, pm.id);
  reply("etiqueta ninguna");
  assert.equal(rt.rows("Entry Tags").filter((t) => t.entry_id === entry().id).length, 0);
});

test("the account of an entry is changed with 'cuenta' / 'account' (and the old 'medio de pago' / 'payment method' still work)", () => {
  const { data, reply, entry } = setup();
  const [a, b, c, d] = data.pms.filter((p) => p.type !== "investment");
  reply(`cuenta ${a.nickname}`);
  assert.equal(entry().payment_method_id, a.id);
  reply(`account ${b.nickname}`);
  assert.equal(entry().payment_method_id, b.id);
  reply(`medio de pago ${c.nickname}`);
  assert.equal(entry().payment_method_id, c.id);
  reply(`payment method ${d.nickname}`);
  assert.equal(entry().payment_method_id, d.id);
});

test("'received in' is accepted next to 'received at' / 'recibido en'", () => {
  const { rt } = setup();
  const ok = (text) => rt.run(`EDIT_COMMAND_PATTERNS.some(function (p) { return p.field === 'received at' && p.re.test(${JSON.stringify(text)}); })`);
  for (const text of ["received in Interbank", "received at Interbank", "recibido en Interbank"]) assert.equal(ok(text), true, text);
});

test("type words and transfer ends in Spanish", () => {
  const { rt, data, reply, entry } = setup();
  const [a, b] = data.pms.filter((p) => p.type !== "investment");
  reply(`tipo transferencia, desde ${a.nickname}, hacia ${b.nickname}`);
  assert.equal(entry().type, "transfer");
  assert.equal(entry().payment_method_id, a.id);
  assert.equal(entry().to_payment_method_id, b.id);
  reply("hacia ninguna");
  assert.equal(entry().to_payment_method_id, "");
  reply("tipo gasto");
  assert.equal(entry().type, "expense");
  reply("tipo inversión");
  assert.equal(entry().type, "investment");
  reply("retiro");
  assert.ok(Number(entry().amount) < 0, "withdrawal is stored negative");
  reply("depósito");
  assert.ok(Number(entry().amount) > 0);
});

test("loan and repayment words in Spanish reroute the entry", () => {
  const { rt, data, reply, pending } = setup();
  const f = data.friends[0];
  const before = rt.rows("Loans").length;
  reply(`préstamo ${f.name}`);
  assert.equal(rt.rows("Loans").length, before + 1);
  assert.equal(rt.rows("Entries").find((e) => e.id === pending.id), undefined, "the pending entry became the loan");
});

test("'ayuda' answers like 'help'", () => {
  const { reply, sent } = setup();
  reply("ayuda");
  assert.match(sent(), /Reply to edit/);
});

test("typed amounts: decimal comma, thousands comma, both, and nonsense", () => {
  const { rt } = setup();
  const amt = (s) => rt.run(`parseTypedAmount_(${JSON.stringify(s)})`);
  assert.equal(amt("45.50"), 45.5);
  assert.equal(amt("45,50"), 45.5);
  assert.equal(amt("45,5"), 45.5);
  assert.equal(amt("1,234"), 1234, "1,234 is read as a thousands comma (the usual grouping)");
  assert.equal(amt("1,234,567"), 1234567);
  assert.equal(amt("1,234.50"), 1234.5);
  assert.equal(amt("1.234,50"), 1234.5);
  assert.equal(amt("1234"), 1234);
  assert.ok(Number.isNaN(amt("1,2,3")));
  assert.ok(Number.isNaN(amt("abc")));
});

test("every command word works with AND without accents (and in capitals)", () => {
  const { rt, reply, entry } = setup();
  reply("CATEGORÍA transporte, DESCRIPCIÓN Taxi");
  assert.equal(entry().category_id, catId(rt, "Transport"));
  reply("categoria restaurantes, descripcion Cena");
  assert.equal(entry().category_id, catId(rt, "Restaurants"));
  assert.equal(entry().description, "Cena");
  reply("tipo inversion");
  assert.equal(entry().type, "investment");
  reply("deposito");
  assert.ok(Number(entry().amount) > 0);
  reply("retiro");
  assert.ok(Number(entry().amount) < 0);
  reply("tipo INVERSIÓN");
  assert.equal(entry().type, "investment");
});

test("'prestamo' without the accent also turns an expense into a loan", () => {
  const { rt, data, reply } = setup();
  const before = rt.rows("Loans").length;
  reply(`prestamo ${data.friends[0].name}`);
  assert.equal(rt.rows("Loans").length, before + 1);
});

test("'tag' (the English bot's wording) and 'etiqueta' both set the label", () => {
  const { rt, data, reply, pending } = setup();
  const tagged = () => rt.rows("Entry Tags").filter((t) => t.entry_id === pending.id).map((t) => t.tag_id);
  reply(`tag ${data.tags[0].name}`);
  assert.deepEqual(tagged(), [data.tags[0].id]);
  reply("etiqueta ninguna");
  assert.deepEqual(tagged(), []);
  reply(`etiqueta ${data.tags[1].name}`);
  assert.deepEqual(tagged(), [data.tags[1].id]);
});

test("a description that contains keywords: only 'comma + keyword + space' starts a new command; text that is not a valid date / currency / amount stays in the description", () => {
  const { reply, entry } = setup();
  reply("descripción Café, Lima");
  assert.equal(entry().description, "Café, Lima");
  reply("descripción categoría de prueba");
  assert.equal(entry().description, "categoría de prueba");
  reply("descripción Pago de fecha 5 y monto 30");
  assert.equal(entry().description, "Pago de fecha 5 y monto 30");
  const amount = entry().amount, date = entry().date, currency = entry().currency;
  reply("descripción Cena, fecha de mi cumpleaños");
  assert.equal(entry().description, "Cena, fecha de mi cumpleaños", "the whole text is kept");
  assert.equal(entry().date, date);
  reply("descripción Regalo, moneda extranjera, monto por persona, fecha de ayer");
  assert.equal(entry().description, "Regalo, moneda extranjera, monto por persona, fecha de ayer");
  assert.equal(entry().amount, amount);
  assert.equal(entry().currency, currency);
  reply("descripción Cena, fecha de mi cumpleaños, monto 20");
  assert.equal(entry().description, "Cena, fecha de mi cumpleaños");
  assert.equal(Number(entry().amount), 20, "a valid keyword after it still applies");
});

test("a bad date / currency NOT after a description is reported and nothing is saved; lookups (category) are never folded into the description", () => {
  const { reply, entry, sent } = setup();
  const before = { date: entry().date, currency: entry().currency, desc: entry().description };
  reply("fecha 2026-02-30"); reply("moneda xyz"); reply("moneda extranjera");
  assert.deepEqual({ date: entry().date, currency: entry().currency, desc: entry().description }, before);
  assert.match(sent(), /Didn't recognize that/, "the person is told it was not understood");
  reply("descripción Uber, categoría zzzz");
  assert.equal(entry().description, "Uber", "a mistyped category is reported, not hidden in the text");
});

test("dates: year first always, and the person's own order (language, or the date_format setting)", () => {
  const { rt, reply, entry } = setup();
  reply("fecha 2026-09-12"); assert.equal(entry().date, "2026-09-12");
  reply("fecha 2026/10/03"); assert.equal(entry().date, "2026-10-03");
  rt.run("setSetting_('language', 'es'); REQUEST_LANG_ = null;");
  reply("fecha 12/09/2026"); assert.equal(entry().date, "2026-09-12", "Spanish: day/month/year");
  reply("fecha 5-8-26"); assert.equal(entry().date, "2026-08-05", "short year and one-digit parts");
  reply("fecha 31/02/2026"); assert.equal(entry().date, "2026-08-05", "a day that does not exist is not saved");
  rt.run("setSetting_('language', 'en'); REQUEST_LANG_ = null;");
  reply("date 09/12/2026"); assert.equal(entry().date, "2026-09-12", "English: month/day/year");
  rt.run("setSetting_('date_format', 'dmy');");
  reply("date 12.09.2026"); assert.equal(entry().date, "2026-09-12", "the date_format setting wins over the language");
  rt.run("setSetting_('date_format', 'ymd');");
  reply("date 13/09/2026"); assert.equal(entry().date, "2026-09-12", "with year-first as the order, day-first text is not guessed");
});
