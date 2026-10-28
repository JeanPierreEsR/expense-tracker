// Moving a bank from code to the pack (backend/RulePack.gs, readEmailWithRules_ in EmailParser.gs): the next matching rule gets a chance when one
// cannot read an e-mail, `first` puts a pack twin in front of the code rule, a rule written for a newer backend is skipped on its own, and
// the twin check compares a twin with its code rule on the mailbox. Made-up banks, names, addresses and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail, BCP_SENDER } = require("./helpers");

const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const clearGap = (rt) => rt.svc.props.delete("EMAIL_SCAN_LAST_AT");
const pack = (rules, version) => ({ version: version === undefined ? 1 : version, rules });
const setPack = (rt, rules, version) => rt.api("setRulePack", { text: js(pack(rules, version)) });
const scan = (rt) => { clearGap(rt); return rt.api("checkEmailsNow"); };
const entriesWith = (rt, test) => rt.rows("Entries").filter((e) => e.source === "email" && test(e));
const matchesWith = (rt, rule, subject, body) => rt.run(`rulePackCompile_(${js(rule)}).match(${js(subject)}, ${js(body || "")})`);
const extractWith = (rt, rule, subject, body) => plain(rt.run(`rulePackCompile_(${js(rule)}).extract(${js(subject)}, ${js(body)})`));
const validate = (rt, p, strict) => plain(rt.run(`rulePackValidate_(${js(typeof p === "string" ? p : js(p))}, { strict: ${!!strict} })`));

// The BCP debit-card rule as data: the same reading the code rule has.
const BCP_TWIN = {
  id: "bcp-consumo-debito", replaces: "Consumo tarjeta de débito", bank: "BCP", sender: BCP_SENDER, label: "Consumo tarjeta de débito (pack)",
  subjectHas: ["realizaste un consumo", "debito"], type: "expense", amount: { label: "Total del consumo" }, merchant: { label: "Empresa" },
  last4: { label: "Número de Tarjeta de Débito", kind: "masked" }, externalId: { label: "Número de operación" }
};

// ---- the scan tries the next matching rule when one cannot read the e-mail ----
test("a code rule that matches but cannot read an e-mail no longer ends it: a pack rule that can read it does", () => {
  const { rt } = freshApp({ small: true });
  // The amount is only in the subject: the BCP code rule matches, finds no amount in the body and gives up.
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo de S/ 33.00 con tu tarjeta de débito BCP", body: "Empresa: Kiosco Prueba\nNúmero de operación: 777001", daysAgo: 0 });
  const mine = (e) => Number(e.amount) === 33 && e.description === "Kiosco Prueba";
  const before = entriesWith(rt, mine).length;
  scan(rt);
  assert.equal(entriesWith(rt, mine).length, before, "unreadable by the code rule alone");

  const rule = Object.assign({}, BCP_TWIN, { id: "bcp-from-subject", replaces: undefined, label: "Consumo desde el asunto", amount: { from: "subject" } });
  delete rule.replaces;
  setPack(rt, [rule], 2);
  // the first scan marked that e-mail handled (skipped as unreadable); the back-check reads old mail again, as the owner would
  const res = rt.run("processEmails({ days: 3, senders: [" + js(BCP_SENDER) + "] })");
  assert.ok(res.created >= 1, "the pack rule read what the code rule could not: " + js(res));
  assert.equal(entriesWith(rt, mine).length, before + 1);
});

test("a rule that matches AND reads an e-mail is still the only one used (no second reading)", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "41.00", merchant: "Tienda Unica", op: "888001" });
  setPack(rt, [Object.assign({}, BCP_TWIN, { id: "twin", label: "Gemelo", description: { text: "FROM THE PACK" } })], 2);
  scan(rt);
  const made = entriesWith(rt, (e) => Number(e.amount) === 41 && e.external_id === "888001");
  assert.equal(made.length, 1);
  assert.equal(made[0].description, "Tienda Unica", "the code rule came first, so it read it");
});

