// Split by category (PurchaseParts.gs, owner's plan 2026-11-27): one purchase saved as linked parts, each in its own category,
// that the bank statement, Home and a friend's Loans screen see as ONE payment. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const uuid = () => "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

function setup() {
  const { rt, data } = freshApp({ entries: 5 });
  const meta = rt.api("getMeta");
  const pm = data.pms[3];
  const cats = meta.categories.filter((c) => c.type === "expense");
  const gifts = cats[0].id, shopping = cats[1].id;
  const row = (id) => rt.rows("Entries").find((e) => e.id === id);
  const partsOf = (pid) => rt.rows("Entries").filter((e) => e.purchase_id === pid);
  const fields = (extra = {}) => Object.assign({ type: "expense", date: "2026-03-10", amount: 120, currency: "PEN", category_id: gifts, description: "Online store",
    paid_by: "me", payment_method_id: pm.id }, extra);
  // The phone's save: the main entry is the first part; `parts` are the others.
  const buy = (opts = {}) => {
    const mainId = uuid(), partId = uuid();
    rt.api("saveEntryAll", { kind: "create", fields: Object.assign(fields(opts.fields), { client_id: mainId, tag_ids: opts.tags || [] }),
      splits: opts.mainSplits || [], parts: [{ id: partId, category_id: shopping, amount: 40, splits: opts.partSplits || [] }] });
    return { mainId, partId };
  };
  return { rt, data, meta, pm, gifts, shopping, row, partsOf, buy, fields };
}

const analyse = (rt, pm, lines) => {
  const stmt = { key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-03-01", end: "2026-03-31" }, balances: { PEN: { closing: 1000 } }, file_name: "x.pdf", lines };
  return JSON.parse(rt.run(`JSON.stringify(analyzeStatements(${JSON.stringify({ statements: [stmt] })}))`)).statements[0].lines;
};

test("a new split purchase: two ordinary expenses, one purchase id, shared fields, each in its own category", () => {
  const t = setup();
  const { mainId, partId } = t.buy();
  const parts = t.partsOf(mainId);
  assert.equal(parts.length, 2);
  const main = t.row(mainId), part = t.row(partId);
  assert.equal(main.category_id, t.gifts);
  assert.equal(Number(main.amount), 120);
  assert.equal(part.category_id, t.shopping);
  assert.equal(Number(part.amount), 40);
  for (const k of ["date", "currency", "description", "paid_by", "payment_method_id"]) assert.equal(String(part[k]), String(main[k]), k);
  assert.equal(part.type, "expense");
  assert.equal(part.status, "confirmed");
  const listed = t.rt.api("listEntries", { startDate: "2026-03-01", endDate: "2026-03-31" }).filter((e) => e.purchase_id === mainId);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((e) => e.purchase_total === 160 && e.purchase_count === 2));
});

test("sent again (a lost reply): no second copy of any part", () => {
  const t = setup();
  const mainId = uuid(), partId = uuid();
  const payload = { kind: "create", fields: Object.assign(t.fields(), { client_id: mainId, tag_ids: [] }), splits: [], parts: [{ id: partId, category_id: t.shopping, amount: 40, splits: [] }] };
  t.rt.api("saveEntryAll", payload);
  t.rt.api("saveEntryAll", payload);
  assert.equal(t.partsOf(mainId).length, 2);
});

test("editing: shared fields follow, a removed part goes, a new part comes, turning it off leaves one plain entry", () => {
  const t = setup();
  const { mainId, partId } = t.buy();
  const third = uuid();
  t.rt.api("saveEntryAll", { kind: "update", id: mainId, fields: { date: "2026-03-12", amount: 100, description: "Store" }, splits: [], tag_ids: [],
    parts: [{ id: partId, category_id: t.shopping, amount: 30, splits: [] }, { id: third, category_id: t.gifts, amount: 30, splits: [] }] });
  assert.equal(t.partsOf(mainId).length, 3);
  assert.equal(String(t.row(partId).date).slice(0, 10), "2026-03-12");
  assert.equal(t.row(third).description, "Store");
  assert.equal(Number(t.row(partId).amount), 30);
  t.rt.api("saveEntryAll", { kind: "update", id: mainId, fields: { amount: 130 }, splits: [], tag_ids: [], parts: [{ id: third, category_id: t.gifts, amount: 30, splits: [] }] });
  assert.equal(t.row(partId), undefined, "the part no longer sent is deleted");
  t.rt.api("saveEntryAll", { kind: "update", id: mainId, fields: { amount: 160 }, splits: [], tag_ids: [], parts: [] });
  assert.equal(t.row(third), undefined);
  assert.equal(t.row(mainId).purchase_id, "");
  assert.equal(Number(t.row(mainId).amount), 160);
});

test("a bad part saves nothing", () => {
  const t = setup();
  const mainId = uuid();
  assert.throws(() => t.rt.api("saveEntryAll", { kind: "create", fields: Object.assign(t.fields(), { client_id: mainId }), parts: [{ id: uuid(), category_id: t.shopping, amount: 0 }] }));
  assert.equal(t.row(mainId), undefined);
  const income = t.meta.categories.find((c) => c.type === "income").id;
  assert.throws(() => t.rt.api("saveEntryAll", { kind: "create", fields: Object.assign(t.fields(), { client_id: mainId }), parts: [{ id: uuid(), category_id: income, amount: 5 }] }));
  assert.equal(t.row(mainId), undefined);
});

