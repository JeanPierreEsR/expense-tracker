// More → Bank emails is one full screen (two views) that absorbed "Not captured automatically" (owner's design, 2026-11-03).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "../../docs", f), "utf8");
const html = read("index.html");
const app = read("app.js");
const strings = read("strings.js");

test("the screen exists, the old Not captured screen and its More row are gone", () => {
  assert.match(html, /id="screen-bank-emails" class="screen"/);
  assert.ok(!/id="screen-notauto"/.test(html));
  assert.ok(!/id="more-notauto-btn"/.test(html));
  assert.match(html, /id="more-bank-mail-btn"/);
});

test("tab memory: the screen is a More sub-screen and the old name is not", () => {
  const list = app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1];
  assert.ok(list.includes('"bank-emails"'));
  assert.ok(!list.includes('"notauto"'));
});

test("the More row opens the screen; the welcome keeps its short pop-up", () => {
  assert.match(app, /more-bank-mail-btn"\)\.addEventListener\("click", \(\) => showBankEmailsScreen\(\)\)/);
  assert.match(app, /openBankMailModal_\(\{ welcome: true/);
  assert.match(app, /function openBankMailModal_\(/);
});

test("it opens at once with Loading and shows its body only when the data has arrived (loading standard)", () => {
  const fn = app.slice(app.indexOf("async function showBankEmailsScreen"), app.indexOf("function renderBankEmails_"));
  assert.match(fn, /be-body"\)\.hidden = true/);
  assert.ok(fn.indexOf('callApi("getManualGaps"') < fn.indexOf('be-body").hidden = false'));
  assert.match(fn, /catch \(err\)/);
});

test("Yape and Plin are drawn inside the bank they are linked to, never as a bank of their own", () => {
  assert.match(app, /be\.wallet\.yape/);
  assert.match(app, /be\.wallet\.plin/);
  assert.match(app, /filter\(\(n\) => !\(n\.toLowerCase\(\) === "yape" && yapeBank\)\)/);
});

test("every text the screen can show exists in both languages", () => {
  const keys = [];
  ["purchase", "bill", "transfer_out", "plin_out", "yape_out", "yape_in", "card_payment", "insurance", "receipt", "other", "money_in"].forEach((k) => keys.push("bankKind." + k));
  ["must", "check", "optional"].forEach((n) => keys.push("be.need." + n, "be.need." + n + ".sub"));
  ["yape_in", "yape_out", "plin_out", "other_manual"].forEach((k) => keys.push("be.kind." + k));
  keys.push("be.tab.bank", "be.tab.tx", "be.foot", "be.state.seen", "be.state.can", "be.state.none", "be.wallet.yape", "be.wallet.plin", "be.wallet.yapeAlone",
    "be.tx.hint", "be.tx.newest", "be.tx.fromStatement", "be.kind.must.yape_out", "be.tip.must.yape_out", "be.tip.yape");
  keys.forEach((k) => {
    const row = strings.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ en: "([^"]*(?:\\\\.[^"]*)*)", es: "([^"]*(?:\\\\.[^"]*)*)" \\}'));
    assert.ok(row && row[1] && row[2], k + " needs English and Spanish");
  });
});

test("the screen never promises what is not known: no 'always arrives' wording for kinds, only 'can arrive' unless it really arrived", () => {
  const get = (k) => strings.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ en: "([^"]*)"'))[1];
  assert.match(get("be.state.can"), /^○ Can arrive if/);
  assert.match(get("be.state.seen"), /^✓ Arrived in your mailbox/);
  assert.match(get("be.state.none"), /^✗ No email/);
  assert.ok(!/receive/i.test(get("be.tip.yape")), "the wallet tip does not claim Yape sends nothing for money received");
});

test("kinds the backend can send all have a name", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../backend/BankCoverage.gs"), "utf8");
  const order = src.match(/BANK_KIND_ORDER_ = \[([^\]]*)\]/)[1].match(/'([a-z_]+)'/g).map((s) => s.replace(/'/g, ""));
  order.forEach((k) => assert.ok(strings.includes('"bankKind.' + k + '"'), "bankKind." + k));
});
