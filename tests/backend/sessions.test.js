// Sign-in sessions (2026-10-05): the access code is typed once to `login`, which
// returns a long random session key; the app uses that key afterwards (not the
// code), each device can be signed out, and only `login` has a lockout — so an
// attacker can block NEW sign-ins but never an existing session.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const login = (rt, code, deviceName = "Test phone") => post(rt, { action: "login", payload: { code, deviceName } });
const asSession = (rt, token, action, payload = {}) => post(rt, { sessionToken: token, action, payload });
const signIn = (rt, deviceName) => login(rt, rt.ACCESS_CODE, deviceName).data;

// ---- signing in ---------------------------------------------------------------
test("the right code signs in and returns a long session key (never the code)", () => {
  const { rt } = freshApp({ entries: 100 });
  const res = login(rt, rt.ACCESS_CODE);
  assert.equal(res.ok, true);
  assert.match(res.data.sessionToken, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(res).includes(rt.ACCESS_CODE));
});

test("a wrong code is refused", () => {
  const { rt } = freshApp({ entries: 100 });
  const res = login(rt, "not-the-code");
  assert.equal(res.ok, false);
  assert.match(res.error, /wrong|invalid/i);
});

test("the session key opens the app; the raw code still works until sessions are required", () => {
  const { rt } = freshApp({ entries: 100 });
  const { sessionToken } = signIn(rt);
  assert.equal(asSession(rt, sessionToken, "getMeta").ok, true);
  assert.equal(post(rt, { accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }).ok, true, "old app copies keep working");
});

test("a made-up or empty session key is refused", () => {
  const { rt } = freshApp({ entries: 100 });
  assert.equal(asSession(rt, "0".repeat(64), "getMeta").ok, false);
  assert.equal(asSession(rt, "", "getMeta").ok, false);
});

test("the sheet stores only a hash of the key, so reading the sheet can't sign anyone in", () => {
  const { rt } = freshApp({ entries: 100 });
  const { sessionToken } = signIn(rt, "Phone A");
  const rows = rt.rows("Sessions");
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(sessionToken));
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].device_name, "Phone A");
});

test("a device name is trimmed and kept short", () => {
  const { rt } = freshApp({ entries: 100 });
  signIn(rt, "  " + "x".repeat(200) + "  ");
  assert.ok(rt.rows("Sessions")[0].device_name.length <= 60);
});

// ---- lockout (sign-in only) -----------------------------------------------------
test("10 wrong codes lock SIGN-IN, even for the right code, but an existing session keeps working", () => {
  const { rt } = freshApp({ entries: 100 });
  const { sessionToken } = signIn(rt, "My phone");
  for (let i = 0; i < 10; i++) login(rt, "guess" + i);

  const locked = login(rt, rt.ACCESS_CODE);
  assert.equal(locked.ok, false);
  assert.match(locked.error, /too many|try again/i);
  assert.equal(asSession(rt, sessionToken, "getMeta").ok, true, "the owner's phone is unaffected");
});

test("sign-in works again once the lock has passed", () => {
  const { rt } = freshApp({ entries: 100 });
  for (let i = 0; i < 10; i++) login(rt, "guess" + i);
  assert.equal(login(rt, rt.ACCESS_CODE).ok, false);
  rt.svc.cache.set("loginlock", String(Date.now() - 1000));   // the lock's time is up
  rt.svc.cache.delete("loginfail");
  assert.equal(login(rt, rt.ACCESS_CODE).ok, true);
});

test("a successful sign-in resets the wrong-code count", () => {
  const { rt } = freshApp({ entries: 100 });
  for (let i = 0; i < 9; i++) login(rt, "guess" + i);
  assert.equal(login(rt, rt.ACCESS_CODE).ok, true);
  for (let i = 0; i < 9; i++) login(rt, "again" + i);
  assert.equal(login(rt, rt.ACCESS_CODE).ok, true, "9 + 9 split by a success is not 18 in a row");
});

