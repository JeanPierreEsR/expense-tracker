// More → Not captured automatically: which kinds of money movement still arrive by hand (backend/ManualGaps.gs).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("classifier: receipt photos, wallets, cash, friends, uncovered banks", () => {
  const { rt } = freshApp({ small: true });
  const c = (item) => rt.run(`gapClassify_(${JSON.stringify(item)}, { emailBanks: ["BCP", "Interbank"] })`);
  assert.equal(c({ source: "photo", direction: "out", text: "Plin a Ana Lo*" }), "plin_out_whatsapp");
  assert.equal(c({ source: "photo", direction: "in", text: "Yape de Ana Lo*" }), "yape_in");
  assert.equal(c({ source: "photo", direction: "out", text: "Yape a Ana Lo*" }), "yape_out");
  assert.equal(c({ source: "statement", direction: "in", text: "PLIN RECIBIDO" }), "plin_in");
  assert.equal(c({ source: "manual", direction: "out", text: "lunch", pmType: "cash" }), "cash");
  assert.equal(c({ source: "manual", direction: "out", text: "dinner", paidByFriend: true }), "friend_paid");
  assert.equal(c({ source: "manual", direction: "out", text: "x", bankName: "BBVA" }), "no_email_bank");
  assert.equal(c({ source: "manual", direction: "out", text: "x", bankName: "bcp" }), "other_manual");
});

test("summary counts per kind in display order, totals only when asked", () => {
  const { rt } = freshApp({ small: true });
  const items = [
    { source: "manual", direction: "out", text: "a", pmType: "cash", date: "2026-10-01", amount: 10, currency: "PEN" },
    { source: "manual", direction: "out", text: "b", pmType: "cash", date: "2026-10-05", amount: -5.5, currency: "PEN" },
    { source: "photo", direction: "in", text: "Yape de Ana Lo*", date: "2026-10-03", amount: 20, currency: "PEN" }
  ];
  const run = (t) => JSON.parse(rt.run(`JSON.stringify(gapSummarize_(${JSON.stringify(items)}, { emailBanks: [] }, ${t}))`));
  const withTotals = run(true);
  assert.deepEqual(withTotals.map((k) => k.key), ["yape_in", "cash"]);
  assert.equal(withTotals[1].count, 2);
  assert.equal(withTotals[1].last, "2026-10-05");
  assert.equal(withTotals[1].totals.PEN, 15.5);
  assert.equal(run(false)[1].totals, undefined);
});

test("getManualGaps: owner sees the manual share, friends' copies only the list", () => {
  const { rt } = freshApp({ small: true });
  const owner = rt.api("getManualGaps");
  assert.equal(owner.owner, true);
  assert.ok(owner.manualShare.total >= owner.manualShare.manual);
  owner.kinds.forEach((k) => assert.ok(k.count > 0 && k.totals));
  rt.svc.props.set("FEATURES", "base");
  const friend = rt.api("getManualGaps");
  assert.equal(friend.owner, false);
  assert.equal(friend.manualShare, undefined);
  friend.kinds.forEach((k) => assert.equal(k.totals, undefined));
});
