// Business 2, piece 9: the yearly "constancia informativa" per lender / partner (Constancia.gs). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
  return rt;
}
const Y = String(new Date().getFullYear() - 1), Y1 = String(new Date().getFullYear());
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const interestCat = (rt) => rt.rows("Categories").find((c) => c.key === "loan_interest").id;

// A lender's 3,000 loan on 1 March of last year; two installments paid last year (interest 30 and 20, withholding 2 and 1).
function lenderWithInstallments(rt) {
  const project = rt.rows("Projects")[0];
  const out = rt.api("saveBankLoan", { friend_name: "Prestamista Prueba", amount: 3000, currency: "PEN", date: `${Y}-03-01`, payment_method_id: pm(rt),
    description: "Préstamo obra", lender: true, company_id: project.company_id, project_id: project.id,
    installments: [{ due_date: `${Y}-04-01`, principal: 1000, interest: 30, fees: 0 }, { due_date: `${Y}-05-01`, principal: 1000, interest: 20, fees: 0 },
      { due_date: `${Y1}-01-15`, principal: 1000, interest: 10, fees: 0 }] });
  rt.api("recordInstallment", { id: out.installments[0].id, date: `${Y}-04-01`, payment_method_id: pm(rt), withholding: 2, category_id: interestCat(rt) });
  rt.api("recordInstallment", { id: out.installments[1].id, date: `${Y}-05-01`, payment_method_id: pm(rt), withholding: 1, category_id: interestCat(rt) });
  return rt.rows("Friends").find((f) => f.name === "Prestamista Prueba").id;
}

test("a lender's year: received, returned, interest gross / withholding / net, balance on 31 December = 1 January + received − returned", () => {
  const rt = companyCopy();
  const id = lenderWithInstallments(rt);
  const s = rt.api("getYearStatement", { friend_id: id, year: Y });
  assert.equal(s.lines.length, 1);
  const l = s.lines[0];
  assert.equal(l.currency, "PEN");
  assert.equal(l.contracted, 3000);
  assert.equal(l.opening, 0);
  assert.equal(l.received, 3000);
  assert.equal(l.returned, 2000);
  assert.equal(l.closing, 1000);
  assert.equal(l.closing, l.opening + l.received - l.returned - l.forgiven);
  assert.equal(l.interest_gross, 50);
  assert.equal(l.interest_withholding, 3);
  assert.equal(l.interest_net, 47);
  assert.equal(s.company.name, "Constructora Andina");
  // the next year starts where this one ended, and its 31 December agrees with the loan screen today
  const next = rt.api("getYearStatement", { friend_id: id, year: Y1 }).lines[0];
  assert.equal(next.opening, 1000);
  assert.equal(next.received, 0);
  const screen = rt.api("listLoanBalances", {}).find((f) => f.friend_id === id).balances.find((b) => b.currency === "PEN");
  assert.equal(next.closing, -screen.net);
});

test("currencies are never added: a USD loan has its own line", () => {
  const rt = companyCopy();
  const id = lenderWithInstallments(rt);
  rt.api("addLoan", { friend_id: id, direction: "i_owe_them", amount: 500, currency: "USD", date: `${Y}-06-10`, payment_method_id: pm(rt) });
  const s = rt.api("getYearStatement", { friend_id: id, year: Y });
  assert.deepEqual(s.lines.map((l) => l.currency), ["PEN", "USD"]);
  assert.equal(s.lines[1].received, 500);
  assert.equal(s.lines[0].received, 3000);
});

test("a partner's year: contributions (year and total), to be decided, distributions with withholding; all of them in one list", () => {
  const rt = companyCopy();
  lenderWithInstallments(rt);
  const inc = rt.rows("Categories").find((c) => c.type === "income").id, exp = rt.rows("Categories").find((c) => c.type === "expense").id;
  const waiting = (type, amount, date) => rt.api("createEntry", { type, date, amount, currency: "PEN", category_id: type === "income" ? inc : exp,
    description: "Abono", payment_method_id: pm(rt), paid_by: "me", status: "pending", source: "email" });
  rt.api("convertEntryToPartnerMoney", { entry_id: waiting("income", 10000, `${Y}-02-01`).id, kind: "contribution", partner_name: "Socio Prueba" });
  rt.api("convertEntryToPartnerMoney", { entry_id: waiting("income", 5000, `${Y1}-01-05`).id, kind: "contribution", partner_name: "Socio Prueba" });
  rt.api("convertEntryToPartnerMoney", { entry_id: waiting("income", 2000, `${Y}-08-01`).id, kind: "pending", partner_name: "Socio Prueba" });
  rt.api("recordDistribution", { entry_id: waiting("expense", 950, `${Y}-12-20`).id, partner_name: "Socio Prueba", withholding: 50 });
  const partner = rt.rows("Friends").find((f) => f.name === "Socio Prueba").id;
  const l = rt.api("getYearStatement", { friend_id: partner, year: Y }).lines[0];
  assert.equal(l.contributed_year, 10000);
  assert.equal(l.contributed_total, 10000);
  assert.equal(l.pending_total, 2000);
  assert.equal(l.distributed_gross, 1000);
  assert.equal(l.distributed_withholding, 50);
  assert.equal(l.distributed_net, 950);
  const l1 = rt.api("getYearStatement", { friend_id: partner, year: Y1 }).lines[0];
  assert.equal(l1.contributed_year, 5000);
  assert.equal(l1.contributed_total, 15000);
  assert.equal(l1.distributed_net, 0);
  const all = rt.api("getYearStatements", { year: Y });
  assert.deepEqual(all.map((s) => s.name), ["Prestamista Prueba", "Socio Prueba"]);   // SUNAT (the withholding's debt) is not an investor
});

test("the months of the year still open are named; a closed one is not", () => {
  const rt = companyCopy();
  rt.api("closeMonth", { month: `${Y}-01`, bank: [] });
  const id = lenderWithInstallments(rt);
  const s = rt.api("getYearStatement", { friend_id: id, year: Y });
  assert.ok(!s.open_months.includes(`${Y}-01`));
  assert.ok(s.open_months.includes(`${Y}-02`));
  assert.equal(s.open_months.length, 11);
});

test("not a company copy: refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("getYearStatements", { year: Y }));
});
