// Access-code protection (2026-10-05). Apps Script can't see who is calling, so a
// lockout would let anyone lock the owner out. Instead: refuse weak codes, offer a
// strong generated one, and ALERT on bursts of wrong guesses (never block).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const wrong = (rt, n = 1, code = "guess") => {
  for (let i = 0; i < n; i++) rt.rawPost(JSON.stringify({ accessCode: code + i, action: "getMeta", payload: {} }));
};
const alertsSent = (rt) => rt.svc.fetchLog.filter((f) => /wrong access-code attempts/.test(f.options.payload));

test("a correct code is never counted, delayed or blocked, even after many wrong guesses", () => {
  const { rt } = freshApp({ entries: 100 });
  linkTelegram(rt);
  wrong(rt, 60);
  const res = rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }));
  assert.equal(res.ok, true, "the owner still gets in");
});

test("a wrong code is rejected exactly as before", () => {
  const { rt } = freshApp({ entries: 100 });
  const res = rt.rawPost(JSON.stringify({ accessCode: "nope", action: "getMeta", payload: {} }));
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid access code/i);
});

test("a burst of wrong guesses sends ONE Telegram alert per level (10, 50, 250), not one per guess", () => {
  const { rt } = freshApp({ entries: 100 });
  linkTelegram(rt);
  wrong(rt, 9);
  assert.equal(alertsSent(rt).length, 0, "9 is still quiet");
  wrong(rt, 1);
  assert.equal(alertsSent(rt).length, 1, "the 10th triggers the first alert");
  wrong(rt, 30);
  assert.equal(alertsSent(rt).length, 1, "no repeat until the next level");
  wrong(rt, 10);                                  // 50th total
  assert.equal(alertsSent(rt).length, 2);
  assert.match(alertsSent(rt)[1].options.payload, /50/);
});

test("with Telegram not linked, wrong guesses are still handled without errors", () => {
  const { rt } = freshApp({ entries: 100 });
  const res = rt.rawPost(JSON.stringify({ accessCode: "x", action: "getMeta", payload: {} }));
  assert.equal(res.ok, false);
  wrong(rt, 15);
});

test("a Telegram alert that fails to send never breaks the rejection", () => {
  const { rt } = freshApp({ entries: 100 });
  linkTelegram(rt);
  rt.state.fetchHandler = () => { throw new Error("network down"); };
  wrong(rt, 12);
  const res = rt.rawPost(JSON.stringify({ accessCode: "x", action: "getMeta", payload: {} }));
  assert.equal(res.ok, false);
});

test("wrong codes sent to the Telegram /start link-up count toward the alert too", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  rt.svc.props.set("TELEGRAM_CHAT_ID", "555");
  for (let i = 0; i < 10; i++) {
    rt.rawPost(JSON.stringify({ update_id: 100 + i, message: { message_id: i, chat: { id: 999 }, text: "/start wrong" + i } }));
  }
  assert.equal(alertsSent(rt).length, 1);
});

test("a weak code is refused when setting one", () => {
  const { rt } = freshApp({ entries: 100 });
  const before = rt.svc.props.get("ACCESS_CODE");
  for (const weak of ["abc", "password123", "1234567890", "aaaaaaaaaaaaaaaaaaaa"]) {
    rt.state.promptResponse = weak;
    rt.run("promptSetAccessCode()");
    assert.equal(rt.svc.props.get("ACCESS_CODE"), before, weak + " must be refused");
  }
  assert.ok(rt.svc.uiLog.some((m) => /too (short|weak|simple)|at least/i.test(m)));
});

test("a long code is accepted when setting one", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.state.promptResponse = "k7Qp2xVn9LdR4sTa8WmY3zBc6HfJ1uEg";
  rt.run("promptSetAccessCode()");
  assert.equal(rt.svc.props.get("ACCESS_CODE"), "k7Qp2xVn9LdR4sTa8WmY3zBc6HfJ1uEg");
});

test("the generator makes long, different, acceptable codes", () => {
  const { rt } = freshApp({ entries: 100 });
  const a = rt.run("generateAccessCode_()"), b = rt.run("generateAccessCode_()");
  assert.ok(a.length >= 32 && b.length >= 32);
  assert.notEqual(a, b);
  assert.equal(rt.run(`accessCodeProblem_(${JSON.stringify(a)})`), "");
});

test("'Generate a strong access code' asks first, then replaces the code and shows the new one once", () => {
  const { rt } = freshApp({ entries: 100 });
  const old = rt.svc.props.get("ACCESS_CODE");
  rt.state.alertButton = "NO";
  rt.run("menuGenerateAccessCode()");
  assert.equal(rt.svc.props.get("ACCESS_CODE"), old, "declined: nothing changes");

  rt.state.alertButton = "YES";
  rt.run("menuGenerateAccessCode()");
  const now = rt.svc.props.get("ACCESS_CODE");
  assert.notEqual(now, old);
  assert.ok(rt.svc.uiLog.some((m) => m.includes(now)), "the new code is shown to the owner");
  assert.equal(rt.rawPost(JSON.stringify({ accessCode: old, action: "getMeta", payload: {} })).ok, false, "old code stops working");
});

test("'Check access code strength' reports length and a verdict, never the code", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("ACCESS_CODE", "short");
  rt.run("menuCheckAccessCodeStrength()");
  let said = rt.svc.uiLog.join(" ");
  assert.match(said, /5 characters/);
  assert.match(said, /too short|weak|change/i);
  assert.ok(!said.includes("short\n") && !/code is "short"/.test(said));

  rt.svc.uiLog.length = 0;
  rt.svc.props.set("ACCESS_CODE", "k7Qp2xVn9LdR4sTa8WmY3zBc6HfJ1uEg");
  rt.run("menuCheckAccessCodeStrength()");
  said = rt.svc.uiLog.join(" ");
  assert.match(said, /32 characters/);
  assert.match(said, /strong/i);
  assert.ok(!said.includes("k7Qp2xVn9LdR4sTa8WmY3zBc6HfJ1uEg"), "the code itself is never displayed");
});
