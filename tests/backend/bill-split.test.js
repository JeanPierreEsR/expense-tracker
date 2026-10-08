// Bill splitter maths (docs/bill-split.js). Made-up bills only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { compute } = require("../../docs/bill-split.js");

const sumTotals = (r) => Object.values(r.perPerson).reduce((s, p) => s + p.total, 0);

test("simple bill: each person pays what they ordered; sums exactly", () => {
  const r = compute({
    people: ["me", "ana"],
    items: [
      { id: 1, price: "30.00", people: ["me"] },
      { id: 2, price: "45.50", people: ["ana"] },
      { id: 3, price: "20.00", people: ["me", "ana"] }
    ],
    printedTotal: "95.50"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.perPerson.me.total, 4000);
  assert.equal(r.perPerson.ana.total, 5550);
  assert.equal(sumTotals(r), 9550);
});

test("a dish shared three ways: the odd cent goes to the owner", () => {
  const r = compute({ people: ["me", "a", "b"], items: [{ id: 1, price: "10.00", people: ["me", "a", "b"] }], printedTotal: "10.00" });
  assert.equal(r.perPerson.me.total, 334);
  assert.equal(r.perPerson.a.total, 333);
  assert.equal(r.perPerson.b.total, 333);
});

test("items must match the printed total, and the difference is reported", () => {
  const r = compute({ people: ["me"], items: [{ id: 1, price: "50", people: ["me"] }], printedTotal: "52.00" });
  assert.equal(r.ok, false);
  assert.equal(r.diffCents, 200);
});

test("an unassigned item blocks saving", () => {
  const r = compute({ people: ["me", "a"], items: [{ id: 1, price: "10", people: [] }], printedTotal: "10" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unassigned, [1]);
});

test("proportional discount follows each person's order", () => {
  const r = compute({
    people: ["me", "a"],
    items: [{ id: 1, price: "60", people: ["me"] }, { id: 2, price: "40", people: ["a"] }],
    adjustments: [{ name: "Promo", amount: "-10", mode: "proportional" }],
    printedTotal: "100"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.perPerson.me.total, 5400);
  assert.equal(r.perPerson.a.total, 3600);
});

test("equal discount is shared evenly but never takes anyone below zero", () => {
  const r = compute({
    people: ["me", "a"],
    items: [{ id: 1, price: "5", people: ["me"] }, { id: 2, price: "50", people: ["a"] }],
    adjustments: [{ name: "Voucher", amount: "-20", mode: "equal" }],
    printedTotal: "55"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.perPerson.me.total, 0);        // 5.00 fully covered, not 10.00 off
  assert.equal(r.perPerson.a.total, 3500);      // the rest of the discount lands on Ana
  assert.equal(sumTotals(r), 3500);
});

test("the printed total is the bill BEFORE discounts; the tip is on what is left after them", () => {
  const r = compute({
    people: ["me", "a"],
    items: [{ id: 1, price: "60", people: ["me"] }, { id: 2, price: "40", people: ["a"] }],
    adjustments: [{ name: "Promo", amount: "-20", mode: "proportional" }],
    tip: { type: "percent", value: 10, mode: "proportional" },
    printedTotal: "100"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.preDiscountCents, 10000);
  assert.equal(r.discountsCents, 2000);
  assert.equal(r.billCents, 8000);
  assert.equal(r.tipCents, 800);        // 10% of 80.00, not of 100.00
  assert.equal(r.grandCents, 8800);
});

test("a negative line under an item is merged: only the net amount is shared, with the item's people", () => {
  const r = compute({
    people: ["me", "a"],
    items: [
      { id: 1, price: "40", people: ["me", "a"] },
      { id: 2, price: "-10", people: [] },            // "Promo" printed under the dish
      { id: 3, price: "20", people: ["a"] }
    ],
    printedTotal: "50"                                // 40 - 10 + 20
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.itemsCents, 5000);
  assert.equal(r.perPerson.me.total, 1500);           // half of the net 30.00
  assert.equal(r.perPerson.a.total, 3500);            // other half + her own 20.00
});

test("the merged net is shared once, so odd cents come out as if the item cost the net", () => {
  const r = compute({
    people: ["me", "a", "b"],
    items: [{ id: 1, price: "10.00", people: ["me", "a", "b"] }, { id: 2, price: "-0.01", people: [] }],
    printedTotal: "9.99"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.perPerson.me.total, 333);
  assert.equal(r.perPerson.a.total, 333);
  assert.equal(r.perPerson.b.total, 333);
});

test("a negative line with no item above it, or bigger than its item, is refused", () => {
  const first = compute({ people: ["me"], items: [{ id: 1, price: "-5", people: [] }, { id: 2, price: "20", people: ["me"] }], printedTotal: "20" });
  assert.equal(first.ok, false);
  assert.match(first.errors.join(" "), /needs an item above/);
  const big = compute({ people: ["me"], items: [{ id: 1, price: "10", people: ["me"] }, { id: 2, price: "-15", people: [] }], printedTotal: "10" });
  assert.equal(big.ok, false);
  assert.match(big.errors.join(" "), /bigger than the item/);
});

test("a fully discounted item (2x1) costs nothing and needs nobody assigned", () => {
  const r = compute({
    people: ["me"],
    items: [{ id: 1, price: "12", people: [] }, { id: 2, price: "-12", people: [] }, { id: 3, price: "8", people: ["me"] }],
    printedTotal: "8"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.perPerson.me.total, 800);
});

test("tip as a percent is shared in proportion; the grand total includes it", () => {
  const r = compute({
    people: ["me", "a"],
    items: [{ id: 1, price: "60", people: ["me"] }, { id: 2, price: "40", people: ["a"] }],
    tip: { type: "percent", value: 10, mode: "proportional" },
    printedTotal: "100"
  });
  assert.equal(r.tipCents, 1000);
  assert.equal(r.perPerson.me.total, 6600);
  assert.equal(r.perPerson.a.total, 4400);
  assert.equal(r.grandCents, 11000);
  assert.equal(sumTotals(r), 11000);
});

test("fixed tip shared equally", () => {
  const r = compute({
    people: ["me", "a", "b"],
    items: [{ id: 1, price: "30", people: ["me"] }, { id: 2, price: "30", people: ["a"] }, { id: 3, price: "10", people: ["b"] }],
    tip: { type: "amount", value: "7", mode: "equal" },
    printedTotal: "70"
  });
  assert.equal(r.perPerson.me.tip + r.perPerson.a.tip + r.perPerson.b.tip, 700);
  assert.equal(r.perPerson.me.tip, 234);       // odd cent to the owner
  assert.equal(sumTotals(r), 7700);
});

test("an extra charge (service fee) can reconcile a bill whose items fall short", () => {
  const r = compute({
    people: ["me", "a"],
    items: [{ id: 1, price: "50", people: ["me"] }, { id: 2, price: "50", people: ["a"] }],
    adjustments: [{ name: "Service", amount: "10", mode: "proportional" }],
    printedTotal: "110"
  });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.perPerson.me.total, 5500);
});

test("many random bills always add up to the cent", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 300; n++) {
    const people = ["me", "a", "b", "c"].slice(0, 2 + Math.floor(rnd() * 3));
    const items = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({
      id: i, price: (1 + Math.floor(rnd() * 9000)) / 100,
      people: people.filter(() => rnd() < 0.5).concat(people[Math.floor(rnd() * people.length)])
    }));
    const itemsSum = items.reduce((s, i) => s + Math.round(i.price * 100), 0);
    const disc = Math.floor(rnd() * itemsSum * 0.3);
    const r = compute({
      people, items,
      adjustments: [{ name: "d", amount: -disc / 100, mode: rnd() < 0.5 ? "equal" : "proportional" }],
      tip: { type: rnd() < 0.5 ? "percent" : "amount", value: rnd() < 0.5 ? 10 : 3.33, mode: rnd() < 0.5 ? "equal" : "proportional" },
      printedTotal: itemsSum / 100
    });
    if (r.errors.some((e) => /bigger than what someone ordered/.test(e))) continue;  // legal refusal
    assert.ok(r.ok, r.errors.join("; "));
    assert.equal(sumTotals(r), r.grandCents);
    Object.values(r.perPerson).forEach((p) => assert.ok(p.total >= 0));
  }
});

test("a service charge read from a photo doesn't add a confusing error while items are still unassigned", () => {
  const r = compute({
    people: ["me", "a"],
    items: [{ id: 1, price: "50", people: [] }],
    adjustments: [{ name: "Servicio", amount: "5", mode: "proportional" }],
    printedTotal: "55"
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /nobody assigned/);
});
