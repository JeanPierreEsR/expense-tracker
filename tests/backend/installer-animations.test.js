// The installer's looping drawings (docs/setup/index.html): every caption and Google-screen word they use exists in both languages,
// each of the three cards has its drawing, they autoplay (no "show me" click) and pause while held, and no caption promises an
// "Allow" button (the real Google flow, recorded 2026-10-24, has none: it is Select all → Continue → "Allowed" page → green Continue).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "setup", "index.html"), "utf8");
const table = /const T = \{([\s\S]*?)\n\}\[LANG\]/.exec(html)[1];
const en = table.slice(table.indexOf("en: {"), table.indexOf("  es: {"));
const es = table.slice(table.indexOf("  es: {"));

test("every caption and Google word the drawings use is written in both languages", () => {
  const keys = new Set([...html.matchAll(/cap: '(c_\w+)'/g)].map((m) => m[1]));
  for (const m of html.matchAll(/T\.(g_\w+|c_\w+|anim\w+)/g)) keys.add(m[1]);
  assert.ok(keys.size > 30, "found the keys");
  for (const k of keys) for (const [name, text] of [["en", en], ["es", es]]) assert.ok(new RegExp(`^    ${k}:`, "m").test(text), `${name}: ${k}`);
});

test("each of the three cards has its drawing, started by the page itself", () => {
  for (const name of ["api", "signin", "approve"]) {
    assert.ok(html.includes(`id="anim-${name}" data-anim="${name}"`), name);
    assert.ok(new RegExp(`\\n  ${name}: \\(\\) => \\(\\{`).test(html), name + " is defined");
  }
  assert.ok(/querySelectorAll\('\[data-anim\]'\)\.forEach\(mountAnim\)/.test(html), "mounted on load, no click needed");
  assert.ok(!/animShow|data-anim-open/.test(html), "no 'Show me how' button any more");
});

test("holding the drawing pauses it, and it loops by itself", () => {
  assert.ok(/addEventListener\('pointerdown', \(\) => hold\(true\)\)/.test(html));
  assert.ok(/'pointerup', 'pointercancel', 'pointerleave'/.test(html));
  assert.ok(/st\.t >= st\.total\) \{ st\.restart\(\)/.test(html), "restarts at the end");
});

test("no caption tells the person to tap an 'Allow' / 'Permitir' button", () => {
  for (const [name, text] of [["en", en], ["es", es]]) {
    for (const m of text.matchAll(/\n    (c_\w+): ('(?:[^'\\]|\\.)*'),/g)) assert.ok(!/“Allow”|“Permitir”/.test(m[2]), `${name}: ${m[1]}`);
  }
});
