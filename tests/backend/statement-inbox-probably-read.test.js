// Inbox "probably already read" (owner, 2026-11-11): only when EVERY account the e-mail could be about already has a saved statement
// ending in the 40 days before the e-mail arrived. It used to be by bank: one saved statement hid the bank's other accounts' statements
// from "Open all". Made-up accounts and dates only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const accts = [{ last_4: "1111" }, { last_4: "2222" }, { last_4: "3333" }];
const read = (rt, received, uploads) => run(rt, `stmtInboxProbablyRead_(${JSON.stringify(received)}, ${JSON.stringify(accts)}, ${JSON.stringify(uploads)})`);

test("one saved statement of a bank does not hide the bank's other statements", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(read(rt, "2026-11-03", [{ account_key: "1111", period_end: "2026-10-30" }]), false);
});

test("every account saved for that cycle: probably read", () => {
  const { rt } = freshApp({ small: true });
  const ups = ["1111", "2222", "3333"].map((k) => ({ account_key: k, period_end: "2026-10-30" }));
  assert.equal(read(rt, "2026-11-03", ups), true);
});

test("an older cycle does not count, and no matching account means never read", () => {
  const { rt } = freshApp({ small: true });
  const old = ["1111", "2222", "3333"].map((k) => ({ account_key: k, period_end: "2026-08-30" }));
  assert.equal(read(rt, "2026-11-03", old), false, "two months back is another statement");
  assert.equal(run(rt, `stmtInboxProbablyRead_("2026-11-03", [], [])`), false);
});
