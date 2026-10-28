// Rule pack (backend/RulePack.gs, docs/rules/email-rules.json, the phone's syncRulePack_ in docs/app.js): simple bank e-mail rules kept as DATA.
// Made-up banks, names, addresses and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const clearGap = (rt) => rt.svc.props.delete("EMAIL_SCAN_LAST_AT");   // the app may scan once a minute; tests scan back to back

const SENDER = "alertas@examplebank.test";
const GOOD_RULE = {
  id: "examplebank-consumo", bank: "Examplebank", sender: SENDER, label: "Consumo", subjectHas: ["compra con tarjeta"],
  type: "expense", amount: { label: "Monto" }, merchant: { label: "Comercio" }, last4: { label: "Tarjeta", kind: "card" }, externalId: { label: "Operación" }
};
const pack = (rules, version) => ({ version: version === undefined ? 1 : version, rules });
const validate = (rt, p, strict) => plain(rt.run(`rulePackValidate_(${js(typeof p === "string" ? p : js(p))}, { strict: ${!!strict} })`));
const errorsOf = (rt, p, strict) => validate(rt, p, strict).errors.join(" | ");
const withRule = (changes) => Object.assign({}, GOOD_RULE, changes);

// ---- validation: only words, no code, nothing private ----
test("a good pack is accepted, an empty one too", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(validate(rt, pack([GOOD_RULE])).ok, true);
  assert.equal(validate(rt, pack([])).ok, true);
});

test("anything that is not exactly the allowed shape is refused", () => {
  const { rt } = freshApp({ small: true });
  assert.match(errorsOf(rt, "not json"), /not JSON/);
  assert.match(errorsOf(rt, ""), /empty/);
  assert.match(errorsOf(rt, js([1])), /not a pack/);
  assert.match(errorsOf(rt, { version: 1, rules: [], extra: 1 }, true), /unknown field extra/);
  assert.match(errorsOf(rt, pack([], 0)), /version/);
  assert.match(errorsOf(rt, pack([], 1.5)), /version/);
  assert.match(errorsOf(rt, { version: 1 }), /rules/);
  assert.match(errorsOf(rt, pack([withRule({ code: "x" })]), true), /unknown field code/);
  assert.match(errorsOf(rt, pack([withRule({ type: "gift" })])), /type/);
  assert.match(errorsOf(rt, pack([withRule({ type: "transferIfOwn" })])), /recipient/);
  assert.match(errorsOf(rt, pack([withRule({ amount: { label: "Monto", regex: ".*" } })])), /unknown field regex/);
  assert.match(errorsOf(rt, pack([withRule({ last4: { label: "Tarjeta", kind: "iban" } })])), /card or account/);
  assert.match(errorsOf(rt, pack([withRule({ subjectHas: [] })])), /short list/);
  assert.match(errorsOf(rt, pack([withRule({ skip: "yes" })])), /true or false/);
  assert.match(errorsOf(rt, pack([GOOD_RULE, GOOD_RULE])), /id used twice/);
});

test("the file is public, so a rule may not hold digits runs, addresses, links, control characters or a bad sender", () => {
  const { rt } = freshApp({ small: true });
  assert.match(errorsOf(rt, pack([withRule({ label: "Compra 1234567" })])), /long number/);
  assert.match(errorsOf(rt, pack([withRule({ subjectHas: ["ana.perez@gmail.test"] })])), /address/);
  assert.match(errorsOf(rt, pack([withRule({ bodyHas: ["https://pay.examplebank.test/x"] })])), /link/);
  assert.match(errorsOf(rt, pack([withRule({ amount: { label: "Monto\u0000" } })])), /control/);
  assert.match(errorsOf(rt, pack([withRule({ sender: "Alertas@ExampleBank.test" })])), /sender/);
  assert.match(errorsOf(rt, pack([withRule({ sender: "not an address" })])), /sender/);
  assert.match(errorsOf(rt, pack([withRule({ label: "x".repeat(121) })])), /too long/);
});

test("size limits: too many rules and a too big file are refused", () => {
  const { rt } = freshApp({ small: true });
  const many = Array.from({ length: 151 }, (_, i) => ({ id: "r" + i, bank: "B", sender: SENDER, label: "L", skip: true, subjectHas: ["a"] }));
  assert.match(errorsOf(rt, pack(many)), /too many rules/);
  assert.match(errorsOf(rt, "x".repeat(40001)), /too big/);
});

