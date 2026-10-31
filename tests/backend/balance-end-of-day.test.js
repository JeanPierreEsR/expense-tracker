// A starting balance set for a past day is the END of that day (owner's rule, 2026-10-31): entries dated that day are already inside it,
// entries of later days count. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Account Opening Balances', function () { return true; });`);
  rt.run(`appendRowObject('Payment Methods', { id: 'eod-pm', nickname: 'EOD wallet', type: 'wallet', bank_id: '', last_4: '' });`);
  return rt;
}
const spend = (rt, date, amount) => rt.run(`appendRowObject('Entries', ${JSON.stringify({
  id: "e" + Math.random().toString(36).slice(2), type: "expense", date, amount, currency: "PEN", category_id: "", description: "x",
  payment_method_id: "eod-pm", paid_by: "me", status: "confirmed", source: "manual", created_at: "2099-01-01T00:00:00" })});`);
const balance = (rt) => rt.api("listPaymentMethodBalances", {}).find((b) => b.id === "eod-pm").balances.find((b) => b.currency === "PEN").amount;

test("a balance for a past day already contains that day's entries; later days count", () => {
  const rt = setup();
  rt.api("setPaymentMethodOpeningBalance", { id: "eod-pm", balances: [{ currency: "PEN", amount: 500, date: "2026-10-28" }] });
  spend(rt, "2026-10-27", 11);   // before: inside it
  spend(rt, "2026-10-28", 22);   // same day, even logged later: inside it
  spend(rt, "2026-10-29", 33);   // next day: counts
  assert.equal(balance(rt), 467);
});

test("a balance dated today is still the moment it was saved", () => {
  const rt = setup();
  const d = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d);
  rt.api("setPaymentMethodOpeningBalance", { id: "eod-pm", balances: [{ currency: "PEN", amount: 100, date: today }] });
  assert.equal(balance(rt), 100);
});
