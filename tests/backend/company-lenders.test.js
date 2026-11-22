// Business 2, piece 3: a lender's loan to the company (the bank-loan form with a lender), its installments' interest on the company, and
// the withholding kept for the tax office as a debt with it (BankLoans.gs). Made-up data only, on the fake Google layer.
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
const interestCat = (rt) => rt.rows("Categories").find((c) => c.key === "loan_interest").id;
// The account's PEN movement total, the way the Balances card adds it up (an opening of 0 long ago).
const balanceOf = (rt, id) => Number(rt.run(`(function () { var pm = getAllRows('Payment Methods').find(function (p) { return p.id === ${JSON.stringify(id)}; });
  return movementsForPaymentMethod_(pm, [{ currency: 'PEN', amount: 0, date: '2000-01-01' }], confirmedEntries_(), buildInboundTransferIds_())
    .reduce(function (n, m) { return n + ((m.entry.currency || 'PEN') === 'PEN' ? m.signed : 0); }, 0); })()`));
const ymd = (d) => d.toISOString().slice(0, 10);
const plusMonths = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return ymd(d); };
// Three monthly installments of a 3,000 loan: principals 1,000 each, interest 30 / 20 / 10.
const rows = () => [1, 2, 3].map((n) => ({ due_date: plusMonths(n), principal: 1000, interest: 40 - 10 * n, fees: 0 }));

function lenderLoan(rt, extra = {}) {
  const project = rt.rows("Projects")[0];
  return rt.api("saveBankLoan", Object.assign({ friend_name: "Prestamista Prueba", amount: 3000, currency: "PEN", date: today(),
    payment_method_id: pm(rt), description: "Préstamo obra", installments: rows(), lender: true,
    company_id: project.company_id, project_id: project.id }, extra));
}

test("a lender's loan: the person is a lender, the loan belongs to the company and its project, the principals add up", () => {
  const rt = companyCopy();
  const out = lenderLoan(rt);
  const friend = rt.rows("Friends").find((f) => f.name === "Prestamista Prueba");
  assert.equal(friend.role, "lender");
  const loan = rt.rows("Loans").find((l) => l.id === out.loan.id);
  assert.equal(loan.company_id, rt.rows("Companies")[0].id);
  assert.equal(loan.project_id, rt.rows("Projects")[0].id);
  assert.equal(loan.direction, "i_owe_them");
  assert.equal(out.installments.reduce((n, r) => n + r.principal, 0), 3000);
  // receiving the loan is never income: a transfer into the account, with no company
  const transfer = rt.rows("Entries").find((e) => e.id === loan.transfer_entry_id);
  assert.equal(transfer.type, "transfer");
  assert.equal(transfer.company_id || "", "");
  // it is listed among the company's people
  assert.ok(rt.api("listBusinessPeople", {}).some((p) => p.name === "Prestamista Prueba" && p.role === "lender"));
  const sched = rt.api("getLoanSchedule", { loan_id: loan.id });
  assert.equal(sched.loan.company_id, loan.company_id);
  assert.equal(sched.remaining_principal, 3000);
});

