// More → Bank emails: what each bank's e-mails cover (BankCoverage.gs) and how necessary an entry added by hand was (ManualGaps.gs gapNeed_).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const runMail = (rt) => rt.run("processEmails()");

test("every kind a bank shows comes from a real rule, and nothing is listed twice", () => {
  const { rt } = freshApp({ small: true });
  const cov = rt.api("getMeta").emailInfo.coverage;
  assert.ok(cov.BCP && cov.Interbank && cov.Diners && cov.SIP && cov.Yape);
  const bcp = cov.BCP.kinds.map((k) => k.key);
  assert.deepEqual(bcp, ["purchase", "bill", "transfer_out", "yape_in"]);
  assert.deepEqual(cov.Yape.kinds.map((k) => k.key), ["yape_out"]);
  assert.ok(cov.Interbank.kinds.some((k) => k.key === "plin_out"));
  Object.keys(cov).forEach((bank) => {
    const keys = cov[bank].kinds.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length, bank + " lists a kind twice");
  });
  const kinds = JSON.parse(rt.run("JSON.stringify(emailRules_().filter(function (r) { return r.bank && !r.skip; }).map(function (r) { return bankKindOfRule_(r); }))"));
  assert.ok(!kinds.includes("other"), "every code rule maps to a named kind");
});

test("an ignored rule does not make a kind appear", () => {
  const { rt } = freshApp({ small: true });
  const cov = rt.api("getMeta").emailInfo.coverage;
  assert.ok(!cov.SIP.kinds.some((k) => k.key === "other"));
});

test("only the owner-confirmed 'no e-mail' facts are listed, never a guess about Yape", () => {
  const { rt } = freshApp({ small: true });
  const cov = rt.api("getMeta").emailInfo.coverage;
  assert.deepEqual(cov.BCP.none, ["money_in"]);
  assert.deepEqual(cov.Yape.none, []);
  assert.deepEqual(cov.Diners.none, []);
});

test("a kind starts with no day and gets the day an e-mail of that kind became an entry", () => {
  const { rt } = freshApp({ small: true });
  const day = (cov, bank, kind) => cov[bank].kinds.find((k) => k.key === kind).seen;
  const before = rt.api("getMeta").emailInfo.coverage;
  assert.equal(day(before, "BCP", "purchase"), "");
  bcpEmail(rt, { op: "COV-1" });
  runMail(rt);
  const after = rt.api("getMeta").emailInfo.coverage;
  assert.match(day(after, "BCP", "purchase"), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(day(after, "BCP", "bill"), "", "another kind of the same bank is not marked");
});

test("an older e-mail never moves a kind's day backwards", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "COV-NEW", daysAgo: 0 });
  runMail(rt);
  const first = rt.api("getMeta").emailInfo.coverage.BCP.kinds.find((k) => k.key === "purchase").seen;
  bcpEmail(rt, { op: "COV-OLD", daysAgo: 2 });
  runMail(rt);
  assert.equal(rt.api("getMeta").emailInfo.coverage.BCP.kinds.find((k) => k.key === "purchase").seen, first);
});

// ---- how necessary adding it by hand was ----
const COV = {
  BCP: { kinds: [{ key: "purchase", seen: "" }, { key: "yape_in", seen: "" }], none: ["money_in"] },
  Yape: { kinds: [{ key: "yape_out", seen: "" }], none: [] },
  Interbank: { kinds: [{ key: "purchase", seen: "" }, { key: "plin_out", seen: "2026-10-30" }], none: [] }
};
const need = (item, extra) => {
  const { rt } = freshApp({ small: true });
  const ctx = Object.assign({ emailBanks: ["BCP", "Yape", "Interbank"], coverage: COV, bankSeen: {} }, extra || {});
  return JSON.parse(rt.run(`JSON.stringify(gapNeed_(${JSON.stringify(item)}, gapClassify_(${JSON.stringify(item)}, ${JSON.stringify(ctx)}), ${JSON.stringify(ctx)}))`));
};