test("first: a pack twin goes in front of the code rule, which stays behind it as the fallback", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "42.00", merchant: "Tienda Dos", op: "888002" });
  setPack(rt, [Object.assign({}, BCP_TWIN, { id: "twin", label: "Gemelo", first: true, description: { text: "FROM THE PACK" } })], 2);
  const order = plain(rt.run("emailRules_().map(function (r) { return r.fromPack ? 'pack' : 'code'; })"));
  assert.equal(order[0], "pack");
  assert.ok(order.indexOf("code") > 0);
  scan(rt);
  const made = entriesWith(rt, (e) => Number(e.amount) === 42 && e.external_id === "888002");
  assert.equal(made.length, 1);
  assert.equal(made[0].description, "FROM THE PACK");

  // the same twin cannot read this one (no card label, no amount): the code rule behind it does
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "Total del consumo: S/ 43.00\nEmpresa: Tienda Tres\nNúmero de operación: 888003", daysAgo: 0 });
  setPack(rt, [Object.assign({}, BCP_TWIN, { id: "twin", label: "Gemelo", first: true, amount: { from: "subject" } })], 3);
  scan(rt);
  const fallback = entriesWith(rt, (e) => Number(e.amount) === 43 && e.external_id === "888003");
  assert.equal(fallback.length, 1, "the code rule is the fallback of a pack twin that cannot read an e-mail");
});

test("an ignore rule that matches first still ends the e-mail, whatever follows", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "Total del consumo: S/ 44.00\nEmpresa: Tienda Cuatro\nNúmero de operación: 888004", daysAgo: 0 });
  setPack(rt, [{ id: "skip-it", bank: "BCP", sender: BCP_SENDER, label: "Ignorar", first: true, skip: true, subjectHas: ["tarjeta de debito"] }], 2);
  scan(rt);
  assert.equal(entriesWith(rt, (e) => e.external_id === "888004").length, 0);
});

test("a rule in front of the code rules must say which e-mails it takes: first without match words is refused", () => {
  const { rt } = freshApp({ small: true });
  const noWords = { id: "grab-all", bank: "BCP", sender: BCP_SENDER, label: "Todo", first: true, type: "expense" };
  assert.match(validate(rt, pack([noWords])).errors.join(" "), /first: needs words to match/);
  assert.equal(validate(rt, pack([Object.assign({}, noWords, { subjectHas: ["consumo"] })])).ok, true);
  assert.equal(validate(rt, pack([Object.assign({}, noWords, { first: false })])).ok, true, "a plain rule may match everything from its sender (the Diners twins do)");
});

// ---- a schema that grows must not block a copy that has not updated ----
test("a rule written for a newer backend is skipped on its own and listed; the others load", () => {
  const { rt } = freshApp({ small: true });
  const future = { id: "future-rule", bank: "Examplebank", sender: "alertas@examplebank.test", label: "Futuro", type: "expense", needsNewThing: { x: 1 } };
  const good = Object.assign({}, BCP_TWIN, { id: "good" });
  const done = plain(setPack(rt, [future, good], 5));
  assert.deepEqual(done, { version: 5, count: 1, skipped: 1 });
  const info = rt.api("getMeta").emailInfo.rulePack;
  assert.deepEqual(info.skipped, ["future-rule"]);
  assert.equal(info.count, 1);
  const strict = validate(rt, pack([future, good]), true);
  assert.equal(strict.ok, false, "the repo's own check is strict: a typo in a field name is caught when the rule is written");
  assert.match(strict.errors.join(" "), /unknown field needsNewThing/);
});

test("the public-file checks cover EVERY string, also inside a field this backend does not know", () => {
  const { rt } = freshApp({ small: true });
  const base = { id: "x", bank: "B", sender: "alertas@examplebank.test", label: "L", type: "expense" };
  assert.equal(validate(rt, pack([Object.assign({}, base, { newField: { note: "write to ana.perez@gmail.test" } })])).ok, false);
  assert.equal(validate(rt, pack([Object.assign({}, base, { newField: ["phone 987654321"] })])).ok, false);
  assert.equal(validate(rt, pack([Object.assign({}, base, { newField: { deep: { deeper: { deepest: { a: { b: { c: "x" } } } } } } })])).ok, false, "nesting is limited");
  assert.equal(validate(rt, { version: 1, rules: [], note: "call 5551234567" }).ok, false);
  assert.equal(validate(rt, pack([Object.assign({}, base, { newField: { note: "plain words" } })])).ok, true);
});

