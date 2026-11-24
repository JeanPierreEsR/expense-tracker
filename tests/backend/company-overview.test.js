// Business 2, piece 4: a company copy's Overview — What is owed (lenders), Still to finance (per project, typed), sent with the period's
// figures (getPeriodSummary `company`). Made-up data only, on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { freshApp, today } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte", "Otros proyectos"] });
  return rt;
}
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const plusMonths = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const rows = (total, n) => Array.from({ length: n }, (_, i) => ({ due_date: plusMonths(i + 1), principal: total / n, interest: 10, fees: 0 }));
const lend = (rt, name, amount, currency = "PEN", n = 2) => rt.api("saveBankLoan", { friend_name: name, amount, currency, date: today(), payment_method_id: pm(rt),
  installments: rows(amount, n), lender: true, company_id: rt.rows("Companies")[0].id });
const summary = (rt) => rt.api("getPeriodSummary", { startDate: today(), endDate: today() });

test("What is owed: every lender with what is left per currency, by name, and totals that match the loans", () => {
  const rt = companyCopy();
  const a = lend(rt, "Zeta Prestamista", 3000);
  lend(rt, "Alfa Prestamista", 1000, "USD");
  lend(rt, "Alfa Prestamista", 500);
  rt.api("recordInstallment", { id: a.installments[0].id, date: today(), payment_method_id: pm(rt), withholding: 2 });
  rt.api("addFriend", { name: "Amigo Personal" });   // a plain friend never shows here
  const co = summary(rt).company;
  assert.deepEqual(co.owed.map((p) => p.name), ["Alfa Prestamista", "Withholding to pay (SUNAT)", "Zeta Prestamista"]);
  const alfa = Object.fromEntries(co.owed[0].lines.map((l) => [l.currency, l.amount]));
  assert.deepEqual(alfa, { PEN: 500, USD: 1000 }, "one line per currency, never converted");
  assert.equal(co.owed.find((p) => p.name === "Zeta Prestamista").lines[0].amount, 1500);
  assert.equal(co.owed.find((p) => /SUNAT/.test(p.name)).lines[0].amount, 2);
  const pen = co.owedTotals.find((t) => t.currency === "PEN"), usd = co.owedTotals.find((t) => t.currency === "USD");
  assert.equal(pen.amount, 500 + 1500 + 2);
  assert.equal(usd.amount, 1000);
  assert.equal(co.owedTotals[0].currency, "PEN", "the main currency first");
  // the totals are the lenders' loan balances (listLoanBalances), added up
  const fromLoans = rt.api("listLoanBalances", {}).filter((f) => f.role === "lender").reduce((n, f) => n + f.balances.filter((b) => b.currency === "PEN").reduce((m, b) => m - b.net, 0), 0);
  assert.equal(Math.round(fromLoans * 100) / 100, pen.amount);
});

test("Still to finance: typed per project with its date, cleared by a blank amount; closed projects are left out", () => {
  const rt = companyCopy();
  const [norte, otros] = rt.rows("Projects");
  let co = summary(rt).company;
  assert.deepEqual(co.funding.map((f) => [f.name, f.amount]), [["Obra Norte", null], ["Otros proyectos", null]]);
  rt.api("setProjectFunding", { project_id: norte.id, amount: 250000, currency: "USD", as_of: "2026-12-15" });
  co = summary(rt).company;
  const f = co.funding.find((x) => x.project_id === norte.id);
  assert.equal(f.amount, 250000);
  assert.equal(f.currency, "USD");
  assert.equal(f.as_of, "2026-12-15", "the date stays a text date");
  assert.throws(() => rt.api("setProjectFunding", { project_id: norte.id, amount: -1, as_of: "2026-12-15" }), /amount|monto/i);
  rt.api("setProjectFunding", { project_id: norte.id, amount: "" });
  assert.equal(summary(rt).company.funding.find((x) => x.project_id === norte.id).amount, null);
  rt.api("updateProject", { id: otros.id, name: otros.name, emoji: otros.emoji, company_id: otros.company_id, status: "closed" });
  assert.deepEqual(summary(rt).company.funding.map((x) => x.name), ["Obra Norte"]);
});

test("not a company copy: no company block, and the switch is refused while the pack is off", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(summary(rt).company, null);
  const friend = freshApp({ small: true }).rt;
  friend.svc.props.set("FEATURES", "base");
  assert.equal(summary(friend).company, null);
});

test("the phone: the company Overview cards, their order and what is hidden; app.js still loads", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /function applyCompanyOverview_\(\)/);
  assert.match(src, /renderCompanyOverview_\(data\.company\)/);
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  assert.ok(html.indexOf('id="co-owed-card"') < html.indexOf('id="co-funding-card"'));
  assert.ok(html.indexOf('id="period-selector-card"') < html.indexOf('id="co-owed-card"'));
  const css = fs.readFileSync(path.join(__dirname, "../../docs/style.css"), "utf8");
  for (const id of ["overview-scope-row", "pace-card", "investments-card", "months-card", "ov-annual-views", "loans-ov-card"]) {
    assert.match(css, new RegExp(`company-ov #${id}`), id);
  }
});

// Owner, 2026-11-24 (testers 2.68.2, Elena): partners' loans belong in What is owed; a past month shows what was owed on its last day.
test("What is owed lists partners' loans too, and a period that ended shows the debt of its last day", () => {
  const rt = companyCopy();
  const a = lend(rt, "Prestamista Uno", 2000, "PEN", 2);
  rt.ctx.__f = { name: "Socio Uno", role: "partner" };
  const partner = rt.run("addFriend(__f)");
  rt.run(`updateRowFields_('Friends', '${partner.id}', { role: 'partner' })`);
  rt.api("addLoan", { friend_id: partner.id, direction: "i_owe_them", amount: 700, currency: "PEN", date: today(), payment_method_id: pm(rt) });
  const now = summary(rt).company.owed;
  assert.ok(now.some((p) => p.name === "Socio Uno" && p.lines[0].amount === 700), "the partner's loan is listed");
  // Yesterday's period: the loans made today were not owed yet.
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yd = y.toISOString().slice(0, 10);
  const past = rt.api("getPeriodSummary", { startDate: yd, endDate: yd }).company.owed;
  assert.deepEqual(past, [], "nothing was owed yesterday");
  rt.api("recordInstallment", { id: a.installments[0].id, date: today(), payment_method_id: pm(rt) });
  assert.equal(summary(rt).company.owed.find((p) => p.name === "Prestamista Uno").lines[0].amount, 1000);
});
