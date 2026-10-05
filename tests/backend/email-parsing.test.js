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

// ---- Two owner decisions (2026-10-05) ----------------------------------------------
// 1. Identical same-day purchases whose email has no operation number are BOTH
//    kept (the "possible duplicate" warning flags the pair) instead of one being
//    silently dropped.
// 2. Emails are tracked one by one (not by Gmail conversation), so a new email
//    that Gmail groups into an already-handled conversation is still read.
const entriesFromEmail = (rt) => rt.rows("Entries").filter((e) => e.source === "email");

test("two identical same-day emails with no operation number create two entries, flagged as possible duplicates", () => {
  const { rt } = freshApp({ entries: 300 });
  const before = entriesFromEmail(rt).length;
  bcpEmail(rt, { op: "", merchant: "Twin Cafe", amount: "5.00" });
  bcpEmail(rt, { op: "", merchant: "Twin Cafe", amount: "5.00" });

  const res = run(rt);

  assert.equal(res.created, 2);
  assert.equal(entriesFromEmail(rt).length, before + 2);
  const pending = rt.api("listPendingEntries").filter((e) => e.merchant && /twin cafe/i.test(e.merchant));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((e) => e.twins.length >= 1), "each is flagged as a possible duplicate of the other");
});

test("re-running never doubles those either (each email is its own identity)", () => {
  const { rt } = freshApp({ entries: 300 });
  bcpEmail(rt, { op: "", merchant: "Twin Cafe", amount: "5.00" });
  bcpEmail(rt, { op: "", merchant: "Twin Cafe", amount: "5.00" });
  run(rt);
  const n = rt.rows("Entries").length;
  assert.equal(run(rt).created, 0);
  assert.equal(rt.rows("Entries").length, n);
});

test("a new email Gmail groups into an already-handled conversation is still processed", () => {
  const { rt } = freshApp({ entries: 300 });
  const thread = bcpEmail(rt, { op: "OP-T1", merchant: "Thread Cafe" });
  assert.equal(run(rt).created, 1);
  assert.ok(labeled(thread));

  bcpEmail(rt, { op: "OP-T2", merchant: "Thread Cafe 2", threadWith: thread });   // joins the labeled conversation
  const res = run(rt);

  assert.equal(res.created, 1, "the second email was read, not skipped with its conversation");
  assert.ok(entriesFromEmail(rt).some((e) => e.external_id === "OP-T2"));
});

test("an unreadable email is reported once, not on every 15-minute run", () => {
  const { rt } = freshApp({ entries: 300 });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "formato nuevo sin monto" });
  assert.equal(run(rt).unparsed, 1);
  assert.equal(run(rt).unparsed, 0);
  assert.equal(run(rt).unparsed, 0);
});

test("an email that errored is NOT marked handled, so the next run retries it", () => {
  const { rt } = freshApp({ entries: 300 });
  bcpEmail(rt, { op: "OP-BAD2", merchant: "Explode Inc" });
  bcpEmail(rt, { op: "OP-OK2", merchant: "Fine Cafe" });
  rt.run(`var __origGuess2 = guessCategoryForEmail_; guessCategoryForEmail_ = function (f) { if (f.merchant === 'Explode Inc') throw new Error('guess failed'); return __origGuess2.apply(null, arguments); };`);
  assert.equal(run(rt).errors, 1);
  rt.run("guessCategoryForEmail_ = __origGuess2;");
  const res = run(rt);
  assert.equal(res.created, 1, "the failed one is retried and now succeeds");
  assert.equal(res.errors, 0);
});

test("switching over: emails already handled under the old label scheme are not created again", () => {
  const { rt } = freshApp({ entries: 300 });
  // State the old scheme left behind: a labeled conversation whose email already
  // became an entry under the OLD fallback id, and no per-email memory yet.
  const thread = bcpEmail(rt, { op: "", merchant: "Legacy Cafe", amount: "9.00" });
  const msg = thread.messages[0];
  const dateStr = rt.run(`Utilities.formatDate(new Date(${msg.getDate().getTime()}), Session.getScriptTimeZone(), 'yyyy-MM-dd')`);
  const legacyId = rt.run(`fallbackExternalId_(${JSON.stringify(BCP_SENDER)}, ${JSON.stringify(dateStr)}, 9, 'Legacy Cafe')`);
  rt.run(`appendRowObject('Entries', { id: 'legacy-1', type: 'expense', date: ${JSON.stringify(dateStr)}, amount: 9, currency: 'PEN', category_id: '', description: 'Legacy Cafe', status: 'pending', source: 'email', external_id: ${JSON.stringify(legacyId)}, merchant: 'legacy cafe', created_at: ${JSON.stringify(dateStr + "T10:00:00")} })`);
  thread.addLabel(rt.svc.gmail.api.getUserLabelByName("ExpenseTracker-Processed") || rt.svc.gmail.api.createLabel("ExpenseTracker-Processed"));
  const before = rt.rows("Entries").length;

  const res = run(rt);

  assert.equal(res.created, 0, "no duplicate of the already-created entry");
  assert.equal(rt.rows("Entries").length, before);
  // ...and the conversation is now handled per email, so a NEW email in it is read
  bcpEmail(rt, { op: "OP-NEW", merchant: "After Cutover", threadWith: thread });
  assert.equal(run(rt).created, 1);
});

test("old memory rows are pruned", () => {
  const { rt } = freshApp({ entries: 300 });
  bcpEmail(rt, { op: "OP-P1" });
  run(rt);
  const sheet = rt.sheet("Processed Emails");
  for (let i = 0; i < 400; i++) sheet.rows.push(["old-" + i, "2020-01-01T00:00:00"]);
  run(rt);
  assert.ok(rt.rows("Processed Emails").every((r) => !String(r.message_id).startsWith("old-")));
  assert.ok(rt.rows("Processed Emails").length >= 1, "recent ones are kept");
});
