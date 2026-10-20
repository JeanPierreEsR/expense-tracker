// Extra e-mail accounts (backend/EmailAccounts.gs): the pairing, the reader's requests, the wrong-account check.
// Made-up addresses and amounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, BCP_SENDER } = require("./helpers");

const URL = "https://script.google.com/macros/s/AKfycbxFAKEFAKEFAKE/exec";
const ADDR = "ana.test@gmail.test";
const reader = (rt, id, code, step, extra = {}) => rt.rawPost(JSON.stringify({ action: "emailReader", payload: { id, code, step, address: ADDR, ...extra } }));
const bcpMessage = (id, op, amount = "31.20") => ({
  id, from: `BCP <${BCP_SENDER}>`, subject: "Realizaste un consumo con tu tarjeta de débito BCP", date: Date.now(),
  body: `Total del consumo: S/ ${amount}\nEmpresa: Corner Cafe\nNúmero de Tarjeta de Débito: ****1234\nNúmero de operación: ${op}`
});
function pair(rt, address = ADDR) {
  const { account, script } = rt.api("addEmailAccount", { address, apiUrl: URL });
  const code = script.match(/var CODE = '([0-9a-f]+)'/)[1];
  return { id: account.id, code, script };
}

test("adding an account gives a reader text with the app address, and the sheet keeps only a hash of the code", () => {
  const { rt } = freshApp({ small: true });
  const { id, code, script } = pair(rt);
  assert.ok(script.includes(URL) && script.includes(id));
  const row = rt.rows("Email Accounts")[0];
  assert.equal(row.address, ADDR);
  assert.notEqual(row.code_hash, code);
  assert.ok(!JSON.stringify(rt.api("listEmailAccounts")).includes(row.code_hash), "the app never sees the hash");
  assert.equal(rt.api("listEmailAccounts").accounts[0].status, "waiting");
});

test("bad address, duplicate and a sixth account are refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("addEmailAccount", { address: "nope", apiUrl: URL }));
  pair(rt);
  assert.throws(() => rt.api("addEmailAccount", { address: ADDR.toUpperCase(), apiUrl: URL }), /already/);
  for (let i = 0; i < 4; i++) pair(rt, `p${i}@gmail.test`);
  assert.throws(() => rt.api("addEmailAccount", { address: "six@gmail.test", apiUrl: URL }), /up to 5/);
});

test("hello connects the account and returns the senders; a wrong code is refused", () => {
  const { rt } = freshApp({ small: true });
  const { id, code } = pair(rt);
  const bad = reader(rt, id, "x".repeat(64), "hello");
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "unknown_account");
  const ok = reader(rt, id, code, "hello");
  assert.equal(ok.ok, true);
  assert.ok(ok.data.senders.includes(BCP_SENDER));
  assert.equal(rt.api("listEmailAccounts").accounts[0].status, "connected");
});

test("a script running in a different account is refused and nothing is imported", () => {
  const { rt } = freshApp({ small: true });
  const { id, code } = pair(rt);
  const before = rt.rows("Entries").length;
  const res = rt.rawPost(JSON.stringify({ action: "emailReader", payload: { id, code, step: "push", address: "other@gmail.test", messages: [bcpMessage("abc123def", "OP1")] } }));
  assert.equal(res.ok, false);
  assert.equal(res.code, "wrong_account");
  assert.equal(rt.rows("Entries").length, before);
  const acct = rt.api("listEmailAccounts").accounts[0];
  assert.equal(acct.status, "wrong_account");
  assert.equal(acct.last_error, "other@gmail.test");
});

test("pushed bank e-mails become pending entries once; a repeat and an unknown sender add nothing", () => {
  const { rt } = freshApp({ small: true });
  const { id, code } = pair(rt);
  const before = rt.rows("Entries").length;
  const msgs = [bcpMessage("abc123def", "OP-77"), { id: "zzz999yyy", from: "promo@shop.test", subject: "Sale", date: Date.now(), body: "50% off" }];
  const first = reader(rt, id, code, "push", { messages: msgs });
  assert.equal(first.ok, true);
  assert.equal(first.data.created, 1);
  const rows = rt.rows("Entries");
  assert.equal(rows.length, before + 1);
  const entry = rows[rows.length - 1];
  assert.equal(entry.status, "pending");
  assert.equal(entry.source, "email");
  assert.equal(Number(entry.amount), 31.2);
  const again = reader(rt, id, code, "push", { messages: msgs });
  assert.equal(again.data.created, 0);
  assert.equal(rt.rows("Entries").length, before + 1);
  // hello now lists the handled e-mail so the reader does not resend its text
  assert.deepEqual(reader(rt, id, code, "hello").data.handled, ["abc123def"]);
});

test("removing an account cuts its reader off", () => {
  const { rt } = freshApp({ small: true });
  const { id, code } = pair(rt);
  rt.api("removeEmailAccount", { id });
  assert.equal(rt.api("listEmailAccounts").accounts.length, 0);
  assert.equal(reader(rt, id, code, "hello").code, "unknown_account");
});

test("without e-mail reading turned on, accounts cannot be added", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  assert.throws(() => rt.api("addEmailAccount", { address: ADDR, apiUrl: URL }), /not turned on/);
});
