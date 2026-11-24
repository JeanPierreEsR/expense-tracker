// Business 2, piece 7: a partner's money (Partners.gs). A contribution / "to be decided" raises the account and is never income; it can
// later become a loan; a profit distribution lowers the account and is never an expense; "paid by the partner" leaves the debt on the
// company. Made-up data only, on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
  return rt;
}
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const balanceOf = (rt, id) => Number(rt.run(`(function () { var pm = getAllRows('Payment Methods').find(function (p) { return p.id === ${JSON.stringify(id)}; });
  return movementsForPaymentMethod_(pm, [{ currency: 'PEN', amount: 0, date: '2000-01-01' }], confirmedEntries_(), buildInboundTransferIds_())
    .reduce(function (n, m) { return n + ((m.entry.currency || 'PEN') === 'PEN' ? m.signed : 0); }, 0); })()`));
const incomeCat = (rt) => rt.rows("Categories").find((c) => c.type === "income").id;
const expenseCat = (rt) => rt.rows("Categories").find((c) => c.type === "expense").id;
// A waiting item as a bank e-mail leaves it.
function waiting(rt, type, amount) {
  return rt.api("createEntry", { type, date: today(), amount, currency: "PEN", category_id: type === "income" ? incomeCat(rt) : expenseCat(rt),
    description: "Abono recibido", payment_method_id: pm(rt), paid_by: "me", status: "pending", source: "email" });
}
const totals = (rt) => rt.api("getPeriodSummary", { startDate: today().slice(0, 8) + "01", endDate: today() }).totals;
const partnersCard = (rt) => rt.api("getPeriodSummary", { startDate: today().slice(0, 8) + "01", endDate: today() }).company.partners;

test("a contribution: the account goes up, income does not, the row says whose and for which company", () => {
  const rt = companyCopy();
  const account = pm(rt);
  const before = balanceOf(rt, account), t0 = totals(rt);
  const e = waiting(rt, "income", 56000);
  const out = rt.api("convertEntryToPartnerMoney", { entry_id: e.id, kind: "contribution", partner_name: "Socio Prueba" });
  assert.equal(out.kind, "contribution");
  const entry = rt.rows("Entries").find((x) => x.id === e.id);
  assert.equal(entry.type, "transfer");
  assert.equal(entry.status, "confirmed");
  assert.equal(entry.company_id || "", "");
  assert.equal(balanceOf(rt, account), before + 56000);
  const t1 = totals(rt);
  assert.equal(t1.income, t0.income);
  assert.equal(t1.expense, t0.expense);
  const partner = rt.rows("Friends").find((f) => f.name === "Socio Prueba");
  assert.equal(partner.role, "partner");
  const row = rt.rows("Contributions")[0];
  assert.equal(row.partner_id, partner.id);
  assert.equal(row.company_id, rt.rows("Companies")[0].id);
  // the row on Home says it is a contribution from the partner (money in)
  const listed = rt.api("listEntries", { startDate: today(), endDate: today() });
  const shown = (Array.isArray(listed) ? listed : listed.entries).find((x) => x.id === e.id);
  assert.equal(shown.link.kind, "contribution");
  assert.equal(shown.link.partner, "Socio Prueba");
  assert.equal(shown.link.friend, undefined);
  // the Partners card
  const card = partnersCard(rt).find((p) => p.name === "Socio Prueba");
  assert.equal(card.lines[0].contributed, 56000);
});

