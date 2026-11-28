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
  assert.equal(analyse(t.rt, t.pm, [{ date: "2026-03-10", description: "ONLINE STORE", amount: -160, currency: "PEN" }])[0].entry.id, e.id);
  // Undo of that confirm: back to ONE waiting item with the whole amount, the other part gone.
  t.rt.api("unconfirmEntry", { id: e.id });
  const back = t.row(e.id);
  assert.equal(back.status, "pending");
  assert.equal(Number(back.amount), 160);
  assert.equal(back.purchase_id, "");
  assert.equal(back.external_id, "mail-123");
  assert.equal(t.row(partId), undefined);
});

test("Undo of a split confirm with parts shared with a friend: back to one waiting item, the friend's debts gone", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Parts Friend " + Math.random().toString(36).slice(2, 6) });
  const e = t.rt.api("createEntry", t.fields({ amount: 160 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email')`);
  const partId = uuid();
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 120, category_id: t.gifts }, splits: [], tag_ids: [],
    parts: [{ id: partId, category_id: t.shopping, amount: 40, splits: [{ friend_id: friend.id, amount: 20 }] }] });
  t.rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: friend.id, amount: 60 }] });
  assert.equal(t.rt.api("getFriendLoanDetail", { friendId: friend.id }).length, 2);
  t.rt.api("unconfirmEntry", { id: e.id });
  assert.equal(t.row(e.id).status, "pending");
  assert.equal(Number(t.row(e.id).amount), 160);
  assert.equal(t.row(partId), undefined);
  assert.equal(t.rt.api("getFriendLoanDetail", { friendId: friend.id }).length, 0, "no debt left from it");
  assert.equal(t.rt.rows("Entry Splits").filter((s) => s.entry_id === e.id || s.entry_id === partId).length, 0);
});

test("Undo is refused once the friend really repaid part of the purchase; nothing changes", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Parts Friend " + Math.random().toString(36).slice(2, 6) });
  const e = t.rt.api("createEntry", t.fields({ amount: 160 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email')`);
  const partId = uuid();
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 120, category_id: t.gifts }, splits: [], tag_ids: [],
    parts: [{ id: partId, category_id: t.shopping, amount: 40, splits: [{ friend_id: friend.id, amount: 20 }] }] });
  t.rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 10, date: "2026-03-11", currency: "PEN", payment_method_id: t.pm.id });
  assert.throws(() => t.rt.api("unconfirmEntry", { id: e.id }), /repaid/);
  assert.equal(t.row(e.id).status, "confirmed");
  assert.ok(t.row(partId));
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

test("Undo when the friend's share was only netted against a debt the other way: allowed, and that debt owes again", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Parts Friend " + Math.random().toString(36).slice(2, 6) });
  t.rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 50, currency: "PEN", date: "2026-03-01", payment_method_id: t.pm.id, description: "Borrowed" });
  const net = () => { const f = t.rt.api("listLoanBalances", {}).find((x) => x.friend_id === friend.id); const b = f && f.balances.find((x) => x.currency === "PEN"); return b ? Math.round(b.net * 100) / 100 : 0; };
  const before = net();
  const e = t.rt.api("createEntry", t.fields({ amount: 160 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email')`);
  const partId = uuid();
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 120, category_id: t.gifts }, splits: [], tag_ids: [],
    parts: [{ id: partId, category_id: t.shopping, amount: 40, splits: [{ friend_id: friend.id, amount: 20 }] }] });
  assert.notEqual(net(), before);
  t.rt.api("unconfirmEntry", { id: e.id });
  assert.equal(t.row(e.id).status, "pending");
  assert.equal(net(), before, "the friend's balance is back to what it was");
});

