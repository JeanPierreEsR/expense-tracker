// Business 2, piece 10: the accountant's monthly package (AccountantPackage.gs) and the receipt fields. Made-up data only.
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
const ym = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 7); })();
const next = (() => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); })();
const day = (n, month = ym) => `${month}-${String(n).padStart(2, "0")}`;
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const cat = (rt, type) => rt.rows("Categories").find((c) => c.type === type).id;
// A CSV back into rows (the files are simple: quoted cells only when needed).
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\r") {} else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c;
  }
  return rows;
}
const file = (pkg, kind) => parseCsv(pkg.files.find((f) => f.kind === kind).text);

function month(rt) {
  rt.sheet("Entries").rows.length = 1;   // only this month's own entries (the sample data has others in it)
  rt.run("ROWS_MEMO_ = null;");
  rt.api("setPaymentMethodOpeningBalance", { id: pm(rt), balances: [{ currency: "PEN", amount: 10000, date: day(1) }] });
  const a = rt.api("createEntry", { type: "expense", date: day(5), amount: 1200, currency: "PEN", category_id: cat(rt, "expense"), description: "Cemento",
    payment_method_id: pm(rt), paid_by: "me", pay_method: "transfer", receipt_type: "factura", receipt_no: "F001-123", receipt_date: day(3) });
  const b = rt.api("createEntry", { type: "expense", date: day(8), amount: 300, currency: "PEN", category_id: cat(rt, "expense"), description: "=HYPERLINK(\"x\")",
    payment_method_id: pm(rt), paid_by: "me" });
  const c = rt.api("createEntry", { type: "income", date: day(9), amount: 5000, currency: "PEN", category_id: cat(rt, "income"), description: "Separación",
    payment_method_id: pm(rt), paid_by: "me", receipt_type: "boleta", receipt_no: "B001-9" });
  return { a, b, c };
}

test("the receipt fields are saved on a company copy (and edited), refused when wrong, ignored elsewhere", () => {
  const rt = companyCopy();
  const { a } = month(rt);
  const row = rt.rows("Entries").find((e) => e.id === a.id);
  assert.equal(row.pay_method, "transfer");
  assert.equal(row.receipt_type, "factura");
  assert.equal(row.receipt_no, "F001-123");
  assert.equal(row.receipt_date, day(3));
  rt.api("updateEntry", { id: a.id, fields: { receipt_no: "F001-124", pay_method: "cheque" } });
  assert.equal(rt.rows("Entries").find((e) => e.id === a.id).receipt_no, "F001-124");
  assert.throws(() => rt.api("updateEntry", { id: a.id, fields: { pay_method: "bitcoin" } }));
  const { rt: plain } = freshApp({ small: true });
  const e = plain.api("createEntry", { type: "expense", date: day(5), amount: 10, currency: "PEN", category_id: plain.rows("Categories").find((c) => c.type === "expense").id,
    description: "x", paid_by: "me", receipt_no: "F1" });
  assert.equal(plain.rows("Entries").find((x) => x.id === e.id).receipt_no, undefined);
});

test("the package: movements add up to the Overview, support and natures are right, a formula-like text is protected", () => {
  const rt = companyCopy();
  month(rt);
  const pkg = rt.api("getAccountantPackage", { month: ym });
  assert.deepEqual(pkg.files.map((f) => f.kind), ["movements", "balances", "ledger", "pending"]);
  const mv = file(pkg, "movements");
  const h = mv[0];
  const col = (name) => h.indexOf(name);
  const rows = mv.slice(1);
  const sum = (nature) => rows.filter((r) => r[col("Naturaleza")] === nature || r[col("Nature")] === nature).reduce((n, r) => n + Number(r[col(h.includes("Monto") ? "Monto" : "Amount")]), 0);
  const summary = rt.api("getPeriodSummary", { startDate: `${ym}-01`, endDate: day(28) });
  const exp = -sum(h.includes("Monto") ? "Gasto" : "Expense"), inc = sum(h.includes("Monto") ? "Ingreso" : "Income");
  assert.equal(exp, summary.totals.expense);
  assert.equal(inc, summary.totals.income);
  const cement = rows.find((r) => r.includes("Cemento"));
  assert.ok(cement.includes("F001-123"));
  assert.ok(cement.includes(day(3)) && cement.includes(day(5)), "issue and payment dates");
  const formula = rows.find((r) => r.some((c) => c.includes("HYPERLINK")));
  assert.ok(formula.some((c) => c.startsWith("'=")), "a formula-like description is written as text");
  // pending: the one without support
  const pen = file(pkg, "pending").slice(1);
  assert.equal(pen.length, 1);
  assert.ok(pen[0].some((c) => c.includes("HYPERLINK")));
});

