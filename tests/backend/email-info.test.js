// getMeta().emailInfo (More → Bank emails and the "can't read this bank yet" notes): which banks have a parsing rule,
// and the address whose inbox is read (only when e-mail reading is on).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("emailInfo lists the banks that have a rule, once each", () => {
  const { rt } = freshApp({ small: true });
  const info = rt.api("getMeta").emailInfo;
  assert.ok(info.banks.includes("BCP") && info.banks.includes("Interbank"));
  assert.equal(new Set(info.banks).size, info.banks.length);
  assert.ok(!info.banks.includes("BBVA"), "a bank with no rule is not listed");
  assert.equal(typeof info.address, "string");
});

test("without e-mail reading turned on there is no address to show", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  assert.equal(rt.api("getMeta").emailInfo.address, "");
});

// ---- "Has an e-mail from this bank arrived yet?" (More → Bank emails ticks each bank; the Home first-steps card uses it too) ----
const { bcpEmail } = require("./helpers");
const runMail = (rt) => rt.run("processEmails()");

test("emailInfo.seen is empty until a bank's first e-mail becomes an entry, then holds that day", () => {
  const { rt } = freshApp({ small: true });
  assert.deepEqual(rt.api("getMeta").emailInfo.seen, {});
  bcpEmail(rt, { op: "SEEN-1" });
  runMail(rt);
  const seen = rt.api("getMeta").emailInfo.seen;
  assert.deepEqual(Object.keys(seen), ["BCP"]);
  assert.match(seen.BCP, /^\d{4}-\d{2}-\d{2}$/);
});

test("an older e-mail never moves a bank's last-seen day backwards", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "NEW-1", daysAgo: 0 });
  runMail(rt);
  const first = rt.api("getMeta").emailInfo.seen.BCP;
  bcpEmail(rt, { op: "OLD-1", daysAgo: 2 });
  runMail(rt);
  assert.equal(rt.api("getMeta").emailInfo.seen.BCP, first);
});

test("the welcome questions stamp when they were first answered, and a second answer keeps the first stamp", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.api("getMeta").emailInfo.since, "");
  rt.api("saveOnboarding", { language: "en", dateOrder: "dmy", currencies: [] });
  const since = rt.api("getMeta").emailInfo.since;
  assert.match(since, /^\d{12,}$/);
  rt.api("saveOnboarding", { language: "es", dateOrder: "dmy", currencies: [] });
  assert.equal(rt.api("getMeta").emailInfo.since, since);
});