test("step 3: a refund of ONE part goes in that part's category, and the purchase keeps it safe", () => {
  const t = setup();
  const { mainId, partId } = t.buy();
  const out = t.rt.api("recordRefund", { entry_id: partId, amount: 15, date: "2026-03-20", payment_method_id: t.pm.id });
  const r = t.row(out.entry.id);
  assert.equal(r.refund_of, partId);
  assert.equal(r.category_id, t.shopping, "same month: a minus expense in the part's own category");
  const parts = t.rt.api("getPurchaseParts", { id: mainId }).parts;
  assert.equal(parts.find((p) => p.id === partId).refunded, 15);
  // The part can't be dropped nor made smaller than its refund; the main part can still change.
  assert.throws(() => t.rt.api("saveEntryAll", { kind: "update", id: mainId, fields: { amount: 160 }, splits: [], tag_ids: [], parts: [] }), /refund/i);
  assert.ok(t.row(partId), "nothing changed");
  assert.throws(() => t.rt.api("saveEntryAll", { kind: "update", id: mainId, fields: { amount: 150 }, splits: [], tag_ids: [], parts: [{ id: partId, category_id: t.shopping, amount: 10, splits: [] }] }));
  assert.equal(Number(t.row(partId).amount), 40);
  t.rt.api("saveEntryAll", { kind: "update", id: mainId, fields: { amount: 100 }, splits: [], tag_ids: [], parts: [{ id: partId, category_id: t.shopping, amount: 60, splits: [] }] });
  assert.equal(Number(t.row(partId).amount), 60);
  // Delete asks about the part's refund too.
  const links = t.rt.api("getEntryRepaymentLinks", { id: mainId });
  assert.equal(links.purchaseRefunds.amount, 15);
});

test("step 3: Undo of a split confirm is refused once money came back on a part", () => {
  const t = setup();
  const e = t.rt.api("createEntry", t.fields({ amount: 160 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email')`);
  const partId = uuid();
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 120, category_id: t.gifts }, splits: [], tag_ids: [], parts: [{ id: partId, category_id: t.shopping, amount: 40, splits: [] }] });
  t.rt.api("recordRefund", { entry_id: partId, amount: 15, date: "2026-03-20", payment_method_id: t.pm.id });
  assert.throws(() => t.rt.api("unconfirmEntry", { id: e.id }), /came back|devolvieron/);
  assert.equal(t.row(e.id).status, "confirmed");
});

test("step 3: Export's spreadsheet has a column tying the parts of a split purchase together", () => {
  const t = setup();
  const { mainId, partId } = t.buy();
  const csv = JSON.parse(t.rt.run(`JSON.stringify(buildEntriesCsv_({ startDate: "2026-03-01", endDate: "2026-03-31" }).text)`));
  const lines = csv.trim().split(/\r\n/);
  assert.match(lines[0], /Split purchase/);
  const rowOf = (id) => lines.find((l) => l.startsWith(id + ","));
  assert.ok(rowOf(mainId).endsWith("," + mainId));
  assert.ok(rowOf(partId).endsWith("," + mainId));
});

test("step 3: a date or account changed on one part from elsewhere follows on the others", () => {
  const t = setup();
  const { mainId, partId } = t.buy();
  t.rt.api("updateEntry", { id: partId, fields: { date: "2026-03-15", description: "Store, renamed" } });
  assert.equal(String(t.row(mainId).date).slice(0, 10), "2026-03-15");
  assert.equal(t.row(mainId).description, "Store, renamed");
  assert.equal(t.row(mainId).category_id, t.gifts, "each part keeps its own category");
  // A part that is no longer an expense leaves the purchase; the one left is a plain entry again.
  const income = t.meta.categories.find((c) => c.type === "income").id;
  t.rt.api("updateEntry", { id: partId, fields: { type: "income", category_id: income } });
  assert.equal(t.row(partId).purchase_id, "");
  assert.equal(t.row(mainId).purchase_id, "");
});

test("step 3: a bot's card for a split purchase shows the whole amount and each part", () => {
  const t = setup();
  const { mainId } = t.buy();
  const card = JSON.parse(t.rt.run(`JSON.stringify(formatEntryForTelegram_(getEntryById_(${JSON.stringify(mainId)}), null, null, { hint: false }))`));
  assert.match(card, /PEN 160\.00/);
  assert.match(card, /Split into: .* 120\.00 · .* 40\.00/);
});