test("wrong codes sent to Telegram /start share the same lockout", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  for (let i = 0; i < 10; i++) {
    post(rt, { update_id: 800 + i, message: { message_id: i, chat: { id: 321 }, text: "/start wrong" + i } });
  }
  assert.equal(login(rt, rt.ACCESS_CODE).ok, false, "sign-in is locked too");
  post(rt, { update_id: 900, message: { message_id: 99, chat: { id: 321 }, text: "/start " + rt.ACCESS_CODE } });
  assert.ok(!rt.svc.props.get("TELEGRAM_CHAT_ID"), "even the right code doesn't link while locked");
});

// ---- signing out ----------------------------------------------------------------
test("sign out ends that session at once; other devices stay signed in", () => {
  const { rt } = freshApp({ entries: 100 });
  const a = signIn(rt, "Phone"), b = signIn(rt, "Mac");
  assert.equal(asSession(rt, a.sessionToken, "getMeta").ok, true);   // warm the cache
  assert.equal(asSession(rt, a.sessionToken, "logout").ok, true);
  assert.equal(asSession(rt, a.sessionToken, "getMeta").ok, false, "the key is dead immediately, not after the cache expires");
  assert.equal(asSession(rt, b.sessionToken, "getMeta").ok, true);
  assert.equal(rt.rows("Sessions").length, 1);
});

test("the device list marks the current device; another device can be revoked", () => {
  const { rt } = freshApp({ entries: 100 });
  const phone = signIn(rt, "Phone"), lost = signIn(rt, "Old phone");
  const list = asSession(rt, phone.sessionToken, "listSessions").data;
  assert.equal(list.length, 2);
  assert.deepEqual(list.filter((s) => s.current).map((s) => s.device_name), ["Phone"]);
  assert.ok(list.every((s) => s.id && s.created_at && s.last_used_at && s.token_hash === undefined), "the hash never leaves the server");

  const lostId = list.find((s) => s.device_name === "Old phone").id;
  assert.equal(asSession(rt, lost.sessionToken, "getMeta").ok, true);
  assert.equal(asSession(rt, phone.sessionToken, "revokeSession", { id: lostId }).ok, true);
  assert.equal(asSession(rt, lost.sessionToken, "getMeta").ok, false, "the lost phone is out immediately");
  assert.equal(asSession(rt, phone.sessionToken, "getMeta").ok, true);
});

test("'sign out my other devices' keeps only the caller", () => {
  const { rt } = freshApp({ entries: 100 });
  const a = signIn(rt, "A"), b = signIn(rt, "B"), c = signIn(rt, "C");
  assert.equal(asSession(rt, a.sessionToken, "revokeOtherSessions").ok, true);
  assert.equal(asSession(rt, a.sessionToken, "getMeta").ok, true);
  assert.equal(asSession(rt, b.sessionToken, "getMeta").ok, false);
  assert.equal(asSession(rt, c.sessionToken, "getMeta").ok, false);
});

test("a session unused for 90 days no longer works", () => {
  const { rt } = freshApp({ entries: 100 });
  const { sessionToken } = signIn(rt);
  rt.sheet("Sessions").rows[1][4] = "2020-01-01T00:00:00";   // last_used_at, long ago
  rt.svc.cache.clear();
  assert.equal(asSession(rt, sessionToken, "getMeta").ok, false);
});

test("using a session refreshes its last-used time", () => {
  const { rt } = freshApp({ entries: 100 });
  const { sessionToken } = signIn(rt);
  rt.sheet("Sessions").rows[1][4] = "2026-09-01T00:00:00";
  rt.svc.cache.clear();
  asSession(rt, sessionToken, "getMeta");
  assert.ok(rt.rows("Sessions")[0].last_used_at > "2026-10-01");
});

