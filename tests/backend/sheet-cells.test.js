// Cells typed by hand in the Sheet (backend/SheetCells.gs): what is clear is read, what isn't stays out of every total and is named on
// Home's card; text starting with = + - @ never becomes a formula. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ small: true });
  return { rt, data, cat: data.cats.find((c) => c.type === "expense") };
}

// Writes straight into the Sheet, as a person typing a row by hand. Columns not given stay empty.
function typeRow(rt, fields, sheetName = "Entries") {
  const sheet = rt.svc.ss.getSheetByName(sheetName);
  const headers = sheet.rows[0];
  const row = sheet.rows.length + 1;
  sheet.rows.push(headers.map((h) => (fields[h] !== undefined ? fields[h] : "")));
  return { row, column: (h) => String.fromCharCode(65 + headers.indexOf(h)) };
}

const baseRow = (cat, over) => Object.assign({
  id: "hand-" + Math.random().toString(36).slice(2), date: today(), type: "expense", amount: 40, currency: "PEN",
  category_id: cat.id, description: "Hand typed", paid_by: "me", status: "confirmed"
}, over);

const spent = (rt) => rt.api("getHomeGlance", {}).months[5].expense;

test("what is clear is read as if it had been saved properly", () => {
  const { rt, cat } = setup();
  const before = spent(rt);
  const clear = [
    { status: "Confirmed" }, { status: " CONFIRMED " }, { type: "Expense" }, { currency: "pen" },
    { amount: "40,00" }, { amount: "40.00" }, { amount: " 40 " }, { date: today().replace(/-/g, "/") }
  ];
  clear.forEach((over) => typeRow(rt, baseRow(cat, over)));
  const g = rt.api("getHomeGlance", {});
  assert.equal(Math.round((g.months[5].expense - before) * 100) / 100, 40 * clear.length);
  assert.equal(g.unreadable, null);
});

test("thousands written unmistakably are read; 1,234 and 1.234 are not guessed", () => {
  const { rt, cat } = setup();
  const before = spent(rt);
  typeRow(rt, baseRow(cat, { amount: "1,234.50" }));
  typeRow(rt, baseRow(cat, { amount: "1.234,50" }));
  assert.equal(Math.round((spent(rt) - before) * 100) / 100, 2469);
  typeRow(rt, baseRow(cat, { amount: "1,234" }));
  typeRow(rt, baseRow(cat, { amount: "1.234" }));
  const g = rt.api("getHomeGlance", {});
  assert.equal(Math.round((g.months[5].expense - before) * 100) / 100, 2469);
  assert.equal(g.unreadable.count, 2);
});

test("one bad amount no longer blanks the month, and the row is named with its cell", () => {
  const { rt, cat } = setup();
  const before = spent(rt);
  const { row, column } = typeRow(rt, baseRow(cat, { amount: "abc", description: "Bad coffee" }));
  const g = rt.api("getHomeGlance", {});
  assert.ok(Number.isFinite(g.months[5].expense));
  assert.equal(g.months[5].expense, before);
  assert.deepEqual(g.unreadable.rows[0], { sheet: "Entries", row, cell: column("amount") + row, field: "amount", value: "abc", description: "Bad coffee" });
});

test("each kind of unclear cell stays out of the totals and on the card", () => {
  const cases = [
    [{ status: "" }, "status"], [{ status: "maybe" }, "status"], [{ type: "gasto" }, "type"], [{ currency: "soles" }, "currency"],
    [{ currency: "" }, "currency"], [{ date: "" }, "date"], [{ date: "06/11/2026" }, "date"], [{ date: 46332 }, "date"], [{ date: "2026-13-45" }, "date"],
    [{ amount: "" }, "amount"], [{ amount: "S/ 10" }, "amount"]
  ];
  cases.forEach(([over, field]) => {
    const { rt, cat } = setup();
    const before = spent(rt);
    const entriesBefore = rt.api("listEntries", {}).length;
    typeRow(rt, baseRow(cat, over));
    const g = rt.api("getHomeGlance", {});
    assert.equal(g.months[5].expense, before, JSON.stringify(over));
    assert.equal(g.unreadable.rows[0].field, field, JSON.stringify(over));
    assert.equal(rt.api("listEntries", {}).length, entriesBefore, "not listed: " + JSON.stringify(over));
  });
});

test("the Sheet itself is never changed by reading", () => {
  const { rt, cat } = setup();
  const { row } = typeRow(rt, baseRow(cat, { amount: "abc", status: "Confirmed" }));
  rt.api("getHomeGlance", {});
  rt.api("listEntries", {});
  const sheet = rt.svc.ss.getSheetByName("Entries");
  const headers = sheet.rows[0];
  assert.equal(sheet.rows[row - 1][headers.indexOf("amount")], "abc");
  assert.equal(sheet.rows[row - 1][headers.indexOf("status")], "Confirmed");
});

test("a blank row is not a problem, and a waiting entry may have no amount yet", () => {
  const { rt, cat } = setup();
  typeRow(rt, {});
  typeRow(rt, baseRow(cat, { status: "pending", amount: "" }));
  assert.equal(rt.api("getHomeGlance", {}).unreadable, null);
});

