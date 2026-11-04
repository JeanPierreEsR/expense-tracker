// First-use practice "Tidy my history": createPracticeTidy makes three uncategorised confirmed expenses Tidy can see, the practice group can be
// listed first, filled and undone through the real calls, and removePracticeTidy deletes only what the practice made. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ small: true });
  const cat = data.cats.find((c) => c.type === "expense");
  return { rt, data, cat };
}
const mine = (rt) => rt.rows("Entries").filter((e) => String(e.external_id || "").startsWith("practice-tidy-"));

test("capability: a backend that can run the Tidy practice says so", () => {
  assert.equal(setup().rt.api("getMeta").capabilities.practiceTidy, true);
});

test("createPracticeTidy makes three confirmed expenses with no category, account or merchant (English or Spanish name)", () => {
  const { rt } = setup();
  const en = rt.api("createPracticeTidy", { lang: "en" });
  assert.equal(en.ids.length, 3);
  assert.equal(en.name, "Practice coffee shop");
  const es = rt.api("createPracticeTidy", { lang: "es" });
  assert.equal(es.name, "Cafetería de práctica");
  for (const e of mine(rt)) {
    assert.equal(e.type, "expense");
    assert.equal(e.status, "confirmed");
    assert.equal(e.date, today());
    assert.equal(String(e.category_id || ""), "");
    assert.equal(String(e.payment_method_id || ""), "");
    assert.equal(String(e.merchant || ""), "");
  }
  assert.equal(mine(rt).length, 6);
});

test("Tidy lists the practice group (marked), and pinPractice puts it first even when real groups are bigger", () => {
  const { rt } = setup();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "big-1", type: "expense", date: today(), created_at: today() + "T09:00:00", amount: 99999, currency: "PEN", status: "confirmed", source: "manual", description: "Big real shop", paid_by: "me", category_id: "" })})`);
  rt.api("createPracticeTidy", { lang: "en" });
  const plain = rt.api("listTidyGroups", {});
  assert.equal(plain.groups[0].label, "Big real shop", "without the pin, the biggest group is first");
  assert.ok(plain.groups.some((g) => g.practice && g.label === "Practice coffee shop" && g.count === 3));
  assert.ok(!plain.groups.find((g) => g.label === "Big real shop").practice);
  const pinned = rt.api("listTidyGroups", { pinPractice: true });
  assert.equal(pinned.groups[0].label, "Practice coffee shop");
  assert.equal(pinned.groups[0].count, 3);
  assert.equal(pinned.groups[0].suggestion, null, "no suggestion: the practice teaches nothing and learns nothing");
  assert.equal(pinned.groups.length, plain.groups.length);
});

test("applying the practice group fills only the practice entries; Undo puts them back", () => {
  const { rt, cat } = setup();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "real-blank", type: "expense", date: today(), created_at: today() + "T09:00:00", amount: 20, currency: "PEN", status: "confirmed", source: "manual", description: "Some real place", paid_by: "me", category_id: "" })})`);
  rt.api("createPracticeTidy", { lang: "en" });
  const group = rt.api("listTidyGroups", { pinPractice: true }).groups[0];
  const res = rt.api("applyTidyGroups", { items: [{ key: group.key, categoryId: cat.id }] });
  assert.equal(res.count, 3);
  assert.ok(mine(rt).every((e) => e.category_id === cat.id));
  assert.equal(String(rt.rows("Entries").find((e) => e.id === "real-blank").category_id || ""), "", "a real uncategorised entry is untouched");
  rt.api("undoCategoryFollow", { changes: res.changes, annualIds: res.annualIds });
  assert.ok(mine(rt).every((e) => !e.category_id));
});

test("removePracticeTidy deletes the practice entries, filled or not, and never a real entry with the same words", () => {
  const { rt, cat } = setup();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "real-same-name", type: "expense", date: today(), created_at: today() + "T09:00:00", amount: 5, currency: "PEN", status: "confirmed", source: "manual", description: "Practice coffee shop", paid_by: "me", category_id: "" })})`);
  rt.api("createPracticeTidy", { lang: "en" });
  const group = rt.api("listTidyGroups", { pinPractice: true }).groups.find((g) => g.practice);
  rt.api("applyTidyGroups", { items: [{ key: group.key, categoryId: cat.id }] });
  const before = rt.rows("Entries").length;
  assert.equal(rt.api("removePracticeTidy", {}).entries, 3);
  assert.equal(rt.rows("Entries").length, before - 3);
  assert.equal(mine(rt).length, 0);
  assert.ok(rt.rows("Entries").some((e) => e.id === "real-same-name"), "a real entry that merely carries the name stays");
  assert.equal(rt.api("removePracticeTidy", {}).entries, 0, "a repeat is harmless");
});

test("the budget alert guard recognises the practice entries in both languages (isPracticeEntry_)", () => {
  const { rt } = setup();
  rt.api("createPracticeTidy", { lang: "es" });
  const es = mine(rt)[0];
  assert.equal(rt.run(`isPracticeEntry_(${JSON.stringify(es)})`), true);
  assert.equal(rt.run(`isPracticeEntry_({ description: 'Practice coffee shop' })`), true);
  assert.equal(rt.run(`isPracticeEntry_({ description: 'Real coffee shop' })`), false);
});
