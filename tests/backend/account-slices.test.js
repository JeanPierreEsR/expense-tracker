// Overview "By account or card" (owner's design, 2026-11-10): an expense a friend paid counts under the account it was
// repaid from; what is still owed is "Not repaid yet"; forgiven is "A friend covered it"; a cancel-out is followed one step
// back. Income counts where it arrived ("Received from" is not a friend paying). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const DAY = "2031-03-15";
const range = { startDate: DAY, endDate: DAY };

function setup() {
  const { rt, data } = freshApp({ small: true });
  const meta = rt.api("getMeta");
  const pms = meta.paymentMethods.filter((p) => p.type !== "investment");
  const pmA = pms[0].id, pmB = pms[1].id;
  const cat = (type) => meta.categories.find((c) => c.type === type).id;
  const friend = rt.api("addFriend", { name: "Slice Friend " + Math.random().toString(36).slice(2, 6) });
  const expense = (fields) => {
    const e = rt.api("createEntry", Object.assign({ type: "expense", date: DAY, category_id: cat("expense"), status: "confirmed", paid_by: "me", amount: 100, currency: "PEN", description: "x" }, fields));
    if (fields.paid_by && fields.paid_by !== "me") rt.api("saveEntrySplits", { entryId: e.id, splits: [] });   // makes the "I owe them" debt
    return e;
  };
  const friendPaid = (amount = 100) => expense({ paid_by: friend.id, amount });
  const repay = (amount, pm, extra = {}) => rt.api("recordRepayment", Object.assign({ friend_id: friend.id, direction: "i_owe_them", amount, currency: "PEN", date: "2031-04-02", payment_method_id: pm || "" }, extra));
  const pie = (type = "expense") => rt.api("getPeriodSummary", range).breakdowns[type].byPaymentMethod;
  const slice = (id, type = "expense") => { const s = pie(type).find((i) => i.id === id); return s ? Math.round(s.amount_pen * 100) / 100 : 0; };
  const drill = (id, type = "expense") => rt.api("listEntries", Object.assign({ type }, range, id === "" ? { noAccount: true } : { paymentMethodId: id }));
  const total = (type = "expense") => rt.api("getPeriodSummary", range).totals[type];
  const addsUp = (type = "expense") => {
    const sum = pie(type).reduce((t, i) => t + i.amount_pen, 0);
    assert.equal(Math.round(sum * 100), Math.round(total(type) * 100), "the pie adds up to the total");
  };
  return { rt, data, meta, pmA, pmB, cat, friend, expense, friendPaid, repay, pie, slice, drill, total, addsUp };
}

test("paid myself: its account, or No account (unchanged)", () => {
  const t = setup();
  t.expense({ payment_method_id: t.pmA });
  t.expense({});
  assert.equal(t.slice(t.pmA), 100);
  assert.equal(t.slice(""), 100);
  assert.equal(t.slice("__friend__"), 0, "the old slice is gone");
  t.addsUp();
});

test("a friend paid, nothing repaid: Not repaid yet (with its name), listed in full", () => {
  const t = setup();
  const e = t.friendPaid();
  assert.equal(t.slice("__notrepaid__"), 100);
  assert.equal(t.pie().find((i) => i.id === "__notrepaid__").name, "Not repaid yet");
  const rows = t.drill("__notrepaid__");
  assert.deepEqual(rows.map((r) => r.id), [e.id]);
  assert.equal(rows[0].slice_part.how, "notRepaid");
  assert.equal(rows[0].slice_part.fraction, 1);
  t.addsUp();
});

test("partly repaid: that part under the account, the rest Not repaid yet; the expense keeps its month and total", () => {
  const t = setup();
  const e = t.friendPaid();
  t.repay(60, t.pmA);
  assert.equal(t.slice(t.pmA), 60);
  assert.equal(t.slice("__notrepaid__"), 40);
  assert.equal(t.total(), 100);
  const a = t.drill(t.pmA).find((r) => r.id === e.id);
  assert.equal(a.slice_part.how, "repaidFrom");
  assert.ok(Math.abs(a.slice_part.fraction - 0.6) < 1e-9);
  assert.ok(a.slice_part.account.length > 0);
  assert.ok(Math.abs(t.drill("__notrepaid__").find((r) => r.id === e.id).slice_part.fraction - 0.4) < 1e-9);
  t.addsUp();
});

