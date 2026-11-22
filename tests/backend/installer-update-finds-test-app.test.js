// The Update page must find the owner's leftover apps made by the throwaway test installer (docs/setup-test/, Drive mark "setupTest"),
// while setting up must not (a fresh setup is never mistaken for a resume). Pulls restoreIfNeeded out of docs/setup/index.html.
// It also updates the tracker THE PHONE uses (the app passes its server's id as dep=…), not just the newest one in Drive.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "setup", "index.html"), "utf8");
const fnSrc = /async function restoreIfNeeded\([\s\S]*?\n}\n/.exec(html)[0];

function build(state, google_, wantDep) {
  return new Function("state", "google_", "log", "save", "propsToProgress", "WANT_DEP", "T", `${fnSrc}; return restoreIfNeeded;`)(
    state, google_, () => {}, () => {}, (ap) => { state.scriptId = ap.scriptId; state.deploymentId = ap.deploymentId; }, wantDep || "", { updWrongApp: "wrong account" });
}

async function run(includeTestApps, files, wantDep) {
  const calls = [];
  const state = {};
  const google_ = async (method, url) => { calls.push(decodeURIComponent(url)); return { files }; };
  await build(state, google_, wantDep)(includeTestApps);
  return { state, query: calls[0] || "" };
}

const found = [{ id: "sheet1", webViewLink: "https://example.test/sheet1", appProperties: { setupTest: "1", scriptId: "script1", deploymentId: "dep1" } }];

test("the Update page looks for both marks, so an app made by the test page is found", async () => {
  const { state, query } = await run(true, found);
  assert.ok(query.includes("key='etSetup'") && query.includes("key='setupTest'"));
  assert.ok(query.includes("trashed=false"));
  assert.equal(state.spreadsheetId, "sheet1");
  assert.equal(state.scriptId, "script1");
});

test("setting up looks only for the real installer's own mark", async () => {
  const { query } = await run(false, []);
  assert.ok(query.includes("key='etSetup'"));
  assert.ok(!query.includes("setupTest"));
  const { query: q2 } = await run(undefined, []);
  assert.ok(!q2.includes("setupTest"));
});

test("nothing found stays 'no app' (the page then says so), and a phone that already knows its app does not ask Drive", async () => {
  const none = await run(true, []);
  assert.equal(none.state.spreadsheetId, undefined);
  const calls = [];
  const state = { spreadsheetId: "known" };
  await build(state, async () => { calls.push(1); return {}; })(true);
  assert.equal(calls.length, 0);
});

test("only the Update flow asks for the test apps", () => {
  assert.match(html, /async function updateMyApp\(\) \{\s*progress\(T\.p_google, 5, T\.stepUpdate\);[\s\S]*?\n  await restoreIfNeeded\(true\);/);
  assert.equal((html.match(/restoreIfNeeded\(true\)/g) || []).length, 1);
});

// ---- the phone's own tracker (2026-10-28) ----
const newest = { id: "newest", webViewLink: "x", appProperties: { etSetup: "1", scriptId: "s2", deploymentId: "DEP_NEW" } };
const older = { id: "older", webViewLink: "x", appProperties: { etSetup: "1", scriptId: "s1", deploymentId: "DEP_OLD" } };

test("with two trackers, the one whose server the phone uses is updated, not the newest", async () => {
  const { state } = await run(true, [newest, older], "DEP_OLD");
  assert.equal(state.spreadsheetId, "older");
  assert.equal(state.deploymentId, "DEP_OLD");
});

test("without a server id from the phone (an older app) the newest tracker is used, as before", async () => {
  const { state } = await run(true, [newest, older], "");
  assert.equal(state.spreadsheetId, "newest");
});

test("when every tracker is known and none is the phone's, the page stops with a clear message instead of updating another one", async () => {
  await assert.rejects(() => run(true, [newest, older], "DEP_OTHER"), /wrong account/);
});

test("a tracker saved before deployment ids were stored cannot be ruled out: the newest is used", async () => {
  const noId = { id: "noid", webViewLink: "x", appProperties: { etSetup: "1", scriptId: "s0" } };
  const { state } = await run(true, [noId, older], "DEP_OTHER");
  assert.equal(state.spreadsheetId, "noid");
});

test("a page that remembers another tracker drops it, with its sign-in code, before looking", () => {
  const fn = /function forgetOtherApp_\(\) \{[\s\S]*?\n}\n/.exec(html)[0];
  assert.match(fn, /'accessCode'/, "the code of the other tracker is never written into the phone's server");
  assert.match(html, /if \(WANT_DEP && state\.deploymentId && state\.deploymentId !== WANT_DEP\) \{[^\n]*forgetOtherApp_\(\); \}/);
});
