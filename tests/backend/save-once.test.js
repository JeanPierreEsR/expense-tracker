// A save sent twice with the same request id is done ONCE (owner, 2026-11-14: a trip saved while the phone was locked was made three
// times: the answer was lost and each "Try again" made it again). The phone keeps one id per save across its retries. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("a trip sent again with the same request id is not made twice; another id makes another", () => {
  const { rt } = freshApp({ small: true });
  const before = rt.api("listTrips", {}).length;
  const p = { name: "Demo once", kind: "trip", start_date: today(), end_date: today(), _requestId: "req-trip-1" };
  const a = rt.api("addTrip", p);
  const b = rt.api("addTrip", p);
  assert.equal(a.id, b.id, "the repeat gets the first answer");
  assert.equal(rt.api("listTrips", {}).length, before + 1);
  rt.api("addTrip", { ...p, _requestId: "req-trip-2" });
  assert.equal(rt.api("listTrips", {}).length, before + 2);
});

test("the other creating saves are marked once on both sides", () => {
  const fs = require("fs"), path = require("path");
  const api = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "Api.gs"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  for (const a of ["addTrip", "addBudget", "addPaymentMethod", "saveCategory", "addTag", "saveBankLoan"]) {
    assert.match(api, new RegExp(`\\b${a}: 1`), `${a} in ONCE_ACTIONS_`);
    assert.match(app.slice(app.indexOf("const ONCE_ACTIONS"), app.indexOf("]);", app.indexOf("const ONCE_ACTIONS"))), new RegExp(`"${a}"`), `${a} in the app's ONCE_ACTIONS`);
  }
  // Retries reuse the ids of the first try.
  assert.match(app, /saveRetryCtx_ = retry;/);
  assert.match(app, /if \(attempt === 1 && saveRetryCtx_ && ONCE_ACTIONS\.has\(action\)/);
});
