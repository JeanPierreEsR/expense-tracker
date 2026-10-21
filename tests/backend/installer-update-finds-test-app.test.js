// The Update page must find the owner's leftover apps made by the throwaway test installer (docs/setup-test/, Drive mark "setupTest"),
// while setting up must not (a fresh setup is never mistaken for a resume). Pulls restoreIfNeeded out of docs/setup/index.html.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "setup", "index.html"), "utf8");
const fnSrc = /async function restoreIfNeeded\([\s\S]*?\n}\n/.exec(html)[0];

async function run(includeTestApps, files) {
  const calls = [];
  const state = {};
  const google_ = async (method, url) => { calls.push(decodeURIComponent(url)); return { files }; };
  const api = new Function("state", "google_", "log", "save", "propsToProgress", `${fnSrc}; return restoreIfNeeded;`)(state, google_, () => {}, () => {}, (ap) => { state.scriptId = ap.scriptId; });
  await api(includeTestApps);
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
  const api = new Function("state", "google_", "log", "save", "propsToProgress", `${fnSrc}; return restoreIfNeeded;`)(state, async () => { calls.push(1); return {}; }, () => {}, () => {}, () => {});
  await api(true);
  assert.equal(calls.length, 0);
});

test("only the Update flow asks for the test apps", () => {
  assert.match(html, /async function updateMyApp\(\) \{\s*progress\(T\.p_google, 5, T\.stepUpdate\);\s*await restoreIfNeeded\(true\);/);
  assert.equal((html.match(/restoreIfNeeded\(true\)/g) || []).length, 1);
});
