// Safer back-checks (overlap with older entries) and the coverage report (EmailCoverage.gs). All e-mails and entries are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, bcpEmail, BCP_SENDER } = require("./helpers");

const json = (x) => JSON.parse(JSON.stringify(x));
const addEntry = (rt, { amount, source = "manual", date = today(), currency = "PEN", type = "expense", id }) =>
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: id || "e-" + Math.random(), type, date, amount, currency, status: "confirmed", source, description: "typed by hand", payment_method_id: "", paid_by: "me", category_id: "" })})`);
const emailEntries = (rt) => rt.rows("Entries").filter((e) => e.source === "email");

test("a back-check lists an e-mail that matches a hand-typed entry instead of creating a second one", () => {
  const { rt } = freshApp({ small: true });
  addEntry(rt, { amount: 31.25 });
  bcpEmail(rt, { amount: "31.25", merchant: "Corner Cafe", op: "OVL-1" });
  bcpEmail(rt, { amount: "77.10", merchant: "Other Shop", op: "OVL-2" });

  const res = json(rt.run("processEmails({ days: 30 })"));

  assert.equal(res.created, 1, "only the e-mail with no twin is created");
  assert.equal(res.overlaps, 1);
  assert.equal(res.mayAlreadyBeIn.length, 1);
  assert.equal(res.mayAlreadyBeIn[0].amount, 31.25);
  assert.match(res.mayAlreadyBeIn[0].matches, /manual/);
  assert.deepEqual(emailEntries(rt).map((e) => e.external_id).filter((x) => x.startsWith("OVL")), ["OVL-2"]);
});

test("one existing entry covers only one e-mail, so repeated same-amount e-mails are not swallowed", () => {
  const { rt } = freshApp({ small: true });
  addEntry(rt, { amount: 140, source: "import" });
  bcpEmail(rt, { amount: "140.00", op: "REP-1" });
  bcpEmail(rt, { amount: "140.00", op: "REP-2" });
  bcpEmail(rt, { amount: "140.00", op: "REP-3" });

  const res = json(rt.run("processEmails({ days: 30 })"));

  assert.equal(res.overlaps, 1);
  assert.equal(res.created, 2);
});

test("entries that came from e-mail never count as twins, and includeOverlaps turns the check off", () => {
  const { rt } = freshApp({ small: true });
  addEntry(rt, { amount: 15.9, source: "email" });
  bcpEmail(rt, { amount: "15.90", op: "EML-1" });
  assert.equal(json(rt.run("processEmails({ days: 30 })")).created, 1, "an e-mail-sourced entry is not a twin");

  const second = freshApp({ small: true }).rt;
  addEntry(second, { amount: 9.5 });
  bcpEmail(second, { amount: "9.50", op: "FORCE-1" });
  const res = json(second.run("processEmails({ days: 30, includeOverlaps: true })"));
  assert.equal(res.created, 1);
  assert.equal(res.overlaps, undefined);
});

test("the normal 3-day run is unchanged: it still creates the entry and reports no overlaps", () => {
  const { rt } = freshApp({ small: true });
  addEntry(rt, { amount: 12.3 });
  bcpEmail(rt, { amount: "12.30", op: "NORM-1" });
  const res = json(rt.run("processEmails()"));
  assert.equal(res.created, 1);
  assert.equal(res.mayAlreadyBeIn, undefined);
});

test("coverage report: parsed, covered elsewhere, missing, no rule, and unknown senders", () => {
  const { rt } = freshApp({ small: true });
  // parsed: processed by the normal run
  bcpEmail(rt, { amount: "10.00", op: "COV-1" });
  rt.run("processEmails()");
  // covered elsewhere: a hand-typed twin, never processed
  addEntry(rt, { amount: 20 });
  bcpEmail(rt, { amount: "20.00", op: "COV-2" });
  // missing: a readable e-mail with no entry at all
  bcpEmail(rt, { amount: "30.00", op: "COV-3" });
  // no rule but looks like a payment, and one that does not
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Constancia de algo nuevo", body: "Operación realizada por S/ 55.00 pago" });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Tu código de seguridad", body: "Tu código es 1234" });
  // a sender nobody wrote a rule for
  rt.svc.gmail.addEmail({ from: "Shop <orders@shop.example>", subject: "Recibiste tu pedido", body: "Total del pago: S/ 45.00" });
  rt.svc.gmail.addEmail({ from: "News <hello@news.example>", subject: "Our week", body: "No prices here" });

  const report = json(rt.run("emailCoverageReport_({ days: 30 })"));
  const bcp = report.senders.find((s) => s.sender === BCP_SENDER);

  assert.equal(bcp.parsed, 1);
  assert.equal(bcp.coveredElsewhere, 1);
  assert.equal(bcp.missing.length, 1);
  assert.equal(bcp.missing[0].amount, 30);
  assert.equal(bcp.noRule.length, 1);
  assert.match(bcp.noRule[0].shape, /constancia de algo nuevo/);
  assert.equal(bcp.notTransaction, 1);
  assert.deepEqual(report.unknownSenders.map((u) => u.sender), ["orders@shop.example"]);
  assert.equal(report.totals.missing, 1);
});

test("coverage report is read-only", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "44.00", op: "RO-1" });
  const before = rt.rows("Entries").length;
  rt.run("emailCoverageReport_({ days: 30 })");
  assert.equal(rt.rows("Entries").length, before);
});
