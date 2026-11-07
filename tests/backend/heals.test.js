// Heals (backend/Heals.gs): one-time repairs of a copy installed before a fix existed. An update only swaps the code, so a Sheet built
// earlier keeps its old settings; the first app open after the update fixes them. First heal: the Sheet's time zone becomes the script's.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setSheetTimeZone } = require("../harness/fake-google");
const { freshApp } = require("./helpers");

const SHEET_TZ = () => "SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()";

// A friend's copy installed before 2026-10-25: Sheet in UTC (no zone of its own), script in America/Lima, dates stored as real dates.
function oldFriendCopy(extra) {
  setSheetTimeZone("UTC");
  const { rt } = freshApp({ entries: 20 });
  rt.svc.props.set("FEATURES", "base");   // what the installer writes: this is a friend's copy
  for (const n of ["Entries", "Loans", "Settlements"]) rt.svc.ss.getSheetByName(n).textCols.clear();
  if (extra) extra(rt);
  return rt;
}
const done = () => setSheetTimeZone(null);

function seedDates(rt) {
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  const acct = rt.rows("Payment Methods")[0].id;
  const f = rt.api("addFriend", { name: "Ana Lo" });
  const e = rt.api("createEntry", { type: "expense", date: "2026-10-26", amount: 10, currency: "PEN", category_id: cat, description: "x" });
  const l = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-21", payment_method_id: acct, description: "L" });
  return { e, l, f };
}
const datesOf = (rt, ids) => ({
  entry: rt.api("listEntries", { limit: 1000 }).find((x) => x.id === ids.e.id).date,
  loan: rt.api("getFriendLoanDetail", { friendId: ids.f.id }).find((x) => x.id === ids.l.id).date,
  loanDue: rt.api("getFriendLoanDetail", { friendId: ids.f.id }).find((x) => x.id === ids.l.id).due_date
});

test("the first open after an update aligns the Sheet's zone with the script's, and no date changes", () => {
  try {
    const rt = oldFriendCopy();
    const ids = seedDates(rt);
    const before = datesOf(rt, ids);
    assert.equal(rt.run(SHEET_TZ()), "UTC");
    rt.api("getMeta", {});
    assert.equal(rt.run(SHEET_TZ()), "America/Lima", "the Sheet now has the script's zone");
    assert.deepEqual(datesOf(rt, ids), before, "every date reads exactly as before");
    assert.deepEqual(before, { entry: "2026-10-26", loan: "2026-10-21", loanDue: "2026-10-28" });
    assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("sheet-time-zone"));
  } finally { done(); }
});

test("it runs once: a later open does not touch the Sheet again", () => {
  try {
    const rt = oldFriendCopy();
    rt.api("getMeta", {});
    rt.svc.ss.failSetTimeZone = true;   // would throw if the heal tried to change the zone again
    rt.api("getMeta", {});
    rt.api("getMeta", {});
    assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("sheet-time-zone"));
  } finally { done(); }
});

test("a refusal from Google never breaks the app: nothing changes, it is not marked done, and the next open tries again", () => {
  try {
    const rt = oldFriendCopy();
    const ids = seedDates(rt);
    rt.svc.ss.failSetTimeZone = true;
    const meta = rt.api("getMeta", {});
    assert.ok(meta.categories.length > 0, "the app still opens");
    assert.equal(rt.run(SHEET_TZ()), "UTC");
    assert.ok(!String(rt.svc.props.get("HEALS_DONE") || "").split(",").includes("sheet-time-zone"), "the failed heal is not marked done (the other heal, which did not fail, is)");
    assert.equal(datesOf(rt, ids).entry, "2026-10-26");
    rt.svc.ss.failSetTimeZone = false;
    rt.api("getMeta", {});
    assert.equal(rt.run(SHEET_TZ()), "America/Lima");
    assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("sheet-time-zone"));
    assert.equal(datesOf(rt, ids).entry, "2026-10-26");
  } finally { done(); }
});

test("a copy whose Sheet already has the script's zone is left alone (and the heal is recorded)", () => {
  setSheetTimeZone("America/Lima");
  try {
    const { rt } = freshApp({ entries: 5 });
    rt.svc.props.set("FEATURES", "base");
    rt.svc.ss.failSetTimeZone = true;   // would throw if it tried
    rt.api("getMeta", {});
    assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("sheet-time-zone"));
  } finally { done(); }
});

test("the owner's own copy is never healed by this (it has no installer FEATURES)", () => {
  setSheetTimeZone("UTC");
  try {
    const { rt } = freshApp({ entries: 5 });
    rt.api("getMeta", {});
    assert.equal(rt.run(SHEET_TZ()), "UTC");
    assert.ok(!String(rt.svc.props.get("HEALS_DONE") || "").split(",").includes("sheet-time-zone"), "only heals marked for the owner run on his copy");
  } finally { done(); }
});

test("a server that still reads dates the OLD way (in the script's zone) shows the right dates once the heal has run: the zones no longer differ", () => {
  // The heal helps every version of the code, not only the current one: with both zones equal there is nothing for a wrong read to shift.
  try {
    const rt = oldFriendCopy();
    const ids = seedDates(rt);
    rt.run("sheetDateTz_ = function () { return Session.getScriptTimeZone(); };");   // the reader of a server not yet updated
    assert.equal(datesOf(rt, ids).entry, "2026-10-25", "before the heal the old reader is a day early on a UTC Sheet");
    rt.run("healSheetTimeZone_();");   // what the first open of a NEW server does
    assert.equal(datesOf(rt, ids).entry, "2026-10-26", "after it, even the old reader is right");
    assert.equal(datesOf(rt, ids).loan, "2026-10-21");
  } finally { done(); }
});

