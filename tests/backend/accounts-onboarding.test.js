// Bank accounts in the welcome questions: the bank catalogue, automatic account names (and their language), saving a
// batch of accounts, and the Yape / Plin links. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

// A new person's copy: no accounts yet (the harness seed has some), e-mail reading on so Yape e-mails are read.
const friendCopy = () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Payment Methods").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; RATES_MEMO_ = null; bumpStructureVersion_();");
  return rt;
};
const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const acct = (cid, bank, kind, extra = {}) => Object.assign({ cid, bank, kind, alias: "", last4: "", showLast4: false }, extra);
const names = (rt) => Object.fromEntries(rt.rows("Payment Methods").map((p) => [p.id, p.nickname]));
const save = (rt, accounts, links = {}, lang = "es", batch) => post(rt, "saveOnboardingAccounts", { accounts, links, lang, batch }, lang).data;

test("the bank list has two groups, each alphabetical: BBVA, BCP, Interbank, Scotiabank, then the others", () => {
  const rt = friendCopy();
  const c = rt.api("getMeta").bankCatalog;
  assert.deepEqual(c.main.map((b) => b.name), ["BBVA", "BCP", "Interbank", "Scotiabank"]);
  const sorted = [...c.other.map((b) => b.name)].sort((a, b) => a.localeCompare(b, "es"));
  assert.deepEqual(c.other.map((b) => b.name), sorted);
  assert.ok(c.other.length >= 8);
  assert.deepEqual(Object.keys(c.words), ["en", "es"]);
  assert.equal(c.words.es.sueldo, "sueldo");
});

test("an installer copy starts with those banks; the owner's copy keeps its own list", () => {
  const rt = friendCopy();
  rt.sheet("Banks").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedBanks();");
  const got = rt.rows("Banks").map((b) => b.name);
  assert.equal(got[0], "BBVA");
  assert.ok(got.includes("Scotiabank") && got.includes("Mibanco"));
  assert.ok(!got.includes("Yape") && !got.includes("SIP"));
  const owner = freshApp({ small: true }).rt;
  assert.ok(owner.rows("Banks").map((b) => b.name).includes("Yape"));
});

test("accounts get automatic names: bank + soles / dólares / crédito / sueldo, digits only when asked", () => {
  const rt = friendCopy();
  const r = save(rt, [
    acct("a", "BCP", "debit_pen"), acct("b", "BCP", "debit_usd", { last4: "9843", showLast4: true }),
    acct("c", "BBVA", "credit", { last4: "3052" }), acct("d", "Interbank", "sueldo", { last4: "4940", showLast4: true })
  ], {}, "es");
  assert.deepEqual(r.accounts.map((a) => a.nickname), ["BCP soles", "BCP dólares (9843)", "BBVA crédito", "Interbank sueldo (4940)"]);
  const rows = rt.rows("Payment Methods");
  const by = (n) => rows.find((p) => p.nickname === n);
  assert.equal(by("BCP soles").type, "debit");
  assert.equal(by("BBVA crédito").type, "credit");
  assert.equal(String(by("BBVA crédito").last_4), "3052", "the digits are kept even when not shown in the name");
  assert.equal(by("BCP soles").alias_auto, "yes");
  assert.equal(by("Interbank sueldo (4940)").alias_kind, "sueldo");
});

test("English words when the app is in English", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("a", "BCP", "debit_usd"), acct("b", "BBVA", "credit"), acct("c", "Scotiabank", "sueldo")], {}, "en");
  assert.deepEqual(r.accounts.map((a) => a.nickname), ["BCP dollars", "BBVA credit", "Scotiabank salary"]);
});

test("a typed alias is used as typed; the digits are added only when asked; long bank names use their short name", () => {
  const rt = friendCopy();
  const r = save(rt, [
    acct("a", "BCP", "sueldo", { alias: "Mi sueldo", last4: "1111" }),
    acct("b", "BCP", "debit_pen", { alias: "Ahorros", last4: "2222", showLast4: true }),
    acct("c", "Banco de la Nación", "debit_pen")
  ], {}, "es");
  assert.deepEqual(r.accounts.map((a) => a.nickname), ["Mi sueldo", "Ahorros (2222)", "Nación soles"]);
  const rows = rt.rows("Payment Methods");
  assert.equal(rows.find((p) => p.nickname === "Mi sueldo").alias_auto, "no");
});