test("repaid in several payments from different accounts: split between them", () => {
  const t = setup();
  t.friendPaid();
  t.repay(30, t.pmB);
  t.repay(70, t.pmA);
  assert.equal(t.slice(t.pmB), 30);
  assert.equal(t.slice(t.pmA), 70);
  assert.equal(t.slice("__notrepaid__"), 0);
  t.addsUp();
});

test("one repayment covering two expenses (oldest first) splits into each", () => {
  const t = setup();
  t.friendPaid(40);
  t.friendPaid(60);
  t.repay(70, t.pmA);
  assert.equal(t.slice(t.pmA), 70);
  assert.equal(t.slice("__notrepaid__"), 30);
  t.addsUp();
});

test("a repayment with no account: No account", () => {
  const t = setup();
  const e = t.friendPaid();
  t.repay(100, "");
  assert.equal(t.slice(""), 100);
  assert.equal(t.drill("").find((r) => r.id === e.id).slice_part.how, "repaidNoAccount");
});

test("an overpayment never counts the expense twice", () => {
  const t = setup();
  t.friendPaid();
  t.repay(130, t.pmA, { overpay_pending_ok: true });
  assert.equal(t.slice(t.pmA), 100);
  t.addsUp();
});

test("canceled out against an expense I paid for them: followed back to that account", () => {
  const t = setup();
  const theirs = t.expense({ payment_method_id: t.pmB, amount: 50 });
  t.rt.api("saveEntrySplits", { entryId: theirs.id, splits: [{ friend_id: t.friend.id, amount: 50 }] });   // they owe me 50
  const mine = t.friendPaid(100);
  t.repay(50, t.pmA);   // cancels 50 against what they owe me, 50 real from A
  assert.equal(t.slice(t.pmB), 50, "nothing of theirs counts (my share is 0) + 50 traced back to B");
  assert.equal(t.slice(t.pmA), 50);
  const traced = t.drill(t.pmB).find((r) => r.id === mine.id);
  assert.equal(traced.slice_part.how, "offsetMeFrom");
  t.addsUp();
});

