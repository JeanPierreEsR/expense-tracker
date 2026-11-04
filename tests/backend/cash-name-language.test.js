// The built-in cash account follows the copy's language while it still has the built-in name (2026-11-04 new-user test: a Spanish
// copy showed "Cash", because the account is made before the welcome sets the language). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const cashName = (rt) => { const id = rt.run("cashAccountId_()"); return rt.rows("Payment Methods").find((p) => p.id === id).nickname; };
// A copy whose cash account was made in English (the app's first open, before the welcome).
const englishCash = () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run("var s = getSheet('Payment Methods'); var h = getHeaders(s); var t = h.indexOf('type'); var v = s.getRange(2, 1, s.getLastRow() - 1, h.length).getValues(); for (var i = v.length - 1; i >= 0; i--) if (v[i][t] === 'cash') s.deleteRow(i + 2); setSetting_('cash_account_id', '');");
  post(rt, "getMeta", {}, "en");
  return rt;
};

test("choosing Spanish renames the built-in Cash to Efectivo, and back to Cash in English", () => {
  const rt = englishCash();
  assert.equal(cashName(rt), "Cash");
  post(rt, "setLanguage", { lang: "es" });
  assert.equal(cashName(rt), "Efectivo");
  post(rt, "setLanguage", { lang: "en" });
  assert.equal(cashName(rt), "Cash");
});

test("a name the person typed is never renamed", () => {
  const rt = englishCash();
  const id = rt.run("cashAccountId_()");
  rt.run(`var s = getSheet('Payment Methods'); var h = getHeaders(s); setCellByRow_(s, h, findRowIndexById(s, h, ${JSON.stringify(id)}), 'nickname', 'Billetera'); ROWS_MEMO_ = null;`);
  post(rt, "setLanguage", { lang: "es" });
  assert.equal(cashName(rt), "Billetera");
});

test("nothing is renamed onto a name another account already uses", () => {
  const rt = englishCash();
  rt.run("appendRowObject('Payment Methods', { id: 'pm-other', nickname: 'Efectivo', type: 'wallet', bank_id: '', last_4: '' }); ROWS_MEMO_ = null;");
  post(rt, "setLanguage", { lang: "es" });
  assert.equal(cashName(rt), "Cash");
});

test("the heal renames it on a Spanish copy installed earlier, once", () => {
  const rt = englishCash();
  rt.run("setSetting_('language', 'es'); REQUEST_LANG_ = null;");
  assert.equal(cashName(rt), "Cash");
  rt.run("relocalizeCashName_(currentLang_());");
  assert.equal(cashName(rt), "Efectivo");
  assert.equal(rt.run("relocalizeCashName_(currentLang_())"), 0, "a second run changes nothing");
});
