// Home → Edit (owner's request 2026-11-03, stage 1): delete several entries at once. Only PLAIN entries go; a loan's movement, a repayment and its extra, a
// forgiveness, an expense whose loans were repaid and one side of a currency exchange are kept with the reason. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense");
  const incomeCat = data.cats.find((c) => c.type === "income");
  const expense = (description, amount = 20) => rt.api("createEntry", { type: "expense", date: today(), amount, currency: "PEN", category_id: cat.id, description, paid_by: "me", payment_method_id: pm });
  const friend = (name) => rt.api("addFriend", { name });
  const ids = {};
  ids.plain1 = expense("Bulk plain 1").id;
  ids.plain2 = expense("Bulk plain 2").id;
  ids.income = rt.api("createEntry", { type: "income", date: today(), amount: 90, currency: "PEN", category_id: incomeCat.id, description: "Bulk income", paid_by: "me", payment_method_id: pm }).id;
  // shared with a friend (the split makes a loan)
  const ana = friend("Bulk Ana");
  ids.shared = expense("Bulk shared", 60).id;
  rt.api("saveEntrySplits", { entryId: ids.shared, splits: [{ friend_id: ana.id, amount: 30 }] });
  // shared and REPAID
  const ben = friend("Bulk Ben");
  ids.repaid = expense("Bulk repaid", 80).id;
  rt.api("saveEntrySplits", { entryId: ids.repaid, splits: [{ friend_id: ben.id, amount: 40 }] });
  rt.api("recordRepayment", { friend_id: ben.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  // a cash loan's own movement
  const cy = friend("Bulk Cy");
  const cashLoan = rt.api("addLoan", { friend_id: cy.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: today(), payment_method_id: pm, description: "Bulk cash loan" });
  ids.loanMovement = rt.rows("Loans").find((l) => l.id === cashLoan.id).transfer_entry_id;
  // a repayment (its money movement) on that loan
  rt.api("recordRepayment", { friend_id: cy.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: pm });
  ids.repayment = rt.rows("Settlements").find((s) => s.transfer_entry_id && s.loan_id === cashLoan.id).transfer_entry_id;
  // a forgiveness
  const di = friend("Bulk Di");
  const forgiven = rt.api("addLoan", { friend_id: di.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: today(), payment_method_id: pm, description: "Bulk to forgive" });
  rt.api("forgiveLoan", { id: forgiven.id, category_id: cat.id, date: today() });
  ids.forgiveness = rt.rows("Loans").find((l) => l.id === forgiven.id).forgiveness_entry_id;
  // a currency exchange: two sides
  const pen = rt.api("addPaymentMethod", { nickname: "Bulk PEN", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Bulk USD", type: "debit" });
  const ex = rt.api("recordCurrencyExchange", { date: today(), house: "Bulk House", out: { payment_method_id: pen.id, amount: 370, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 100, currency: "USD" } });
  ids.exchange = ex.out_entry_id || ex.out_id || (ex.legs && ex.legs[0] && ex.legs[0].id) || rt.rows("Entries").find((e) => /Currency exchange/i.test(e.description || "")).id;
  return { rt, ids, pm };
}
const ok = (name, v) => assert.ok(v, name);

test("the backend says it can delete several Home entries", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.entriesBulk, true);
});

test("previewEntriesDelete says which entries can go, how many friends' debts a shared one touches, and why the others can't", () => {
  const { rt, ids } = setup();
  const items = rt.api("previewEntriesDelete", { ids: Object.values(ids).concat(["gone-1"]) }).items;
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by[ids.plain1].reason, ""); assert.equal(by[ids.plain1].shared, 0);
  assert.equal(by[ids.income].reason, "");
  assert.equal(by[ids.shared].reason, ""); assert.equal(by[ids.shared].shared, 1, "one friend's debt goes with it");
  assert.equal(by[ids.repaid].reason, "repaidLoans");
  assert.equal(by[ids.loanMovement].reason, "loanMovement");
  assert.equal(by[ids.repayment].reason, "repayment");
  assert.equal(by[ids.forgiveness].reason, "forgiveness");
  assert.equal(by[ids.exchange].reason, "exchange");
  assert.equal(by["gone-1"].reason, "missing");
});

