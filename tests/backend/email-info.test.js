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
