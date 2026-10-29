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
    assert.equal(rt.svc.props.get("HEALS_DONE"), "sheet-time-zone");
  } finally { done(); }
});

test("it runs once: a later open does not touch the Sheet again", () => {
  try {
    const rt = oldFriendCopy();
    rt.api("getMeta", {});
    rt.svc.ss.failSetTimeZone = true;   // would throw if the heal tried to change the zone again
    rt.api("getMeta", {});
    rt.api("getMeta", {});
    assert.equal(rt.svc.props.get("HEALS_DONE"), "sheet-time-zone");
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
    assert.ok(!rt.svc.props.get("HEALS_DONE"));
    assert.equal(datesOf(rt, ids).entry, "2026-10-26");
    rt.svc.ss.failSetTimeZone = false;
    rt.api("getMeta", {});
    assert.equal(rt.run(SHEET_TZ()), "America/Lima");
    assert.equal(rt.svc.props.get("HEALS_DONE"), "sheet-time-zone");
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
    assert.equal(rt.svc.props.get("HEALS_DONE"), "sheet-time-zone");
  } finally { done(); }
});

test("the owner's own copy is never healed by this (it has no installer FEATURES)", () => {
  setSheetTimeZone("UTC");
  try {
    const { rt } = freshApp({ entries: 5 });
    rt.api("getMeta", {});
    assert.equal(rt.run(SHEET_TZ()), "UTC");
    assert.ok(!rt.svc.props.get("HEALS_DONE"));
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
  assert.deepEqual(ids, ["sheet-time-zone"]);
  assert.equal(new Set(ids).size, ids.length);
});