test("an ignore rule needs only its match words", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(validate(rt, pack([{ id: "x-skip", bank: "Examplebank", sender: SENDER, label: "Promo", skip: true, subjectHas: ["promocion"] }])).ok, true);
});

// ---- the engine: a data rule reads an e-mail the same way its code twin does ----
const extractWith = (rt, rule, subject, body) => plain(rt.run(`rulePackCompile_(${js(rule)}).extract(${js(subject)}, ${js(body)})`));
const extractCode = (rt, sender, label, subject, body) =>
  plain(rt.run(`EMAIL_RULES.filter(function (r) { return r.sender === ${js(sender)} && r.label === ${js(label)}; })[0].extract(${js(subject)}, ${js(body)})`));
const matchesWith = (rt, rule, subject, body) => rt.run(`rulePackCompile_(${js(rule)}).match(${js(subject)}, ${js(body || "")})`);

const BCP = "notificaciones@notificacionesbcp.com.pe";
const EQUIVALENT = [
  {
    name: "BCP debit-card purchase",
    code: { sender: BCP, label: "Consumo tarjeta de débito" },
    rule: { id: "t1", bank: "BCP", sender: BCP, label: "Consumo tarjeta de débito", subjectHas: ["realizaste un consumo", "debito"], type: "expense", amount: { label: "Total del consumo" },
      merchant: { label: "Empresa" }, last4: { label: "Número de Tarjeta de Débito", kind: "card" }, externalId: { label: "Número de operación" } },
    subject: "Realizaste un consumo con tu tarjeta de débito BCP",
    body: "Total del consumo: S/ 25.50\nEmpresa: Corner Cafe\nNúmero de Tarjeta de Débito: ****1234\nNúmero de operación: 000111"
  },
  {
    name: "BCP utility bill",
    code: { sender: BCP, label: "Pago de servicios" },
    rule: { id: "t2", bank: "BCP", sender: BCP, label: "Pago de servicios", subjectHas: ["constancia de pago de servicio"], type: "expense", amount: { label: "Monto total" },
      description: { labels: ["Empresa", "Servicio"] }, merchant: { label: "Empresa" }, last4: { label: "Cuenta de origen", kind: "card" }, externalId: { label: "Número de operación" } },
    subject: "Constancia de pago de servicios",
    body: "Monto total: S/ 80.00\nEmpresa: Luz Test\nServicio: Recibo de luz\nCuenta de origen: ****1234\nNúmero de operación: 555111"
  },
  {
    name: "Diners purchase (no subject words, merchant between two phrases)",
    code: { sender: "avisos@dinersenlinea.pe", label: "Consumo" },
    rule: { id: "t3", bank: "Diners", sender: "avisos@dinersenlinea.pe", label: "Consumo", type: "expense", merchant: { between: ["en el comercio", "por"] } },
    subject: "Aviso de consumo",
    body: "Se realizó un consumo en el comercio Tienda Prueba por S/ 12.30 con tu tarjeta."
  },
  {
    name: "Interbank transfer to someone else (an expense to review)",
    code: { sender: "servicioalcliente@netinterbank.com.pe", label: "Transferencia" },
    rule: { id: "t4", bank: "Interbank", sender: "servicioalcliente@netinterbank.com.pe", label: "Transferencia", subjectEndsWith: "constancia de transferencia", type: "transferIfOwn",
      amount: { label: "Monto y moneda" }, recipient: { label: "Cuenta destino" }, last4: { label: "Cuenta a cargo", kind: "account" }, externalId: { label: "Código de operación" } },
    subject: "Constancia de transferencia",
    body: "Monto y moneda: S/ 150.00\nCuenta destino: Ana Prueba Test\nCuenta a cargo\nCuenta Simple\nSoles\n000 0000000123\nCódigo de operación: AB1234"
  },
  {
    name: "Interbank Plin payment to someone else",
    code: { sender: "servicioalcliente@netinterbank.com.pe", label: "Pago Plin" },
    rule: { id: "t5", bank: "Interbank", sender: "servicioalcliente@netinterbank.com.pe", label: "Pago Plin", subjectHas: ["constancia de pago plin"], type: "transferIfOwn",
      amount: { label: "Monto y moneda" }, recipient: { label: "Destinatario" }, description: { labels: ["Destinatario"], prefix: "Plin a " }, last4: { label: "Cuenta cargo", kind: "account" }, externalId: { label: "Código de operación" } },
    subject: "Constancia de pago Plin",
    body: "Monto y moneda: S/ 30.00\nDestinatario: Luis Prueba\nCuenta cargo\nCuenta Simple\nSoles\n000 0000000456\nCódigo de operación: CD5678"
  }
];
for (const c of EQUIVALENT) {
  test("equivalence: " + c.name, () => {
    const { rt } = freshApp({ small: true });
    const fromCode = extractCode(rt, c.code.sender, c.code.label, c.subject, c.body);
    const fromData = extractWith(rt, c.rule, c.subject, c.body);
    assert.ok(fromCode && fromCode.amount > 0, "the code rule reads the made-up e-mail");
    assert.deepEqual(fromData, fromCode);
    assert.equal(matchesWith(rt, c.rule, c.subject, c.body), true);
  });
}

