// Changing the main currency at any time (HomeCurrency.gs: rates are stored against a fixed BASE currency and the
// main currency is only the lens). Two promises are tested across the app's whole read side:
//   1. REVERSIBLE: switch main and switch back -> every screen's numbers are exactly what they were.
//   2. CONSISTENT: with dollars as main, totals are the soles totals divided by that month's rate.
// Made-up data only (the harness' ~seeded entries, with rates for USD/EUR/CLP against soles).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const thisMonth = () => today().slice(0, 7);
const monthEnd = (m) => { const [y, mo] = m.split("-").map(Number); return m + "-" + String(new Date(y, mo, 0).getDate()).padStart(2, "0"); };

function setup() {
  const { rt } = freshApp({ small: true });
  const usd = rt.api("listExchangeRates").filter((r) => r.currency === "USD").sort((a, b) => (a.month < b.month ? -1 : 1));
  const months = usd.map((r) => r.month).slice(-4);
  const usdRate = (m) => usd.filter((r) => r.month <= m).pop().rate;   // latest on or before
  return { rt, months, usdRate };
}

// Everything the screens read, as plain data.
function battery(rt, months) {
  const cur = thisMonth();
  return {
    totals: months.map((m) => rt.api("getPeriodSummary", { startDate: m + "-01", endDate: monthEnd(m) }).totals),
    entries: rt.api("listEntries", { limit: 40 }).map((e) => [e.id, e.currency, e.amount, e.amount_pen, e.own_share_pen]),
    budgets: rt.api("listBudgets", { month: cur }).budgets.map((b) => [b.id, b.currency, b.amount, b.amount_pen, b.progress && b.progress.spent]),
    projections: rt.api("getProjections", { period: "month", anchor: cur + "-15" }),
    categoryProjections: rt.api("listCategoryProjections", {}),
    loans: rt.api("listLoanBalances", {}),
    balances: rt.api("listPaymentMethodBalances", {}),
    expected: rt.api("listExpectedRecurringItems", {}),
    recurring: rt.api("listRecurringExpenses", {})
  };
}

test("the harness data really has foreign entries to convert (so the checks below mean something)", () => {
  const { rt } = setup();
  assert.ok(rt.api("listEntries", { limit: 200 }).some((e) => e.currency !== "PEN"));
});

test("REVERSIBLE: soles -> dollars -> soles gives back exactly the same numbers on every screen", () => {
  const { rt, months } = setup();
  const before = battery(rt, months);
  rt.api("changeMainCurrency", { currency: "USD" });
  assert.equal(rt.run("homeCurrency_()"), "USD");
  const inDollars = battery(rt, months);
  assert.notDeepEqual(inDollars.totals, before.totals, "the numbers really did change while dollars were main");
  rt.api("changeMainCurrency", { currency: "PEN" });
  assert.deepEqual(battery(rt, months), before);
});

test("REVERSIBLE: the same through a currency that has no rate yet (one rate is asked, nothing else is rewritten)", () => {
  const { rt, months } = setup();
  const before = battery(rt, months);
  const rowsBefore = JSON.stringify(rt.rows("Exchange Rates"));
  const pre = rt.api("previewMainCurrencyChange", { currency: "JPY" });
  assert.equal(pre.needsRate, true);
  assert.throws(() => rt.api("changeMainCurrency", { currency: "JPY" }), /how many JPY/);
  assert.equal(rt.run("homeCurrency_()"), "PEN", "a refused change changes nothing");
  rt.api("changeMainCurrency", { currency: "JPY", rate: 40 });   // 1 PEN = 40 JPY
  const rowsAfter = rt.rows("Exchange Rates");
  assert.equal(rowsAfter.length, JSON.parse(rowsBefore).length + 1, "exactly one new rate row (JPY's first)");
  rt.api("changeMainCurrency", { currency: "PEN" });
  assert.deepEqual(battery(rt, months), before);
});

test("CONSISTENT: with dollars as main, each month's totals are the soles totals divided by that month's dollar rate", () => {
  const { rt, months, usdRate } = setup();
  const pen = battery(rt, months);
  rt.api("changeMainCurrency", { currency: "USD" });
  const usd = battery(rt, months);
  months.forEach((m, i) => {
    for (const k of ["income", "expense", "investment", "net"]) {
      const want = pen.totals[i][k] / usdRate(m);
      assert.ok(Math.abs(usd.totals[i][k] - want) < 0.01 * Math.max(1, Math.abs(want)) * 0.01, `${m} ${k}: ${usd.totals[i][k]} vs ${want}`);
    }
  });
});