test("several accounts of the same bank and kind never share a name", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("a", "BCP", "debit_pen"), acct("b", "BCP", "debit_pen"), acct("c", "BCP", "debit_pen", { last4: "7777" }), acct("d", "BCP", "debit_pen")], {}, "es");
  assert.deepEqual(r.accounts.map((a) => a.nickname), ["BCP soles", "BCP soles 2", "BCP soles (7777)", "BCP soles 3"]);
});

test("banks are reused, not duplicated, and a bank typed by hand is added", () => {
  const rt = friendCopy();
  rt.sheet("Banks").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedBanks();");
  const before = rt.rows("Banks").length;
  save(rt, [acct("a", "bcp", "debit_pen"), acct("b", "BCP", "debit_usd"), acct("c", "Banco Nuevo", "credit")], {}, "es");
  assert.equal(rt.rows("Banks").length, before + 1);
  assert.ok(rt.rows("Banks").some((b) => b.name === "Banco Nuevo"));
});

test("saving the same batch twice saves it once; bad input is refused", () => {
  const rt = friendCopy();
  const one = save(rt, [acct("a", "BCP", "debit_pen")], {}, "es", "batch-1");
  assert.equal(one.accounts.length, 1);
  const again = save(rt, [acct("a", "BCP", "debit_pen")], {}, "es", "batch-1");
  assert.equal(again.already, true);
  assert.equal(rt.rows("Payment Methods").filter((p) => p.nickname === "BCP soles").length, 1);
  assert.equal(post(rt, "saveOnboardingAccounts", { accounts: [acct("x", "BCP", "nonsense")] }).ok, false);
  assert.equal(post(rt, "saveOnboardingAccounts", { accounts: [acct("x", "BCP", "debit_pen", { last4: "12" })] }).ok, false);
  assert.equal(post(rt, "saveOnboardingAccounts", { accounts: [acct("x", "", "debit_pen")] }).ok, false);
});

test("Yape and Plin links: saved per currency, changeable, and the app finds the linked account", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("s", "BCP", "debit_pen"), acct("d", "BCP", "debit_usd"), acct("i", "Interbank", "debit_pen")],
    { yape_pen: "s", yape_usd: "d", plin_pen: "i" }, "es");
  const id = Object.fromEntries(r.accounts.map((a) => [a.cid, a.id]));
  const s = rt.api("getMeta").settings;
  assert.equal(s.yape_pen, id.s); assert.equal(s.yape_usd, id.d); assert.equal(s.plin_pen, id.i); assert.ok(!s.plin_usd);
  const pms = rt.rows("Payment Methods");
  assert.equal(rt.run(`railAccount_('yape', 'PEN', getAllRows('Payment Methods')).id`), id.s);
  assert.equal(rt.run(`railAccount_('plin', 'PEN', getAllRows('Payment Methods')).id`), id.i);
  // change the link later (Yape: BCP only; Plin: any bank but BCP)
  const second = save(rt, [acct("s2", "BCP", "debit_pen"), acct("sc", "Scotiabank", "debit_usd")], {}, "es").accounts;
  const sid = Object.fromEntries(second.map((a) => [a.cid, a.id]));
  rt.api("saveRailLinks", { yape_pen: sid.s2, plin_usd: sid.sc });
  assert.equal(rt.run(`railAccount_('yape', 'PEN', getAllRows('Payment Methods')).id`), sid.s2);
  assert.equal(rt.run(`railAccount_('plin', 'USD', getAllRows('Payment Methods')).id`), sid.sc);
  rt.api("saveRailLinks", { yape_pen: "" });
  assert.equal(rt.run(`railAccount_('yape', 'PEN', getAllRows('Payment Methods'))`), null, "unlinked and no legacy-named account: none");
  assert.throws(() => rt.api("saveRailLinks", { yape_pen: "not-an-account" }), /not found|No se encontr/i);
  assert.ok(pms.length >= 3);
});