test("a data rule refuses the e-mails its code twin refuses, and an unreadable e-mail gives null", () => {
  const { rt } = freshApp({ small: true });
  const r = EQUIVALENT[0].rule;
  assert.equal(matchesWith(rt, r, "Otro asunto", ""), false);
  assert.equal(matchesWith(rt, r, "Realizaste un consumo con tu tarjeta de crédito BCP"), false, "both words are needed");
  assert.equal(matchesWith(rt, r, "REALIZASTE UN CONSUMO con tu tarjeta de DEBITO"), true, "capitals and accents do not matter");
  assert.equal(extractWith(rt, r, "x", "sin monto"), null);
  assert.equal(matchesWith(rt, EQUIVALENT[3].rule, "Constancia de transferencia  "), true);
  assert.equal(matchesWith(rt, EQUIVALENT[3].rule, "Constancia de transferencia a terceros"), false, "subjectEndsWith means the end");
});

test("transferIfOwn: my own name makes a transfer, anyone else an expense to review", () => {
  const { rt } = freshApp({ small: true });
  const rule = EQUIVALENT[3].rule;
  const body = EQUIVALENT[3].body;
  const other = extractWith(rt, rule, "Constancia de transferencia", body);
  assert.equal(other.type, "expense");
  assert.equal(other.needsReview, true);
  rt.run("var __own = isOwnAccount_; isOwnAccount_ = function () { return true; }");
  const mine = extractWith(rt, rule, "Constancia de transferencia", body);
  assert.equal(mine.type, "transfer");
  assert.equal(mine.needsReview, undefined);
  rt.run("isOwnAccount_ = __own");
});

test("a label is plain words: characters that mean something in a pattern are taken literally", () => {
  const { rt } = freshApp({ small: true });
  const rule = withRule({ amount: { label: "Monto (S/.)" }, merchant: { label: "Tienda.*" } });
  const out = extractWith(rt, rule, "Compra con tarjeta", "Monto (S/.): S/ 9.90\nTienda.*: Kiosco\nOtra cosa: nada");
  assert.equal(out.amount, 9.9);
  assert.equal(out.merchant, "Kiosco");
});

// ---- the door and the scan, end to end, with a bank the app has never heard of ----
const emailFor = (rt, extra) => rt.svc.gmail.addEmail(Object.assign({ from: SENDER, subject: "Compra con tarjeta aprobada", body: "Monto: S/ 45.00\nComercio: Corner Cafe\nTarjeta: ****4321\nOperación: OP-9", daysAgo: 0 }, extra || {}));