test("to be decided, then a loan: same date, amount and account; the debt is the company's; the account counts it once", () => {
  const rt = companyCopy();
  const account = pm(rt);
  const before = balanceOf(rt, account);
  const e = waiting(rt, "income", 30000);
  rt.api("convertEntryToPartnerMoney", { entry_id: e.id, kind: "pending", partner_name: "Socio Prueba" });
  assert.equal(partnersCard(rt)[0].lines[0].pending, 30000);
  const pending = rt.api("listPendingContributions", {});
  assert.equal(pending.length, 1);
  rt.api("changePartnerMoney", { id: pending[0].id, kind: "loan" });
  assert.equal(rt.rows("Contributions").length, 0);
  const loan = rt.rows("Loans").find((l) => l.transfer_entry_id === e.id);
  assert.equal(loan.direction, "i_owe_them");
  assert.equal(Number(loan.amount), 30000);
  assert.equal(loan.company_id, rt.rows("Companies")[0].id);
  assert.equal(rt.rows("Loans").filter((l) => l.friend_id === loan.friend_id).length, 1);
  assert.equal(rt.rows("Entries").filter((x) => x.type === "transfer" && /Socio Prueba/.test(x.description || "")).length, 1);   // no second money movement
  assert.equal(balanceOf(rt, account), before + 30000);
  const card = partnersCard(rt)[0];
  assert.equal(card.lines[0].owed, 30000);
  assert.equal(card.lines[0].pending, 0);
});

test("to be decided, then a contribution", () => {
  const rt = companyCopy();
  const e = waiting(rt, "income", 1000);
  rt.api("convertEntryToPartnerMoney", { entry_id: e.id, kind: "pending", partner_name: "Socio Prueba" });
  const id = rt.rows("Contributions")[0].id;
  rt.api("changePartnerMoney", { id, kind: "contribution" });
  assert.equal(rt.rows("Contributions")[0].kind, "contribution");
  assert.match(rt.rows("Entries").find((x) => x.id === e.id).description, /Aporte de capital|Capital contribution/);
});

test("a partner's loan straight from Needs review is an ordinary 'I owe them' loan on the company", () => {
  const rt = companyCopy();
  const account = pm(rt);
  const before = balanceOf(rt, account), t0 = totals(rt);
  const e = waiting(rt, "income", 5000);
  const out = rt.api("convertEntryToPartnerMoney", { entry_id: e.id, kind: "loan", partner_name: "Socio Prueba" });
  assert.equal(out.kind, "loan");
  const loan = rt.rows("Loans").find((l) => l.id === out.loan.id);
  assert.equal(loan.direction, "i_owe_them");
  assert.equal(loan.company_id, rt.rows("Companies")[0].id);
  assert.equal(balanceOf(rt, account), before + 5000);
  assert.equal(totals(rt).income, t0.income);
});

test("a profit distribution: the account goes down by the net, no expense, gross = net + withholding", () => {
  const rt = companyCopy();
  const account = pm(rt);
  const before = balanceOf(rt, account), t0 = totals(rt);
  const e = waiting(rt, "expense", 9500);
  const out = rt.api("recordDistribution", { entry_id: e.id, partner_name: "Socio Prueba", withholding: 500 });
  assert.equal(out.distribution.gross, 10000);
  assert.equal(out.distribution.net, 9500);
  assert.equal(balanceOf(rt, account), before - 9500);
  const t1 = totals(rt);
  assert.equal(t1.expense, t0.expense);
  assert.equal(t1.income, t0.income);
  const line = partnersCard(rt)[0].lines[0];
  assert.equal(line.distributed, 9500);
  assert.equal(line.gross, 10000);
  assert.equal(line.withholding, 500);
  const listed = rt.api("listEntries", { startDate: today(), endDate: today() });
  assert.equal((Array.isArray(listed) ? listed : listed.entries).find((x) => x.id === e.id).link.kind, "distribution");
  assert.throws(() => rt.api("recordDistribution", { entry_id: waiting(rt, "expense", 10).id, partner_name: "Socio Prueba", withholding: -1 }));
});

test("money in cannot be a distribution, money out cannot be a contribution", () => {
  const rt = companyCopy();
  assert.throws(() => rt.api("recordDistribution", { entry_id: waiting(rt, "income", 10).id, partner_name: "Socio Prueba" }));
  assert.throws(() => rt.api("convertEntryToPartnerMoney", { entry_id: waiting(rt, "expense", 10).id, kind: "contribution", partner_name: "Socio Prueba" }));
});