test("canceled out against cash I lent them: that account", () => {
  const t = setup();
  t.rt.api("addLoan", { friend_id: t.friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2031-01-01", payment_method_id: t.pmB });
  t.friendPaid(100);
  t.repay(0.01, t.pmA);   // the cancel-out happens first; a cent is real money
  assert.ok(Math.abs(t.slice(t.pmB) - 100) < 0.02);
});

test("canceled out against income they owed me: Paid with what they owed me, and the income: Received as what I owed them", () => {
  const t = setup();
  const inc = t.rt.api("createEntry", { type: "income", date: DAY, amount: 100, currency: "PEN", category_id: t.cat("income"), description: "job", paid_by: t.friend.id, income_waiting: true, status: "confirmed" });
  assert.equal(t.slice("__notreceived__", "income"), 100);
  const exp = t.friendPaid(100);
  t.repay(0.01, t.pmA);
  assert.ok(Math.abs(t.slice("__owedme__") - 100) < 0.02);
  assert.equal(t.pie().find((i) => i.id === "__owedme__").name, "Paid with what they owed me");
  assert.ok(Math.abs(t.slice("__owedthem__", "income") - 100) < 0.02);
  assert.equal(t.pie("income").find((i) => i.id === "__owedthem__").name, "Received as what I owed them");
  assert.ok(t.drill("__owedme__").some((r) => r.id === exp.id));
  assert.ok(t.drill("__owedthem__", "income").some((r) => r.id === inc.id));
  t.addsUp(); t.addsUp("income");
});

test("forgiven by the friend (part, then the rest): A friend covered it", () => {
  const t = setup();
  t.friendPaid();
  const loan = t.rt.rows("Loans").find((l) => l.friend_id === t.friend.id && l.direction === "i_owe_them");
  t.repay(20, t.pmA);
  t.rt.api("forgiveLoan", { id: loan.id, amount: 30, category_id: t.cat("income"), date: "2031-04-05" });
  assert.equal(t.slice(t.pmA), 20);
  assert.equal(t.slice("__covered__"), 30);
  assert.equal(t.slice("__notrepaid__"), 50);
  t.rt.api("forgiveLoan", { id: loan.id, category_id: t.cat("income"), date: "2031-04-06" });
  assert.equal(t.slice("__covered__"), 80);
  assert.equal(t.slice("__notrepaid__"), 0);
  assert.equal(t.pie().find((i) => i.id === "__covered__").name, "A friend covered it");
  t.addsUp();
});

test("a debt in another currency than the expense still splits by proportion", () => {
  const t = setup();
  const e = t.friendPaid(100);
  t.rt.run(`updateRowFields_('Loans', '${t.rt.rows("Loans").find((l) => l.entry_id === e.id).id}', { amount: 25 });`);   // as if kept in another unit
  t.repay(10, t.pmA);
  assert.equal(t.slice(t.pmA), 40);
  assert.equal(t.slice("__notrepaid__"), 60);
});

test("a repayment deleted: back to Not repaid yet; account edited: it moves", () => {
  const t = setup();
  t.friendPaid();
  t.repay(100, t.pmA);
  const money = t.rt.rows("Entries").find((e) => e.type === "transfer" && Number(e.amount) === 100 && e.payment_method_id === t.pmA);
  t.rt.run(`updateRowFields_('Entries', '${money.id}', { payment_method_id: '${t.pmB}' });`);
  assert.equal(t.slice(t.pmB), 100, "the money entry's account is what counts");
  t.rt.api("deleteRepayment", { id: t.rt.rows("Settlements").find((s) => s.transfer_entry_id === money.id).id });
  assert.equal(t.slice("__notrepaid__"), 100);
});

test("income: the account it arrived in, even with a 'Received from' (bug fixed 2026-11-10); waiting income by what arrived", () => {
  const t = setup();
  const payor = t.rt.api("addPayor", { name: "Employer Test" });
  t.rt.api("createEntry", { type: "income", date: DAY, amount: 1000, currency: "PEN", category_id: t.cat("income"), description: "salary", paid_by: payor.id, payment_method_id: t.pmA, status: "confirmed" });
  assert.equal(t.slice(t.pmA, "income"), 1000);
  t.rt.api("createEntry", { type: "income", date: DAY, amount: 200, currency: "PEN", category_id: t.cat("income"), description: "job", paid_by: t.friend.id, income_waiting: true, status: "confirmed" });
  t.rt.api("recordRepayment", { friend_id: t.friend.id, direction: "they_owe_me", amount: 150, currency: "PEN", date: "2031-04-02", payment_method_id: t.pmB });
  assert.equal(t.slice(t.pmB, "income"), 150);
  assert.equal(t.slice("__notreceived__", "income"), 50);
  assert.equal(t.pie("income").find((i) => i.id === "__notreceived__").name, "Not received yet");
  const row = t.drill(t.pmB, "income").find((r) => r.description === "job");
  assert.equal(row.slice_part.how, "receivedIn");
  t.addsUp("income");
});

test("names in Spanish", () => {
  const t = setup();
  t.rt.api("setLanguage", { lang: "es" });
  t.friendPaid();
  const s = t.pie().find((i) => i.id === "__notrepaid__");
  assert.equal(s.name, "Aún no devuelto");
});

test("an older phone's 'Paid by a friend' list still lists every friend-paid expense", () => {
  const t = setup();
  const e = t.friendPaid();
  t.repay(100, t.pmA);
  assert.deepEqual(t.drill("__friend__").map((r) => r.id), [e.id]);
});