test("Yape works only with BCP accounts and Plin only with other banks (never BCP)", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("b", "BCP", "debit_pen"), acct("i", "Interbank", "debit_pen"), acct("v", "BBVA", "sueldo")], {}, "es");
  const id = Object.fromEntries(r.accounts.map((a) => [a.cid, a.id]));
  assert.throws(() => rt.api("saveRailLinks", { yape_pen: id.i }), /solo funciona con cuentas BCP|only works with BCP/);
  assert.throws(() => rt.api("saveRailLinks", { plin_pen: id.b }), /no funciona con cuentas BCP|doesn't work with BCP/);
  rt.api("saveRailLinks", { yape_pen: id.b, plin_pen: id.v });
  const s = rt.api("getMeta").settings;
  assert.equal(s.yape_pen, id.b); assert.equal(s.plin_pen, id.v);
  // the welcome step cannot sneak a wrong link in either
  const rt2 = friendCopy();
  const r2 = save(rt2, [acct("b", "BCP", "debit_pen"), acct("i", "Interbank", "debit_pen")], { yape_pen: "i", plin_pen: "b" }, "es");
  const s2 = rt2.api("getMeta").settings;
  assert.ok(!s2.yape_pen && !s2.plin_pen, "links the rails cannot work with are not saved");
  assert.equal(r2.accounts.length, 2);
});

test("Plin can also use a credit card, of any bank (BCP included); Yape never uses a card", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("c1", "Interbank", "credit"), acct("c2", "BCP", "credit"), acct("b", "BCP", "debit_pen")], {}, "es");
  const id = Object.fromEntries(r.accounts.map((a) => [a.cid, a.id]));
  rt.api("saveRailLinks", { plin_pen: id.c1, plin_usd: id.c2 });
  const s = rt.api("getMeta").settings;
  assert.equal(s.plin_pen, id.c1); assert.equal(s.plin_usd, id.c2);
  assert.throws(() => rt.api("saveRailLinks", { yape_pen: id.c2 }), /solo funciona con cuentas BCP|only works with BCP/);
  assert.throws(() => rt.api("saveRailLinks", { plin_pen: id.b }), /no funciona con cuentas BCP|doesn't work with BCP/, "a BCP DEBIT account still cannot");
  // the welcome step saves a card link too
  const rt2 = friendCopy();
  const r2 = save(rt2, [acct("k", "Scotiabank", "credit")], { plin_pen: "k" }, "es");
  assert.equal(rt2.api("getMeta").settings.plin_pen, r2.accounts[0].id);
});

test("a Yape e-mail goes to the account the person linked", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("s", "BCP", "debit_pen"), acct("o", "BCP", "debit_pen")], { yape_pen: "o" }, "es");
  const interbank = r.accounts.find((a) => a.cid === "o").id;   // the second BCP account: the one linked
  rt.svc.gmail.addEmail({ from: "notificaciones@yape.pe", subject: "Constancia de yapeo", body: "Hola, acabas de yapear\nMonto de yapeo\nS/ 12.00\nNombre del Beneficiario\nAna Lo*\nCódigo de operación 0098765" });
  rt.run("processEmails()");
  const e = rt.rows("Entries").find((x) => x.source === "email" && String(x.description || "").startsWith("Yape a"));
  assert.ok(e, "the Yape e-mail became an entry");
  assert.equal(e.payment_method_id, interbank);
});

test("the owner's copy: Yape -> BCP soles/dolares and Plin -> IBK soles/dolares are linked once, by themselves", () => {
  const { rt } = freshApp({ small: true });
  const bank = (name) => rt.api("addBank", { name }).id;
  const mk = (nickname, bankName) => rt.api("savePaymentMethod", { nickname, type: "debit", bank_id: bank(bankName) }).id;
  const ids = { bs: mk("BCP soles", "BCP"), bd: mk("BCP dolares", "BCP"), is: mk("IBK soles", "Interbank"), id: mk("IBK dolares", "Interbank") };
  rt.run("setSetting_('rail_defaults', ''); ");
  const s = rt.api("getMeta").settings;
  assert.equal(s.yape_pen, ids.bs); assert.equal(s.yape_usd, ids.bd); assert.equal(s.plin_pen, ids.is); assert.equal(s.plin_usd, ids.id);
  // a link the owner changes is not overwritten
  rt.api("saveRailLinks", { yape_pen: ids.bd });
  rt.api("getMeta");
  assert.equal(rt.api("getMeta").settings.yape_pen, ids.bd);
});

test("an installer copy is NOT auto-linked", () => {
  const rt = friendCopy();
  rt.api("savePaymentMethod", { nickname: "BCP soles", type: "debit" });
  rt.run("setSetting_('rail_defaults', '');");
  assert.ok(!rt.api("getMeta").settings.yape_pen);
});

