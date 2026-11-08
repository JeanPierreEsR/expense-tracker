// Exchange rates stored against the US dollar (RatesUsd.gs, release B of the rates plan): the preview, the conversion,
// rates asked as "1 USD = ? X" afterwards, and the share-in-dollars line of a third-currency entry. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const M1 = "2031-03", M2 = "2031-04";   // after every made-up rate, so these are the latest
function app() {
  const { rt } = freshApp({ small: true });
  const cat = rt.api("getMeta").categories.find((c) => c.type === "expense");
  const add = (o) => rt.api("createEntry", Object.assign({ type: "expense", category_id: cat.id, status: "confirmed", paid_by: "me", description: "x" }, o));
  const row = (id) => rt.api("listEntries", { startDate: "2031-01-01", endDate: "2031-12-31" }).find((e) => e.id === id);
  return { rt, add, row };
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test("the preview lists every row the dollar way and changes nothing; the conversion keeps same-month totals", () => {
  const { rt, add, row } = app();
  rt.api("setExchangeRate", { currency: "USD", month: M1, rate: 3.75 });
  rt.api("setExchangeRate", { currency: "ARS", month: M1, rate: 0.0026 });
  const e = add({ date: `${M1}-10`, amount: 10000, currency: "ARS" });
  const before = row(e.id).own_share_pen;
  const p = rt.api("previewRatesToUsd");
  const ars = p.rows.find((r) => r.currency === "ARS" && r.month === M1), pen = p.rows.find((r) => r.currency === "PEN" && r.month === M1);
  close(ars.per_usd, 3.75 / 0.0026, "1 USD = ARS");
  close(pen.per_usd, 3.75, "1 USD = PEN");
  assert.equal(pen.before.currency, "USD");
  assert.equal(p.months.filter((m) => m.month >= M1).length, 0, "same month: nothing changes");
  assert.equal(rt.run("ratesThroughUsd_()"), false, "the preview saves nothing");
  assert.equal(row(e.id).own_share_usd, undefined, "no dollar line before the conversion");

  const res = rt.api("convertRatesToUsd");
  assert.equal(res.changed, true);
  assert.equal(rt.run("ratesThroughUsd_()"), true);
  close(row(e.id).own_share_pen, before, "the entry reads the same in soles");
  close(row(e.id).own_share_usd, 10000 * 0.0026 / 3.75, "its share in dollars");
  const sheet = rt.run("getAllRows('Exchange Rates')");
  assert.equal(sheet.length, rt.run("getAllRows('Exchange Rates before USD')").length, "one row for each old one");
  assert.ok(sheet.every((r) => r.currency !== "USD"), "the dollar has no row of its own");
  close(Number(sheet.find((r) => r.currency === "PEN" && r.month === M1).rate), 3.75, "the Sheet reads 1 USD = 3.75 PEN");
  assert.ok(rt.run("getAllRows('Exchange Rates before USD')").some((r) => r.currency === "USD" && r.month === M1), "the old rows are kept");
  const list = rt.api("listExchangeRates");
  close(list.find((r) => r.currency === "USD" && r.month === M1).rate, 3.75, "the list still says 1 USD = 3.75 main");
  close(list.find((r) => r.currency === "ARS" && r.month === M1).per_usd, 3.75 / 0.0026, "and 1 USD = ARS …");
  assert.deepEqual(rt.api("convertRatesToUsd"), { done: true, changed: false }, "a second tap does nothing");
});

test("a month with a newer dollar rate reads through the dollar, and the preview says so first", () => {
  const { rt, add } = app();
  rt.api("setExchangeRate", { currency: "USD", month: M1, rate: 3.75 });
  rt.api("setExchangeRate", { currency: "ARS", month: M1, rate: 0.0026 });
  rt.api("setExchangeRate", { currency: "USD", month: M2, rate: 3.5 });
  add({ date: `${M2}-05`, amount: 10000, currency: "ARS" });
  add({ date: `${M2}-06`, amount: 50, currency: "PEN" });
  const p = rt.api("previewRatesToUsd");
  const late = p.months.filter((m) => m.month >= M1);
  assert.equal(late.length, 1);
  assert.equal(late[0].month, M2);
  close(late[0].before, 50 + 26, "before: the ARS rate straight to soles");
  assert.ok(Math.abs(late[0].after - (50 + 10000 * (0.0026 / 3.75) * 3.5)) < 0.01, "after: ARS → USD (March) → PEN (April)");
  assert.equal(late[0].entries, 1);
});

test("after the conversion a rate is typed as 1 USD = ? X; the older form is refused before it", () => {
  const { rt, add, row } = app();
  rt.api("setExchangeRate", { currency: "USD", month: M1, rate: 3.75 });
  assert.throws(() => rt.api("setExchangeRate", { currency: "ARS", month: M1, per_usd: 1400 }));
  rt.api("convertRatesToUsd");
  const r = rt.api("setExchangeRate", { currency: "ARS", month: M1, per_usd: 1400 });
  close(r.rate, 3.75 / 1400, "answered as 1 ARS = ? PEN");
  close(rt.api("getExchangeRate", { currency: "ARS", month: M1 }).rate, 3.75 / 1400, "read back the same");
  close(rt.api("getLatestRateOnOrBefore", { currency: "ARS", month: M2 }).per_usd, 1400, "the far-off check gets the dollar figure");
  rt.api("setExchangeRate", { currency: "USD", month: M1, per_usd: 3.8 });
  close(rt.api("getExchangeRate", { currency: "USD", month: M1 }).rate, 3.8, "the dollar's own rate is the main currency's row");
  const e = add({ date: `${M1}-02`, amount: 1400, currency: "ARS" });
  close(row(e.id).own_share_pen, 3.8, "1,400 ARS = 1 USD = 3.80 PEN");
  close(row(e.id).own_share_usd, 1, "share in dollars");
  const u = add({ date: `${M1}-02`, amount: 10, currency: "USD" });
  assert.equal(row(u.id).own_share_usd, undefined, "a dollar entry keeps its own dollar line only");
  // The old form still works (Telegram, older phones): 1 ARS = rate main.
  rt.api("setExchangeRate", { currency: "ARS", month: M2, rate: 0.0025 });
  close(rt.api("getExchangeRate", { currency: "ARS", month: M2 }).rate, 0.0025, "old form, same meaning");
});

test("a split shows the owner's share in dollars; switching the main currency to dollars still works", () => {
  const { rt, add, row } = app();
  rt.api("setExchangeRate", { currency: "USD", month: M1, rate: 4 });
  rt.api("setExchangeRate", { currency: "ARS", month: M1, rate: 0.004 });
  rt.api("convertRatesToUsd");
  const e = add({ date: `${M1}-03`, amount: 2000, currency: "ARS" });
  const friend = rt.api("addFriend", { name: "Ana Lo" });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: friend.id, amount: 1000 }] });
  close(row(e.id).own_share_usd, 1, "1,000 ARS of mine = 1 USD");
  rt.api("changeMainCurrency", { currency: "USD" });
  close(row(e.id).own_share_pen, 1, "now the main amount is the dollar one");
  assert.equal(row(e.id).own_share_usd, undefined, "and no second dollar line");
});

