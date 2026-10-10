// More → Export data: the server builds an entries CSV and/or a full-backup
// JSON and emails them to the owner (backend/Export.gs). Made-up data only;
// the mail service is the fake one, which records what would have been sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const OWNER = "owner@example.com"; // made-up
function ready(opts) {
  const app = freshApp(opts);
  app.rt.api("admin_setExportEmail", { email: OWNER });
  return app;
}
const mails = (rt) => rt.svc.mailLog;
const attachment = (mail, prefix) => mail.attachments.find((b) => b.name.startsWith(prefix));

// Minimal CSV reader for the tests (handles quotes and doubled quotes).
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  return rows;
}
const csvRows = (blob) => {
  const [head, ...body] = parseCsv(blob.data.replace(/^﻿/, ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

test("both files in one email, addressed to the saved owner address", () => {
  const { rt } = ready();
  const res = rt.api("exportData", { cards: ["entries", "backup"] });
  assert.equal(res.sent, true);
  assert.equal(mails(rt).length, 1, "one email, not one per file");
  const mail = mails(rt)[0];
  assert.equal(mail.to, OWNER);
  assert.equal(mail.attachments.length, 2);
  assert.ok(attachment(mail, "entries_all-time"));
  assert.ok(attachment(mail, "backup_"));
});

test("either card alone sends only that file", () => {
  const { rt } = ready();
  rt.api("exportData", { cards: ["entries"] });
  rt.api("exportData", { cards: ["backup"] });
  assert.equal(mails(rt)[0].attachments.length, 1);
  assert.ok(attachment(mails(rt)[0], "entries_"));
  assert.equal(mails(rt)[1].attachments.length, 1);
  assert.ok(attachment(mails(rt)[1], "backup_"));
});

test("nothing chosen, or no address saved, sends nothing", () => {
  const { rt } = ready();
  assert.throws(() => rt.api("exportData", { cards: [] }), /at least one/);
  const fresh = freshApp();
  assert.throws(() => fresh.rt.api("exportData", { cards: ["backup"] }), /No export email address/);
  assert.equal(mails(rt).length + mails(fresh.rt).length, 0);
});

test("the destination can never come from the request", () => {
  const { rt } = ready();
  rt.api("exportData", { cards: ["backup"], to: "attacker@example.com", email: "attacker@example.com" });
  assert.equal(mails(rt)[0].to, OWNER);
});

test("saving the address rejects things that are not one address", () => {
  const { rt } = freshApp();
  for (const bad of ["", "nope", "a@b", "a@b.com, c@d.com", "a b@c.com"]) {
    assert.throws(() => rt.api("admin_setExportEmail", { email: bad }), /does not look like/, bad);
  }
});

test("a resend with the same request id does not email twice", () => {
  const { rt } = ready();
  rt.api("exportData", { cards: ["backup"], _requestId: "req-1" });
  rt.api("exportData", { cards: ["backup"], _requestId: "req-1" });
  assert.equal(mails(rt).length, 1);
});

test("entries CSV: confirmed only by default, pending when asked, one row per entry", () => {
  const { rt, data } = ready();
  const cat = data.cats.find((c) => c.type === "expense");
  rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: cat.id,
    description: "A pending one", paid_by: "me", payment_method_id: data.pms[3].id, status: "pending" });
  const all = rt.rows("Entries");
  const confirmed = all.filter((e) => e.status === "confirmed").length;
  const pending = all.filter((e) => e.status === "pending").length;
  assert.ok(pending >= 1);

  rt.api("exportData", { cards: ["entries"] });
  rt.api("exportData", { cards: ["entries"], includePending: true });
  const [plain, withPending] = mails(rt).map((m) => csvRows(attachment(m, "entries_")));
  assert.equal(plain.length, confirmed);
  assert.equal(withPending.length, confirmed + pending);
  assert.ok(!plain.some((r) => r.Status === "pending"));
  assert.equal(new Set(withPending.map((r) => r.ID)).size, withPending.length, "no entry twice");
});

test("entries CSV: date range is inclusive and the file name says which", () => {
  const { rt } = ready();
  const dates = rt.rows("Entries").filter((e) => e.status === "confirmed").map((e) => e.date).sort();
  const start = dates[Math.floor(dates.length * 0.4)], end = dates[Math.floor(dates.length * 0.6)];
  rt.api("exportData", { cards: ["entries"], startDate: start, endDate: end });
  const blob = attachment(mails(rt)[0], "entries_");
  assert.equal(blob.name, `entries_${start}_to_${end}.csv`);
  const rows = csvRows(blob);
  assert.equal(rows.length, dates.filter((d) => d >= start && d <= end).length);
  assert.ok(rows.every((r) => r.Date >= start && r.Date <= end));
  assert.ok(rows.map((r) => r.Date).every((d, i, a) => i === 0 || a[i - 1] <= d), "oldest first");

  assert.throws(() => rt.api("exportData", { cards: ["entries"], startDate: "2026-02-01", endDate: "2026-01-01" }), /after the end/);
  assert.throws(() => rt.api("exportData", { cards: ["entries"], startDate: "01/02/2026" }), /Dates must look like/);
});

test("entries CSV: PEN value comes from the rate table, share excludes what was split off", () => {
  const { rt, data } = ready();
  const month = today().slice(0, 7);
  rt.api("setExchangeRate", { currency: "USD", month, rate: 3.75 });
  const friend = rt.api("addFriend", { name: "Export Friend" });
  const cat = data.cats.find((c) => c.type === "expense");
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 100, currency: "USD", category_id: cat.id,
    description: "Dinner in USD", paid_by: "me", payment_method_id: data.pms[3].id });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: friend.id, amount: 40 }] });

  rt.api("exportData", { cards: ["entries"], startDate: today(), endDate: today() });
  const row = csvRows(attachment(mails(rt)[0], "entries_")).find((r) => r.ID === e.id);
  assert.equal(row.Amount, "100");
  assert.equal(row.Currency, "USD");
  assert.equal(row["Amount (PEN)"], "375.00");
  assert.equal(row["Your share"], "60.00");
  assert.equal(row["Your share (PEN)"], "225.00");
  assert.equal(row["Split with"], "Export Friend 40.00");
  assert.equal(row["Payment method"], data.pms[3].nickname);
  const catRows = rt.rows("Categories");
  const parent = catRows.find((c) => c.id === cat.parent_id);
  assert.equal(row.Category, parent ? `${parent.name} › ${cat.name}` : cat.name);
});

