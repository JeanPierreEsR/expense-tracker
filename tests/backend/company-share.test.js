// Business 2, piece 12: the statement to share (ShareStatement.gs). A section not chosen appears nowhere; the figures are the Overview's.
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
  rt.sheet("Entries").rows.length = 1;
  rt.run("ROWS_MEMO_ = null;");
  return rt;
}
const ym = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
const last = (() => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); })();
const pm = (rt) => rt.rows("Payment Methods")[0].id;

function month(rt) {
  const project = rt.rows("Projects")[0];
  const cat = (t) => rt.rows("Categories").find((c) => c.type === t).id;
  rt.api("setPaymentMethodOpeningBalance", { id: pm(rt), balances: [{ currency: "PEN", amount: 20000, date: `${ym}-01` }] });
  rt.api("createEntry", { type: "expense", date: `${ym}-05`, amount: 1200, currency: "PEN", category_id: cat("expense"), description: "Cemento", payment_method_id: pm(rt), paid_by: "me", company_id: project.company_id, project_id: project.id });
  rt.api("createEntry", { type: "income", date: `${ym}-09`, amount: 5000, currency: "PEN", category_id: cat("income"), description: "Separación", payment_method_id: pm(rt), paid_by: "me", company_id: project.company_id, project_id: project.id });
  const lender = rt.api("addFriend", { name: "Prestamista Prueba", role: "lender" });
  rt.api("addLoan", { friend_id: lender.id, direction: "i_owe_them", amount: 8000, currency: "PEN", date: `${ym}-10`, payment_method_id: pm(rt) });
}

test("the default sections leave the lenders out; a section not chosen appears nowhere", () => {
  const rt = companyCopy();
  month(rt);
  const def = rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last });
  assert.ok(!def.sections.includes("owed"));
  assert.equal(def.data.owed, undefined);
  assert.ok(!JSON.stringify(def).includes("Prestamista Prueba"), "no lender anywhere");
  const only = rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last, sections: ["categories"] });
  assert.deepEqual(Object.keys(only.data), ["categories"]);
  assert.ok(!JSON.stringify(only.data).includes("Obra Norte"), "no project when projects are not chosen");
  // remembered for next time
  assert.deepEqual(rt.api("getShareSections", {}).sections, ["categories"]);
  assert.deepEqual(rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last }).sections, ["categories"]);
  const withOwed = rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last, sections: ["owed"] });
  assert.equal(withOwed.data.owed.people[0].name, "Prestamista Prueba");
  assert.throws(() => rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last, sections: [] }));
});

test("the figures are the Overview's and the Companies & projects screen's; the close state is said", () => {
  const rt = companyCopy();
  month(rt);
  const s = rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last, sections: ["cash", "categories", "projects", "partners", "sales"] });
  const ov = rt.api("getPeriodSummary", { startDate: `${ym}-01`, endDate: last });
  assert.equal(s.data.categories.income, Math.round(ov.totals.income * 100) / 100);
  assert.equal(s.data.categories.expense, Math.round(ov.totals.expense * 100) / 100);
  const proj = s.data.projects.find((p) => p.name === "Obra Norte").lines.find((l) => l.currency === "PEN");
  assert.equal(proj.income, 5000);
  assert.equal(proj.costs, 1200);
  assert.equal(proj.result, 3800);
  const cash = s.data.cash.find((a) => a.balances.some((b) => b.currency === "PEN"));
  const bal = rt.api("listPaymentMethodBalances", {}).find((a) => a.nickname === cash.name);
  assert.equal(cash.balances[0].amount, bal.balances[0].amount);
  assert.equal(s.close.month, ym);
  assert.equal(s.close.closed, false);
  rt.api("closeMonth", { month: ym, bank: [] });
  assert.equal(rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last }).close.closed, true);
});

test("not a company copy: refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("buildShareStatement", { startDate: `${ym}-01`, endDate: last }));
});
