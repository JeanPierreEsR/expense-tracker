// Pack v11 (2026-11-26, owner: "build group A and try B"): twins for the last code-only bank rules that the pack can describe — BCP "a otros
// bancos", Interbank Plin, SIP "Enviar a celular", Crecer Seguros (group A) and the three Yape rules (group B). They sit BEHIND their code
// rules (no `first`) until the twin check on the owner's real mail says they read alike. New pack words: `rail`, `review`, `category`,
// `accountsOfBank`, `amount.orLabel`, `merchant.text`, `recipient.initialOk|between|skipWords`, `description.ownText|orText|spaceWords`.
// Made-up samples only (tests/rule-samples/).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const PACK_TEXT = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8");
const PACK = JSON.parse(PACK_TEXT);
const SAMPLES = {};
for (const f of fs.readdirSync(path.join(__dirname, "..", "rule-samples")).filter((x) => x.endsWith(".json"))) {
  Object.assign(SAMPLES, JSON.parse(fs.readFileSync(path.join(__dirname, "..", "rule-samples", f), "utf8")));
}
const WAVE2 = ["bcp-transferencia-otros-bancos", "bcp-yapeo-recibido", "crecer-seguro-tarjetas", "yape-enviado", "yape-enviado-dolares",
  "interbank-pago-plin", "sip-enviar-a-celular"];
const NEW_WORDS = ["rail", "review", "category", "accountsOfBank", "orLabel", "text", "initialOk", "between", "skipWords", "ownText", "orText", "spaceWords"];
const twin = (id) => PACK.rules.find((r) => r.id === id);
const codeOf = (t) => `EMAIL_RULES.filter(function (r) { return r.sender === ${js(t.sender)} && r.label === ${js(t.replaces)}; })[0]`;

test("pack v11 holds the seven new twins, none of them in front of its code rule yet", () => {
  assert.ok(PACK.version >= 11);
  for (const id of WAVE2) {
    const t = twin(id);
    assert.ok(t, id + " is in the pack");
    assert.ok(t.replaces, id + " is a twin");
    assert.notEqual(t.first, true, id + " waits behind its code rule until the twin check passes");
  }
});

test("each new twin, put in front, makes the SAME entry from its sample as the code rule does on its own", () => {
  for (const id of WAVE2) {
    for (const s of SAMPLES[id].filter((x) => x.matches !== false)) {
      const entryWith = (pack) => {
        const { rt } = freshApp({ small: true });
        if (pack) {
          const res = rt.api("setRulePack", { text: js({ version: 99, rules: [Object.assign({}, twin(id), { first: true })] }) });
          assert.deepEqual([res.count, res.skipped], [1, 0], id + ": the twin loaded");
          const first = plain(rt.run(`(function () { var r = emailRules_().filter(function (x) { return x.sender === ${js(twin(id).sender)} && x.match(${js(s.subject)}, ${js(s.body)}); })[0]; return r && r.packId; })()`));
          assert.equal(first, id, id + ": the twin is the rule that reads it");
        }
        rt.svc.gmail.addEmail({ from: twin(id).sender, subject: s.subject, body: s.body, daysAgo: 0 });
        rt.svc.props.delete("EMAIL_SCAN_LAST_AT");
        rt.run("processEmails()");
        const e = rt.rows("Entries").filter((x) => x.source === "email" && Number(x.amount) === s.expect.amount).pop();
        assert.ok(e, id + ": an entry was made" + (pack ? " by the twin" : ""));
        // Two fresh copies give their rows different ids: compare accounts and categories by name.
        const pm = (id) => (rt.rows("Payment Methods").find((p) => p.id === id) || {}).nickname || "";
        const cat = (id) => (rt.rows("Categories").find((c) => c.id === id) || {}).name || "";
        return { type: e.type, status: e.status, amount: String(e.amount), currency: e.currency, description: e.description,
          from: pm(e.payment_method_id), to: pm(e.to_payment_method_id), category: cat(e.category_id) };
      };
      assert.deepEqual(entryWith(true), entryWith(false), id + ": the entry differs");
    }
  }
});