test("the FIRST part turned into income: it leaves, and the other parts stay one purchase led by the next part", () => {
  const t = setup();
  const mainId = uuid(), p2 = uuid(), p3 = uuid();
  t.rt.api("saveEntryAll", { kind: "create", fields: Object.assign(t.fields(), { client_id: mainId, tag_ids: [] }), splits: [],
    parts: [{ id: p2, category_id: t.shopping, amount: 40, splits: [] }, { id: p3, category_id: t.shopping, amount: 10, splits: [] }] });
  const income = t.meta.categories.find((c) => c.type === "income").id;
  t.rt.api("updateEntry", { id: mainId, fields: { type: "income", category_id: income } });
  assert.equal(t.row(mainId).purchase_id, "");
  const rest = [t.row(p2), t.row(p3)];
  assert.equal(rest[0].purchase_id, rest[1].purchase_id);
  assert.ok([p2, p3].includes(rest[0].purchase_id), "led by one of its own parts");
  // A date changed on it still follows on the other part.
  t.rt.api("updateEntry", { id: p3, fields: { date: "2026-03-20" } });
  assert.equal(String(t.row(p2).date).slice(0, 10), "2026-03-20");
  assert.notEqual(String(t.row(mainId).date).slice(0, 10), "2026-03-20");
  // With two parts, the first turned into income leaves ONE plain entry.
  const two = t.buy();
  t.rt.api("updateEntry", { id: two.mainId, fields: { type: "income", category_id: income } });
  assert.equal(t.row(two.partId).purchase_id, "");
});

const waitingShared = (t, friend, amount) => {
  const e = t.rt.api("createEntry", t.fields({ amount: 100 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email')`);
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 100, category_id: t.gifts }, splits: [{ friend_id: friend.id, amount }], tag_ids: [] });
  return e;
};

test("Undo of a confirm of a plain entry shared with a friend: waiting again, the friend's share and debt gone", () => {
  const t = setup();
  assert.equal(t.meta.capabilities.unconfirmShared, true);
  const friend = t.rt.api("addFriend", { name: "Undo Friend " + Math.random().toString(36).slice(2, 6) });
  const e = waitingShared(t, friend, 50);
  assert.equal(t.rt.api("getFriendLoanDetail", { friendId: friend.id }).length, 1);
  t.rt.api("unconfirmEntry", { id: e.id });
  assert.equal(t.row(e.id).status, "pending");
  assert.equal(Number(t.row(e.id).amount), 100);
  assert.equal(t.rt.api("getFriendLoanDetail", { friendId: friend.id }).length, 0);
  assert.equal(t.rt.rows("Entry Splits").filter((s) => s.entry_id === e.id).length, 0);
  // The several-at-once Undo too.
  const e2 = waitingShared(t, friend, 30);
  const res = t.rt.api("unconfirmEntries", { items: [{ id: e2.id }] });
  assert.deepEqual(res.undone, [e2.id]);
  assert.equal(t.rt.api("getFriendLoanDetail", { friendId: friend.id }).length, 0);
});

test("Undo of a plain shared confirm is refused once the friend really repaid; nothing changes", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Undo Friend " + Math.random().toString(36).slice(2, 6) });
  const e = waitingShared(t, friend, 50);
  t.rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 10, date: "2026-03-11", currency: "PEN", payment_method_id: t.pm.id });
  assert.throws(() => t.rt.api("unconfirmEntry", { id: e.id }), /repaid/);
  assert.equal(t.row(e.id).status, "confirmed");
  assert.equal(t.rt.api("getFriendLoanDetail", { friendId: friend.id }).length, 1);
  const res = t.rt.api("unconfirmEntries", { items: [{ id: e.id }] });
  assert.equal(res.kept[0].reason, "refused");
});

test("Undo of a confirm of an entry a friend paid: waiting again, the debt to the friend gone", () => {
  const t = setup();
  const friend = t.rt.api("addFriend", { name: "Undo Friend " + Math.random().toString(36).slice(2, 6) });
  const e = t.rt.api("createEntry", t.fields({ amount: 100 }));
  t.rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'status', 'pending'); setEntryField_(${JSON.stringify(e.id)}, 'source', 'email')`);
  t.rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { amount: 100, category_id: t.gifts, paid_by: friend.id }, splits: [], tag_ids: [] });
  assert.ok(t.rt.rows("Loans").some((l) => l.entry_id === e.id), "the friend paid: a debt to them");
  t.rt.api("unconfirmEntry", { id: e.id });
  assert.equal(t.row(e.id).status, "pending");
  assert.equal(t.rt.rows("Loans").filter((l) => l.entry_id === e.id).length, 0);
});