test("a confirmed entry in a currency with no rate at all is named; so is a bad share in Entry Splits", () => {
  const { rt, cat } = setup();
  typeRow(rt, baseRow(cat, { currency: "XYZ", description: "Odd money" }));
  let u = rt.api("getHomeGlance", {}).unreadable;
  assert.equal(u.rows[0].field, "currency");
  assert.equal(u.rows[0].value, "XYZ");

  const { rt: rt2, cat: cat2 } = setup();
  const before = spent(rt2);
  typeRow(rt2, baseRow(cat2, { id: "shared-1", description: "Shared lunch" }));
  typeRow(rt2, { id: "sp-1", entry_id: "shared-1", amount: "abc" }, "Entry Splits");
  const g = rt2.api("getHomeGlance", {});
  assert.ok(Number.isFinite(g.months[5].expense));
  assert.equal(g.months[5].expense, before + 40);
  assert.equal(g.unreadable.rows[0].sheet, "Entry Splits");
  assert.equal(g.unreadable.rows[0].description, "Shared lunch");
});

test("the card carries at most five rows but counts them all", () => {
  const { rt, cat } = setup();
  for (let i = 0; i < 7; i++) typeRow(rt, baseRow(cat, { amount: "abc" }));
  const u = rt.api("getHomeGlance", {}).unreadable;
  assert.equal(u.count, 7);
  assert.equal(u.rows.length, 5);
});

test("text starting with = + - @ stays text, on creating and on editing; a number sent as text stays a number", () => {
  const { rt, cat } = setup();
  const pm = rt.rows("Payment Methods")[0];
  ["=1+1", "+51 999", "-less", "@home"].forEach((text) => {
    const made = rt.api("createEntry", { date: today(), type: "expense", amount: 12, currency: "PEN", category_id: cat.id, description: text, paid_by: "me", payment_method_id: pm.id });
    const id = made.id || made.entry.id;
    const row = () => rt.rows("Entries").find((e) => e.id === id);
    assert.equal(row().description, text);
    rt.api("updateEntry", { id, fields: { description: text + " again" } });
    assert.equal(row().description, text + " again");
  });
  const sheetSafeText_ = (v) => rt.run(`sheetSafeText_(${JSON.stringify(v)})`);
  assert.equal(sheetSafeText_("-5"), "-5");
  assert.equal(sheetSafeText_("-"), "'-");
  assert.equal(sheetSafeText_(-5), -5);
  assert.equal(sheetSafeText_("plain"), "plain");
});

test("names typed on the newer screens stay text too, on add and on update (testers, 2026-11-15)", () => {
  const { rt, cat } = setup();
  const F = '=HYPERLINK("http://example.invalid","x")';
  const clean = (sheetName) => {
    const bad = JSON.stringify(rt.rows(sheetName)).indexOf("#FORMULA#");
    assert.equal(bad, -1, sheetName + " holds a formula: " + JSON.stringify(rt.rows(sheetName)).slice(bad, bad + 60));
  };
  const tag = rt.api("addTag", { name: F });
  clean("Tags");
  rt.api("renameTag", { id: tag.id || tag.tag.id, name: F + "2" });
  clean("Tags");
  const trip = rt.api("addTrip", { name: F, kind: "trip", start_date: today(), end_date: today(), group_size: 3 });
  clean("Trips"); clean("Friends");
  rt.api("updateTrip", { id: trip.id || trip.trip.id, name: F + "2", kind: "trip", start_date: today(), end_date: today() });
  clean("Trips"); clean("Friends");
  rt.api("addTrip", { name: "Emoji test", emoji: "+51 999", kind: "trip", start_date: today(), end_date: today() });
  clean("Trips");   // a trip's emoji is free text too (Rafael's re-check, 2026-11-15)
  rt.api("addFriend", { name: "Notes test", notes: "=1+1" });
  clean("Friends");
  rt.api("addBank", { name: F });
  clean("Banks");
  rt.api("addPayor", { name: F });
  clean("Payors"); clean("Friends");
  const b = rt.api("addBudget", { category_id: cat.id, amount: 100, currency: "PEN", period_type: "weekly", name: F });
  clean("Budgets");
  rt.api("updateBudget", { id: b.id, name: F + "2" });
  clean("Budgets");
  const r = rt.api("addRecurringExpense", { category_id: cat.id, description: F, amount: 50, currency: "PEN", frequency: "monthly", day: 5 });
  clean("Recurring Expenses");
  rt.api("updateRecurringExpense", { id: r.id || r.item.id, description: F + "2" });
  clean("Recurring Expenses");
  rt.api("setReminderTemplate", { lang: "en", text: '=HYPERLINK("http://example.invalid",{list})' });
  clean("Settings");
  const tpl = rt.rows("Settings").find((s) => s.key === "remind_template_en");
  assert.equal(tpl.value, '=HYPERLINK("http://example.invalid",{list})', "read back unchanged");
  assert.ok(rt.rows("Tags").some((t) => t.name.startsWith("=HYPERLINK(")), "a tag name reads back as typed (cut to 40 letters)");
});
