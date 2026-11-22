// The app's escapeHtml (docs/app.js) must be safe inside a quoted attribute too: text from bank e-mails and files lands in
// value="…" and data-…="…" (journeys run, 2026-11-17: Rafael found that a description holding " could add an attribute).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
const src = app.match(/function escapeHtml\(str\) \{[\s\S]*?\n\}/)[0];
// The browser's textContent → innerHTML turns & < > into entities and leaves quotes alone; the same here.
const document = { createElement: () => { let t = ""; return { set textContent(v) { t = String(v); }, get innerHTML() { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); } }; } };
const escapeHtml = new Function("document", src + "\nreturn escapeHtml;")(document);

test("escapeHtml makes both quotes safe, as well as & < >", () => {
  assert.equal(escapeHtml(`Bodega "Don" Pepe's <b>&`), "Bodega &quot;Don&quot; Pepe&#39;s &lt;b&gt;&amp;");
});

test("a planted description cannot leave the value it is put in", () => {
  const html = `<input value="${escapeHtml('x" autofocus onfocus="alert(1)')}">`;
  assert.equal((html.match(/"/g) || []).length, 2, "only the attribute's own two quotes remain");
});
