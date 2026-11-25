// The bots write dates the way the person chose in More → My profile → How I type dates (owner, 2026-11-25): never a
// year-month-day code, the month as a word like the app, and the typed examples in the same order.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const orders = { dmy: "15 Nov 2026", mdy: "Nov 15, 2026", ymd: "2026 Nov 15" };

test("a date the bot writes follows the chosen order", () => {
  const { rt } = freshApp({ entries: 50 });
  for (const [order, want] of Object.entries(orders)) {
    rt.run(`setSetting_('date_format', '${order}')`);
    assert.equal(rt.run("botDate_('2026-11-15')"), want);
  }
});

test("the transaction card and the overdue reminder carry no year-month-day code", () => {
  const { rt, data } = freshApp({ entries: 300 });
  const e = data.entries.find((x) => x.status === "pending" && x.type === "expense");
  rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'date', '2025-03-07')`);
  rt.run("setSetting_('date_format', 'dmy')");
  const card = rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(e.id)}), null, null, {})`);
  assert.doesNotMatch(card, /2025-03-07/);
  assert.match(card, /7 Mar 2025/);
  rt.run("setSetting_('date_format', 'mdy')");
  const alert = rt.run("loanOverdueAlertText_({ direction: 'they_owe_me', currency: 'PEN', remaining: 10, due_date: '2025-03-07' }, 'Ana')");
  assert.match(alert, /Mar 7, 2025/);
});

test("typed examples follow the chosen order", () => {
  const { rt } = freshApp({ entries: 50 });
  rt.run("setSetting_('date_format', 'dmy')");
  assert.match(rt.run("tr_('help.date')"), /15\/11\/2026/);
  assert.match(rt.run("whatsappAskText_('date')"), /15\/11\/2026/);
  assert.doesNotMatch(rt.run("whatsappAskText_('date')"), /2026-11-15/);
  rt.run("setSetting_('date_format', 'mdy')");
  assert.match(rt.run("tr_('whatsapp.newHow')"), /date 11\/15\/2026/);
});
