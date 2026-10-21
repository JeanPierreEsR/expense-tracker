// The installer page tells everyone to open it in a Private tab before they start (owner's decision 2026-10-21): a Private tab starts
// with no Google accounts, which is the surest way past Google's approval screen. Static checks on docs/setup/index.html.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "setup", "index.html"), "utf8");
const table = /const T = \{([\s\S]*?)\n\}\[LANG\]/.exec(html)[1];
const en = table.slice(table.indexOf("en: {"), table.indexOf("  es: {"));
const es = table.slice(table.indexOf("  es: {"));

test("the Private tab card is on the page for everyone, above the account tip, with a button that copies the address", () => {
  const card = html.indexOf('id="privateTip"');
  assert.ok(card > 0);
  assert.ok(card < html.indexOf('data-t="accountTip"'), "it comes before everything else the person reads");
  assert.ok(/id="btnCopyPrivate" data-t="copyPageBtn"/.test(html));
  assert.ok(/\['btnCopyPrivate', 'btnCopyPage'\]\.forEach/.test(html), "the same copy handler serves both buttons");
});

test("it is written in both languages, with a fallback when the phone will not copy", () => {
  for (const [name, text] of [["en", en], ["es", es]]) {
    for (const key of ["privateTitle", "privateBody", "copyManual", "copyPageBtn", "copiedBtn"]) assert.ok(new RegExp(`^    ${key}:`, "m").test(text), `${name}: ${key}`);
  }
  assert.ok(/Private/.test(en) && /privada/.test(es));
});

test("it is hidden for an update (nothing new is asked of Google) and once the app exists (the 'can't open the file' card takes over)", () => {
  assert.ok(/\$\('privateTip'\)\.hidden = WANT_UPDATE \|\| !!state\.webAppUrl;/.test(html));
});

test("the person is never told to 'copy' the app or that it is a 'tracker' (wording rule 2026-10-14) in the new text", () => {
  const body = /privateBody: '([^']*(?:\\'[^']*)*)'/.exec(en)[1] + /privateTitle: '([^']*)'/.exec(en)[1];
  assert.ok(!/\btracker\b/i.test(body));
  assert.ok(!/copy (of )?(the |your )?app/i.test(body));
});
