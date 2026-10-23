// "Delete everything": the pieces that cannot run in the fake backend are checked in the page source — the row is for friends'
// copies only, the app hands over to the setup page's "#remove", and that page deletes only what it made.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", "..", f), "utf8");
const app = read("docs/app.js");
const html = read("docs/index.html");
const setup = read("docs/setup/index.html");

test("the More row sits after Sign out, is hidden by default and is hidden on the owner's copy", () => {
  assert.match(html, /id="more-erase-btn" hidden/);
  assert.ok(html.indexOf('id="more-signout-btn"') < html.indexOf('id="more-erase-btn"'));
  assert.match(app, /more-erase-btn"\)\.hidden = owner/);
});

test("the app asks the backend with confirm:true only after the typed word matches, then hands over to the setup page", () => {
  assert.match(app, /callApi\("eraseEverything", \{ confirm: true \}\)/);
  assert.match(app, /if \(!eraseWordOk_\(\)\) return;/);
  assert.match(app, /siteUrl_\("setup\/#remove"/);
});

test("the setup page's remove mode finds only the apps it made (etSetup / setupTest) and removes its own permission", () => {
  assert.match(setup, /WANT_REMOVE = \/\(\^\|\[#&\?\]\)remove\\b\//);
  assert.match(setup, /async function removeEverything\(\)/);
  assert.match(setup, /key='etSetup' and value='1'/);
  assert.match(setup, /google\.accounts\.oauth2\.revoke\(accessToken/);
});

test("every new text exists in English and Spanish", () => {
  const strings = read("docs/strings.js");
  for (const k of ["more.erase", "erase.title", "erase.intro", "erase.item1", "erase.item2", "erase.item3", "erase.item4", "erase.noUndo",
    "erase.typePrompt", "erase.word", "erase.btn", "erase.working", "erase.failed", "erase.step2Title", "erase.step2Body", "erase.finishBtn",
    "erase.later", "erase.copy", "erase.hintHome", "erase.hintSafari", "erase.signedOut"]) {
    assert.match(strings, new RegExp('"' + k.replace(".", "\\.") + '": \\{ en: ".+", es: ".+" \\}'), k);
  }
  const en = setup.slice(setup.indexOf("  en: {"), setup.indexOf("  es: {"));
  const es = setup.slice(setup.indexOf("  es: {"), setup.indexOf("}[LANG]"));
  for (const k of ["stepRemove", "rmPageTitle", "rmTitle", "rmBody", "rmBtn", "rmWorking", "rmLooking", "rmNone", "rmDone", "rmFile", "rmAfter", "rmOpenGoogle", "rmReady"]) {
    assert.ok(en.includes("    " + k + ":"), "en " + k);
    assert.ok(es.includes("    " + k + ":"), "es " + k);
  }
});
