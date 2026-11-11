// A statement's balance check for a currency the account has no starting balance in (owner, 2026-11-11): the app counts that currency
// from 0 on the date of the account's other starting balance, and the check says so, since that is a likely cause of an unexplained
// difference. Made-up accounts and amounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

test("a currency with no starting balance of its own says so", () => {
  const { rt } = freshApp({ small: true });
  const e = { id: "apple", date: "2019-03-08", type: "expense", amount: 50, currency: "USD", payment_method_id: "pm-c", status: "confirmed", description: "Apple" };
  const args = { pm: { id: "pm-c", nickname: "Card C", type: "credit" }, currency: "USD", closing: -60, start: "2019-03-01", end: "2019-03-20", lines: [],
    openings: [{ currency: "PEN", amount: 0, date: "2019-03-10" }], confirmed: [e], inboundIds: {}, entryById: { apple: e } };
  const c = run(rt, "stmtBalanceCheck_(" + JSON.stringify(args) + ")");
  assert.equal(c.direction, "forward");
  assert.deepEqual(c.noAnchor, { date: "2019-03-10" });
  assert.equal(c.appAtEnd, 0, "counted from 0; the purchase before that date does not count");
  assert.equal(c.unexplained, -60);
});

test("a currency with its own starting balance gets no note", () => {
  const { rt } = freshApp({ small: true });
  const args = { pm: { id: "pm-c", nickname: "Card C", type: "credit" }, currency: "USD", closing: -60, start: "2019-03-01", end: "2019-03-20", lines: [],
    openings: [{ currency: "USD", amount: -50, date: "2019-03-10" }], confirmed: [], inboundIds: {}, entryById: {} };
  assert.equal(run(rt, "stmtBalanceCheck_(" + JSON.stringify(args) + ")").noAnchor, undefined);
});
