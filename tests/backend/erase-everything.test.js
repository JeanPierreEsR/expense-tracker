// "Delete everything" (More → Delete everything), step 1 of 2: the backend empties the Sheet, forgets every setting, signs
// every device out and takes back its own Google permission. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("the owner's own copy refuses, even when confirmed", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("eraseEverything", { confirm: true }), /only for copies/);
  assert.ok(rt.svc.ss.getSheets().some((s) => s.getLastRow() > 1), "nothing was touched");
});

test("a copy made by the installer needs the confirmation flag", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  assert.throws(() => rt.api("eraseEverything", {}), /confirmation/);
  assert.throws(() => rt.api("eraseEverything", { confirm: "yes" }), /confirmation/);
  assert.ok(rt.svc.ss.getSheets().some((s) => s.getLastRow() > 1), "nothing was touched");
  assert.equal(rt.svc.props.get("FEATURES"), "base");
});

test("confirmed: every tab is empty, every setting is gone, the app's own permission is taken back", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "fake-bot-token");
  const r = rt.api("eraseEverything", { confirm: true });
  assert.equal(r.erased, true);
  assert.equal(r.permissionRevoked, true);
  assert.ok(r.tabs > 5, "every tab was emptied");
  for (const sheet of rt.svc.ss.getSheets()) assert.equal(sheet.getLastRow(), 0, sheet.getName());
  assert.equal(rt.svc.props.size, 0, "access code, features, Telegram link: all forgotten");
  assert.equal(rt.state.authInvalidated, 1);
});

test("the old sign-in stops working at once, and so does the raw access code", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.api("eraseEverything", { confirm: true });
  const out = rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }));
  assert.equal(out.ok, false);
});
