// Start-up trims (2026-11-28, from the owner's real timings): the business set-up is remembered once done, partner tabs are not read
// outside company copies, the paused-items check reads only its own tab, trip group friends are checked with one read of Friends.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");
const fg = require("../harness/fake-google");

const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
function readsDuring(rt, js) {
  const st = fg.stats; st.bySheet = {};
  rt.run(js);
  const seen = Object.keys(st.bySheet);
  st.bySheet = null;
  return seen;
}

test("business set-up: done once, then only the tab names are looked at; a tab deleted by hand is made again", () => {
  const { rt } = freshApp({ small: true });
  rt.run("setSetting_('business_features', 'yes')");
  rt.run("businessEnsured_ = false; ensureBusinessSheets_()");
  assert.equal(rt.svc.props.get("BUSINESS_SETUP_DONE"), plain(rt.run("businessSetupSignature_()")));
  const seen = readsDuring(rt, "businessEnsured_ = false; ROWS_MEMO_ = null; ensureBusinessSheets_()");
  assert.deepEqual(seen, [], "a later start reads no tab for it");
  rt.svc.ss.deleteSheet(rt.svc.ss.getSheetByName("Units"));
  rt.run("businessEnsured_ = false; ensureBusinessSheets_()");
  assert.ok(rt.svc.ss.getSheetByName("Units"), "made again");
});

test("a new business set-up version runs the full check again", () => {
  const { rt } = freshApp({ small: true });
  rt.run("setSetting_('business_features', 'yes')");
  rt.svc.props.set("BUSINESS_SETUP_DONE", "0:old");
  rt.run("businessEnsured_ = false; ensureBusinessSheets_()");
  assert.equal(rt.svc.props.get("BUSINESS_SETUP_DONE"), plain(rt.run("businessSetupSignature_()")));
});

test("partner tabs are not read outside a company copy", () => {
  const { rt } = freshApp({ small: true });
  rt.run("setSetting_('business_features', 'yes'); businessEnsured_ = false; ensureBusinessSheets_()");
  rt.svc.ss.getSheetByName("Contributions").appendRow(["x"]);
  const seen = readsDuring(rt, "contributionRows_(); distributionRows_(); partnerLinkMap_()");
  assert.ok(!seen.some((s) => /Contributions|Distributions/.test(s)), seen.join(", "));
  assert.deepEqual(plain(rt.run("contributionRows_()")), []);
});

test("the paused-items check lists paused items from the Programmed tab alone", () => {
  const { rt } = freshApp({ small: true });
  const item = rt.api("addRecurringExpense", { description: "Gym prueba", amount: 50, currency: "PEN", frequency: "monthly", day: 5,
    category_id: rt.rows("Categories").find((c) => c.type === "expense").id });
  const id = item.id || (item.item && item.item.id);
  rt.run(`setCellByRow_(getSheet('Recurring Expenses'), getHeaders(getSheet('Recurring Expenses')), getAllRows('Recurring Expenses').findIndex(function (r) { return r.id === '${id}'; }) + 2, 'active', 'false')`);
  const seen = readsDuring(rt, "ROWS_MEMO_ = null; __p = pausedProgrammedForApp_()");
  assert.ok(!seen.some((s) => /^Entries/.test(s)), "no Entries read: " + seen.join(", "));
  const paused = plain(rt.run("__p"));
  assert.equal(paused.length, 1);
  assert.equal(paused[0].description, "Gym prueba");
  assert.equal(paused[0].amount, 50);
});

test("trip group friends: one read of Friends when every trip has its group", () => {
  const { rt } = freshApp({ small: true });
  rt.api("addTrip", { name: "Viaje prueba", start_date: "2026-01-01", end_date: "2026-01-05" });
  rt.run("ensureAllTripGroupFriends_()");
  const friends = rt.rows("Friends").length;
  rt.run("ROWS_MEMO_ = {}; ensureAllTripGroupFriends_(); ROWS_MEMO_ = null");
  assert.equal(rt.rows("Friends").length, friends, "no second group friend");
});