test("a new bank arrives as data: unknown before, read after setRulePack, listed as supported", () => {
  const { rt } = freshApp({ small: true });
  emailFor(rt);
  const before = rt.rows("Entries").length;
  const mine = () => rt.rows("Entries").filter((e) => e.source === "email" && Number(e.amount) === 45 && e.description === "Corner Cafe" && e.external_id);
  const already = mine().length;
  assert.ok(!rt.api("getMeta").emailInfo.banks.includes("Examplebank"));
  rt.api("checkEmailsNow");
  assert.equal(rt.rows("Entries").length, before, "an unknown sender is not even searched");

  const done = rt.api("setRulePack", { text: js(pack([GOOD_RULE], 3)) });
  assert.deepEqual(plain(done), { version: 3, count: 1, skipped: 0 });
  const info = rt.api("getMeta").emailInfo;
  assert.ok(info.banks.includes("Examplebank"));
  assert.equal(info.rulePack.version, 3);
  assert.equal(info.rulePack.count, 1);
  assert.equal(info.rulePack.error, "");
  assert.ok(plain(rt.api("listSupportedSenders")).some((s) => s.sender === SENDER && s.bank === "Examplebank"));

  clearGap(rt);
  rt.api("checkEmailsNow");
  assert.equal(mine().length, already + 1);
  const made = mine().filter((e) => e.status === "pending" && e.type === "expense");
  assert.ok(made.length >= 1, "anything automated waits in Needs review");
  clearGap(rt);
  rt.api("checkEmailsNow");
  assert.equal(mine().length, already + 1, "the same e-mail is never read twice");
});

test("the rules written in code keep winning, and a refused file leaves the last good pack in place", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: js(pack([GOOD_RULE], 2)) });
  const bad = rt.run(`(function () { try { setRulePack({ text: ${js(js(pack([withRule({ label: "Call 5551234567" })], 9)))} }); return "no error"; } catch (e) { return e.code; } })()`);
  assert.equal(bad, "rule_pack_refused");
  const info = rt.api("getMeta").emailInfo;
  assert.equal(info.rulePack.version, 2, "the good pack is still the one in use");
  assert.match(info.rulePack.error, /long number/);
  assert.ok(info.banks.includes("Examplebank"));
  assert.ok(info.banks.includes("BCP"), "the built-in rules are untouched");
  const order = plain(rt.run("emailRules_().map(function (r) { return r.fromPack ? 'pack' : 'code'; })"));
  assert.equal(order.lastIndexOf("code") < order.indexOf("pack"), true, "pack rules come after every code rule");
});

test("the pack is checked again on every read: a hand-edited Settings cell never reaches the reader unchecked", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: js(pack([GOOD_RULE], 2)) });
  rt.run(`setSetting_('rule_pack', '{"version":2,"rules":[{"id":"x","bank":"Evil","sender":"a@b.test","label":"x","type":"expense","code":"boom"}]}')`);
  assert.ok(!rt.api("getMeta").emailInfo.banks.includes("Evil"));
  assert.ok(!rt.api("getMeta").emailInfo.banks.includes("Examplebank"), "an invalid pack gives no pack rules, never an error");
  assert.ok(rt.api("getMeta").emailInfo.banks.includes("BCP"));
  rt.run("setSetting_('rule_pack', '{ broken')");
  assert.ok(rt.api("getMeta").emailInfo.banks.includes("BCP"));
});

test("the phone is not sent the pack (it can be 40,000 characters); it is sent only its version and count", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: js(pack([GOOD_RULE], 2)) });
  const meta = rt.api("getMeta");
  assert.equal(meta.settings.rule_pack, undefined);
  assert.equal(meta.emailInfo.rulePack.version, 2);
  assert.equal(meta.capabilities.rulePack, true);
});

test("a signed-out caller cannot hand over a pack", () => {
  const { rt } = freshApp({ small: true });
  const res = rt.rawPost(JSON.stringify({ action: "setRulePack", payload: { text: js(pack([GOOD_RULE])) } }));
  assert.equal(res.ok, false);
});

// ---- the public files and the phone ----
// tests/rule-samples/*.json: { "<rule id>": [ { subject, body, expect?, matches? } ] } with MADE-UP text in the bank's layout.
const loadSamples = () => {
  const dir = path.join(root, "tests", "rule-samples");
  const all = {};
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) Object.assign(all, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  return all;
};

test("the live pack file is valid, and every rule in it has a made-up sample that reads as expected", () => {
  const { rt } = freshApp({ small: true });
  const text = read("docs", "rules", "email-rules.json");
  const v = validate(rt, text, true);   // strict: a typo in a field name is caught here, when the rule is written
  assert.equal(v.ok, true, (v.errors || []).join(" | "));
  const samples = loadSamples();
  for (const rule of v.pack.rules) {
    const list = samples[rule.id];
    assert.ok(list && list.length >= 1, `rule "${rule.id}" needs made-up samples in tests/rule-samples/ (a file with a "${rule.id}" list)`);
    for (const s of list) {
      assert.equal(matchesWith(rt, rule, s.subject, s.body), s.matches !== false, `${rule.id}: match`);
      if (s.matches === false) continue;
      const got = extractWith(rt, rule, s.subject, s.body);
      for (const k of Object.keys(s.expect || {})) assert.equal(got && got[k], s.expect[k], `${rule.id}: ${k}`);
    }
  }
});