test("nothing an e-mail cannot bring is ever called optional", () => {
  assert.equal(need({ source: "manual", direction: "out", text: "lunch", pmType: "cash" }), "must");
  assert.equal(need({ source: "manual", direction: "out", text: "dinner", paidByFriend: true }), "must");
  assert.equal(need({ source: "manual", direction: "out", text: "x", bankName: "BBVA" }), "must");
  assert.equal(need({ source: "manual", direction: "in", text: "Plin de Ana Lo*" }), "must");
  assert.equal(need({ source: "manual", direction: "in", text: "sueldo", bankName: "BCP" }), "must", "money received in an account sends no e-mail");
  assert.equal(need({ source: "manual", direction: "out", text: "Yape a Ana Lo*", amount: 4, currency: "PEN" }), "must", "Yape e-mails start at S/ 10");
});

test("an e-mail exists but none reached the person: 'check', not optional", () => {
  assert.equal(need({ source: "manual", direction: "out", text: "Yape a Ana Lo*", amount: 25, currency: "PEN" }), "check");
  assert.equal(need({ source: "manual", direction: "out", text: "Mercado", bankName: "BCP" }), "check");
  assert.equal(need({ source: "manual", direction: "in", text: "Yape de Ana Lo*", bankName: "BCP" }), "check");
});

test("e-mails of that kind or bank really arrive: adding by hand was optional", () => {
  assert.equal(need({ source: "manual", direction: "out", text: "Plin a Ana Lo*", bankName: "Interbank" }), "optional");
  assert.equal(need({ source: "manual", direction: "out", text: "Mercado", bankName: "BCP" }, { bankSeen: { BCP: "2026-10-31" } }), "optional");
  assert.equal(need({ source: "manual", direction: "out", text: "Mercado", bankName: "bcp" }, { bankSeen: { BCP: "2026-10-31" } }), "optional");
});

test("a line only a statement revealed was not captured, so it is never optional", () => {
  assert.equal(need({ source: "statement", direction: "out", text: "Mercado", bankName: "BCP" }, { bankSeen: { BCP: "2026-10-31" } }), "check");
});

test("without coverage nothing is claimed", () => {
  const { rt } = freshApp({ small: true });
  const r = rt.run(`JSON.stringify(gapSummarize_([{ source: "manual", direction: "out", text: "a", pmType: "cash", date: "2026-10-01", amount: 1, currency: "PEN" }], { emailBanks: [] }, false))`);
  assert.equal(JSON.parse(r)[0].need, undefined);
});

test("groups come out must, check, optional; each lists its newest 20 things, newest first", () => {
  const { rt } = freshApp({ small: true });
  const items = [];
  for (let i = 1; i <= 25; i++) items.push({ source: "manual", direction: "out", text: "cash " + i, pmType: "cash", date: "2026-10-" + String(i).padStart(2, "0"), amount: i, currency: "PEN" });
  items.push({ source: "manual", direction: "out", text: "Mercado", bankName: "BCP", date: "2026-10-02", amount: 9, currency: "PEN" });
  items.push({ source: "manual", direction: "out", text: "Cena", bankName: "BCP", date: "2026-10-03", amount: 9, currency: "PEN" });
  const ctx = { emailBanks: ["BCP"], coverage: COV, bankSeen: { BCP: "2026-10-31" } };
  const out = JSON.parse(rt.run(`JSON.stringify(gapSummarize_(${JSON.stringify(items)}, ${JSON.stringify(ctx)}, false, true, 20))`));
  assert.deepEqual(out.map((g) => g.need + ":" + g.key), ["must:cash", "optional:other_manual"]);
  assert.equal(out[0].count, 25);
  assert.equal(out[0].items.length, 20);
  assert.equal(out[0].items[0].description, "cash 25");
  assert.equal(out[0].items[19].description, "cash 6");
  assert.equal(out[1].items.length, 2);
});

test("getManualGaps hands the groups with a need and their entries to the app", () => {
  const { rt } = freshApp({ small: true });
  const gaps = rt.api("getManualGaps");
  gaps.kinds.forEach((k) => {
    assert.ok(["must", "check", "optional"].includes(k.need));
    assert.ok(Array.isArray(k.items) && k.items.length > 0 && k.items.length <= 20);
    assert.ok(k.items.length === Math.min(20, k.count));
  });
});
