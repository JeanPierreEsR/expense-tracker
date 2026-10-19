// Trips & events — each trip has its OWN main currency (2026-10-19). Every figure on the trip
// (total, phases, by category, by day, budget) is in that currency: an expense already in it counts
// exactly as paid; anything else goes through the main currency at the rates on file.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.api("setExchangeRate", { currency: "USD", month: "2020-03", rate: 4 });   // 1 USD = 4 PEN
  rt.api("setExchangeRate", { currency: "EUR", month: "2020-03", rate: 5 });   // 1 EUR = 5 PEN
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Cur test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  return rt;
}
function entry(rt, tripId, id, amount, currency, date = "2020-03-10") {
  const e = { id, type: "expense", date, amount, currency, category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)}); ensureEntriesTripColumn_(); setEntryField_('${id}', 'trip_id', '${tripId}');`);
}
const trip = (rt, over = {}) => rt.api("addTrip", { name: "Trip", kind: "trip", start_date: "2020-03-01", end_date: "2020-03-31", ...over });

test("a USD trip: USD expenses count exactly, soles and euros are converted into dollars", () => {
  const rt = setup();
  const t = trip(rt, { currency: "USD" });
  entry(rt, t.id, "pen", 400, "PEN");   // 100 USD
  entry(rt, t.id, "usd", 50, "USD");    // exactly 50
  entry(rt, t.id, "eur", 40, "EUR");    // 200 PEN = 50 USD
  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.currency, "USD");
  assert.equal(d.totalMain, 200);
  assert.equal(d.during, 200);
  assert.equal(d.byCategory.reduce((s, c) => s + c.amount_pen, 0), 200);
  assert.equal(d.byDay[0].amount_main, 200);
  const listed = rt.api("listTrips", {})[0];
  assert.equal(listed.cur, "USD");
  assert.equal(listed.spentMain, 200);
});

test("the default is the app's main currency, and an older trip follows its budget's currency", () => {
  const rt = setup();
  const t = trip(rt);                                      // no currency chosen
  entry(rt, t.id, "usd", 50, "USD");
  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.currency, "PEN");
  assert.equal(d.totalMain, 200, "50 USD at 4");

  // a trip saved before trips had a currency, with its budget in USD
  rt.run(`appendRowObject('Trips', { id: 'old', name: 'Old', kind: 'trip', start_date: '2020-03-01', end_date: '2020-03-31', emoji: '', budget_amount: 500, budget_currency: 'USD', alert_thresholds: '', currency: '' });`);
  entry(rt, "old", "o1", 400, "PEN");
  const old = rt.api("getTripDetail", { id: "old" });
  assert.equal(old.currency, "USD");
  assert.equal(old.totalMain, 100);
  assert.equal(old.budgetSpent, 100, "the budget is measured in the same currency as the total");
});

test("a budget is always in the trip's currency", () => {
  const rt = setup();
  const t = trip(rt, { currency: "USD", budget_amount: 300 });
  assert.equal(t.budget_currency, "USD");
  entry(rt, t.id, "e1", 400, "PEN");
  entry(rt, t.id, "e2", 50, "USD");
  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.budgetSpent, 150);
  assert.equal(d.trip.budget_amount, 300);

  const noCurrency = trip(rt, { name: "Budget only", budget_amount: 1000 });
  assert.equal(noCurrency.budget_currency, "PEN", "a budget with no currency chosen is in the main currency");
  const noBudget = trip(rt, { name: "No budget", currency: "EUR" });
  assert.equal(noBudget.currency, "EUR");
  assert.equal(noBudget.budget_currency, "");
});

test("a missing rate leaves out only what needs it — expenses already in the trip's currency always count", () => {
  const rt = setup();
  const t = trip(rt, { currency: "CHF" });                 // no CHF rate anywhere
  entry(rt, t.id, "chf", 30, "CHF");
  entry(rt, t.id, "pen", 100, "PEN");
  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.totalMain, 30);
  assert.equal(d.missingRate, 1);
});

test("estimates count in the trip's currency too", () => {
  const rt = setup();
  const usdTrip = trip(rt, { name: "Dollars", currency: "USD" });
  const penTrip = trip(rt, { name: "Soles" });
  rt.api("addRecurringExpense", { category_id: "cat-a", description: "Hotel", amount: 100, currency: "USD", frequency: "once", date: "2020-03-12", trip_id: usdTrip.id });
  rt.api("addRecurringExpense", { category_id: "cat-a", description: "Tour", amount: 100, currency: "USD", frequency: "once", date: "2020-03-12", trip_id: penTrip.id });
  assert.equal(rt.api("getTripDetail", { id: usdTrip.id }).estimatedMain, 100, "exactly 100 USD");
  assert.equal(rt.api("getTripDetail", { id: penTrip.id }).estimatedMain, 400);
});

test("a bad currency is refused, and the column is added to an older Trips tab", () => {
  const rt = setup();
  assert.throws(() => trip(rt, { currency: "DOLLARS" }), /3-letter/i);
  rt.run(`var sh = getSheet('Trips'); var h = getHeaders(sh); sh.getRange(1, h.indexOf('currency') + 1).clearContent();`);
  rt.run("tripsColumnsChecked_ = false;");
  rt.api("getMeta", {});
  assert.ok(rt.run("getHeaders(getSheet('Trips'))").includes("currency"));
});

test("the Telegram budget alert quotes the trip's currency", () => {
  const rt = setup();
  const t = trip(rt, { currency: "USD", budget_amount: 100, end_date: new Date().toISOString().slice(0, 10) });
  entry(rt, t.id, "e", 480, "PEN");                        // 120 USD = 120% of the budget
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: 1 } });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "fake-bot-token");
  rt.svc.props.set("TELEGRAM_CHAT_ID", "555");
  const res = rt.run("checkTripBudgets()");
  assert.equal(res.alertsSent, 1);
  assert.match(rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n"), /120% of its USD 100\.00 budget \(USD 120\.00/);
});