test("heals are listed once each, in order, with ids that are never reused", () => {
  const rt = freshApp({ small: true }).rt;
  const ids = JSON.parse(rt.run("JSON.stringify(HEALS_.map(function (h) { return h.id; }))"));
  assert.deepEqual(ids, ["sheet-time-zone", "paused-programmed-to-ended", "cash-name-language", "mailbox-address-to-line", "owner-account-currencies"]);
  assert.equal(new Set(ids).size, ids.length);
});

// ---- The owner's accounts get a currency (2026-11-06) ----
const owner = (opts) => require("./helpers").freshApp(Object.assign({ small: true }, opts));
const jsv = (rt, code) => JSON.parse(rt.run("JSON.stringify(" + code + ")"));

test("an account's name states its currency, in either language, or says nothing", () => {
  const { rt } = owner();
  for (const [name, want] of [["BCP soles", "PEN"], ["Ahorros Sol", "PEN"], ["IBK dolares", "USD"], ["Cuenta dólares", "USD"], ["Savings USD", "USD"], ["Ahorro euros", "EUR"],
    ["Interbank", ""], ["Soldado", ""], ["Soles y dolares", ""], ["Autos", ""]]) {
    assert.equal(jsv(rt, "accountNameCurrency_(" + JSON.stringify(name) + ")"), want, name);
  }
});

test("entries decide only with 5 or more, listing every currency with 10% of them", () => {
  const { rt } = owner();
  const t = (list) => jsv(rt, "accountEntriesCurrencies_(" + JSON.stringify(list) + ")");
  assert.deepEqual(t(["PEN", "PEN", "PEN", "PEN"]), []);
  assert.deepEqual(t(["PEN", "PEN", "PEN", "PEN", "PEN"]), ["PEN"]);
  assert.deepEqual(t(["USD", "USD", "USD", "USD", "PEN"]), ["USD", "PEN"]);
  assert.deepEqual(t([...Array(19).fill("PEN"), "USD"]), ["PEN"], "5% is left out");
});

test("the heal fills the list where the app knows nothing: never a name, a kind, or a list already there", () => {
  const { rt } = owner();
  const add = (o) => rt.run("appendRowObject('Payment Methods', " + JSON.stringify(Object.assign({ last_4: "", bank_id: "" }, o)) + ")");
  rt.run("ensurePaymentMethodAliasColumns_(); ensurePaymentMethodCurrenciesColumn_()");
  add({ id: "h1", nickname: "Banco soles", type: "debit" });
  add({ id: "h2", nickname: "Banco dolares", type: "debit" });
  add({ id: "h3", nickname: "Banco sin nada", type: "debit" });
  add({ id: "h4", nickname: "Tarjeta soles", type: "credit" });
  add({ id: "h5", nickname: "Banco soles dos", type: "debit", alias_kind: "debit_usd" });
  add({ id: "h6", nickname: "Mezcla", type: "debit" });
  add({ id: "h7", nickname: "Banco soles tres", type: "debit", currencies: "EUR" });
  add({ id: "h8", nickname: "Plain card", type: "credit", alias_kind: "credit" });
  add({ id: "h9", nickname: "Efectivo soles", type: "cash" });
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  ["PEN", "PEN", "PEN", "USD", "USD"].forEach((currency, i) => rt.run("appendRowObject('Entries', " + JSON.stringify({ id: "he" + i, type: "expense", date: "2026-01-0" + (i + 1), amount: 5, currency, category_id: cat, payment_method_id: "h6", paid_by: "me", status: "confirmed" }) + ")"));
  rt.run("healAccountCurrencies_()");
  const of = (id) => rt.rows("Payment Methods").find((r) => r.id === id);
  const cur = (id) => String(of(id).currencies || "");
  assert.equal(cur("h1"), "PEN");
  assert.equal(cur("h2"), "USD");
  assert.equal(cur("h3"), "", "nothing to go on: left empty");
  assert.equal(cur("h4"), "PEN", "an older card too");
  assert.equal(cur("h5"), "", "a kind that names a currency already says");
  assert.equal(cur("h6"), "PEN,USD", "mixed entries: both");
  assert.equal(cur("h7"), "EUR", "a list already there stays");
  assert.equal(cur("h8"), "", "a plain card already reads as both");
  assert.equal(cur("h9"), "", "cash is left alone");
  assert.equal(of("h1").nickname, "Banco soles", "names never change");
  assert.equal(String(of("h1").alias_kind || ""), "", "kinds never change");
});

test("it runs on the owner's copy once and never on a friend's", () => {
  const { rt } = owner();
  rt.api("getMeta", {});
  assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("owner-account-currencies"));
  const friend = owner().rt;
  friend.svc.props.set("FEATURES", "base");   // what the installer writes: this is a friend's copy
  friend.api("getMeta", {});
  assert.ok(!String(friend.svc.props.get("HEALS_DONE") || "").split(",").includes("owner-account-currencies"));
});
