// Apple Pay capture (ApplePay.gs): the iPhone's shortcut posts a payment with the person's own key in the link; it lands in Needs
// review, learns which account a Wallet card is, reads the amount the way iOS writes it, and joins the bank's e-mail for the same purchase.
// All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const key = (rt) => rt.api("makeApplePayKey").key;
const pay = (rt, k, body) => {
  rt.ctx.__k = k;
  rt.ctx.__body = JSON.stringify(body);
  return JSON.parse(rt.run("doPost({ parameter: { k: __k }, postData: { contents: __body } }).getContent()"));
};
// A BCP debit card ending 1234, the digits bcpEmail's made-up e-mails carry.
const addBcpCard = (rt) => rt.run(`(function () { var b = getAllRows('Banks').find(function (x) { return x.name === 'BCP'; });
  var pm = { id: 'pm-ap-test', nickname: 'Test BCP debit', type: 'debit', bank_id: b.id, last_4: '1234' };
  appendRowObject('Payment Methods', pm); return pm.id; })()`);
const shortcutRows = (rt) => rt.rows("Entries").filter((e) => e.source === "shortcut");

test("reading the amount the way iOS writes it", () => {
  const { rt } = freshApp({ small: true });
  const num = (t) => rt.run(`applePayNumber_(${JSON.stringify(t)})`);
  assert.equal(num("S/ 12.50"), 12.5);
  assert.equal(num("1,234.56 US$"), 1234.56);
  assert.equal(num("1.234,56 €"), 1234.56);
  assert.equal(num("4,99 €"), 4.99);
  assert.equal(num("$1,234"), 1234);
  assert.equal(num("S/ 1 234,50"), 1234.5);
  assert.ok(Number.isNaN(num("free")));
  const cur = (t, own = [], home = "PEN") => JSON.parse(JSON.stringify(rt.run(`applePayCurrency_(${JSON.stringify(t)}, ${JSON.stringify(own)}, ${JSON.stringify(home)})`)));
  assert.deepEqual(cur("S/ 12.50"), { currency: "PEN", sure: true });
  assert.deepEqual(cur("US$ 4.99"), { currency: "USD", sure: true });
  assert.deepEqual(cur("PEN 4.99"), { currency: "PEN", sure: true });
  assert.deepEqual(cur("100 €"), { currency: "EUR", sure: true });
  assert.deepEqual(cur("R$ 20,00"), { currency: "BRL", sure: true });
  // A bare "$": the card's only currency, else a "$" main currency, else US dollars.
  assert.deepEqual(cur("$4.99", ["PEN"]), { currency: "PEN", sure: true });
  assert.deepEqual(cur("$4.99", [], "MXN"), { currency: "MXN", sure: true });
  assert.deepEqual(cur("$4.99", ["PEN", "USD"], "PEN"), { currency: "USD", sure: true });
  // No sign: the person checks it.
  assert.deepEqual(cur("12.50"), { currency: "PEN", sure: false });
});

test("only the right key gets in, and it can only add a waiting entry", () => {
  const { rt } = freshApp({ small: true });
  const before = rt.rows("Entries").length;
  const wrong = pay(rt, "not-the-key", { amount: "S/ 10.00", merchant: "Corner Bakery", card: "Test Visa" });
  assert.equal(wrong.ok, false);
  assert.equal(rt.rows("Entries").length, before);
  // No key made yet: nothing gets in either (an empty key must never match).
  assert.equal(pay(rt, "", { amount: "S/ 10.00" }).ok, false);

  const k = key(rt);
  const res = pay(rt, k, { amount: "S/ 10.00", merchant: "Corner Bakery", card: "Test Visa" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.data.message, /PEN 10\.00 at Corner Bakery/);
  const [e] = shortcutRows(rt);
  assert.equal(e.status, "pending");
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 10);
  assert.equal(e.currency, "PEN");
  assert.equal(e.description, "Corner Bakery");
  assert.equal(e.applepay, "wait");
  assert.equal(e.wallet_card, "Test Visa");
  // The key is not a sign-in: it cannot read anything.
  rt.ctx.__body = JSON.stringify({ accessCode: k, action: "listEntries", payload: {} });
  assert.equal(JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()")).ok, false);
  // Replacing it: the old link stops working.
  const k2 = rt.api("makeApplePayKey", { replace: true }).key;
  assert.notEqual(k2, k);
  assert.equal(pay(rt, k, { amount: "S/ 3.00", merchant: "X", card: "Test Visa" }).ok, false);
  assert.equal(rt.api("getApplePaySetup").count, 1);
});

test("the same payment sent twice is saved once", () => {
  const { rt } = freshApp({ small: true });
  const k = key(rt);
  const body = { amount: "S/ 7.20", merchant: "Kiosk", card: "Test Visa", time: new Date().toISOString() };
  pay(rt, k, body);
  const again = pay(rt, k, body);
  assert.equal(again.data.repeat, true);
  assert.equal(shortcutRows(rt).length, 1);
});

test("pressing play on the shortcut by hand saves nothing and says the link works (owner, 2026-11-22)", () => {
  const { rt } = freshApp({ small: true });
  const k = key(rt);
  for (const body of [{}, { amount: "", merchant: "", card: "" }, { amount: "0", merchant: "", card: "Test Visa" }]) {
    const res = pay(rt, k, body);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.test, true);
    assert.equal(res.data.message, "Test received: your link works. Nothing was added.");
  }
  assert.equal(shortcutRows(rt).length, 0);
  // A real payment whose amount cannot be read still waits, with its shop, for the person to check.
  assert.equal(pay(rt, k, { amount: "free", merchant: "Kiosk", card: "Test Visa" }).data.saved, true);
  assert.equal(shortcutRows(rt).length, 1);
});