test("deleteEntries removes the plain ones (a shared one takes its split and loan along) and keeps every other kind, untouched", () => {
  const { rt, ids } = setup();
  const before = rt.rows("Entries").length;
  const res = rt.api("deleteEntries", { ids: Object.values(ids).concat(["gone-1", ids.plain1]) });
  assert.deepEqual(res.deleted.sort(), [ids.plain1, ids.plain2, ids.income, ids.shared].sort(), "a repeated id counts once");
  const why = Object.fromEntries(res.kept.map((k) => [k.id, k.reason]));
  assert.deepEqual(why, { [ids.repaid]: "repaidLoans", [ids.loanMovement]: "loanMovement", [ids.repayment]: "repayment", [ids.forgiveness]: "forgiveness", [ids.exchange]: "exchange", "gone-1": "missing" });
  assert.equal(rt.rows("Entries").length, before - 4);
  assert.ok(!rt.rows("Entry Splits").some((s) => s.entry_id === ids.shared), "its split went");
  assert.ok(!rt.rows("Loans").some((l) => l.origin === "entry" && l.entry_id === ids.shared), "and the debt that came from it");
  [ids.repaid, ids.loanMovement, ids.repayment, ids.forgiveness, ids.exchange].forEach((id) => ok(id, rt.rows("Entries").some((e) => e.id === id)));
  assert.ok(rt.rows("Loans").some((l) => l.origin === "entry" && l.entry_id === ids.repaid), "the repaid loan is untouched");
});

test("the phone's incremental sync is told about the deletions", () => {
  const { rt, ids } = setup();
  rt.api("deleteEntries", { ids: [ids.plain1, ids.plain2] });
  const logged = rt.rows("Entry Deletions").map((r) => String(r.entry_id || r.id || Object.values(r)[0]));
  assert.ok(logged.includes(ids.plain1) && logged.includes(ids.plain2));
});

test("tags and bills go with a deleted entry; an empty list does nothing; too many at once is refused", () => {
  const { rt, ids } = setup();
  const tag = rt.api("addTag", { name: "Bulk tag" });
  rt.api("saveEntryTags", { entryId: ids.plain1, tagIds: [tag.id] });
  rt.api("deleteEntries", { ids: [ids.plain1] });
  assert.ok(!rt.rows("Entry Tags").some((t) => t.entry_id === ids.plain1));
  assert.deepEqual(rt.api("deleteEntries", { ids: [] }), { deleted: [], kept: [] });
  assert.throws(() => rt.api("deleteEntries", { ids: Array.from({ length: 301 }, (_, i) => "x" + i) }), /up to 300/);
});

test("the screen: pencils on the Home list and the search results, tick rows, one preview, one question, names in the result, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  for (const id of ["entries-edit-btn", "search-edit-btn", "entries-editbar", "entries-done-btn", "entries-delete-selected-btn", "entries-selectall-btn"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /callApi\("previewEntriesDelete", \{ ids \}\)/);
  assert.match(app, /callApi\("deleteEntries", entriesListThen_\(\{ ids: sendIds \}\)\)/);
  assert.match(app, /busy: "common\.deletingToast"/);
  assert.match(app, /name !== "entries" && entriesEditing_/, "leaving Home ends Edit mode");
  for (const key of ["entriesBulk.title", "entriesBulk.confirm", "entriesBulk.sharedNote", "entriesBulk.keptNote", "entriesBulk.noneDeletable", "entriesBulk.selectAllMatches", "entriesBulk.limit",
    "entriesBulk.done", "entriesBulk.resultKept", "entriesBulk.why.repayment", "entriesBulk.why.loanMovement", "entriesBulk.why.repaidLoans", "entriesBulk.why.exchange", "entriesBulk.why.forgiveness", "entriesBulk.why.missing"]) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: .+, es: .+ \\}`), key);
  }
});
