// The main ("home") currency (HomeCurrency.gs): soles by default (the owner's copy, unchanged), or whatever a person
// chose once in the welcome questions. Totals, budgets, rates and exports are expressed in it.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function usdHome() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.api("saveOnboarding", { language: "en", dateOrder: "dmy", homeCurrency: "usd", currencies: ["pen", "eur"] });
  const meta = rt.api("getMeta");
  const cat = meta.categories.find((c) => c.type === "expense");
  return { rt, cat, month: today().slice(0, 7) };
}
const entry = (rt, cat, o) => rt.api("createEntry", Object.assign({ type: "expense", date: today(), category_id: cat.id, status: "confirmed", paid_by: "me" }, o));
const fromList = (rt, id) => rt.api("listEntries", { limit: 50 }).find((e) => e.id === id);

test("default: soles are the main currency and nothing changes for the owner's copy", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.run("homeCurrency_()"), "PEN");
  assert.equal(rt.api("getMeta").settings.default_currency, "PEN");
  const cat = rt.api("getMeta").categories.find((c) => c.type === "expense");
  rt.api("setExchangeRate", { currency: "USD", month: today().slice(0, 7), rate: 4 });
  const e = entry(rt, cat, { amount: 10, currency: "USD", description: "usd" });
  assert.equal(fromList(rt, e.id).amount_pen, 40);
  assert.equal(entry(rt, cat, { amount: 10, description: "no currency given" }).currency, "PEN");
});

test("the welcome answer sets the main currency, first in the quick buttons", () => {
  const { rt } = usdHome();
  assert.equal(rt.run("homeCurrency_()"), "USD");
  const s = rt.api("getMeta").settings;
  assert.equal(s.default_currency, "USD");
  assert.equal(s.favorite_currencies, "USD,PEN,EUR");
});

test("with dollars as main: a dollar entry needs no rate, a sol entry is converted with the rate on file", () => {
  const { rt, cat, month } = usdHome();
  const usd = entry(rt, cat, { amount: 100, currency: "USD", description: "dollars" });
  assert.equal(fromList(rt, usd.id).amount_pen, 100, "main currency: its own amount, no rate");
  const soles = entry(rt, cat, { amount: 100, currency: "PEN", description: "soles" });
  assert.equal(fromList(rt, soles.id).amount_pen, null, "no rate for soles yet");
  rt.api("setExchangeRate", { currency: "PEN", month, rate: 0.25 });
  assert.equal(fromList(rt, soles.id).amount_pen, 25, "1 PEN = 0.25 USD");
});

test("with dollars as main: an entry saved without a currency is in dollars", () => {
  const { rt, cat } = usdHome();
  assert.equal(entry(rt, cat, { amount: 5, description: "plain" }).currency, "USD");
});

test("with dollars as main: the period total adds dollars at face value and soles through the rate", () => {
  const { rt, cat, month } = usdHome();
  rt.api("setExchangeRate", { currency: "PEN", month, rate: 0.25 });
  const range = { startDate: today(), endDate: today() };
  const before = rt.api("getPeriodSummary", range).totals.expense;
  entry(rt, cat, { amount: 100, currency: "USD", description: "a" });
  entry(rt, cat, { amount: 100, currency: "PEN", description: "b" });
  const after = rt.api("getPeriodSummary", range).totals.expense;
  assert.ok(Math.abs(after - before - 125) < 0.001, "100 USD + 100 PEN x 0.25 = 125");
});

test("with dollars as main: the CSV export labels its columns with the main currency", () => {
  const { rt, cat } = usdHome();
  entry(rt, cat, { amount: 7, currency: "USD", description: "csv" });
  const files = rt.api("exportDownload", { cards: ["entries"], startDate: today(), endDate: today() }).files;
  const csv = files.find((f) => /entries_/.test(f.name)).text;
  const header = csv.split("\n")[0];
  assert.ok(header.includes("Amount (USD)") && header.includes("Your share (USD)"), header);
  assert.ok(!header.includes("(PEN)"));
});

test("the main currency is chosen once: a later answer cannot change it", () => {
  const { rt, cat } = usdHome();
  entry(rt, cat, { amount: 1, description: "x" });
  const r = rt.api("saveOnboarding", { language: "en", dateOrder: "dmy", homeCurrency: "EUR", currencies: [] });
  assert.equal(r.homeCurrency, "USD");
  assert.equal(rt.api("getMeta").settings.default_currency, "USD");
});

test("junk is ignored: the main currency stays soles unless it is a 3-letter code", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  const r = rt.api("saveOnboarding", { language: "en", dateOrder: "dmy", homeCurrency: "dollars", currencies: [] });
  assert.equal(r.homeCurrency, "PEN");
});

test("budgets and rates: with dollars as main, a dollar budget is not converted and a sol budget is", () => {
  const { rt, cat, month } = usdHome();
  rt.api("setExchangeRate", { currency: "PEN", month, rate: 0.25 });
  const other = rt.api("getMeta").categories.filter((c) => c.type === "expense");
  const used = new Set(rt.api("listBudgets", { month }).budgets.map((b) => b.category_id));
  const free = other.find((c) => !used.has(c.id));
  assert.ok(free, "a category without a budget");
  const b1 = rt.api("addBudget", { category_id: free.id, amount: 200, currency: "USD", period_type: "monthly", thresholds: "50,100" });
  assert.equal(b1.currency, "USD");
  const listed = rt.api("listBudgets", { month }).budgets.find((b) => b.id === b1.id);
  assert.equal(listed.amount_pen, 200, "a budget in the main currency is its own amount");
  const free2 = other.find((c) => !used.has(c.id) && c.id !== free.id);
  const b2 = rt.api("addBudget", { category_id: free2.id, amount: 400, currency: "PEN", period_type: "monthly", thresholds: "50,100" });
  assert.equal(rt.api("listBudgets", { month }).budgets.find((x) => x.id === b2.id).amount_pen, 100, "400 PEN x 0.25");
});