// ---- the words a data rule can use ----
test("subjectIs, description.text and phrases that wrap over two lines", () => {
  const { rt } = freshApp({ small: true });
  const rule = { id: "t", bank: "Examplebank", sender: "alertas@examplebank.test", label: "L", subjectIs: "Constancia de pago", bodyHas: ["pago de tu tarjeta"], type: "transfer", description: { text: "Pago tarjeta Prueba" }, amount: { label: "Monto" } };
  assert.equal(matchesWith(rt, rule, "  Constancia de pago ", "Tu pago\nde tu   tarjeta se realizó"), true, "case, accents and line breaks do not matter");
  assert.equal(matchesWith(rt, rule, "Constancia de pago de servicios", "pago de tu tarjeta"), false, "subjectIs means the whole subject");
  const out = extractWith(rt, rule, "Constancia de pago", "Monto: S/ 12.00");
  assert.equal(out.description, "Pago tarjeta Prueba");
  assert.equal(out.type, "transfer");
});

// ---- the twin check ----
const checkOf = (rt, days) => plain(rt.api("rulePackTwinCheck", { days: days || 30 }));

test("a twin that reads the mailbox like its code rule is reported identical", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "25.50", merchant: "Corner Cafe", op: "000111" });
  bcpEmail(rt, { amount: "10.00", merchant: "Kiosco Prueba", op: "000112", daysAgo: 2 });
  setPack(rt, [BCP_TWIN], 2);
  const r = checkOf(rt).twins[0];
  assert.equal(r.codeRuleFound, true);
  assert.equal(r.emails, 2);
  assert.equal(r.both, 2);
  assert.equal(r.identical, 2);
  assert.equal(r.different, 0);
  assert.equal(r.onlyCode, 0);
  assert.equal(r.onlyTwin, 0);
});

test("a twin that reads differently is reported with the NAMES of the fields, never their values", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "25.50", merchant: "Corner Cafe", op: "000111" });
  setPack(rt, [Object.assign({}, BCP_TWIN, { merchant: { label: "Comercio" } })], 2);
  const report = checkOf(rt);
  const r = report.twins[0];
  assert.equal(r.different, 1);
  assert.equal(r.fieldsDiffering.merchant, 1);
  assert.equal(r.fieldsDiffering.description, 1);
  const text = js(report);
  assert.ok(!/Corner Cafe|25\.50|000111|1234/.test(text), "no amount, name or number in the report: " + text);
});

test("a twin that matches more than its code rule is reported as 'only twin', with the rule it would take the e-mail from", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de crédito BCP", body: "Total del consumo: S/ 5.00\nEmpresa: Tienda\nNúmero de operación: 1", daysAgo: 0 });
  setPack(rt, [Object.assign({}, BCP_TWIN, { subjectHas: ["realizaste un consumo"] })], 2);
  const r = checkOf(rt).twins[0];
  assert.equal(r.onlyTwin, 1);
  assert.equal(r.examples[0].kind, "only twin");
  assert.equal(r.examples[0].wouldTakeFrom, "(no code rule matches it)");
});

test("a twin whose code rule is missing is reported, and a tighter twin shows 'only code rule'", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "25.50", merchant: "Corner Cafe", op: "000111" });
  setPack(rt, [Object.assign({}, BCP_TWIN, { id: "nocode", replaces: "No such rule" }), Object.assign({}, BCP_TWIN, { id: "tight", subjectHas: ["realizaste un consumo", "debito", "palabra que nunca sale"] })], 2);
  const [missing, tight] = checkOf(rt).twins;
  assert.equal(missing.codeRuleFound, false);
  assert.equal(missing.emails, 0);
  assert.equal(tight.onlyCode, 1);
});

test("the twin check is read-only, owner's copy only, and open to the Mac helper's key", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "000113" });
  setPack(rt, [BCP_TWIN], 2);
  const before = rt.rows("Entries").length;
  checkOf(rt);
  assert.equal(rt.rows("Entries").length, before, "it creates nothing");

  const KEY = "h".repeat(32);
  rt.svc.props.set("HELPER_KEY", KEY);
  const viaKey = rt.rawPost(JSON.stringify({ helperKey: KEY, action: "rulePackTwinCheck", payload: { days: 7 } }));
  assert.equal(viaKey.ok, true);
  assert.equal(viaKey.data.twins[0].emails, 1);
  assert.equal(rt.rawPost(JSON.stringify({ helperKey: "x".repeat(32), action: "rulePackTwinCheck", payload: {} })).ok, false);
  assert.equal(rt.rawPost(JSON.stringify({ action: "rulePackTwinCheck", payload: {} })).ok, false, "signed out");

  rt.svc.props.set("FEATURES", "gmail");   // a friend's copy
  const code = rt.run(`(function () { try { rulePackTwinCheck_({}); return "no error"; } catch (e) { return e.code; } })()`);
  assert.equal(code, "twin_not_here");
});
