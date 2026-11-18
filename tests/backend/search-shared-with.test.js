// Searching a friend's name finds the expenses shared with them ("With Pablo, Rosa"), not only their repayments (Lucho, 2026-11-18).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("an expense split with a friend is found by the friend's name", () => {
  const { rt, data } = freshApp({ entries: 10 });
  const pablo = rt.api("addFriend", { name: "Pablo Zeta" });
  const cat = data.cats.find((c) => c.type === "expense").id;
  rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date: "2026-10-05", amount: 90, currency: "PEN", category_id: cat, description: "Group dinner", paid_by: "me", payment_method_id: data.pms[0].id },
    splits: [{ friend_id: pablo.id, amount: 30 }] });
  const index = rt.api("listEntrySearchIndex", {});
  const rows = Array.from(index).filter((e) => String(e._s || "").includes("pablo zeta"));
  assert.ok(rows.some((e) => e.description === "Group dinner"));
});