test("CONSISTENT: a dollar entry is its own amount; every other entry is converted through its own month's rates", () => {
  const { rt } = setup();
  rt.api("changeMainCurrency", { currency: "USD" });
  const list = rt.api("listEntries", { limit: 60 });
  const usdEntry = list.find((e) => e.currency === "USD");
  assert.equal(usdEntry.amount_pen, usdEntry.amount);
  const solEntry = list.find((e) => e.currency === "PEN");
  assert.ok(solEntry.amount_pen < solEntry.amount, "soles are worth less than dollars");
});

test("the rate screens speak in the main currency: 1 X = r MAIN, both ways round", () => {
  const { rt } = setup();
  const m = thisMonth();
  rt.api("setExchangeRate", { currency: "USD", month: m, rate: 4 });          // 1 USD = 4 PEN
  assert.equal(rt.api("getExchangeRate", { currency: "USD", month: m }).rate, 4);
  rt.api("changeMainCurrency", { currency: "USD" });
  // now: 1 PEN = 0.25 USD, and the stored table did not change
  assert.equal(rt.api("getExchangeRate", { currency: "PEN", month: m }).rate, 0.25);
  assert.equal(rt.api("getExchangeRate", { currency: "USD", month: m }), null, "the main currency has no rate of its own");
  const row = rt.api("listExchangeRates").find((r) => r.currency === "PEN" && r.month === m);
  assert.equal(row.rate, 0.25);
  // editing in the new main's terms: 1 PEN = 0.2 USD  <=>  1 USD = 5 PEN
  rt.api("setExchangeRate", { currency: "PEN", month: m, rate: 0.2 });
  rt.api("changeMainCurrency", { currency: "PEN" });
  assert.ok(Math.abs(rt.api("getExchangeRate", { currency: "USD", month: m }).rate - 5) < 1e-9);
  assert.throws(() => rt.api("setExchangeRate", { currency: "PEN", month: m, rate: 1 }), /no rate of its own/);
});

test("months before the new main currency's first rate use that first rate (an estimate), not 'no rate'", () => {
  const { rt } = setup();
  rt.api("changeMainCurrency", { currency: "JPY", rate: 40 });
  const old = rt.api("listEntries", { limit: 2000 }).filter((e) => e.currency === "PEN" && e.date < thisMonth() + "-01").pop();
  assert.ok(old, "an entry from before this month");
  assert.equal(Math.round(old.amount_pen * 100) / 100, Math.round(old.amount * 40 * 100) / 100);
  assert.equal(rt.api("previewMainCurrencyChange", { currency: "PEN" }).same, false);
});

test("new entries start in the new main currency and the quick buttons lead with it", () => {
  const { rt } = setup();
  rt.api("changeMainCurrency", { currency: "USD" });
  const cat = rt.api("getMeta").categories.find((c) => c.type === "expense");
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 3, category_id: cat.id, status: "confirmed", paid_by: "me" });
  assert.equal(e.currency, "USD");
  assert.ok(rt.api("getMeta").settings.favorite_currencies.startsWith("USD"));
});

test("an installer copy: the first main currency is its base, so a fresh table works in any currency", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.sheet("Exchange Rates").rows.length = 1;   // a friend's copy starts with no rates
  rt.run("ROWS_MEMO_ = null; RATES_MEMO_ = null; bumpStructureVersion_();");
  rt.api("saveOnboarding", { language: "en", dateOrder: "dmy", homeCurrency: "usd", currencies: [] });
  assert.equal(rt.run("rateBase_()"), "USD");
  rt.api("setExchangeRate", { currency: "PEN", month: thisMonth(), rate: 0.27 });   // 1 PEN = 0.27 USD
  rt.api("changeMainCurrency", { currency: "PEN" });                                   // needs no rate: PEN has one
  assert.ok(Math.abs(rt.api("getExchangeRate", { currency: "USD", month: thisMonth() }).rate - 1 / 0.27) < 1e-9);
});