test("friends' copies are not offered the conversion yet; no dollar rate means nothing to convert", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  assert.equal(rt.api("getMeta").capabilities.ratesUsdConvert, false);
  assert.throws(() => rt.api("convertRatesToUsd"));
  const own = freshApp({ small: true }).rt;
  assert.equal(own.api("getMeta").capabilities.ratesUsdConvert, true);
  own.run("deleteRowsWhere_('Exchange Rates', function () { return true; })");
  own.api("setExchangeRate", { currency: "ARS", month: M1, rate: 0.0026 });
  assert.deepEqual(own.api("previewRatesToUsd"), { needsUsd: true });
  assert.throws(() => own.api("convertRatesToUsd"));
});

test("after the conversion, dollar entries are not reported as a currency without a rate (owner's Home card, 2026-11-08)", () => {
  const { rt, add } = app();
  rt.api("setExchangeRate", { currency: "USD", month: M1, rate: 3.75 });
  rt.api("setExchangeRate", { currency: "ARS", month: M1, rate: 0.0026 });
  add({ date: `${M1}-03`, amount: 12, currency: "USD", description: "Made-up subscription" });
  assert.equal(rt.api("getHomeGlance", {}).unreadable, null, "before");
  rt.api("convertRatesToUsd");
  assert.equal(rt.api("getHomeGlance", {}).unreadable, null, "after: the dollar is the base, worth 1");
  add({ date: `${M1}-04`, amount: 5, currency: "CHF", description: "No rate at all" });
  const u = rt.api("getHomeGlance", {}).unreadable;
  assert.equal(u.count, 1, "a currency with no rate is still reported");
  assert.equal(u.rows[0].value, "CHF");
});
