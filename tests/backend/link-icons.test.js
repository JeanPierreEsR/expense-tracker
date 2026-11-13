// Every text link carries a line icon chosen by what it does (owner, 2026-11-13; private spec specs/design-system.md § Icons).
// The icon comes from LINK_ICON_RULES_ in docs/app.js, which reads the link's words in either language. This test finds the
// links' texts (in index.html and where app.js / statements.js build a link button) and checks that each one, in English and
// Spanish, matches a rule: an icon, or null for a link that keeps none on purpose. A new link that matches nothing stops the ship.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "docs");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const block = app.slice(app.indexOf("// LINK_ICON_RULES_ start"), app.indexOf("// LINK_ICON_RULES_ end"));
const LINK_ICON_RULES_ = new Function(block.replace("const LINK_ICON_RULES_ =", "return"))();
const STR = require(path.join(DOCS, "strings.js"));
const strings = STR.STRINGS || STR;
const iconsBlock = app.slice(app.indexOf("const LINE_ICONS_"), app.indexOf("const EMOJI_ICON_ ="));
const iconNames = new Set([...iconsBlock.matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]));

function linkKeys() {
  const keys = new Set();
  const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
  for (const m of html.matchAll(/<button\b[^>]*class="[^"]*\b(add-inline|wa-link)\b[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) {
    const open = m[0].slice(0, m[0].indexOf(">"));
    const k = (open.match(/data-i18n="([^"]+)"/) || [])[1];
    if (k) keys.add(k);
    else for (const n of m[2].matchAll(/data-i18n="([^"]+)"/g)) keys.add(n[1]);
  }
  for (const f of ["app.js", "statements.js"]) {
    for (const line of fs.readFileSync(path.join(DOCS, f), "utf8").split("\n")) {
      if (!/class="add-inline|class=\\"add-inline|"add-inline|wa-link/.test(line)) continue;
      for (const m of line.matchAll(/<button[^>]*class="add-inline[^"]*"[^>]*>\$\{(?:escapeHtml\()?tr\("([\w.]+)"/g)) keys.add(m[1]);
    }
  }
  return [...keys].filter((k) => strings[k] && typeof strings[k].en === "string");
}

test("every text link matches an icon rule, in English and Spanish", () => {
  const keys = linkKeys();
  assert.ok(keys.length > 100, "found the links (" + keys.length + ")");
  const bad = [];
  for (const k of keys) {
    for (const lang of ["en", "es"]) {
      const t = strings[k][lang].replace(/\{\w+\}/g, "1").trim();
      const emojiMarker = /^\p{Extended_Pictographic}/u.test(t);   // drawn by the emoji markers instead
      if (!emojiMarker && !LINK_ICON_RULES_.some(([re]) => re.test(t))) bad.push(`${k} (${lang}): ${t}`);
    }
  }
  assert.deepEqual(bad, [], "add a rule to LINK_ICON_RULES_ (an icon, or null to keep it without one)");
});

test("every icon a rule names exists", () => {
  const missing = LINK_ICON_RULES_.map(([, n]) => n).filter((n) => n && !iconNames.has(n));
  assert.deepEqual(missing, []);
});

test("a few links get the icon they should", () => {
  const pick = (t) => (LINK_ICON_RULES_.find(([re]) => re.test(t)) || [])[1];
  assert.equal(pick("Copy the message"), "copy");
  assert.equal(pick("Copiar el mensaje"), "copy");
  assert.equal(pick("Cambiar el sentido"), "swap");
  assert.equal(pick("Change main currency…"), "pencil");
  assert.equal(pick("Read the items from a photo"), "camera");
  assert.equal(pick("Cancel"), null);
  assert.equal(pick("‹ Back to check"), null);
  assert.equal(pick("+ Project"), "plus");
});
