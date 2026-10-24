// The installer's "Show me how" drawings (docs/setup/index.html): every caption and Google-screen word they use exists in both languages,
// and the approval step no longer promises an "Allow" button (the real Google flow, recorded 2026-10-24, has none).
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
  assert.ok(keys.size > 20, "found the keys");
  for (const k of keys) for (const [name, text] of [["en", en], ["es", es]]) assert.ok(new RegExp(`^    ${k}:`, "m").test(text), `${name}: ${k}`);
});

test("each of the three cards has its drawing", () => {
  for (const name of ["api", "signin", "approve"]) {
    assert.ok(html.includes(`data-anim-open="${name}"`) && html.includes(`id="anim-${name}"`), name);
    assert.ok(new RegExp(`\\n  ${name}: \\(\\) => \\(\\{`).test(html), name + " is defined");
  }
});

test("the approval text no longer says there is an 'Allow' / 'Permitir' button", () => {
  for (const [name, text] of [["en", en], ["es", es]]) {
    const v = new RegExp("\\n    approveAsk: ('(?:[^'\\\\]|\\\\.)*'),").exec(text)[1];
    assert.ok(!/\bAllow\b|Permitir/.test(v), name);
  }
});