test("closing balances of a month are the next month's opening balances", () => {
  const rt = companyCopy();
  month(rt);
  rt.api("createEntry", { type: "expense", date: day(4, next), amount: 50, currency: "PEN", category_id: cat(rt, "expense"), description: "Clavos", payment_method_id: pm(rt), paid_by: "me" });
  const b1 = file(rt.api("getAccountantPackage", { month: ym }), "balances").slice(1);
  const b2 = file(rt.api("getAccountantPackage", { month: next }), "balances").slice(1);
  assert.equal(b1[0][3], b2[0][2]);
  assert.equal(Number(b1[0][3]), 10000 - 1200 - 300 + 5000);
  assert.equal(Number(b2[0][3]), Number(b1[0][3]) - 50);
});

test("sending: to the accountant with a copy, the address kept; a change after sending makes the next one CORRECTED with what changed", () => {
  const rt = companyCopy();
  const { a } = month(rt);
  rt.api("closeMonth", { month: ym, bank: [] });
  const out = rt.api("sendAccountantPackage", { month: ym, to: "contadora@example.com" });
  assert.equal(out.sent, true);
  assert.equal(out.corrected, false);
  const mail = rt.svc.mailLog[rt.svc.mailLog.length - 1];
  assert.equal(mail.to, "contadora@example.com");
  assert.equal(mail.attachments.length, 4);
  assert.match(mail.body, /No es contabilidad|Not accounting/);
  const state = rt.api("getMonthClose", { month: ym });
  assert.equal(state.package.email, "contadora@example.com");
  assert.ok(state.package.sent_at);
  assert.equal(state.package.changed_since, false);
  rt.api("updateEntry", { id: a.id, fields: { amount: 1250 } });
  assert.equal(rt.api("getMonthClose", { month: ym }).package.changed_since, true);
  const again = rt.api("sendAccountantPackage", { month: ym, to: "contadora@example.com" });
  assert.equal(again.corrected, true);
  const mail2 = rt.svc.mailLog[rt.svc.mailLog.length - 1];
  assert.match(mail2.subject, /CORREGIDO|CORRECTED/);
  assert.match(mail2.body, /1200 → 1250/);
  assert.match(mail2.body, new RegExp(`- ${day(5)} Cemento PEN [\\d.,]+: (Amount|Monto) 1200 → 1250 · (changed on|cambiado el) `), "the entry's date first, the field in words (testers 2.68.2)");
  assert.throws(() => rt.api("sendAccountantPackage", { month: ym, to: "not an address" }));
});

test("the ledger: a lender's month as in the yearly statement", () => {
  const rt = companyCopy();
  const lender = rt.api("addFriend", { name: "Prestamista Prueba", role: "lender" });
  rt.api("addLoan", { friend_id: lender.id, direction: "i_owe_them", amount: 8000, currency: "PEN", date: day(10), payment_method_id: pm(rt) });
  const led = file(rt.api("getAccountantPackage", { month: ym }), "ledger");
  const row = led.find((r) => r[0] === "Prestamista Prueba");
  assert.equal(Number(row[4]), 8000);   // received
  assert.equal(Number(row[9]), 8000);   // closing
});

test("not a company copy: refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("getAccountantPackage", { month: ym }));
});

// Testers 2.68.2 (Elena): a starting balance dated the 1st left the month's opening at 0.00, so opening + movements ≠ closing.
test("a starting balance dated the 1st is that month's opening; opening + movements = closing", () => {
  const rt = companyCopy();
  month(rt);
  const b1 = file(rt.api("getAccountantPackage", { month: ym }), "balances").slice(1);
  assert.equal(Number(b1[0][2]), 10000);
  assert.equal(Number(b1[0][2]) - 1200 - 300 + 5000, Number(b1[0][3]));
});

// Testers 2.68.2 (Carlos): a Spanish package showed the stored English names ("Materials", "Cash").
test("a Spanish package names built-in categories and Cash in Spanish", () => {
  const rt = companyCopy();
  const mat = rt.rows("Categories").find((c) => c.key === "materials");
  assert.ok(mat, "the construction sector has Materials");
  const cash = rt.rows("Payment Methods").find((p) => /^(cash|efectivo)$/i.test(String(p.nickname)));
  rt.api("createEntry", { type: "expense", date: day(6), amount: 80, currency: "PEN", category_id: mat.id, description: "Arena", payment_method_id: (cash || rt.rows("Payment Methods")[0]).id, paid_by: "me" });
  const res = rt.rawPost(JSON.stringify({ accessCode: "test-access-code", action: "getAccountantPackage", payload: { month: ym }, lang: "es" }));
  const mv = file(res.data, "movements");
  const row = mv.find((r) => r.includes("Arena"));
  assert.ok(row.includes("Materiales"), row.join(","));
  if (cash) assert.ok(row.includes("Efectivo"), row.join(","));
});

test("the movements file ends with SUNAT's receipt code, the base without IGV and the total", () => {
  const rt = companyCopy();
  month(rt);
  const mv = file(rt.api("getAccountantPackage", { month: ym }), "movements");
  const h = mv[0];
  const row = mv.find((r) => r.includes("F001-123"));
  assert.equal(row[h.length - 3], "01", "factura");
  assert.equal(Number(row[h.length - 1]), 1200);
  assert.equal(Number(row[h.length - 2]), 1200 - (Number(row[h.indexOf("IGV")]) || 0));
});