test("paid by the partner: the debt carries the company even with no project", () => {
  const rt = companyCopy();
  const partner = rt.api("addFriend", { name: "Socia Prueba", role: "partner" });
  const company = rt.rows("Companies")[0].id;
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 200, currency: "PEN", category_id: expenseCat(rt), description: "Materiales",
    paid_by: partner.id, company_id: company, project_id: "" });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [] });
  const loan = rt.rows("Loans").find((l) => l.entry_id === e.id);
  assert.equal(loan.direction, "i_owe_them");
  assert.equal(loan.company_id, company);
  const line = partnersCard(rt).find((p) => p.name === "Socia Prueba").lines[0];
  assert.equal(line.owed_bills, 200, "a bill the partner paid shows apart from money they lent (testers 2.68.2)");
  assert.equal(line.owed, 0);
});

test("a partner repaid in full shows as repaid, not 'nothing recorded'", () => {
  const rt = companyCopy();
  const partner = rt.api("addFriend", { name: "Socio Pagado", role: "partner" });
  rt.run(`updateRowFields_('Friends', '${partner.id}', { role: 'partner' })`);
  rt.api("addLoan", { friend_id: partner.id, direction: "i_owe_them", amount: 300, currency: "PEN", date: today(), payment_method_id: pm(rt) });
  rt.api("recordRepayment", { friend_id: partner.id, direction: "i_owe_them", amount: 300, currency: "PEN", date: today(), payment_method_id: pm(rt) });
  const p = partnersCard(rt).find((x) => x.name === "Socio Pagado");
  assert.equal(p.repaid, true);
});

test("not a company copy: refused, and a friend-paid expense's debt carries no company", () => {
  const { rt } = freshApp({ small: true });
  const e = rt.api("createEntry", { type: "income", date: today(), amount: 10, currency: "PEN", category_id: rt.rows("Categories").find((c) => c.type === "income").id,
    description: "x", payment_method_id: rt.rows("Payment Methods")[0].id, paid_by: "me", status: "pending" });
  assert.throws(() => rt.api("convertEntryToPartnerMoney", { entry_id: e.id, kind: "contribution", partner_name: "X" }));
  assert.equal(rt.api("getPeriodSummary", { startDate: today(), endDate: today() }).company, null);
});

// Testers 2.68.2 (Lucho): a distribution's amount edited on Home left the old gross in the Partners card (net 1,500 / gross 1,785.55).
test("a distribution's amount edited afterwards: gross follows (new net + withholding) in the card, the link and the constancia", () => {
  const rt = companyCopy();
  const e = waiting(rt, "expense", 1700);
  const out = rt.api("recordDistribution", { entry_id: e.id, partner_name: "Socio Prueba", withholding: 85.55 });
  rt.api("updateEntry", { id: e.id, fields: { amount: 1500 } });
  const line = partnersCard(rt)[0].lines[0];
  assert.equal(line.distributed, 1500);
  assert.equal(line.gross, 1585.55);
  const listed = rt.api("listEntries", { startDate: today(), endDate: today() });
  assert.equal((Array.isArray(listed) ? listed : listed.entries).find((x) => x.id === e.id).link.gross, 1585.55);
  const year = rt.api("getYearStatement", { friend_id: out.distribution.partner_id, year: Number(today().slice(0, 4)) });
  assert.equal(JSON.stringify(year).includes("1585.55"), true, "the constancia uses the new gross");
});

test("a second partner conversion of the same movement says it is already a partner's money (testers 2.68.2)", () => {
  const rt = companyCopy();
  const e = waiting(rt, "expense", 500);
  rt.api("recordDistribution", { entry_id: e.id, partner_name: "Socio Prueba", withholding: 0 });
  assert.throws(() => rt.api("recordDistribution", { entry_id: e.id, partner_name: "Socio Prueba", withholding: 0 }), /already a partner's money/);
});
