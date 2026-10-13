// Prints what the Telegram bot says, in English and in Spanish, with made-up data
// (nothing touches Telegram or any real sheet). Used to review the bot's texts as
// people really see them, and as the "no English left" check before the default
// language is changed. Run:  node tests/harness/bot-sample.js [--json]
const { freshApp, linkTelegram, today } = require("../backend/helpers");

function sample(lang) {
  const { rt, data } = freshApp({ entries: 120 });
  const chat = linkTelegram(rt);
  rt.run(`setSetting_('language', ${JSON.stringify(lang)}); REQUEST_LANG_ = null;`);
  const out = [];
  const say = (title) => {
    const msgs = rt.svc.fetchLog.splice(0).map((f) => JSON.parse(f.options.payload)).filter((p) => p.text);
    out.push({ title, messages: msgs.map((m) => ({ text: m.text, buttons: m.reply_markup ? m.reply_markup.inline_keyboard[0].map((b) => b.text) : [] })) });
  };
  const exp = (c) => data.cats.find((x) => x.type === c);
  const mk = (fields) => rt.run(`(function () { var e = Object.assign({ id: Utilities.getUuid(), type: 'expense', date: ${JSON.stringify(today())}, amount: 108.22, currency: 'PEN', category_id: '', description: 'Cinema One', paid_by: 'me', payment_method_id: ${JSON.stringify(data.pms[3].id)}, status: 'pending', source: 'email', created_at: new Date().toISOString() }, ${JSON.stringify(fields)}); appendRowObject('Entries', e); return e; })()`);
  const card = (e, cat, reason) => rt.run(`sendTelegramEntryNotification_(getEntryById_(${JSON.stringify(e.id)}), ${cat ? JSON.stringify(cat) : "null"}, ${reason ? JSON.stringify(reason) : "null"})`);
  const link = (e, mid) => rt.run(`appendRowObject('Telegram Messages', { message_id: '${mid}', entry_id: ${JSON.stringify(e.id)}, created_at: 'x' })`);
  let n = 0;
  const reply = (mid, text) => rt.rawPost(JSON.stringify({ update_id: 6000 + (++n), message: { chat: { id: chat }, message_id: 900 + n, text, reply_to_message: { message_id: mid } } }));
  const tap = (kind, e) => rt.rawPost(JSON.stringify({ update_id: 6000 + (++n), callback_query: { id: "cb" + n, data: kind + ":" + e.id, message: { chat: { id: chat }, message_id: 77 } } }));
  const friend = data.friends[0];

  // cards
  const groceries = data.cats.find((c) => c.name === "Groceries");
  const e1 = mk({ category_id: groceries.id, description: "Market" });
  rt.run(`saveEntrySplits(${JSON.stringify(e1.id)}, [{ friend_id: ${JSON.stringify(friend.id)}, amount: 40 }]); saveEntryTags({ entryId: ${JSON.stringify(e1.id)}, tagIds: [${JSON.stringify(data.tags[0].id)}] });`);
  card(e1, null, rt.run("tr_('guess.history', { n: 3, total: 4, merchant: 'Market' })"));
  say("Card: expense with a guessed category, a split and a label");
  const e2 = mk({ type: "transfer", description: "", payment_method_id: "" }); card(e2); say("Card: transfer with no accounts yet");
  const e3 = mk({ type: "investment", amount: -500, description: "Hapi" }); card(e3); say("Card: investment withdrawal with no platform");
  const e4 = mk({ type: "income", paid_by: "", description: "Salary" }); card(e4); say("Card: income with no payor");
  const e5 = mk({ category_id: groceries.id, description: "Market", amount: 108.22 }); card(e5); say("Card: possible duplicate (same day and amount as the first)");

  // button taps
  const e6 = mk({ description: "Taxi" }); tap("confirm", e6); say("Tap Confirm with no category");
  rt.run(`setEntryField_(${JSON.stringify(e6.id)}, 'category_id', ${JSON.stringify(groceries.id)})`); tap("confirm", e6); say("Tap Confirm");
  tap("confirm", e6); say("Tap Confirm again"); tap("discard", e6); say("Tap Discard on a confirmed entry");
  const e7 = mk({ description: "Copy" }); tap("discard", e7); say("Tap Discard"); tap("discard", e7); say("Tap Discard on an entry that is gone");

  // replies
  const e8 = mk({ description: "Reply target" }); link(e8, 800);
  reply(800, "nonsense words"); say("A reply the bot doesn't understand (shows the help)");
  reply(800, "monto 48, categoría zzz"); say("A reply that partly applies");
  reply(800, "help"); say("Help for an expense");
  const e9 = mk({ type: "transfer", description: "" }); link(e9, 801); reply(801, "ayuda"); say("Help for a transfer");
  const e10 = mk({ type: "investment", description: "Hapi" }); link(e10, 802); reply(802, "help"); say("Help for an investment");
  const e11 = mk({ type: "income", paid_by: "", description: "Salary" }); link(e11, 803); reply(803, "help"); say("Help for an income");
  const e12 = mk({ description: "Dinner" }); link(e12, 804); reply(804, `repayment Zzz`); say("Repayment with an unknown friend");
  reply(804, `loan ${friend.name}`); say("Convert to a loan");
  const e13 = mk({ type: "transfer", description: "" }); link(e13, 805); reply(805, `loan ${friend.name}`); say("Loan on a transfer");
  reply(900, "hello"); say("A reply to something that is not a card");
  rt.rawPost(JSON.stringify({ update_id: 6999, message: { chat: { id: chat }, message_id: 1, text: "just text" } })); say("A message that is not a reply");
  rt.rawPost(JSON.stringify({ update_id: 6998, message: { chat: { id: 4242 }, message_id: 1, text: "/start wrong-code" } })); say("/start with a wrong code");
  rt.rawPost(JSON.stringify({ update_id: 6997, message: { chat: { id: chat }, message_id: 1, text: "/start " + rt.ACCESS_CODE } })); say("/start with the right code (already linked)");

  // alerts and notices
  const budget = rt.rows("Budgets").find((x) => x.category_id !== "ALL" && !String(x.category_id).includes(","));
  const budgetCat = rt.run(`categoryLabel_(getAllRows('Categories').find(function (c) { return c.id === ${JSON.stringify(budget.category_id)}; }))`);
  rt.run(`sendTelegramBudgetAlert_(getAllRows('Budgets').find(function (b) { return b.id === ${JSON.stringify(budget.id)}; }), ${JSON.stringify(budgetCat)}, 75, { percent: 77.4, spent: 310 })`); say("Budget alert (monthly)");
  rt.run(`sendTelegramLoanOverdueAlert_({ direction: 'they_owe_me', currency: 'PEN', remaining: 120, due_date: '2026-10-05', description: 'Concert tickets' }, ${JSON.stringify(friend.name)})`); say("Overdue loan: they owe you");
  rt.run(`sendTelegramLoanOverdueAlert_({ direction: 'i_owe_them', currency: 'PEN', remaining: 80, due_date: '2026-10-05', description: '' }, ${JSON.stringify(friend.name)})`); say("Overdue loan: you owe");
  rt.run("sendTelegramText_(tr_('notice.statement', { bank: 'Interbank Visa', date: '2026-10-12' }))"); say("New statement in the inbox");
  rt.run("alertAutomationFailures_(['telegram: boom'])"); say("Automatic scan problem");
  const photo = (text) => rt.run(`photoReply_(${chat}, 1, ${JSON.stringify(text)})`);
  photo(rt.run("tr_('photo.queued')")); photo(rt.run("tr_('photo.notAReceipt')")); photo(rt.run("tr_('photo.noAmount', { kind: tr_('photo.kind.yape_sent') })")); photo(rt.run("tr_('photo.duplicate')")); photo(rt.run("tr_('photo.ownerName')")); say("Photo replies");
  return out;
}

if (require.main === module) {
  const result = { en: sample("en"), es: sample("es") };
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(result, null, 1));
  } else {
    ["en", "es"].forEach((lang) => {
      console.log(`\n=================== ${lang.toUpperCase()} ===================`);
      result[lang].forEach((s) => {
        console.log(`\n--- ${s.title}`);
        s.messages.forEach((m) => console.log(m.text + (m.buttons.length ? `\n   [ ${m.buttons.join(" ] [ ")} ]` : "")));
      });
    });
  }
}
module.exports = { sample };
