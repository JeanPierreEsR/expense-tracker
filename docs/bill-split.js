// Bill splitter maths (pure functions, no screen code) — used by the "Split a
// bill by items" sheet in app.js and tested directly in
// tests/backend/bill-split.test.js.
//
// Everything is done in whole cents so each person's total adds up EXACTLY to
// the bill. Any leftover cent goes to whoever has the largest fractional
// remainder; on a tie it goes to the owner ("me") first, then in list order —
// the same "odd cent falls to the owner" rule as the normal equal split.
(function (root) {
  "use strict";

  const OWNER = "me";

  function toCents(v) {
    const n = parseFloat(v);
    return isFinite(n) ? Math.round(n * 100) : 0;
  }

  // Splits `cents` (any sign) among `keys` in proportion to `weights[key]`
  // (integers >= 0). Returns {key: cents} summing exactly to `cents`, or null
  // when no key has a positive weight.
  function allocate(cents, keys, weights) {
    const live = keys.filter((k) => (weights[k] || 0) > 0);
    if (!live.length) return null;
    const sign = cents < 0 ? -1 : 1;
    const abs = Math.abs(cents);
    const sumW = live.reduce((s, k) => s + weights[k], 0);
    const out = {};
    const frac = {};
    let given = 0;
    live.forEach((k) => {
      const exact = abs * weights[k];
      out[k] = Math.floor(exact / sumW);
      frac[k] = exact % sumW;
      given += out[k];
    });
    const order = live.slice().sort((a, b) =>
      (frac[b] - frac[a]) || ((b === OWNER) - (a === OWNER)) || (keys.indexOf(a) - keys.indexOf(b)));
    for (let i = 0; i < abs - given; i++) out[order[i % order.length]] += 1;
    live.forEach((k) => { out[k] *= sign; });
    return out;
  }

  // Equal split of a DISCOUNT where nobody can be discounted below zero:
  // someone whose equal share is bigger than what they owe pays 0 and the
  // rest is shared by the others.
  function allocateEqualCapped(cents, keys, caps) {
    const out = {};
    let remaining = Math.abs(cents);
    let active = keys.filter((k) => caps[k] > 0);
    while (remaining > 0 && active.length) {
      const share = allocate(remaining, active, active.reduce((w, k) => (w[k] = 1, w), {}));
      const over = active.filter((k) => share[k] > caps[k] - (out[k] || 0));
      if (!over.length) {
        active.forEach((k) => { out[k] = (out[k] || 0) + share[k]; });
        remaining = 0;
        break;
      }
      over.forEach((k) => {
        const room = caps[k] - (out[k] || 0);
        out[k] = (out[k] || 0) + room;
        remaining -= room;
      });
      active = active.filter((k) => !over.includes(k));
    }
    const result = {};
    keys.forEach((k) => { if (out[k]) result[k] = -out[k]; });
    return { amounts: result, leftover: remaining };
  }

  // input:
  //   people:      ["me", friendId, ...]
  //   items:       [{id, name, price, people: [keys]}]   price = number or text
  //   adjustments: [{name, amount, mode}] amount < 0 = discount, > 0 = extra
  //                charge; mode "proportional" | "equal"
  //   tip:         {type: "percent" | "amount", value, mode}
  //   printedTotal: the total printed on the bill BEFORE discounts and tip
  //                 (items + any extra charge); discounts come off after it
  function compute(input) {
    const people = input.people || [OWNER];
    const errors = [];

    // ---- items ----
    const subtotal = {};
    people.forEach((k) => { subtotal[k] = 0; });
    const unassigned = [];
    let itemsCents = 0;
    // A NEGATIVE line (a discount printed under a dish, "-10.00") is folded into
    // the nearest positive line above it, so only the NET amount of that item is
    // shared — and with the same people, whatever the discount line itself says.
    const lines = [];
    let discountWithoutItem = false;
    (input.items || []).forEach((it) => {
      const cents = toCents(it.price);
      if (cents > 0) lines.push({ id: it.id, cents, people: it.people || [] });
      else if (cents < 0) {
        if (!lines.length) discountWithoutItem = true;
        else lines[lines.length - 1].cents += cents;
      }                                             // blank / zero lines are ignored
    });
    if (discountWithoutItem) errors.push("A discount line needs an item above it.");
    lines.forEach((ln) => {
      if (ln.cents < 0) { errors.push("A discount is bigger than the item it is under."); return; }
      if (ln.cents === 0) return;                   // fully discounted: nothing to share
      itemsCents += ln.cents;
      const who = people.filter((k) => ln.people.includes(k));   // no repeats, list order
      if (!who.length) { unassigned.push(ln.id); return; }
      const shares = allocate(ln.cents, who, who.reduce((w, k) => (w[k] = 1, w), {}));
      who.forEach((k) => { subtotal[k] += shares[k]; });
    });
    if (itemsCents === 0) errors.push("Add at least one item with a price.");
    if (unassigned.length) errors.push(`${unassigned.length === 1 ? "1 item has" : unassigned.length + " items have"} nobody assigned yet.`);

    // ---- discounts / extra charges ----
    const adjustments = {};
    people.forEach((k) => { adjustments[k] = 0; });
    let adjCents = 0;
    (input.adjustments || []).forEach((a) => {
      const cents = toCents(a.amount);
      if (!cents) return;
      adjCents += cents;
      let shares = null;
      if (a.mode === "equal") {
        if (cents < 0) {
          const running = {};
          people.forEach((k) => { running[k] = subtotal[k] + adjustments[k]; });
          const r = allocateEqualCapped(cents, people, running);
          shares = r.amounts;
        } else {
          const who = people.filter((k) => subtotal[k] > 0);
          shares = allocate(cents, who, who.reduce((w, k) => (w[k] = 1, w), {}));
        }
      } else {
        shares = allocate(cents, people, subtotal);
      }
      // (While items are still unassigned nobody has an order yet, so this
      // would only repeat "nobody assigned" in a more confusing way.)
      if (!shares) { if (!unassigned.length) errors.push(`"${a.name || "Adjustment"}" has nobody to be shared among.`); return; }
      Object.keys(shares).forEach((k) => { adjustments[k] += shares[k]; });
    });

    const afterAdj = {};
    people.forEach((k) => { afterAdj[k] = subtotal[k] + adjustments[k]; });
    const billCents = itemsCents + adjCents;        // what the bill should total
    if (people.some((k) => afterAdj[k] < 0)) errors.push("A discount is bigger than what someone ordered.");

    // ---- reconciliation with the printed total ----
    // The printed total is the bill BEFORE discounts: items plus any extra
    // charge (service fee). Discounts are taken off after it, so only the
    // positive adjustments take part in the check.
    const chargesCents = (input.adjustments || []).reduce((sum, a) => {
      const c = toCents(a.amount);
      return c > 0 ? sum + c : sum;
    }, 0);
    const preDiscountCents = itemsCents + chargesCents;
    const discountsCents = chargesCents - adjCents;      // positive number
    const printedCents = toCents(input.printedTotal);
    const diffCents = printedCents - preDiscountCents;
    if (!(printedCents > 0)) errors.push("Enter the total printed on the bill.");
    else if (diffCents !== 0) errors.push("Items and charges don't add up to the bill total yet.");

    // ---- tip ----
    const tipIn = input.tip || {};
    let tipCents = 0;
    if (tipIn.type === "percent") tipCents = Math.round(billCents * (parseFloat(tipIn.value) || 0) / 100);
    else tipCents = toCents(tipIn.value);
    const tipShare = {};
    people.forEach((k) => { tipShare[k] = 0; });
    if (tipCents > 0) {
      const who = people.filter((k) => afterAdj[k] > 0);
      const w = tipIn.mode === "equal" ? who.reduce((o, k) => (o[k] = 1, o), {}) : afterAdj;
      const shares = allocate(tipCents, people, w);
      if (shares) Object.keys(shares).forEach((k) => { tipShare[k] += shares[k]; });
    }

    const perPerson = {};
    people.forEach((k) => {
      perPerson[k] = { items: subtotal[k], adjustments: adjustments[k], tip: tipShare[k], total: afterAdj[k] + tipShare[k] };
    });
    const grandCents = billCents + tipCents;

    return {
      ok: errors.length === 0,
      errors,
      unassigned,
      itemsCents,
      adjCents,
      billCents,
      preDiscountCents,
      discountsCents,
      printedCents,
      diffCents,
      tipCents,
      grandCents,
      perPerson
    };
  }

  const api = { compute, toCents, allocate, OWNER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BillSplit = api;
})(typeof window !== "undefined" ? window : this);
