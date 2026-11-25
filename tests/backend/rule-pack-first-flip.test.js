// Pack v10 (2026-11-25, owner's go after the shadow week): the Diners and SIP twins go in FRONT of their code rules (`first`). The code rules
// stay behind them as the fallback. BCP and Interbank stay behind. Made-up samples only (tests/rule-samples/).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const PACK_TEXT = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8");
const PACK = JSON.parse(PACK_TEXT);
const sample = (bank) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "rule-samples", bank + ".json"), "utf8"));
const FIRST = ["diners-consumo", "diners-pago-tarjeta", "sip-consumo", "sip-pago-tarjeta", "sip-agora-pago-tarjeta-ignorado", "sip-transferencia-otro-banco"];

test("the live pack passes the owner's strict check", () => {
  const { rt } = freshApp({ small: true });
  const res = plain(rt.run(`rulePackValidate_(${js(PACK_TEXT)}, { strict: true })`));
  assert.equal(res.ok, true, (res.errors || []).join("; "));
});

test("exactly the Diners and SIP twins are first; BCP and Interbank twins stay behind their code rules", () => {
  const first = PACK.rules.filter((r) => r.first === true).map((r) => r.id).sort();
  assert.deepEqual(first, FIRST.slice().sort());
  PACK.rules.filter((r) => r.replaces && /^(BCP|Interbank)$/.test(r.bank)).forEach((r) => assert.notEqual(r.first, true, r.id));
});

test("each first twin still matches its made-up samples and reads them like its code rule", () => {
  const { rt } = freshApp({ small: true });
  const samples = Object.assign({}, sample("diners"), sample("sip"));
  FIRST.forEach((id) => {
    const rule = PACK.rules.find((r) => r.id === id);
    const code = `EMAIL_RULES.filter(function (r) { return r.sender === ${js(rule.sender)} && r.label === ${js(rule.replaces)}; })[0]`;
    (samples[id] || []).forEach((s) => {
      const want = s.matches !== false;
      assert.equal(rt.run(`rulePackCompile_(${js(rule)}).match(${js(s.subject)}, ${js(s.body)})`), want, id + " matches its sample as expected");
      if (!want) return;
      if (rule.skip) return;
      const a = plain(rt.run(`rulePackCompile_(${js(rule)}).extract(${js(s.subject)}, ${js(s.body)})`));
      const b = plain(rt.run(`(${code}).extract(${js(s.subject)}, ${js(s.body)})`));
      assert.deepEqual(plain(rt.run(`rulePackDiffFields_(${js(a)}, ${js(b)})`)), [], id + " reads like its code rule");
    });
  });
});

test("with the live pack loaded, each Diners and SIP twin sits in front of its code rule", () => {
  const { rt } = freshApp({ small: true });
  rt.api("setRulePack", { text: PACK_TEXT });
  const order = plain(rt.run("emailRules_().map(function (r) { return r.packId || r.label; })"));
  FIRST.forEach((id) => {
    const rule = PACK.rules.find((r) => r.id === id);
    const codeAt = order.indexOf(rule.replaces);
    assert.ok(order.indexOf(id) >= 0 && order.indexOf(id) < codeAt, id + " sits before its code rule");
  });
});