test("a Wallet card is learned once the person gives its account", () => {
  const { rt } = freshApp({ small: true });
  const k = key(rt);
  const pm = rt.rows("Payment Methods").find((p) => p.type === "credit" || p.type === "debit");
  pay(rt, k, { amount: "S/ 5.00", merchant: "Shop One", card: "Learner Card" });
  const [first] = shortcutRows(rt);
  assert.equal(first.payment_method_id, "");
  rt.run(`updateRowFields_('Entries', ${JSON.stringify(first.id)}, { payment_method_id: ${JSON.stringify(pm.id)}, status: 'confirmed' })`);
  pay(rt, k, { amount: "S/ 6.00", merchant: "Shop Two", card: "Learner Card" });
  const second = shortcutRows(rt).find((e) => e.description === "Shop Two");
  assert.equal(second.payment_method_id, pm.id);
});

test("an amount with no currency sign waits with a note to check it", () => {
  const { rt } = freshApp({ small: true });
  const res = pay(rt, key(rt), { amount: "12.50", merchant: "Mystery", card: "Test Visa" });
  assert.match(res.data.message, /Check its amount and currency/);
  const [e] = shortcutRows(rt);
  assert.match(e.description, /check the amount and currency: 12\.50/);
  assert.equal(e.status, "pending");
});

test("Apple Pay first, bank e-mail second: one entry, the e-mail brings the account", () => {
  const { rt } = freshApp({ small: true });
  const pmId = addBcpCard(rt);
  pay(rt, key(rt), { amount: "S/ 25.50", merchant: "Corner Cafe Miraflores", card: "Test Debit" });
  const before = rt.rows("Entries").length;
  bcpEmail(rt, { amount: "25.50", merchant: "CORNER CAFE", op: "777001" });
  const res = JSON.parse(JSON.stringify(rt.run("processEmails()")));
  assert.equal(res.created, 0, JSON.stringify(res));
  assert.equal(rt.rows("Entries").length, before);
  const [e] = shortcutRows(rt);
  assert.equal(e.description, "Corner Cafe Miraflores");
  assert.match(e.applepay, /^joined\|/);
  // A second scan does not bring the e-mail back.
  rt.run("processEmails()");
  assert.equal(rt.rows("Entries").length, before);
  assert.equal(e.payment_method_id, pmId);
  // The card is now learned from what the e-mail said.
  pay(rt, rt.api("getApplePaySetup").key, { amount: "S/ 3.00", merchant: "Later", card: "Test Debit" });
  assert.equal(shortcutRows(rt).find((x) => x.description === "Later").payment_method_id, pmId);
});

test("bank e-mail first, Apple Pay second: the e-mail's entry gets the shop's name, no second entry", () => {
  const { rt } = freshApp({ small: true });
  const pmId = addBcpCard(rt);
  bcpEmail(rt, { amount: "41.90", merchant: "SUPERMKT 0042", op: "777002" });
  rt.run("processEmails()");
  const mail = rt.rows("Entries").find((e) => e.source === "email" && Number(e.amount) === 41.9);
  assert.ok(mail);
  const before = rt.rows("Entries").length;
  const res = pay(rt, key(rt), { amount: "S/ 41.90", merchant: "Super Market Centro", card: "Test Debit" });
  assert.equal(res.data.joined, true);
  assert.equal(rt.rows("Entries").length, before);
  const joined = rt.rows("Entries").find((e) => e.id === mail.id);
  assert.equal(joined.description, "Super Market Centro");
  assert.match(joined.applepay, /^joined\|applepay-/);
  assert.equal(joined.wallet_card, "Test Debit");
  assert.equal(joined.payment_method_id, pmId);
  // The next payment with that card already knows its account.
  pay(rt, rt.api("getApplePaySetup").key, { amount: "S/ 2.00", merchant: "Next", card: "Test Debit" });
  assert.equal(shortcutRows(rt).find((x) => x.description === "Next").payment_method_id, pmId);
});

