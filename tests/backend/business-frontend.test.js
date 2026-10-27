// Business pack — the parts of the front end a backend test cannot see (source guards; the screens themselves were
// clicked through on the test app in English and Spanish). See specs/business.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const app = read("docs", "app.js");
const html = read("docs", "index.html");
const api = read("backend", "Api.gs");

test("the three business screens are remembered by the More tab (tab memory)", () => {
  const line = app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1];
  for (const name of ["business", "business-detail", "business-features"]) {
    assert.ok(line.includes(`"${name}"`), name + " is in MORE_SUBSCREENS");
    assert.ok(html.includes(`id="screen-${name}"`), name + " exists in index.html");
  }
});

test("creating a company or a project is protected against a resend, in the app and in the backend", () => {
  for (const action of ["addCompany", "addProject"]) {
    assert.match(app.match(/const ONCE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1], new RegExp(`"${action}"`), action + " in app.js");
    assert.match(api.match(/var ONCE_ACTIONS_ = \{([\s\S]*?)\};/)[1], new RegExp(`\\b${action}: 1`), action + " in Api.gs");
  }
});

test("the More card is hidden in the page itself, so a copy that never opts in never sees it", () => {
  assert.match(html, /id="more-business-btn" hidden/);
  assert.match(html, /id="business-field" hidden/);
});

test("the entry form sends the business link only through businessLinkFields_ (nothing while the pack is off)", () => {
  const fn = app.match(/function businessLinkFields_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(!businessOn\(\)[^\n]*return \{\};/);
  // all three save paths spread it (new entry, edit, confirm-from-review)
  assert.equal((app.match(/\.\.\.businessLink\b/g) || []).length, 3);
});

test("the owner's own copy is switched on once, and only when nothing was ever chosen (friends' copies never)", () => {
  const fn = app.match(/function maybeEnableBusinessForOwner_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /!perfIsOwnerCopy_\(\)\) return;/, "owner's copy only");
  assert.match(fn, /saved !== undefined && saved !== ""\) return;/, "a choice already on record is respected");
  assert.match(fn, /callApi\("enableBusinessForOwnerOnce"/, "the server decides (a stale phone copy must not undo a later 'no')");
  assert.match(app, /function refreshExtrasRow_\(\) \{\s*maybeEnableBusinessForOwner_\(\);/, "runs after the app's data has loaded");
});

test("step 2: People is a remembered More screen; business people hide from ordinary pickers while the pack is off", () => {
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"business-people"'));
  assert.ok(html.includes('id="screen-business-people"'));
  assert.match(app, /function plainFriends_\(\) \{ return meta\.friends\.filter\(\(f\) => !isGroupFriend_\(f\) && \(!isBusinessPerson_\(f\) \|\| businessOn\(\)\)\); \}/);
  assert.match(app, /\(!isGroupFriend_\(f\) && \(!isBusinessPerson_\(f\) \|\| businessOn\(\)\)\) \|\| \(tripId/, "the split list follows the same rule");
});

test("step 2: a repayment from a project sheet carries the project; the Loans tab never does", () => {
  assert.match(app, /project_id: repaymentProjectId_ \|\| undefined/);
  assert.match(app, /openLoanDetail\(r\.friend_id, r\.friend_name, ""\)/, "the Loans tab asks for every debt of the person");
  assert.match(app, /openLoanDetail\(row\.dataset\.friend, row\.dataset\.name, d\.project\.id\)/, "the project's Owed rows ask for that project only");
});

test("step 2: the cash-loan form and the Entries-tab Repayment / New loan send a project only while the pack is on", () => {
  assert.match(app, /if \(businessOn\(\)\) fields\.project_id = document\.getElementById\("loan-project"\)\.value;/);
  assert.match(app, /if \(businessOn\(\)\) fields\.project_id = businessPickProjectId_\(\);/);
});

test("a future date with a company or project is refused instead of becoming a Programmed item", () => {
  assert.match(app, /business\.futureNotYet/);
});