test("each request after the first does not touch the Sessions sheet (fast)", () => {
  const { rt } = freshApp({ entries: 100 });
  const { sessionToken } = signIn(rt);
  asSession(rt, sessionToken, "getMeta");
  rt.resetStats();
  asSession(rt, sessionToken, "getMeta");
  const sessionReads = rt.svc.ss.getSheetByName("Sessions");
  assert.ok(sessionReads, "sheet exists");
  // compare with the same request authenticated by the raw code: no extra reads
  const withCode = (() => { rt.resetStats(); post(rt, { accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }); return rt.stats.reads; })();
  rt.resetStats(); asSession(rt, sessionToken, "getMeta");
  assert.ok(rt.stats.reads <= withCode, `session check added reads: ${rt.stats.reads} vs ${withCode}`);
});

// ---- requiring sessions + the Mac helper's own key ---------------------------------------
test("once sessions are required, the raw code stops working — except to sign in", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("REQUIRE_SESSIONS", "true");
  assert.equal(post(rt, { accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }).ok, false);
  const res = login(rt, rt.ACCESS_CODE);
  assert.equal(res.ok, true);
  assert.equal(asSession(rt, res.data.sessionToken, "getMeta").ok, true);
});

test("the Mac helper's key works for its four photo actions only", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("HELPER_KEY", "h".repeat(32));
  rt.svc.props.set("REQUIRE_SESSIONS", "true");
  const withKey = (action, payload = {}) => post(rt, { helperKey: "h".repeat(32), action, payload });
  assert.equal(withKey("listPhotoJobs").ok, true);
  assert.equal(withKey("getMeta").ok, false, "not a way into the rest of the app");
  assert.equal(withKey("listEntries", { limit: 1 }).ok, false);
  assert.equal(post(rt, { helperKey: "wrong", action: "listPhotoJobs", payload: {} }).ok, false);
});

test("the helper key is not accepted as an access code, and vice versa", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("HELPER_KEY", "h".repeat(32));
  assert.equal(post(rt, { accessCode: "h".repeat(32), action: "getMeta", payload: {} }).ok, false);
  assert.equal(post(rt, { helperKey: rt.ACCESS_CODE, action: "listPhotoJobs", payload: {} }).ok, false);
});

// ---- sheet menu items -----------------------------------------------------------------------
test("menu: generating a helper key asks first, stores it, shows it once", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.state.alertButton = "NO";
  rt.run("menuGenerateHelperKey()");
  assert.ok(!rt.svc.props.get("HELPER_KEY"));
  rt.state.alertButton = "YES";
  rt.run("menuGenerateHelperKey()");
  const key = rt.svc.props.get("HELPER_KEY");
  assert.ok(key && key.length >= 32);
  assert.ok(rt.svc.uiLog.some((m) => m.includes(key)));
});

test("menu: requiring sessions warns about the Mac helper when it has no key, and toggles", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.state.alertButton = "YES";
  rt.run("menuRequireSessions()");
  assert.equal(rt.svc.props.get("REQUIRE_SESSIONS"), "true");
  assert.ok(rt.svc.uiLog.some((m) => /helper/i.test(m)), "mentions the Mac helper");
  rt.run("menuRequireSessions()");                      // run again = switch it back off
  assert.notEqual(rt.svc.props.get("REQUIRE_SESSIONS"), "true");
});

test("menu: sign out all devices removes every session", () => {
  const { rt } = freshApp({ entries: 100 });
  const a = signIn(rt, "A"), b = signIn(rt, "B");
  rt.state.alertButton = "YES";
  rt.run("menuSignOutAllDevices()");
  assert.equal(rt.rows("Sessions").length, 0);
  assert.equal(asSession(rt, a.sessionToken, "getMeta").ok, false);
  assert.equal(asSession(rt, b.sessionToken, "getMeta").ok, false);
});

test("existing protections still apply: wrong sign-ins feed the burst alert", () => {
  const { rt } = freshApp({ entries: 100 });
  linkTelegram(rt);
  for (let i = 0; i < 10; i++) login(rt, "guess" + i);
  const alerts = rt.svc.fetchLog.filter((f) => /wrong access-code attempts/.test(f.options.payload));
  assert.equal(alerts.length, 1);
});
