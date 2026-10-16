// Stage 1 of the friends & family rollout: optional abilities (FEATURES), this copy's own web
// address (WEB_APP_URL) and polite behaviour when an optional Google approval was not given.
// Made-up data only; the fake Google layer records every outgoing call.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const URL_A = "https://script.google.com/macros/s/AKfycbMadeUpAddressOne/exec";
const URL_B = "https://script.google.com/macros/s/AKfycbMadeUpAddressTwo/exec";
const pings = (rt) => rt.svc.fetchLog.filter((f) => /macros\/s\//.test(f.url));
// Counts every call that reaches Gmail, whichever way of reading e-mail is in use.
const countGmail = (rt) => {
  let n = 0;
  const wrap = (obj, key) => { const orig = obj[key]; obj[key] = (...a) => { n++; return orig(...a); }; };
  wrap(rt.svc.gmail.api, "search");
  wrap(rt.svc.gmail.advanced.Users.Messages, "list");
  return () => n;
};

test("owner's copy: no FEATURES setting means everything is on", () => {
  const { rt } = freshApp({ small: true });
  for (const f of ["base", "keepawake", "gmail"]) assert.equal(rt.run(`featureOn_("${f}")`), true, f);
});

test("FEATURES lists what was approved; 'base' is always on", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "keepawake");
  assert.equal(rt.run('featureOn_("base")'), true);
  assert.equal(rt.run('featureOn_("keepawake")'), true);
  assert.equal(rt.run('featureOn_("gmail")'), false);
  rt.svc.props.set("FEATURES", "base");
  assert.equal(rt.run('featureOn_("keepawake")'), false);
  rt.svc.props.set("FEATURES", " keepawake , gmail ");
  assert.equal(rt.run('featureOn_("gmail")'), true, "spaces are ignored");
});

test("the keep-awake ping uses this copy's own address, and does nothing without it or without approval", () => {
  const { rt } = freshApp({ small: true });
  rt.run("pingWebApp_()");
  assert.equal(pings(rt).length, 0, "no address known yet: nothing is called");
  rt.svc.props.set("WEB_APP_URL", URL_A);
  rt.run("pingWebApp_()");
  assert.equal(pings(rt).length, 1);
  assert.equal(pings(rt)[0].url, URL_A);
  rt.svc.props.set("FEATURES", "gmail");   // keep-awake was never approved
  rt.run("pingWebApp_()");
  assert.equal(pings(rt).length, 1, "not approved: no second call");
});

test("a signed-in request teaches the backend its own address once; a bad address is ignored; sign-in alone teaches nothing", () => {
  const { rt } = freshApp({ small: true });
  const post = (extra) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {}, ...extra }));
  assert.equal(post({ apiUrl: "http://evil.example/exec" }).ok, true);
  assert.equal(rt.run("getWebAppUrl_()"), "", "not a real Apps Script address");
  rt.rawPost(JSON.stringify({ action: "login", payload: { code: rt.ACCESS_CODE }, apiUrl: URL_B }));
  assert.equal(rt.run("getWebAppUrl_()"), "", "the sign-in request itself teaches nothing");
  post({ apiUrl: URL_A });
  assert.equal(rt.run("getWebAppUrl_()"), URL_A);
  post({ apiUrl: URL_B });
  assert.equal(rt.run("getWebAppUrl_()"), URL_A, "the first one is kept");
});

test("the Telegram webhook target is this copy's address, and a missing one gives a plain message", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.run("getTelegramWebhookTargetUrl_()"), /web address is not saved yet/);
  rt.svc.props.set("WEB_APP_URL", URL_A);
  assert.equal(rt.run("getTelegramWebhookTargetUrl_()"), URL_A);
  rt.svc.props.set("TELEGRAM_RELAY_URL", "https://relay.example.workers.dev");
  assert.equal(rt.run("getTelegramWebhookTargetUrl_()"), "https://relay.example.workers.dev", "a relay still wins");
});

test("without the bank-e-mail approval the automatic scan never touches Gmail, and still finishes cleanly", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "10.00", op: "900001" });
  const gmailCalls = countGmail(rt);
  rt.svc.props.set("FEATURES", "keepawake");
  rt.run("runAutomation()");
  assert.equal(gmailCalls(), 0, "Gmail was not approved: not even a search");
  assert.equal(rt.svc.props.get("LAST_AUTOMATION_OK") ? true : false, true, "no failure is reported for a skipped step");
});

test("with the approval (or on the owner's copy) the scan does read Gmail", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { amount: "11.00", op: "900002" });
  const gmailCalls = countGmail(rt);
  rt.run("runAutomation()");
  assert.ok(gmailCalls() > 0, "owner's copy (no FEATURES): reads e-mail as before");
  const { rt: rt2 } = freshApp({ small: true });
  bcpEmail(rt2, { amount: "11.00", op: "900003" });
  const calls2 = countGmail(rt2);
  rt2.svc.props.set("FEATURES", "keepawake,gmail");
  rt2.run("runAutomation()");
  assert.ok(calls2() > 0, "approved: reads e-mail");
});

test("asking for a statement PDF without e-mail approval gives a plain sentence in both languages", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "keepawake");
  assert.throws(() => rt.run('requireFeature_("gmail", "feature.gmailOff")'), /not turned on for this app yet/);
  const es = (() => { try { rt.run('REQUEST_LANG_ = "es"; requireFeature_("gmail", "feature.gmailOff")'); } catch (e) { return e.message; } return ""; })();
  assert.match(es, /aún no está activada/);
});

test("meta tells the app what this copy can do", () => {
  const { rt } = freshApp({ small: true });
  let caps = rt.api("getMeta", {}).capabilities;
  assert.equal(caps.bankEmails, true); assert.equal(caps.keepAwake, true);
  rt.svc.props.set("FEATURES", "keepawake");
  caps = rt.api("getMeta", {}).capabilities;
  assert.equal(caps.bankEmails, false); assert.equal(caps.keepAwake, true); assert.equal(caps.telegram, false);
});

test("the performance log is offered on the owner's copy only", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.api("getMeta", {}).capabilities.perfLog, true);
  rt.svc.props.set("FEATURES", "gmail,keepawake");
  assert.equal(rt.api("getMeta", {}).capabilities.perfLog, false);
});
