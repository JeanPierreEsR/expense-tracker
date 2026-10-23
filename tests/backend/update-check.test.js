// "Update my app" notice (stage 4c): the app reads docs/setup/pin.json from our own site on every check and asks GitHub only when the pin is new to the
// phone. Before 2026-10-23 every answer was remembered for 12 hours, so a promote could take half a day to show up (a friend-like spare copy did not see it).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const fnSource = app.slice(app.indexOf("async function latestBackendRef_() {"), app.indexOf("async function checkBackendUpdateNow_"));

const HOUR = 3600 * 1000;
const PIN_A = "a".repeat(40), PIN_B = "b".repeat(40);

// Runs latestBackendRef_ against a fake pin.json, a fake GitHub and a fake localStorage.
async function run({ pin = PIN_A, pinFails = false, github = {}, githubOk = true, cache = null, now = 1_000_000_000_000 }) {
  const store = {};
  if (cache) store.etBackendUpdate = JSON.stringify(cache);
  const calls = { pin: 0, github: [] };
  const ctx = {
    UPDATE_CHECK_KEY: "etBackendUpdate",
    siteUrl_: (p) => "https://site/" + p,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async (url) => {
      if (url === "https://site/setup/pin.json") { calls.pin++; if (pinFails) throw new Error("offline"); return { ok: true, json: async () => ({ pin }) }; }
      const sha = decodeURIComponent(/sha=([^&]*)/.exec(url)[1]);
      calls.github.push(sha);
      return { ok: githubOk, json: async () => [{ sha: github[sha] || "" }] };
    },
    Date: { now: () => now },
    JSON, encodeURIComponent, Infinity,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource, ctx);
  const latest = await vm.runInContext("latestBackendRef_()", ctx);
  return { latest, calls, saved: store.etBackendUpdate ? JSON.parse(store.etBackendUpdate) : null };
}

test("pinned, nothing remembered: asks GitHub for the last backend commit at the pin and remembers it with the pin", async () => {
  const r = await run({ pin: PIN_A, github: { [PIN_A]: "ref1" } });
  assert.equal(r.latest, "ref1");
  assert.deepEqual(r.calls.github, [PIN_A]);
  assert.equal(r.saved.latest, "ref1");
  assert.equal(r.saved.pin, PIN_A);
});

test("the same pin is never asked again, however old the memory is (the answer for a pin cannot change), but pin.json is read every time", async () => {
  const r = await run({ pin: PIN_A, cache: { at: 1, latest: "ref1", pin: PIN_A } });
  assert.equal(r.latest, "ref1");
  assert.equal(r.calls.github.length, 0);
  assert.equal(r.calls.pin, 1);
});

test("a promote moves the pin: the phone notices at once instead of after up to 12 hours", async () => {
  const now = 1_000_000_000_000;
  const r = await run({ pin: PIN_B, github: { [PIN_B]: "ref2" }, cache: { at: now - 5 * 60 * 1000, latest: "ref1", pin: PIN_A }, now });
  assert.equal(r.latest, "ref2", "checked 5 minutes ago, still sees the new pin");
  assert.deepEqual(r.calls.github, [PIN_B]);
  assert.equal(r.saved.pin, PIN_B);
});

test("not pinned (follow main): the answer is remembered 12 hours, then asked again", async () => {
  const now = 1_000_000_000_000;
  const fresh = await run({ pin: "", github: { main: "m2" }, cache: { at: now - 11 * HOUR, latest: "m1", pin: "" }, now });
  assert.equal(fresh.latest, "m1");
  assert.equal(fresh.calls.github.length, 0);
  const old = await run({ pin: "", github: { main: "m2" }, cache: { at: now - 13 * HOUR, latest: "m1", pin: "" }, now });
  assert.equal(old.latest, "m2");
  assert.deepEqual(old.calls.github, ["main"]);
});

test("a memory from before this change (no pin saved with it) is asked again once, so a stale 'ecf61d6' cannot hide a newer pin", async () => {
  const now = 1_000_000_000_000;
  const r = await run({ pin: PIN_B, github: { [PIN_B]: "ref2" }, cache: { at: now - HOUR, latest: "ref1" }, now });
  assert.equal(r.latest, "ref2");
  assert.equal(r.calls.github.length, 1);
});

test("our own site not answering: a fresh memory is used, otherwise nothing happens and GitHub is not asked", async () => {
  const now = 1_000_000_000_000;
  const fresh = await run({ pinFails: true, cache: { at: now - HOUR, latest: "ref1", pin: PIN_A }, now });
  assert.equal(fresh.latest, "ref1");
  const none = await run({ pinFails: true, now });
  assert.equal(none.latest, "");
  assert.equal(none.calls.github.length, 0, "never falls back to 'main' by accident");
  const stale = await run({ pinFails: true, cache: { at: now - 20 * HOUR, latest: "ref1", pin: PIN_A }, now });
  assert.equal(stale.latest, "");
});

test("GitHub saying no (busy, offline): silent, nothing remembered, the person is never bothered", async () => {
  const r = await run({ pin: PIN_A, githubOk: false });
  assert.equal(r.latest, "");
  assert.equal(r.saved, null);
});

test("the app checks again when it comes back to the front, not only at startup", () => {
  assert.match(app, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(!document\.hidden\) \{ updateChecked_ = false; checkBackendUpdate_\(\); \} \}\);/);
  assert.match(app, /const latest = await latestBackendRef_\(\);/);
});
