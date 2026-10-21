// "Your bank is ready": the backend says which sender addresses it reads (backend/BankSamples.gs listSupportedSenders), and the phone
// (docs/bank-sample.js) remembers the addresses it sent samples for and tells the person once when one is covered.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");
const BankSample = require("../../docs/bank-sample.js");

const call = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));

test("the backend lists each readable sender once, with its bank, and leaves out addresses that only have 'ignore' rules", () => {
  const { rt } = freshApp({ small: true });
  const res = call(rt, "listSupportedSenders");
  assert.equal(res.ok, true);
  const list = res.data;
  assert.ok(list.length >= 5);
  assert.equal(new Set(list.map((r) => r.sender)).size, list.length, "no address twice");
  assert.ok(list.every((r) => /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(r.sender) && r.bank));
  assert.deepEqual(list.find((r) => r.sender === "notificaciones@interbank.pe"), { sender: "notificaciones@interbank.pe", bank: "Interbank" });
  // every address with at least one working rule is there; an address with only skip rules is not
  const onlySkip = rt.run(`(function () {
    var by = {}; EMAIL_RULES.forEach(function (r) { var k = String(r.sender).toLowerCase(); by[k] = by[k] || { skip: 0, rule: 0 }; (r.skip ? by[k].skip++ : by[k].rule++); });
    return Object.keys(by).filter(function (k) { return by[k].rule === 0; });
  })()`);
  for (const s of onlySkip) assert.ok(!list.some((r) => r.sender === s), s);
  assert.ok(list.length + onlySkip.length >= 5);
});

test("it needs a sign-in, and a copy tells the app it can answer the question", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.rawPost(JSON.stringify({ action: "listSupportedSenders", payload: {} })).ok, false);
  assert.equal(call(rt, "getMeta").data.capabilities.bankReady, true);
});

const supported = [{ sender: "notificaciones@interbank.pe", bank: "Interbank" }, { sender: "notificaciones@yape.pe", bank: "Yape" }, { sender: "no_reply@email.apple.com", bank: "Interbank" }];

test("the phone remembers the address of each sample it sent, once, newest last, at most 20", () => {
  let list = [];
  list = BankSample.rememberSender(list, "Alerts <alerts@newbank.pe>", 1);
  list = BankSample.rememberSender(list, "alerts@newbank.pe", 2);
  assert.deepEqual(list, [{ s: "alerts@newbank.pe", at: 2, told: false }]);
  list = BankSample.rememberSender(list, "not an address", 3);
  assert.equal(list.length, 1);
  for (let i = 0; i < 30; i++) list = BankSample.rememberSender(list, `a${i}@b${i}.pe`, 10 + i);
  assert.equal(list.length, 20);
  assert.equal(list[19].s, "a29@b29.pe");
});

test("a covered address is reported with its bank, once per bank; an uncovered one keeps waiting", () => {
  let list = [];
  ["notificaciones@interbank.pe", "no_reply@email.apple.com", "alerts@newbank.pe"].forEach((s, i) => { list = BankSample.rememberSender(list, s, i); });
  const ready = BankSample.readyBanks(list, supported);
  assert.deepEqual(ready.senders, ["notificaciones@interbank.pe", "no_reply@email.apple.com"]);
  assert.deepEqual(ready.banks, ["Interbank"], "one bank named once, even though two addresses matched");
  list = BankSample.markTold(list, ready.senders);
  assert.deepEqual(BankSample.pending(list).map((e) => e.s), ["alerts@newbank.pe"], "told once, then only the bank still waiting is pending");
  assert.deepEqual(BankSample.readyBanks(list, supported).senders, []);
});

test("an older backend's answer, junk, or no list at all never breaks it and never tells anyone anything", () => {
  const list = BankSample.rememberSender([], "alerts@newbank.pe", 1);
  for (const bad of [undefined, null, "x", {}, [null, 5, { sender: 7 }]]) assert.deepEqual(BankSample.readyBanks(list, bad), { senders: [], banks: [] });
  assert.deepEqual(BankSample.readyBanks(undefined, supported), { senders: [], banks: [] });
  assert.deepEqual(BankSample.pending(null), []);
});

test("sending another sample for an address that was already told about waits again (the new e-mail kind may still be missing)", () => {
  let list = BankSample.rememberSender([], "notificaciones@interbank.pe", 1);
  list = BankSample.markTold(list, ["notificaciones@interbank.pe"]);
  assert.equal(BankSample.pending(list).length, 0);
  list = BankSample.rememberSender(list, "notificaciones@interbank.pe", 2);
  assert.equal(BankSample.pending(list).length, 1);
});

test("the app asks only a backend that says it can answer, never the owner's copy, and the pop-up exists in both languages", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(app, /caps\.bankReady !== true \|\| perfIsOwnerCopy_\(\)/);
  assert.match(app, /bankSentSave_\(BankSample\.rememberSender\(bankSentList_\(\), bs_\.sender/);
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");
  for (const id of ["bank-ready-backdrop", "bank-ready-body", "bank-ready-mail", "bank-ready-ok"]) assert.ok(html.includes(`id="${id}"`), id);
  const strings = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "strings.js"), "utf8");
  for (const k of ["bankReady.title", "bankReady.body", "bankReady.yourBank", "bankReady.needAccount", "bankReady.needMail", "bankReady.ok"]) {
    assert.ok(new RegExp(`"${k}": \\{ en: ".+", es: ".+" \\}`).test(strings), k);
  }
});
