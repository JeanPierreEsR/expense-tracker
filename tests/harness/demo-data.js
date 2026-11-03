// Made-up DEMO scenarios for trying the newest features by hand on the test copy (tests/harness/server.js). Everything here is invented and
// dated relative to today, so the same things are always there to try. Not used by the automated tests (they build their own data).
//
//   Trips & events .. delete several (their expenses stay, unlinked; an estimate stays as a Programmed item)
//   Friends ........ delete (no records) / hide (history, nothing owed) / kept (money owed) / already hidden (Unhide, re-add the same name)
//   Programmed ..... Stop it / Delete it (items with payments), plain delete (no payments), ended items (Start again), one-time paid / unpaid,
//                    an income item, a shared item (split), a variable item, and LEGACY PAUSED items to try the heal:
//                    two are converted silently, four are left for the "decide now" sheet.
const { TZ } = require("./fake-google");

const lima = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const [Y, M, D] = lima().split("-").map(Number);
const pad = (n) => String(n).padStart(2, "0");
// The day `day` of the month `k` months ago (k = 0 is this month).
const ago = (k, day) => { const d = new Date(Date.UTC(Y, M - 1 - k, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(day)}`; };
const todayISO = () => `${Y}-${pad(M)}-${pad(D)}`;
const inMonths = (k, day) => ago(-k, day);

function seedDemo(rt, data) {
  let seq = 0;
  const cats = data.cats.filter((c) => c.type === "expense");
  const incomeCat = data.cats.find((c) => c.type === "income");
  const pm = data.pms[0].id;
  const cat = (i) => cats[i % cats.length].id;
  const pay = (category, description, amount, date, extra) => {
    const id = "demo-" + ++seq;
    rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id, type: "expense", date, amount, currency: "PEN", category_id: category, description, paid_by: "me", payment_method_id: pm, status: "confirmed", source: "manual" }, extra || {}))});`);
    return id;
  };
  const item = (fields) => rt.api("addRecurringExpense", Object.assign({ currency: "PEN", frequency: "monthly" }, fields));
  const pause = (it) => { rt.api("updateRecurringExpense", { id: it.id, active: false }); return it; };
  const months = (name, category, amount, day, from, to, skip) => { for (let k = from; k >= to; k--) if (!(skip || []).includes(k)) pay(category, name, amount, ago(k, day)); };

  // ---------------- Friends ----------------
  rt.api("addFriend", { name: "Demo Free A (no records)" });
  rt.api("addFriend", { name: "Demo Free B (no records)" });
  const settled = rt.api("addFriend", { name: "Demo History settled" });
  rt.api("addLoan", { friend_id: settled.id, direction: "they_owe_me", amount: 120, currency: "PEN", date: ago(3, 10), payment_method_id: pm, description: "Demo loan" });
  rt.api("recordRepayment", { friend_id: settled.id, direction: "they_owe_me", amount: 120, currency: "PEN", date: ago(2, 10), payment_method_id: pm });
  const settled2 = rt.api("addFriend", { name: "Demo History settled 2" });
  rt.api("addLoan", { friend_id: settled2.id, direction: "i_owe_them", amount: 60, currency: "PEN", date: ago(4, 3), payment_method_id: pm, description: "Demo loan" });
  rt.api("recordRepayment", { friend_id: settled2.id, direction: "i_owe_them", amount: 60, currency: "PEN", date: ago(3, 3), payment_method_id: pm });
  const owes = rt.api("addFriend", { name: "Demo Owes me" });
  rt.api("addLoan", { friend_id: owes.id, direction: "they_owe_me", amount: 85, currency: "PEN", date: ago(1, 12), payment_method_id: pm, description: "Demo loan still open" });
  const already = rt.api("addFriend", { name: "Demo Already hidden" });
  rt.api("addLoan", { friend_id: already.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: ago(5, 5), payment_method_id: pm, description: "Demo old loan" });
  rt.api("recordRepayment", { friend_id: already.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: ago(5, 20), payment_method_id: pm });
  rt.api("deleteFriends", { ids: [already.id] });   // has history, owes nothing: hidden

  // ---------------- Programmed items: active, with payments ----------------
  months("Demo Gym", cat(0), 109.9, 5, 12, 1);
  item({ category_id: cat(0), description: "Demo Gym", amount: 109.9, day: 5, start_date: ago(12, 5) });
  months("Demo Streaming", cat(1), 24.9, 12, 9, 1);
  item({ category_id: cat(1), description: "Demo Streaming", amount: 24.9, day: 12, start_date: ago(9, 12) });
  // Nothing paid yet and it only starts today: deleting it has no effect on any average.
  item({ category_id: cat(2), description: "Demo Not paid yet", amount: 45, day: D, start_date: todayISO() });
  // Shared with a friend (try Stop it, then Start again: the split comes along).
  const rentCategory = cat(3);
  for (let k = 10; k >= 0; k--) {   // the whole bill is paid and 600 of it is the friend's share, like the item says
    const id = pay(rentCategory, "Demo Shared rent", 1800, ago(k, 1));
    rt.run(`appendRowObject('Entry Splits', ${JSON.stringify({ id: "demo-split-" + id, entry_id: id, friend_id: owes.id, amount: 600 })});`);
  }
  const rent = item({ category_id: rentCategory, description: "Demo Shared rent", amount: 1800, day: 1, start_date: ago(10, 1) });
  rt.api("saveRecurringExpenseSplits", { recurringExpenseId: rent.id, splits: [{ friend_id: owes.id, amount: 600 }] });
  // Amount changes every month.
  [82.4, 97.1, 88.8, 104.3, 91.5, 86.2].forEach((a, i) => pay(cat(4), "Demo Electricity bill", a, ago(6 - i, 15)));
  item({ category_id: cat(4), description: "Demo Electricity", amount: 90, day: 15, variable: true, match_words: "electricity", start_date: ago(6, 15) });
  // Income: no average to fall back on, so deleting it changes nothing.
  for (let k = 8; k >= 1; k--) pay(incomeCat.id, "Demo Salary", 3500, ago(k, 28), { type: "income" });
  item({ category_id: incomeCat.id, description: "Demo Salary", amount: 3500, day: 28, start_date: ago(8, 28) });
  // Yearly.
  pay(cat(5), "Demo Insurance", 640, ago(11, 20));
  item({ category_id: cat(5), description: "Demo Insurance", amount: 640, frequency: "yearly", month: ((M + 12 - 11 - 1) % 12) + 1, day: 20, start_date: ago(11, 20) });

  // ---------------- Ended (shown under the past items; try Start again) ----------------
  months("Demo Old gym (ended)", cat(6), 89, 8, 12, 4);
  item({ category_id: cat(6), description: "Demo Old gym (ended)", amount: 89, day: 8, start_date: ago(12, 8), end_date: ago(4, 8) });

  // ---------------- One-time ----------------
  pay(cat(7), "Demo Laptop (paid)", 2400, ago(2, 10));
  item({ category_id: cat(7), description: "Demo Laptop (paid)", amount: 2400, frequency: "once", date: ago(2, 10) });   // paid: goes to the past items
  item({ category_id: cat(8), description: "Demo Old plan, never paid", amount: 300, frequency: "once", date: ago(1, 20) });   // overdue and unpaid: stays visible
  item({ category_id: cat(9), description: "Demo Concert tickets (future)", amount: 420, frequency: "once", date: inMonths(2, 14) });

  // ---------------- LEGACY PAUSED items (try the heal) ----------------
  // 1. Converted silently: every occurrence paid, nothing changes.
  months("Demo Paused clean A", cat(10), 59, 9, 8, 3);
  pause(item({ category_id: cat(10), description: "Demo Paused clean A", amount: 59, day: 9 }));
  // 2. Converted silently: it already had an end date; only the pause is switched off.
  months("Demo Paused clean B", cat(11), 33, 20, 8, 4);
  pause(item({ category_id: cat(11), description: "Demo Paused clean B", amount: 33, day: 20, end_date: ago(4, 28) }));
  // 3. Left for the decide-now sheet: never paid.
  pause(item({ category_id: cat(12), description: "Demo Paused never paid", amount: 18, day: 6 }));
  // 4. Left for the sheet: a month was missed in the middle.
  months("Demo Paused with a gap", cat(13), 71, 14, 6, 2, [4]);
  pause(item({ category_id: cat(13), description: "Demo Paused with a gap", amount: 71, day: 14 }));
  // 5. Left for the sheet: one-time items have no end date.
  pause(item({ category_id: cat(14), description: "Demo Paused one-time", amount: 90, frequency: "once", date: ago(0, 2) }));
  // 6. Left for the sheet: starts in the future.
  pause(item({ category_id: cat(15), description: "Demo Paused not started", amount: 25, day: 3, start_date: inMonths(3, 3) }));

  // ---------------- Trips & events (try More → Trips & events → Edit: expenses are only unlinked) ----------------
  const dayOffset = (n) => { const d = new Date(Date.UTC(Y, M - 1, D + n)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const tripRent = (name, kind, from, to, extra) => rt.api("addTrip", Object.assign({ name, kind, start_date: dayOffset(from), end_date: dayOffset(to) }, extra || {}));
  const beach = tripRent("Demo Beach weekend", "trip", -2, 3, { budget_amount: 900, budget_currency: "PEN" });   // happening now, with a budget
  pay(cat(0), "Demo Beach hotel", 420, dayOffset(-2), { trip_id: beach.id });
  pay(cat(1), "Demo Beach dinner", 96, dayOffset(-1), { trip_id: beach.id });
  item({ category_id: cat(2), description: "Demo Beach friend's share (estimate)", amount: 150, frequency: "once", date: dayOffset(2), trip_id: beach.id });   // an estimate: stays, unlinked, when the trip is deleted
  const party = tripRent("Demo Birthday party", "event", -40, -40);   // past
  pay(cat(3), "Demo Party cake", 85, dayOffset(-40), { trip_id: party.id });
  pay(cat(4), "Demo Party drinks", 140, dayOffset(-40), { trip_id: party.id });
  tripRent("Demo Cusco (upcoming)", "trip", 25, 31);   // not started, nothing linked yet
  tripRent("Demo Empty trip", "trip", -90, -85);   // past, no expenses: deleted with no side effects

  // The demo has to look the same every time: nothing here should be "unknown" to the figures, so drop the cached reads.
  return { demo: true };
}

module.exports = { seedDemo };