test("paying an installment: interest is the company's expense, the withholding is a debt with SUNAT, the net is what left the bank", () => {
  const rt = companyCopy();
  const out = lenderLoan(rt);
  const account = pm(rt);
  const before = balanceOf(rt, account);
  const first = out.installments[0];
  const res = rt.api("recordInstallment", { id: first.id, date: today(), payment_method_id: account, interest: 1000, withholding: 50, category_id: interestCat(rt) });
  const interest = rt.rows("Entries").find((e) => e.id === res.extra_entry_id);
  assert.equal(interest.type, "expense");
  assert.equal(Number(interest.amount), 1000, "the expense is the gross interest");
  assert.equal(interest.company_id, rt.rows("Companies")[0].id);
  assert.equal(interest.project_id, rt.rows("Projects")[0].id);
  assert.equal(interest.status, "confirmed");
  // the withheld 50: a debt with SUNAT on the same company, its transfer puts the 50 back in the account
  const held = rt.rows("Loans").find((l) => l.id === res.withholding_loan_id);
  assert.equal(Number(held.amount), 50);
  assert.equal(held.direction, "i_owe_them");
  assert.equal(held.company_id, rt.rows("Companies")[0].id);
  const sunat = rt.rows("Friends").find((f) => f.id === held.friend_id);
  assert.equal(sunat.name, "SUNAT");
  assert.equal(sunat.role, "lender");
  // what left the account: principal 1,000 + interest 1,000 − withholding 50 = 1,950 (the lender gets 1,950 too: the net)
  const after = balanceOf(rt, account);
  assert.equal(Math.round((before - after) * 100) / 100, 1950);
  const sched = rt.api("getLoanSchedule", { loan_id: out.loan.id });
  assert.equal(sched.remaining_principal, 2000);
  assert.equal(sched.withheld_month, 50);
  assert.equal(sched.installments[0].withholding, 50);
  // a second SUNAT person is never made
  rt.api("recordInstallment", { id: out.installments[1].id, date: today(), payment_method_id: account, withholding: 1, category_id: interestCat(rt) });
  assert.equal(rt.rows("Friends").filter((f) => f.name === "SUNAT").length, 1);
  assert.equal(rt.api("getLoanSchedule", { loan_id: out.loan.id }).withheld_month, 51);
});

test("the withholding cannot be more than the interest; a personal bank loan never withholds and stays personal", () => {
  const rt = companyCopy();
  const out = lenderLoan(rt);
  assert.throws(() => rt.api("recordInstallment", { id: out.installments[0].id, date: today(), payment_method_id: pm(rt), withholding: 31 }), /withholding|retención/i);
  const bank = rt.api("saveBankLoan", { friend_name: "Banco Prueba", amount: 3000, currency: "PEN", date: today(), payment_method_id: pm(rt), installments: rows() });
  assert.equal(rt.rows("Friends").find((f) => f.name === "Banco Prueba").role || "friend", "friend");
  const r = rt.api("recordInstallment", { id: bank.installments[0].id, date: today(), payment_method_id: pm(rt), withholding: 5, category_id: interestCat(rt) });
  assert.equal(r.withholding_loan_id, "");
  assert.equal(rt.rows("Entries").find((e) => e.id === r.extra_entry_id).company_id || "", "", "friend money / a personal loan stays personal");
});

test("Overview: the company's loans count for the company, not as personal", () => {
  const rt = companyCopy();
  const c = rt.rows("Companies")[0].id;
  const d = today();
  const sum = (scope) => Number(rt.api("getPeriodSummary", { start: d, end: d, scope }).totals.loans || 0);
  const companyBefore = sum("company:" + c), personalBefore = sum("personal");
  lenderLoan(rt, { project_id: "" });
  assert.equal(Math.round(sum("company:" + c) - companyBefore), 3000);
  assert.equal(Math.round(sum("personal") - personalBefore), 0);
});

test("on the owner's copy and a friend's copy nothing changes: no lender role without the pack, a bank loan as before", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  const out = rt.api("saveBankLoan", { friend_name: "Banco Normal", amount: 3000, currency: "PEN", date: today(), payment_method_id: pm(rt), installments: rows(), lender: true });
  assert.equal(rt.rows("Friends").find((f) => f.name === "Banco Normal").role || "friend", "friend");
  assert.equal(rt.rows("Loans").find((l) => l.id === out.loan.id).company_id || "", "");
});

test("the phone: the loan form, the installment window and People know lenders; app.js still loads (no name declared twice)", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const src = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(src), "a name declared twice stops the whole app from loading");
  assert.match(src, /lender: true/);
  assert.match(src, /withholding: bankNum_/);
  assert.match(src, /\["client", "supplier", "partner", "lender"\]/);
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  for (const id of ["bank-business", "bank-record-withholding", "bank-record-net", "people-hint", "bank-lender-label"]) assert.match(html, new RegExp(`id="${id}"`), id);
});
