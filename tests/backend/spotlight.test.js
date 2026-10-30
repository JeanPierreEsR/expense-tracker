// First-use tips (docs/spotlight.js): which tips a phone has seen, and where the bubble goes. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Spotlight = require("../../docs/spotlight.js");

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test("a tip is unseen until marked, stays seen, and 'show tips again' clears them all", () => {
  const st = fakeStorage();
  assert.equal(Spotlight.seen(st, "loans"), false);
  Spotlight.markSeen(st, "loans");
  Spotlight.markSeen(st, "loans");
  Spotlight.markSeen(st, "budgets");
  assert.equal(Spotlight.seen(st, "loans"), true);
  assert.equal(Spotlight.seen(st, "budgets"), true);
  assert.equal(Spotlight.seen(st, "trips"), false);
  assert.deepEqual(JSON.parse(st.getItem(Spotlight.SEEN_KEY)), ["loans", "budgets"]);
  Spotlight.resetSeen(st);
  assert.equal(Spotlight.seen(st, "loans"), false);
});

test("a damaged saved list never breaks anything", () => {
  const st = fakeStorage();
  st.setItem(Spotlight.SEEN_KEY, "{not json");
  assert.equal(Spotlight.seen(st, "loans"), false);
  Spotlight.markSeen(st, "loans");
  assert.equal(Spotlight.seen(st, "loans"), true);
  st.setItem(Spotlight.SEEN_KEY, JSON.stringify({ loans: true }));
  assert.equal(Spotlight.seen(st, "loans"), false);
});

test("the bubble goes below the target when it fits, else above, else over the lower part", () => {
  const view = { w: 390, h: 700 }, bubble = { w: 320, h: 130 };
  const below = Spotlight.placeBubble({ top: 100, bottom: 140, left: 20, right: 80 }, view, bubble);
  assert.equal(below.side, "below");
  assert.ok(below.top >= 140 && below.left >= 12 && below.left + bubble.w <= view.w - 12);
  const above = Spotlight.placeBubble({ top: 600, bottom: 640, left: 300, right: 370 }, view, bubble);
  assert.equal(above.side, "above");
  assert.ok(above.top + bubble.h <= 600);
  const tall = Spotlight.placeBubble({ top: 20, bottom: 690, left: 10, right: 380 }, view, bubble);
  assert.equal(tall.side, "inside");
  assert.ok(tall.top >= 12 && tall.top + bubble.h <= view.h);
});

test("the arrow points at the target and stays inside the bubble", () => {
  const view = { w: 390, h: 700 }, bubble = { w: 320, h: 100 };
  for (const rect of [{ top: 100, bottom: 130, left: 0, right: 30 }, { top: 100, bottom: 130, left: 360, right: 390 }, { top: 100, bottom: 130, left: 180, right: 210 }]) {
    const p = Spotlight.placeBubble(rect, view, bubble);
    assert.ok(p.arrowLeft >= 18 && p.arrowLeft <= bubble.w - 18, JSON.stringify(p));
  }
});

test("a step with no target is centred", () => {
  const p = Spotlight.placeBubble(null, { w: 390, h: 700 }, { w: 320, h: 100 });
  assert.equal(p.side, "center");
  assert.equal(p.left, 35);
  assert.equal(p.top, 300);
});

test("the page loads the engine before app.js, and the practice walkthrough points at things that exist", () => {
  const docs = path.join(__dirname, "..", "..", "docs");
  const html = fs.readFileSync(path.join(docs, "index.html"), "utf8");
  assert.ok(html.indexOf("spotlight.js") !== -1 && html.indexOf("spotlight.js") < html.indexOf("app.js?"));
  for (const id of ["fab-new-entry", "split-detail", "split-friend-chips", "split-add-friend-btn", "submit-btn", "paid_by", "payment_method", "payment-method-field", "category-picker", "amount", "record-repayment-btn", "settlement-amount", "settlement-payment-method", "settlement-save-btn", "loan-detail-subtitle", "loans-tip-invite", "tour-choice-tips"]) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no #${id}`);
  }
});
