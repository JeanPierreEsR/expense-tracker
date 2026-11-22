// More → Accounts → Edit (owner's request 2026-11-03): several accounts at once, each by the single Delete's rule, never throwing for one. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
const addEntry = (rt, id, extra) => rt.run(`appendRowObject('Entries', Object.assign({ id: ${JSON.stringify(id)}, type: 'expense', date: '2026-01-05', amount: 10, currency: 'PEN', category_id: '', description: 'x', paid_by: 'me', status: 'confirmed', source: 'manual' }, ${JSON.stringify(extra)}));`);
const mk = (rt, nickname, type = "debit") => { const r = post(rt, "savePaymentMethod", { nickname, type }); assert.equal(r.ok, true, JSON.stringify(r)); return r.data.id; };

function setup() {
  const { rt } = freshApp({ entries: 10 });
  post(rt, "getMeta");
  const cash = rt.run("cashAccountId_()");
  const ids = { free1: mk(rt, "Demo Free 1"), free2: mk(rt, "Demo Free 2"), used: mk(rt, "Demo Used"), wallet: mk(rt, "Demo Wallet", "wallet"), viaTo: mk(rt, "Demo Receives"), already: mk(rt, "Demo Already hidden"), cash };
  post(rt, "setPaymentMethodOpeningBalance", { id: ids.free1, balances: [{ currency: "PEN", amount: 50, date: "2026-01-01" }] });
  post(rt, "setPaymentMethodOpeningBalance", { id: ids.used, balances: [{ currency: "PEN", amount: 80, date: "2026-01-01" }] });
  addEntry(rt, "demo-e1", { payment_method_id: ids.used });
  addEntry(rt, "demo-e2", { type: "transfer", payment_method_id: ids.used, to_payment_method_id: ids.viaTo });
  addEntry(rt, "demo-e3", { payment_method_id: ids.already });
  post(rt, "setPaymentMethodHidden", { id: ids.already, hidden: true });
  rt.run(`setSetting_('yape_pen', ${JSON.stringify(ids.wallet)});`);
  return { rt, ids };
}

test("the backend says it can delete accounts in bulk", () => {
  assert.equal(post(freshApp({ entries: 5 }).rt, "getMeta").data.capabilities.pmBulkRemove, true);
});

test("each account gets the single Delete's rule: unused deleted, with history hidden, Cash / wallet-linked / already hidden / missing kept", () => {
  const { rt, ids } = setup();
  const before = rt.rows("Entries").length;
  const res = post(rt, "removePaymentMethods", { ids: [ids.free1, ids.free2, ids.used, ids.viaTo, ids.cash, ids.wallet, ids.already, "gone-1", ids.free1] });
  assert.equal(res.ok, true, JSON.stringify(res));
  const d = res.data;
  assert.deepEqual(d.deleted.map((x) => x.id).sort(), [ids.free1, ids.free2].sort(), "unused ones are deleted (a repeated id counts once)");
  assert.deepEqual(d.deleted.map((x) => x.name).sort(), ["Demo Free 1", "Demo Free 2"]);
  assert.deepEqual(d.hidden.map((x) => x.id).sort(), [ids.used, ids.viaTo].sort(), "one used as sender, one only as the receiving end of a transfer: both have history");
  assert.equal(d.hidden.find((x) => x.id === ids.used).used, 2, "an entry as sender + the transfer");
  const reasons = Object.fromEntries(d.kept.map((k) => [k.id, k.reason]));
  assert.equal(reasons[ids.cash], "cash");
  assert.equal(reasons[ids.wallet], "rail");
  assert.equal(reasons[ids.already], "hiddenAlready");
  assert.equal(reasons["gone-1"], "missing");
  const pms = rt.rows("Payment Methods");
  assert.ok(!pms.some((p) => p.id === ids.free1 || p.id === ids.free2), "the two unused rows are gone");
  assert.equal(pms.find((p) => p.id === ids.used).hidden, "yes");
  assert.equal(pms.find((p) => p.id === ids.viaTo).hidden, "yes");
  assert.ok(!pms.find((p) => p.id === ids.cash).hidden);
  assert.ok(!pms.find((p) => p.id === ids.wallet).hidden, "a wallet linked to Yape stays visible");
  assert.equal(rt.rows("Entries").length, before, "no entry is touched");
});

test("starting balances go with a deleted account only; a hidden one keeps its balance", () => {
  const { rt, ids } = setup();
  post(rt, "removePaymentMethods", { ids: [ids.free1, ids.used] });
  const bal = rt.rows("Account Opening Balances");
  assert.ok(!bal.some((r) => r.payment_method_id === ids.free1));
  assert.ok(bal.some((r) => r.payment_method_id === ids.used), "its starting balance stays: hiding changes no balance");
});

test("an empty or missing list does nothing", () => {
  const { rt } = setup();
  const n = rt.rows("Payment Methods").length;
  assert.deepEqual(post(rt, "removePaymentMethods", { ids: [] }).data, { deleted: [], hidden: [], kept: [] });
  assert.deepEqual(post(rt, "removePaymentMethods", {}).data, { deleted: [], hidden: [], kept: [] });
  assert.equal(rt.rows("Payment Methods").length, n);
});

test("the screen: pencil beside +, a fixed bar with Done, Cash can't be ticked, one question per batch, names in the result, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  assert.match(html, /id="accounts-edit-btn"[^>]*class="icon-btn"|class="icon-btn" id="accounts-edit-btn"/);
  assert.match(html, /id="accounts-editbar"/);
  assert.match(html, /id="accounts-done-btn"/);
  assert.match(app, /callApi\("removePaymentMethods", \{ ids \}\)/);
  assert.match(app, /busy: "common\.deletingToast"/);
  assert.match(app, /name !== "accounts" && accountsEditing_/, "leaving the screen ends Edit mode");
  assert.match(app, /const isCash = isBasicCashPm_\(pm\)/);
  for (const key of ["accounts.confirmDeleteMany", "accounts.resultDeleted", "accounts.resultHidden", "accounts.resultRail", "accounts.resultHiddenAlready", "accounts.resultKept"]) {
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), key);
  }
});
