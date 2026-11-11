// "Is this already in your bank's balance?" (owner, 2026-11-11): entries marked "Not yet" when a starting balance is saved count AFTER
// it, even though they were recorded before it and dated on/before its day. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Account Opening Balances', function () { return true; });`);
  rt.run(`appendRowObject('Payment Methods', { id: 'ny-pm', nickname: 'NY card', type: 'credit', bank_id: '', last_4: '' });`);
  return rt;
}
const spend = (rt, id, date, amount, currency) => rt.run(`appendRowObject('Entries', ${JSON.stringify({
  id, type: "expense", date, amount, currency: currency || "PEN", category_id: "", description: "Purchase " + id,
  payment_method_id: "ny-pm", paid_by: "me", status: "confirmed", source: "manual", created_at: "2026-01-01T00:00:00" })});`);
const balance = (rt, cur) => rt.api("listPaymentMethodBalances", {}).find((b) => b.id === "ny-pm").balances.find((b) => b.currency === (cur || "PEN")).amount;

test("a purchase marked Not yet counts after the starting balance; one left Already in does not", () => {
  const rt = setup();
  spend(rt, "a", "2026-10-08", 10);
  spend(rt, "b", "2026-10-09", 42.50);
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -100, date: "2026-10-09", not_yet: ["b"] }] });
  assert.equal(balance(rt), -142.50);
  const row = rt.api("listPaymentMethodBalances", {}).find((b) => b.id === "ny-pm").openings[0];
  assert.deepEqual(row.not_yet, ["b"]);
});

test("re-saving without marks keeps the saved ones for the same currency and day; a new day drops them", () => {
  const rt = setup();
  spend(rt, "b", "2026-10-09", 50);
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -100, date: "2026-10-09", not_yet: ["b"] }] });
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -120, date: "2026-10-09" }] });
  assert.equal(balance(rt), -170);
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -120, date: "2026-10-10" }] });
  assert.equal(balance(rt), -120);
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -120, date: "2026-10-10", not_yet: [] }] });
  assert.equal(balance(rt), -120);
});

test("the candidates are the account's entries of the 3 days up to the balance's day, per currency, newest first", () => {
  const rt = setup();
  spend(rt, "old", "2026-10-06", 1);
  spend(rt, "d7", "2026-10-07", 2);
  spend(rt, "d9", "2026-10-09", 3);
  spend(rt, "later", "2026-10-10", 4);
  spend(rt, "usd", "2026-10-08", 5, "USD");
  const out = rt.api("listStartBalanceCandidates", { id: "ny-pm", rows: [{ currency: "PEN", date: "2026-10-09" }, { currency: "USD", date: "2026-10-09" }] });
  assert.deepEqual(out.PEN.map((e) => e.id), ["d9", "d7"]);
  assert.equal(out.PEN[0].signed, -3);
  assert.deepEqual(out.USD.map((e) => e.id), ["usd"]);
});

test("a statement line matched to a Not yet purchase is explained by the statement check, not left unexplained", () => {
  const rt = setup();
  spend(rt, "b", "2026-10-09", 42.50);
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -100, date: "2026-10-09", not_yet: ["b"] }] });
  const out = rt.run(`(function () {
    var pm = getAllRows('Payment Methods').find(function (p) { return p.id === 'ny-pm'; });
    var openings = buildOpeningsByPm_([pm])['ny-pm'];
    var confirmed = confirmedEntries_();
    var byId = {}; confirmed.forEach(function (e) { byId[e.id] = e; });
    return stmtBalanceCheck_({ pm: pm, currency: 'PEN', closing: -142.50, start: '2026-10-01', end: '2026-10-31',
      lines: [{ date: '2026-10-09', currency: 'PEN', amount: -42.50, status: 'matched', entry: { id: 'b' } }],
      openings: openings, confirmed: confirmed, inboundIds: {}, entryById: byId });
  })()`);
  assert.equal(out.appAtEnd, -142.50);
  assert.equal(out.diff, 0);
  assert.equal(out.unexplained, 0);
});

test("the candidates also name every currency the account has movements in, at any date", () => {
  const rt = setup();
  spend(rt, "a", "2026-10-09", 5);
  spend(rt, "u", "2020-01-01", 7, "USD");
  const out = rt.api("listStartBalanceCandidates", { id: "ny-pm", rows: [{ currency: "PEN", date: "2026-10-09" }] });
  assert.deepEqual(out.__moved, ["PEN", "USD"]);
});

test("option C: a bank e-mail that arrives after the balance was saved, for a purchase of its last 3 days, counts after it; a hand-typed one does not", () => {
  const rt = setup();
  const day = (k) => { const d = new Date(Date.now() - k * 86400000); return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(d); };
  rt.api("setPaymentMethodOpeningBalance", { id: "ny-pm", balances: [{ currency: "PEN", amount: -100, date: day(0) }] });
  const late = (id, date, amount, source) => rt.run(`appendRowObject('Entries', ${JSON.stringify({
    id, type: "expense", date, amount, currency: "PEN", category_id: "", description: "Late " + id,
    payment_method_id: "ny-pm", paid_by: "me", status: "confirmed", source, created_at: "2099-01-01T00:00:00" })});`);
  late("mail-yesterday", day(1), 30, "email");    // counts after: the bank was still processing it
  late("hand-yesterday", day(1), 7, "manual");    // stays inside: typed later, usually already posted
  late("mail-old", day(5), 11, "email");          // older than the window: stays inside
  assert.equal(balance(rt), -130);
});
