// First-use practice "Bank statements": the phone adds an empty "Practice account", builds a made-up bank-style CSV for it (StatementTable.practiceFile
// kind 'bank') and runs the REAL read / preview / save / Undo. Server pieces: createPracticeBankAccount and removePracticeBank (the Import cleanup plus
// deleting the practice account when the phone made it). A real account is never deleted. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");
const ST = require("../../docs/statement-table.js");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const api = (rt, name, payload) => rt.api(name, payload);
const accounts = (rt) => run(rt, "getAllRows('Payment Methods').map(function (p) { return { id: p.id, nickname: p.nickname }; })");
const practiceAccounts = (rt) => run(rt, "getAllRows('Payment Methods').filter(isPracticeAccount_).map(function (p) { return p.id; })");

function bankStatement(lang, accountId) {
  const f = ST.practiceFile(lang, today(), "bank");
  const lines = f.text.trim().split("\n").slice(1).map((l) => { const [date, description, amount] = l.split(","); return { date, description, amount: Number(amount), currency: "PEN" }; });
  return { key: "ACCT-" + accountId, kind: "csv", source: "", holder: "", verified: false, balances: {}, file_name: f.name,
    period: { start: lines[lines.length - 1].date, end: lines[0].date }, lines };
}
function saveIt(rt, st) {
  const plan = api(rt, "planStatementHistory", { statements: [st] });
  return api(rt, "applyStatementDecisions", { dryRun: false, filename: st.file_name, statements: [st], categoryMap: {}, categoryNames: {}, actions: plan.actions });
}
const batchEntries = (rt, id) => run(rt, `getAllRows('Entries').filter(function (e) { return e.import_batch_id === ${JSON.stringify(id)}; })`);

test("capability: a backend that can run the Bank statements practice says so", () => {
  assert.equal(freshApp({ small: true }).rt.api("getMeta").capabilities.practiceBank, true);
});

test("the made-up statement is read the way the screen needs, in both languages: three expenses, no category, never mistaken for an app's export", async () => {
  for (const lang of ["en", "es"]) {
    const f = ST.practiceFile(lang, "2026-03-02", "bank");
    const rows = await ST.readTable(new TextEncoder().encode(f.text), f.name);
    const g = ST.guessMapping(rows, {});
    assert.deepEqual([g.date, g.description, g.amount, g.category, g.sign], [0, 1, 2, -1, "negative"], lang);
    assert.equal(ST.recognize(g.headers), null);
    const out = ST.applyMapping(rows, g);
    assert.equal(out.lines.length, 3);
    assert.ok(out.lines.every((l) => l.amount < 0));
    assert.ok(ST.PRACTICE_FILE_NAMES.includes(f.name));
    assert.match(ST.signature(g, rows), /practice file|archivo de practica/);
    assert.notEqual(ST.practiceFile(lang, "2026-03-02", "bank").name, ST.practiceFile(lang, "2026-03-02").name, "a different file from the Import practice's");
  }
});

test("createPracticeBankAccount adds an empty debit account called Practice account / Cuenta de práctica, and never a second one", () => {
  for (const [lang, name] of [["en", "Practice account"], ["es", "Cuenta de práctica"]]) {
    const { rt } = freshApp({ small: true });
    const before = accounts(rt).length;
    const a = api(rt, "createPracticeBankAccount", { lang });
    assert.equal(a.existed, false);
    const pm = run(rt, `getAllRows('Payment Methods').find(function (p) { return p.id === ${JSON.stringify(a.id)}; })`);
    assert.equal(pm.nickname, name);
    assert.equal(pm.type, "debit");
    assert.equal(String(pm.bank_id || ""), "");
    assert.equal(String(pm.last_4 || ""), "");
    assert.equal(accounts(rt).length, before + 1);
    const again = api(rt, "createPracticeBankAccount", { lang });
    assert.equal(again.existed, true);
    assert.equal(again.id, a.id);
    assert.equal(accounts(rt).length, before + 1, "nothing new was made");
  }
});

test("the real save puts three entries on the practice account with no category, named as the cleanup expects, and Undo takes them back", () => {
  for (const lang of ["en", "es"]) {
    const { rt } = freshApp({ small: true });
    const a = api(rt, "createPracticeBankAccount", { lang });
    const before = run(rt, "getAllRows('Entries').length");
    const saved = saveIt(rt, bankStatement(lang, a.id));
    const rows = batchEntries(rt, saved.batchId);
    assert.equal(rows.length, 3, lang);
    for (const e of rows) {
      assert.equal(e.payment_method_id, a.id);
      assert.equal(String(e.category_id || ""), "");
      assert.equal(run(rt, `isPracticeEntry_({description: ${JSON.stringify(e.description)}})`), true, e.description);
    }
    api(rt, "undoStatementBatch", { batchId: saved.batchId });
    assert.equal(run(rt, "getAllRows('Entries').length"), before);
  }
});

test("removePracticeBank after an Exit with the statement saved: the batch is undone, the layout forgotten and the practice account deleted", () => {
  const { rt } = freshApp({ small: true });
  const accountsBefore = accounts(rt).length;
  const entriesBefore = run(rt, "getAllRows('Entries').length");
  const a = api(rt, "createPracticeBankAccount", { lang: "en" });
  saveIt(rt, bankStatement("en", a.id));
  api(rt, "saveStatementFormat", { signature: "date|description|amount|practice file", label: "", mapping: { date: 0 }, accounts: { "*": a.id }, categories: {} });
  const out = api(rt, "removePracticeBank", { signature: "date|description|amount|practice file", account: true });
  assert.equal(out.batches, 1);
  assert.equal(out.entries, 3);
  assert.equal(out.layouts, 1);
  assert.equal(out.accounts, 1);
  assert.equal(run(rt, "getAllRows('Entries').length"), entriesBefore);
  assert.equal(accounts(rt).length, accountsBefore);
  assert.equal(api(rt, "getStatementFormat", { signature: "date|description|amount|practice file" }).found, false);
});

test("removePracticeBank without the account flag leaves an account the phone did not make", () => {
  const { rt } = freshApp({ small: true });
  const a = api(rt, "createPracticeBankAccount", { lang: "en" });
  const out = api(rt, "removePracticeBank", { signature: "", account: false });
  assert.equal(out.accounts, 0);
  assert.deepEqual(practiceAccounts(rt), [a.id]);
});

test("removePracticeBank never touches a real account or a real statement upload", () => {
  const { rt } = freshApp({ small: true });
  const real = accounts(rt).find((p) => !/practice|práctica/i.test(p.nickname));
  const st = { key: "ACCT-" + real.id, kind: "csv", source: "", holder: "", verified: false, balances: {}, file_name: "real.csv",
    period: { start: "2019-03-05", end: "2019-03-06" }, lines: [
      { date: "2019-03-05", description: "Bodega la Esquina", amount: -23.47, currency: "PEN" },
      { date: "2019-03-06", description: "Farmacia Sur", amount: -40.1, currency: "PEN" }] };
  const saved = saveIt(rt, st);
  const n = batchEntries(rt, saved.batchId).length;
  assert.ok(n > 0);
  const a = api(rt, "createPracticeBankAccount", { lang: "en" });
  const out = api(rt, "removePracticeBank", { signature: "", account: true });
  assert.equal(out.accounts, 1);
  assert.equal(batchEntries(rt, saved.batchId).length, n, "the real statement is still there");
  assert.ok(accounts(rt).some((p) => p.id === real.id), "the real account is still there");
  assert.ok(!accounts(rt).some((p) => p.id === a.id));
});
