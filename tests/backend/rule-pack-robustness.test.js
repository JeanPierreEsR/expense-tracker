// Rule pack: hostile and awkward input. A file from the internet and e-mails from banks must never make a scan throw, hang or read the wrong thing.
// Made-up text only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, bcpEmail, BCP_SENDER } = require("./helpers");

const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const pack = (rules, version) => ({ version: version === undefined ? 1 : version, rules });
const validate = (rt, p, strict) => plain(rt.run(`rulePackValidate_(${js(typeof p === "string" ? p : js(p))}, { strict: ${!!strict} })`));
const compile = (rule) => `rulePackCompile_(${js(rule)})`;
const matches = (rt, rule, subject, body) => rt.run(`${compile(rule)}.match(${js(subject)}, ${js(body)})`);
const extract = (rt, rule, subject, body) => plain(rt.run(`${compile(rule)}.extract(${js(subject)}, ${js(body)})`));
const RULE = { id: "r", bank: "Examplebank", sender: "alertas@examplebank.test", label: "L", subjectHas: ["compra"], type: "expense", amount: { label: "Monto" }, merchant: { label: "Comercio" } };

test("hostile files: deep nesting, huge numbers, odd keys and a non-text payload are refused or skipped, never thrown", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(validate(rt, "[".repeat(39000)).ok, false);
  assert.equal(validate(rt, '{"version":1,"rules":' + "[".repeat(5000) + "]".repeat(5000) + "}").ok, false);
  assert.equal(validate(rt, js({ version: 1e9, rules: [] })).ok, false);
  assert.equal(validate(rt, js({ version: -1, rules: [] })).ok, false);
  assert.equal(validate(rt, js({ version: "1", rules: [] })).ok, false);
  assert.equal(validate(rt, js({ version: 1, rules: "nope" })).ok, false);
  assert.equal(validate(rt, js({ version: 1, rules: [null, 7, "x", []] })).ok, false);
  // a __proto__ key arrives as an own property of the parsed file: it is an unknown field, so the rule is skipped and nothing is polluted
  const poisoned = '{"version":1,"rules":[{"id":"p","bank":"B","sender":"a@b.test","label":"L","type":"expense","__proto__":{"polluted":"yes"}}]}';
  const v = validate(rt, poisoned);
  assert.equal(v.ok, true);
  assert.deepEqual(v.skipped, ["p"]);
  assert.equal(rt.run("({}).polluted"), undefined);
  const door = (payload) => rt.run(`(function () { try { setRulePack(${js(payload)}); return "no error"; } catch (e) { return e.code; } })()`);
  assert.equal(door({ text: { not: "text" } }), "rule_pack_refused");
  assert.equal(door({}), "rule_pack_refused");
  assert.equal(door(null), "rule_pack_refused");
  assert.equal(door({ text: 12345 }), "rule_pack_refused");
});

test("a refused file changes nothing; an older version number is accepted again (that is how a rule is rolled back)", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: js(pack([RULE], 5)) });
  assert.equal(rt.api("getMeta").emailInfo.rulePack.version, 5);
  rt.api("setRulePack", { text: js(pack([], 2)) });
  const info = rt.api("getMeta").emailInfo;
  assert.equal(info.rulePack.version, 2);
  assert.equal(info.rulePack.count, 0);
  assert.ok(!info.banks.includes("Examplebank"), "the rolled-back rule is gone");
  const refused = rt.run(`(function () { try { setRulePack({ text: "{ not json" }); return "no error"; } catch (e) { return e.code; } })()`);
  assert.equal(refused, "rule_pack_refused");
  assert.equal(rt.api("getMeta").emailInfo.rulePack.version, 2, "still the last good one");
});

test("awkward e-mail text: missing parts, non-breaking spaces, composed and decomposed accents, capitals", () => {
  const { rt } = freshApp({ small: true });
  const r = Object.assign({}, RULE, { subjectHas: ["compra con tarjeta"], bodyHas: ["tarjeta de débito"] });
  assert.doesNotThrow(() => matches(rt, r, undefined, undefined));
  assert.equal(matches(rt, r, null, null), false);
  assert.equal(matches(rt, r, "", ""), false);
  assert.equal(extract(rt, r, "", ""), null, "no amount: unreadable, not an error");
  assert.equal(matches(rt, r, "Compra con tarjeta", "Pagaste con tu tarjeta de débito"), true, "non-breaking spaces are spaces");
  assert.equal(matches(rt, r, "COMPRA CON TARJETA", "TARJETA DE DEBITO"), true, "capitals and accents do not matter");
  assert.equal(matches(rt, r, "Compra con tarjeta", "tarjeta de débito"), true, "an accent written as letter + mark is the same accent");
  assert.equal(matches(rt, r, "Compra con tarjeta", "tarjeta de crédito"), false);
});

test("amounts: thousands separators, dollars, both spellings; the first amount in the text wins like the code rules", () => {
  const { rt } = freshApp({ small: true });
  const at = (text) => extract(rt, RULE, "compra", text);
  assert.deepEqual([at("Monto: S/ 1,234.50").amount, at("Monto: S/ 1,234.50").currency], [1234.5, "PEN"]);
  assert.deepEqual([at("Monto: US$ 5.00").amount, at("Monto: US$ 5.00").currency], [5, "USD"]);
  assert.deepEqual([at("Monto: $ 10").amount, at("Monto: $ 10").currency], [10, "USD"]);
  assert.equal(at("Monto: sin importe"), null);
});

