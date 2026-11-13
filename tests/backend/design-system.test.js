// The design base (design review batch 2, 2026-11-12; private spec specs/design-system.md): the stylesheet uses named
// colours, one text-size scale, named corner sizes and named layers, so screens stay consistent as the app grows.
// The welcome tour's mini-phone pictures (.ts-*) keep their own pixel sizes until they are rebuilt from real pieces.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "docs");
const css = fs.readFileSync(path.join(DOCS, "style.css"), "utf8");
const root = css.match(/:root\s*\{[^}]*\}/)[0];
const rest = css.replace(root, "");
// Innermost rule blocks: [selector, declarations]. Tour pictures are left out.
const blocks = [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => [m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), m[2]])
  .filter(([sel]) => !sel.includes(".ts-"));

test("no fixed colour code outside the named colours in :root", () => {
  const bad = [];
  rest.replace(/\/\*[\s\S]*?\*\//g, "").replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/g, (h, at, all) => {
    // a selector like "#add-tag-btn" is not a colour: only values after a ":" count
    const before = all.slice(Math.max(0, at - 120), at);
    if (/:[^;{}]*$/.test(before)) bad.push(h);
    return h;
  });
  assert.deepEqual(bad, [], "use a named colour (var(--…)) from :root; add one there if it is really new");
});

test("text sizes come from the scale, in rem (em inside a sized parent)", () => {
  const SCALE = ["0.6875", "0.75", "0.8125", "0.875", "1", "1.125", "1.25", "1.5", "2"];
  const bad = [];
  for (const [sel, decl] of blocks) {
    for (const m of decl.matchAll(/font-size:\s*([^;}]+?)\s*(?:;|$)/g)) {
      const v = m[1].trim();
      if (["inherit", "revert"].includes(v)) continue;
      if (/^[\d.]+vw$/.test(v) && sel.includes(".nav-btn")) continue;   // the tab bar on phones under 340px
      const mm = v.match(/^([\d.]+)(rem|em)$/);
      if (!mm || !SCALE.includes(String(Number(mm[1])))) bad.push(`${sel.slice(-60)} → ${v}`);
    }
  }
  assert.deepEqual(bad, [], "pick the nearest size on the scale");
});

test("corners use the named sizes; layers of 100 or more use a named layer", () => {
  const badR = [], badZ = [];
  for (const [sel, decl] of blocks) {
    for (const m of decl.matchAll(/border-radius:\s*([^;}]+?)\s*(?:;|$)/g)) {
      const parts = m[1].trim().split(/\s+/);
      if (!parts.every((p) => /^var\(--r-(xs|sm|md|lg|xl|pill)\)$/.test(p) || p === "50%" || p === "0" || p === "inherit")) badR.push(`${sel.slice(-60)} → ${m[1]}`);
    }
    for (const m of decl.matchAll(/z-index:\s*(\d+)/g)) if (Number(m[1]) >= 100) badZ.push(`${sel.slice(-60)} → ${m[1]}`);
  }
  assert.deepEqual(badR, [], "border-radius: var(--r-xs|sm|md|lg|xl|pill), 50% or 0");
  assert.deepEqual(badZ, [], "z-index of 100 or more: one of the --z-… layers in :root");
});

test("no inline colour code on the page (error lines use the error-text class)", () => {
  const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
  const bad = [...html.matchAll(/style="[^"]*#[0-9a-fA-F]{3,6}[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(bad, []);
});