test("every twin in the live pack reads its made-up samples exactly like the code rule it replaces, and says the same about the entry", () => {
  const { rt } = freshApp({ small: true });
  const v = validate(rt, read("docs", "rules", "email-rules.json"), true);
  const samples = loadSamples();
  const twins = v.pack.rules.filter((r) => r.replaces);
  assert.ok(twins.length >= 12, "the migrated banks are in the pack");
  for (const twin of twins) {
    const same = plain(rt.run(`(function () {
      var t = rulePackCompile_(${js(twin)});
      var code = EMAIL_RULES.filter(function (r) { return r.sender === ${js(twin.sender)} && r.label === ${js(twin.replaces)}; })[0];
      if (!code) return { missing: true };
      var attrs = [];
      ['bank', 'cardIsDestination', 'skip', 'rail', 'exchange', 'accountByCurrency'].forEach(function (k) {
        var x = code[k] === undefined ? null : code[k], y = t[k] === undefined ? null : t[k];
        if (JSON.stringify(x) !== JSON.stringify(y)) attrs.push(k);
      });
      return { missing: false, attrs: attrs };
    })()`));
    assert.equal(same.missing, false, `${twin.id}: no code rule called "${twin.replaces}" for that sender`);
    assert.deepEqual(same.attrs, [], `${twin.id}: the twin says something different about the entry than the code rule`);
    for (const s of samples[twin.id] || []) {
      const out = plain(rt.run(`(function () {
        var t = rulePackCompile_(${js(twin)});
        var code = EMAIL_RULES.filter(function (r) { return r.sender === ${js(twin.sender)} && r.label === ${js(twin.replaces)}; })[0];
        var cm = !!code.match(${js(s.subject)}, ${js(s.body)}), tm = !!t.match(${js(s.subject)}, ${js(s.body)});
        var a = cm && !code.skip ? code.extract(${js(s.subject)}, ${js(s.body)}) : null, b = tm && !t.skip ? t.extract(${js(s.subject)}, ${js(s.body)}) : null;
        return { cm: cm, tm: tm, diff: rulePackDiffFields_(a, b) };
      })()`));
      assert.equal(out.tm, out.cm, `${twin.id}: the twin and the code rule must match the same e-mails`);
      assert.deepEqual(out.diff, [], `${twin.id}: fields that differ`);
    }
  }
});

test("the promoted copy for friends, when it exists, is valid too", () => {
  const f = path.join(root, "docs", "setup", "rules.json");
  if (!fs.existsSync(f)) return;
  const { rt } = freshApp({ small: true });
  const v = validate(rt, fs.readFileSync(f, "utf8"), true);
  assert.equal(v.ok, true, (v.errors || []).join(" | "));
});

test("the phone reads the live file on the owner's copy, the promoted one on a friend's, and only sends a new version", () => {
  const app = read("docs", "app.js");
  const fn = app.slice(app.indexOf("async function syncRulePack_"), app.indexOf("async function syncRulePack_") + 2200);
  assert.match(fn, /perfIsOwnerCopy_\(\) \? "rules\/email-rules\.json" : "setup\/rules\.json"/);
  assert.match(fn, /have\.version === version/);
  assert.match(fn, /caps\.rulePack/);
  assert.match(app, /checkBackendUpdate_\(\);\n  syncRulePack_\(\);/);
});

test("only promote writes docs/setup/rules.json, and the live rules folder is not part of the friends' frozen screens", () => {
  const promote = read("promote.sh");
  assert.match(promote, /cp "\$SRC\/docs\/rules\/email-rules\.json" "\$W\/docs\/setup\/rules\.json"/);
  assert.match(promote, /--exclude='\/rules\/'/);
  assert.match(promote, /PATHS\+=\(docs\/setup\/rules\.json\)/);
});