test("a Yape twin knows the money is BCP's and that it moved by Yape, like its code rule", () => {
  const { rt } = freshApp({ small: true });
  for (const id of ["yape-enviado", "yape-enviado-dolares", "bcp-yapeo-recibido"]) {
    const attrs = plain(rt.run(`(function () { var t = rulePackCompile_(${js(twin(id))}), c = ${codeOf(twin(id))};
      return [JSON.stringify([c.rail, c.accountByCurrency]), JSON.stringify([t.rail, t.accountByCurrency])]; })()`));
    assert.equal(attrs[1], attrs[0], id);
  }
});

test("BCP to another bank: my own name printed with only the last surname's initial is a transfer in the twin too", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const s = SAMPLES["bcp-transferencia-otros-bancos"][0];
  const body = s.body.replace("Ana Ramos Torres", "Eva Carla Ramos T.");
  const out = plain(rt.run(`(function () { var t = rulePackCompile_(${js(twin("bcp-transferencia-otros-bancos"))}), c = ${codeOf(twin("bcp-transferencia-otros-bancos"))};
    var a = c.extract(${js(s.subject)}, ${js(body)}), b = t.extract(${js(s.subject)}, ${js(body)});
    return { type: b.type, review: b.needsReview, diff: rulePackDiffFields_(a, b) }; })()`));
  assert.deepEqual(out, { type: "transfer", review: false, diff: [] });
});

test("Plin and 'Enviar a celular' to myself: the twin writes the same '(propio)' description as the code rule", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const cases = [["interbank-pago-plin", "ANA PRUEBA", "Plin (propio)"], ["sip-enviar-a-celular", "Ana Prueba Lopez", "Envío a celular (propio)"]];
  for (const [id, other, want] of cases) {
    const s = SAMPLES[id][0];
    const body = s.body.replace(other, "Eva Carla Ramos Torres");
    const out = plain(rt.run(`(function () { var t = rulePackCompile_(${js(twin(id))}), c = ${codeOf(twin(id))};
      var a = c.extract(${js(s.subject)}, ${js(body)}), b = t.extract(${js(s.subject)}, ${js(body)});
      return { type: b.type, description: b.description, diff: rulePackDiffFields_(a, b) }; })()`));
    assert.deepEqual(out, { type: "transfer", description: want, diff: [] }, id);
  }
});

test("an older backend, which does not know the new words, skips only the seven new twins and keeps every other rule", () => {
  const { rt } = freshApp({ small: true });
  // Pretend to be an older backend: every new word gets a name this backend does not know either.
  const older = JSON.parse(PACK_TEXT);
  const rename = (o) => { for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) rename(o[k]); if (NEW_WORDS.includes(k)) { o[k + "Newer"] = o[k]; delete o[k]; } } };
  older.rules.filter((r) => WAVE2.includes(r.id)).forEach(rename);
  const v = plain(rt.run(`rulePackValidate_(${js(js(older))}, { strict: false })`));
  assert.ok(v.ok, js(v.errors));
  const kept = v.pack.rules.map((r) => r.id);
  WAVE2.forEach((id) => assert.ok(!kept.includes(id), id + " is skipped"));
  assert.equal(kept.length, PACK.rules.length - WAVE2.length, "every other rule still loads");
});

test("the new words are checked: a wrong rail, a negative skipWords or a link in a category are refused", () => {
  const { rt } = freshApp({ small: true });
  const base = twin("yape-enviado-dolares");
  const bad = [{ rail: "paypal" }, { recipient: Object.assign({}, base.recipient, { skipWords: -1 }) }, { category: { name: "see https://example.com" } }];
  for (const change of bad) {
    const v = plain(rt.run(`rulePackValidate_(${js(js({ version: 1, rules: [Object.assign({}, base, change)] }))}, { strict: true })`));
    assert.equal(v.ok, false, js(change));
  }
});