test("a payment with another account never joins that account's e-mail", () => {
  const { rt } = freshApp({ small: true });
  addBcpCard(rt);
  const other = rt.rows("Payment Methods").find((p) => p.id !== "pm-ap-test" && (p.type === "credit" || p.type === "debit"));
  const k = key(rt);
  pay(rt, k, { amount: "S/ 1.00", merchant: "Teach", card: "Other Card" });
  const t = shortcutRows(rt)[0];
  rt.run(`updateRowFields_('Entries', ${JSON.stringify(t.id)}, { payment_method_id: ${JSON.stringify(other.id)}, status: 'confirmed' })`);
  pay(rt, k, { amount: "S/ 19.00", merchant: "Shop Z", card: "Other Card" });
  bcpEmail(rt, { amount: "19.00", merchant: "SHOP Z", op: "777009" });
  const res = JSON.parse(JSON.stringify(rt.run("processEmails()")));
  assert.equal(res.created, 1);
  assert.equal(shortcutRows(rt).find((x) => x.description === "Shop Z").applepay, "wait");
});

test("different amounts never join", () => {
  const { rt } = freshApp({ small: true });
  pay(rt, key(rt), { amount: "S/ 10.00", merchant: "Shop A", card: "Test Debit" });
  bcpEmail(rt, { amount: "10.50", merchant: "SHOP A", op: "777003" });
  const res = JSON.parse(JSON.stringify(rt.run("processEmails()")));
  assert.equal(res.created, 1);
  assert.equal(shortcutRows(rt)[0].applepay, "wait");
});

test("friends' copies do not get it yet", () => {
  const { rt } = freshApp({ small: true });
  const k = key(rt);
  rt.svc.props.set("FEATURES", "gmail");
  assert.equal(rt.api("getMeta").capabilities.applePay, false);
  assert.equal(pay(rt, k, { amount: "S/ 1.00", merchant: "X", card: "Y" }).ok, false);
  assert.throws(() => rt.api("getApplePaySetup"));
});

test("the owner's copy is known by its address even when it has a FEATURES list", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail,keepawake");
  assert.equal(rt.api("getMeta").capabilities.applePay, false);
  rt.svc.props.set("WEB_APP_URL", "https://script.google.com/macros/s/" + rt.run("OWNER_WEB_APP_ID_") + "/exec");
  assert.equal(rt.api("getMeta").capabilities.applePay, true);
  const k = key(rt);
  assert.equal(pay(rt, k, { amount: "S/ 1.00", merchant: "X", card: "Y" }).ok, true);
});

test("the address the phone sends never marks a copy as the owner's (testers 2026-11-18); a mark already there stays", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail,keepawake");
  rt.svc.props.set("WEB_APP_URL", "https://script.google.com/macros/s/AFriendsDeploymentId/exec");
  const ownerUrl = "https://evil.example/s/" + rt.run("OWNER_WEB_APP_ID_") + "/x";
  rt.ctx.__body = JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {}, apiUrl: ownerUrl });
  const res = JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  assert.equal(res.data.capabilities.applePay, false);
  assert.ok(!rt.svc.props.get("OWNER_COPY"));
  assert.equal(rt.api("getWhatsAppBot").offered, false);
  // The owner's copy, marked earlier, keeps it: the shortcut's door works.
  rt.svc.props.set("OWNER_COPY", "yes");
  assert.equal(rt.api("getMeta").capabilities.applePay, true);
  assert.equal(pay(rt, key(rt), { amount: "S/ 1.00", merchant: "X", card: "Y" }).ok, true);
});

test("a copy with no saved address never learns the owner's exact address from the phone (Rafael, re-check 2026-11-18)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail,keepawake");
  rt.svc.props.delete ? rt.svc.props.delete("WEB_APP_URL") : rt.svc.props.set("WEB_APP_URL", "");
  const ownerUrl = "https://script.google.com/macros/s/" + rt.run("OWNER_WEB_APP_ID_") + "/exec";
  rt.ctx.__body = JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {}, apiUrl: ownerUrl });
  const res = JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
  assert.equal(res.data.capabilities.applePay, false);
  assert.ok(!rt.svc.props.get("WEB_APP_URL"));
  assert.equal(rt.api("getWhatsAppBot").offered, false);
  // Its own address is still learned.
  const own = "https://script.google.com/macros/s/AFriendsDeploymentId/exec";
  rt.ctx.__body = JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {}, apiUrl: own });
  rt.run("doPost({ postData: { contents: __body } }).getContent()");
  assert.equal(rt.svc.props.get("WEB_APP_URL"), own);
});