test("deleting any part deletes the whole purchase, one by one or in a bulk delete", () => {
  const t = setup();
  const a = t.buy();
  t.rt.api("discardEntry", { id: a.partId });
  assert.equal(t.partsOf(a.mainId).length, 0);
  const b = t.buy();
  const out = t.rt.api("deleteEntries", { ids: [b.mainId] });
  assert.equal(out.deleted.length, 2);
  assert.equal(t.partsOf(b.mainId).length, 0);
});

test("bank statement: one line of the whole amount matches the purchase, and nothing is offered twice", () => {
  const t = setup();
  const { mainId } = t.buy();
  const lines = analyse(t.rt, t.pm, [{ date: "2026-03-10", description: "ONLINE STORE", amount: -160, currency: "PEN" }]);
  assert.equal(lines[0].status, "matched");
  assert.equal(lines[0].entry.id, mainId);
  assert.equal(lines[0].entry.amount, 160);
  // A line of only one part's amount is not that purchase.
  const one = analyse(t.rt, t.pm, [{ date: "2026-03-10", description: "ONLINE STORE", amount: -40, currency: "PEN" }]);
  assert.ok(!one[0].entry || one[0].entry.id !== mainId);
});

test("friends, part by part: each part's own share counts, the friend owes the sum, one purchase on their screen", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Parts Friend " + Math.random().toString(36).slice(2, 6) });
  const { mainId, partId } = t.buy({ mainSplits: [{ friend_id: friend.id, amount: 60 }], partSplits: [{ friend_id: friend.id, amount: 20 }] });
  const listed = t.rt.api("listEntries", { startDate: "2026-03-01", endDate: "2026-03-31" });
  assert.equal(listed.find((e) => e.id === mainId).own_share, 60);
  assert.equal(listed.find((e) => e.id === partId).own_share, 20);
  const loans = t.rt.api("getFriendLoanDetail", { friendId: friend.id });
  assert.equal(loans.length, 2);
  assert.ok(loans.every((l) => l.purchase_id === mainId));
  const owed = loans.reduce((s, l) => s + Number(l.remaining), 0);
  assert.equal(owed, 80);
  // The statement still sees the whole 160 the card paid.
  assert.equal(analyse(t.rt, t.pm, [{ date: "2026-03-10", description: "ONLINE STORE", amount: -160, currency: "PEN" }])[0].status, "matched");
});

test("getPurchaseParts: every part, main first, with its split", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Parts Friend " + Math.random().toString(36).slice(2, 6) });
  const { mainId, partId } = t.buy({ partSplits: [{ friend_id: friend.id, amount: 20 }] });
  const out = t.rt.api("getPurchaseParts", { id: partId });
  assert.equal(out.purchase_id, mainId);
  assert.deepEqual(out.parts.map((p) => p.id), [mainId, partId]);
  assert.deepEqual(out.parts[1].splits, [{ friend_id: friend.id, amount: 20 }]);
});

test("Needs review (step 2): a waiting purchase confirmed as a split purchase keeps its e-mail id on the main part", () => {
  const t = setup();
  const e = t.rt.api("createEntry", t.fields({ amount: 160 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email'); setEntryField_(${JSON.stringify(e.id)}, 'external_id', 'mail-123')`);
  const partId = uuid();
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 120, category_id: t.gifts }, splits: [], tag_ids: [],
    parts: [{ id: partId, category_id: t.shopping, amount: 40, splits: [] }] });
  const main = t.row(e.id), part = t.row(partId);
  assert.equal(main.status, "confirmed");
  assert.equal(main.external_id, "mail-123");
  assert.equal(Number(main.amount), 120);
  assert.equal(part.status, "confirmed");
  assert.equal(part.purchase_id, e.id);
  assert.equal(String(part.payment_method_id), String(main.payment_method_id));
  // The confirm's Undo is refused: a split purchase never goes back half way.
  assert.throws(() => t.rt.api("unconfirmEntry", { id: e.id }));
  assert.equal(analyse(t.rt, t.pm, [{ date: "2026-03-10", description: "ONLINE STORE", amount: -160, currency: "PEN" }])[0].entry.id, e.id);
});

test("a bank e-mail of the whole amount is warned about as a possible copy of the split purchase", () => {
  const t = setup();
  const { mainId } = t.buy({ fields: { description: "Online store" } });
  const mail = t.rt.api("createEntry", t.fields({ amount: 160, description: "ONLINE STORE" }));
  t.rt.run(`setEntryField_(${JSON.stringify(mail.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(mail.id)}, 'source', 'email')`);
  const waiting = t.rt.api("listPendingEntries").find((x) => x.id === mail.id);
  assert.ok(waiting, "the e-mail waits in Needs review");
  assert.ok((waiting.twins || []).some((x) => x.id === mainId), "warned against the purchase");
});
