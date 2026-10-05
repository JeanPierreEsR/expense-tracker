// Gmail -> pending entries (EmailParser.gs), against the fake Gmail.
// Emails here are made up; the parsing rules are the real ones.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram, bcpEmail, BCP_SENDER } = require("./helpers");

const pendingFromEmail = (rt) => rt.rows("Entries").filter((e) => e.source === "email" && e.status === "pending");
const labeled = (t) => t.labelNames.has("ExpenseTracker-Processed");
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));

test("a bank email becomes a pending entry and its thread is marked processed", () => {
  const { rt } = freshApp({ entries: 300 });
  const before = pendingFromEmail(rt).length;
  const t = bcpEmail(rt, { amount: "25.50", merchant: "Corner Cafe", op: "OP-1" });

  const res = run(rt);

  assert.equal(res.created, 1);
  const created = pendingFromEmail(rt).filter((e) => e.external_id === "OP-1");
  assert.equal(created.length, 1);
  assert.equal(Number(created[0].amount), 25.5);
  assert.equal(created[0].currency, "PEN");
  assert.ok(labeled(t));
  assert.equal(pendingFromEmail(rt).length, before + 1);
});

test("running again does not create the same entry twice", () => {
  const { rt } = freshApp({ entries: 300 });
  bcpEmail(rt, { op: "OP-2" });
  run(rt);
  const n = rt.rows("Entries").length;
  const again = run(rt);
  assert.equal(again.created, 0);
  assert.equal(rt.rows("Entries").length, n);
});

test("an email older than 3 days is not scanned by the normal run", () => {
  const { rt } = freshApp({ entries: 300 });
  bcpEmail(rt, { op: "OP-OLD", daysAgo: 5 });
  assert.equal(run(rt).created, 0);
});

test("an email from a bank sender that matches no rule is skipped quietly", () => {
  const { rt } = freshApp({ entries: 300 });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Conoce nuestras promociones", body: "Hola" });
  const res = run(rt);
  assert.equal(res.created, 0);
  assert.equal(res.unparsed, 0, "marketing is not an 'unreadable bank email'");
});

test("an email the rule matches but cannot read is counted as unparsed (so the owner is told)", () => {
  const { rt } = freshApp({ entries: 300 });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "El banco cambió el formato y ya no hay monto" });
  const res = run(rt);
  assert.equal(res.created, 0);
  assert.equal(res.unparsed, 1);
  assert.equal(res.unparsedSubjects.length, 1);
});

test("the owner gets a Telegram alert about unreadable emails after a scheduled run", () => {
  const { rt } = freshApp({ entries: 300 });
  linkTelegram(rt);
  rt.run("pingWebApp_ = function () {}; pollTelegramUpdates = function () {}; checkBudgets = function () {}; checkOverdueLoans = function () {}; backfillInvestmentCategories_ = function () {}; scanStatementInbox_ = function () {}; retryStatementInboxNudges_ = function () {};");
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "formato nuevo sin monto" });
  rt.run("runAutomation()");
  const sent = rt.svc.fetchLog.map((f) => f.options.payload).join(" ");
  assert.match(sent, /could not be read/);
});

test("if Telegram is down, the entry is still saved, the email is marked done, and the rest of the run continues", () => {
  const { rt } = freshApp({ entries: 300 });
  linkTelegram(rt);
  rt.state.fetchHandler = () => { throw new Error("network down"); };
  const t1 = bcpEmail(rt, { op: "OP-A", merchant: "Cafe A" });
  const t2 = bcpEmail(rt, { op: "OP-B", merchant: "Cafe B" });

  const res = run(rt);

  assert.equal(res.created, 2, "both emails saved despite Telegram failing");
  assert.ok(labeled(t1) && labeled(t2));
});

test("one email that throws does not block the others, and is left unlabeled to retry", () => {
  const { rt } = freshApp({ entries: 300 });
  const bad = bcpEmail(rt, { op: "OP-BAD", merchant: "Explode Inc" });
  const good = bcpEmail(rt, { op: "OP-GOOD", merchant: "Fine Cafe" });
  rt.run(`var __origGuess = guessCategoryForEmail_; guessCategoryForEmail_ = function (f) { if (f.merchant === 'Explode Inc') throw new Error('guess failed'); return __origGuess.apply(null, arguments); };`);

  const res = run(rt);

  assert.equal(res.errors, 1);
  assert.equal(res.created, 1, "the good email was still processed");
  assert.ok(labeled(good));
  assert.ok(!labeled(bad), "the failed email will be retried next run");
});