test("entries CSV: a repayment / cash loan row names the friend", () => {
  const { rt, data } = ready();
  const friend = rt.api("addFriend", { name: "Debt Friend" });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: today(), payment_method_id: data.pms[3].id });
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 20, date: today(), currency: "PEN", payment_method_id: data.pms[3].id });
  rt.api("exportData", { cards: ["entries"], startDate: today(), endDate: today() });
  const linked = csvRows(attachment(mails(rt)[0], "entries_")).filter((r) => r["Linked friend"] === "Debt Friend");
  assert.deepEqual(linked.map((r) => r["Linked as"]).sort(), ["Loan (they owe me)", "Repayment (they owe me)"]);
});

test("entries CSV: commas, quotes and line breaks survive; formula-looking text is neutralised; amounts stay numbers", () => {
  const { rt, data } = ready();
  const cat = data.cats.find((c) => c.type === "expense");
  const mk = (description, amount = 12.5) => rt.api("createEntry", { type: "expense", date: today(), amount, currency: "PEN",
    category_id: cat.id, description, paid_by: "me", payment_method_id: data.pms[3].id });
  const a = mk('Lunch, "special"\nsecond line');
  const b = mk('=HYPERLINK("http://example.com","click")');
  const c = mk("-5 refund");
  rt.api("exportData", { cards: ["entries"], startDate: today(), endDate: today() });
  const rows = csvRows(attachment(mails(rt)[0], "entries_"));
  const byId = (id) => rows.find((r) => r.ID === id);
  assert.equal(byId(a.id).Description, 'Lunch, "special"\nsecond line');
  assert.equal(byId(b.id).Description, `'=HYPERLINK("http://example.com","click")`);
  assert.equal(byId(c.id).Description, "'-5 refund");
  assert.equal(byId(a.id).Amount, "12.5");
  assert.ok(attachment(mails(rt)[0], "entries_").data.startsWith("﻿"), "UTF-8 marker for Excel");
});

test("backup: every data tab, nothing sensitive", () => {
  const { rt } = ready();
  rt.api("exportData", { cards: ["backup"] });
  const backup = JSON.parse(attachment(mails(rt)[0], "backup_").data);
  assert.ok(backup.exported_at);
  for (const name of ["Entries", "Entry Splits", "Categories", "Payment Methods", "Friends", "Loans", "Settlements", "Budgets", "Exchange Rates"]) {
    assert.ok(Array.isArray(backup.tables[name]), name + " missing");
  }
  assert.equal(backup.tables.Entries.length, rt.rows("Entries").length, "all statuses, raw");
  for (const name of ["Sessions", "Settings", "Telegram Messages", "Processed Emails", "Budget Alert Log", "Loan Alert Log"]) {
    assert.ok(!(name in backup.tables), name + " must not be exported");
  }
  assert.ok(!JSON.stringify(backup).includes("token_hash"));
  assert.ok(!JSON.stringify(backup).includes("test-access-code"));
});

test("a daily-email-limit stop is a clear message, not a crash", () => {
  const { rt } = ready();
  rt.state.mailQuota = 0;
  assert.throws(() => rt.api("exportData", { cards: ["backup"] }), /daily email limit/);
  assert.equal(mails(rt).length, 0);
});