test("the owner's original names still resolve (accent- and case-insensitive) on the owner's copy only", () => {
  const { rt } = freshApp({ small: true });
  rt.sheet("Payment Methods").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; bumpStructureVersion_();");
  rt.api("savePaymentMethod", { nickname: "BCP dólares", type: "debit" });
  rt.run("setSetting_('yape_usd', '');");
  assert.equal(rt.run(`railAccount_('yape', 'USD', getAllRows('Payment Methods')).nickname`), "BCP dólares");
  rt.svc.props.set("FEATURES", "base");
  assert.equal(rt.run(`railAccount_('yape', 'USD', getAllRows('Payment Methods'))`), null, "an installer copy has links or nothing");
});

test("language change: when EVERY bank account has an automatic name, the names follow the language", () => {
  const rt = friendCopy();
  save(rt, [acct("a", "BCP", "debit_usd"), acct("b", "BBVA", "credit"), acct("c", "Interbank", "sueldo", { last4: "4940", showLast4: true })], {}, "es");
  rt.api("setLanguage", { lang: "en" });
  assert.deepEqual(rt.rows("Payment Methods").filter((p) => p.alias_auto === "yes").map((p) => p.nickname).sort(), ["BBVA credit", "BCP dollars", "Interbank salary (4940)"]);
  rt.api("setLanguage", { lang: "es" });
  assert.deepEqual(rt.rows("Payment Methods").filter((p) => p.alias_auto === "yes").map((p) => p.nickname).sort(), ["BBVA crédito", "BCP dólares", "Interbank sueldo (4940)"]);
});

test("language change: if even ONE name was typed by the person, NOTHING is renamed", () => {
  const rt = friendCopy();
  save(rt, [acct("a", "BCP", "debit_usd"), acct("b", "BBVA", "credit", { alias: "Mi Visa" })], {}, "es");
  rt.api("setLanguage", { lang: "en" });
  assert.deepEqual(rt.rows("Payment Methods").map((p) => p.nickname).sort(), ["BCP dólares", "Mi Visa"]);
});

test("language change: an account renamed by hand later stops automatic renaming for all", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("a", "BCP", "debit_pen"), acct("b", "BBVA", "credit")], {}, "es");
  const a = r.accounts[0];
  rt.api("savePaymentMethod", { id: a.id, nickname: "Mi cuenta", type: "debit", bank_id: a.bank_id, last_4: "" });
  assert.equal(rt.rows("Payment Methods").find((p) => p.id === a.id).alias_auto, "no");
  rt.api("setLanguage", { lang: "en" });
  assert.deepEqual(rt.rows("Payment Methods").map((p) => p.nickname).sort(), ["BBVA crédito", "Mi cuenta"]);
});

test("language change: the owner's own accounts (no automatic names) are never renamed", () => {
  const { rt } = freshApp({ small: true });
  rt.api("savePaymentMethod", { nickname: "IBK sueldo", type: "debit" });
  const before = rt.rows("Payment Methods").map((p) => p.nickname);
  rt.api("setLanguage", { lang: "en" });
  assert.deepEqual(rt.rows("Payment Methods").map((p) => p.nickname), before);
});

test("wallets and cash do not block automatic renaming", () => {
  const rt = friendCopy();
  save(rt, [acct("a", "BCP", "debit_usd")], {}, "es");
  rt.api("savePaymentMethod", { nickname: "Starbucks", type: "wallet" });
  rt.api("setLanguage", { lang: "en" });
  assert.ok(rt.rows("Payment Methods").some((p) => p.nickname === "BCP dollars"));
  assert.ok(rt.rows("Payment Methods").some((p) => p.nickname === "Starbucks"));
});

test("editing the last 4 of an automatic name that shows them updates the name", () => {
  const rt = friendCopy();
  const r = save(rt, [acct("a", "BCP", "debit_pen", { last4: "1111", showLast4: true })], {}, "es");
  const a = r.accounts[0];
  assert.equal(a.nickname, "BCP soles (1111)");
  rt.api("savePaymentMethod", { id: a.id, nickname: a.nickname, type: "debit", bank_id: a.bank_id, last_4: "2222" });
  assert.equal(rt.rows("Payment Methods").find((p) => p.id === a.id).nickname, "BCP soles (2222)");
  assert.equal(rt.rows("Payment Methods").find((p) => p.id === a.id).alias_auto, "yes");
});