test("speed: 150 rules and a 200 KB e-mail are matched in well under the 6-minute limit", () => {
  const { rt } = freshApp({ small: true });
  const rules = Array.from({ length: 150 }, (_, i) => ({ id: "s" + i, bank: "B" + i, sender: "a" + i + "@examplebank.test", label: "L" + i, skip: true, bodyHas: ["frase " + i], subjectHas: ["x"] }));
  assert.equal(validate(rt, pack(rules)).ok, true);
  rt.api("setRulePack", { text: js(pack(rules, 2)) });
  const big = ("linea de relleno con palabras  y espacios\n").repeat(5000);   // ~200 KB
  const t0 = Date.now();
  rt.run(`(function () { for (var i = 0; i < 20; i++) { readEmailWithRules_('a149@examplebank.test', 'x', ${js(big)}); readEmailWithRules_('notificaciones@notificacionesbcp.com.pe', 'x', ${js(big)}); } })()`);
  assert.ok(Date.now() - t0 < 5000, "took " + (Date.now() - t0) + " ms");
});

test("pathological text: a long line with no end marker, and a label repeated thousands of times, finish quickly", () => {
  const { rt } = freshApp({ small: true });
  const between = Object.assign({}, RULE, { merchant: { between: ["en el comercio", "por"] } });
  const t0 = Date.now();
  const longLine = "en el comercio " + "a".repeat(100000);
  extract(rt, between, "compra", "Monto: S/ 1.00\n" + longLine);
  extract(rt, between, "compra", "Monto: S/ 1.00\n" + "en el comercio x\n".repeat(5000));
  extract(rt, RULE, "compra", "Monto " + " ".repeat(50000) + "S/ 2.00");
  extract(rt, RULE, "compra", ("Comercio: \n").repeat(5000) + "Monto: S/ 3.00");
  assert.ok(Date.now() - t0 < 5000, "took " + (Date.now() - t0) + " ms");
});

test("two e-mails that look alike but come from different senders never share a rule", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: js(pack([Object.assign({}, RULE, { sender: "alertas@examplebank.test" })], 2)) });
  const read = (sender) => plain(rt.run(`(function () { var r = readEmailWithRules_(${js(sender)}, 'compra', 'Monto: S/ 9.00\\nComercio: Tienda'); return { rule: r.rule ? r.rule.label : null, fields: !!r.fields }; })()`));
  assert.deepEqual(read("alertas@examplebank.test"), { rule: "L", fields: true });
  assert.deepEqual(read("alertas@otherbank.test"), { rule: null, fields: false });
  assert.deepEqual(read("ALERTAS@examplebank.test"), { rule: null, fields: false }, "senders are compared as the scan gives them (lower case)");
});

test("the code rules still read their own e-mails exactly as before: no code rule overlaps another one's e-mails", () => {
  // The scan now tries the next matching rule when one cannot read an e-mail. That is only a change for e-mails matched by TWO rules of one
  // sender. Walk every code rule's made-up sample (helpers + rule samples) and check no other code rule of that sender also matches it.
  const { rt } = freshApp({ small: true });
  const samples = [];
  const dir = path.join(__dirname, "..", "rule-samples");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const map = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const twinRules = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8")).rules;
    for (const id of Object.keys(map)) {
      const twin = twinRules.find((r) => r.id === id);
      for (const s of map[id]) if (s.matches !== false) samples.push({ sender: twin.sender, subject: s.subject, body: s.body, id });
    }
  }
  assert.ok(samples.length >= 12);
  for (const s of samples) {
    const labels = plain(rt.run(`EMAIL_RULES.filter(function (r) { return r.sender === ${js(s.sender)} && r.match(${js(s.subject)}, ${js(s.body)}); }).map(function (r) { return r.label; })`));
    assert.equal(labels.length, 1, `${s.id}: matched by ${labels.length} code rules: ${labels.join(" | ")}`);
  }
});

test("every twin names exactly one code rule: no two code rules of a sender share a label", () => {
  const { rt } = freshApp({ small: true });
  const dup = plain(rt.run(`(function () { var seen = {}, dup = []; EMAIL_RULES.forEach(function (r) { var k = r.sender + '|' + r.label; if (seen[k]) dup.push(k); seen[k] = true; }); return dup; })()`));
  assert.deepEqual(dup, []);
});

test("an e-mail the code rule cannot read and no pack rule can either is still reported as unreadable, once, and stays handled", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", body: "Empresa: Kiosco Prueba\nNúmero de operación: 654321", daysAgo: 0 });
  rt.api("setRulePack", { text: js(pack([{ id: "twin", bank: "BCP", sender: BCP_SENDER, label: "Gemelo", subjectHas: ["realizaste un consumo"], type: "expense", amount: { label: "Total del consumo" } }], 2)) });
  const before = rt.rows("Entries").length;
  rt.svc.props.delete("EMAIL_SCAN_LAST_AT");
  const first = rt.api("checkEmailsNow");
  assert.equal(rt.rows("Entries").length, before);
  rt.svc.props.delete("EMAIL_SCAN_LAST_AT");
  rt.api("checkEmailsNow");
  const unread = rt.rows("Unread Emails").filter((r) => String(r.kind) === "unreadable");
  assert.equal(unread.length, 1);
  assert.equal(Number(unread[0].count), 1, "read once, not again on the next scan");
  assert.ok(first, "the scan itself did not fail");
});
