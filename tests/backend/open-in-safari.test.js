// "Open in Safari" for the Update / Extra features buttons (docs/app.js): from the Home Screen app the page must be handed to
// Safari ("x-safari-https://…"), not opened inside the app. The functions are pulled out of app.js and run with stand-ins.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const block = /function safariUrl_[\s\S]*?\nfunction openUpdateModal_/.exec(src)[0].replace(/\nfunction openUpdateModal_$/, "");

function env({ standalone, hiddenAfter }) {
  const calls = { opened: [], navigated: [], stuck: 0 };
  const timers = [];
  const window = { open: (...a) => calls.opened.push(a), matchMedia: undefined };
  const navigator = { standalone };
  const location = { set href(v) { calls.navigated.push(v); } };
  const document = { hidden: false };
  const setTimeout = (fn) => timers.push(fn);
  const api = new Function("window", "navigator", "location", "document", "setTimeout", `${block}; return { safariUrl_, isHomeScreenApp_, openInSafari_ };`)(window, navigator, location, document, setTimeout);
  return { api, calls, document, runTimers: () => timers.forEach((t) => t()) };
}

test("a page address becomes the address that makes iOS open Safari", () => {
  const { api } = env({ standalone: true });
  assert.equal(api.safariUrl_("https://example.github.io/expense-tracker/setup/#update"), "x-safari-https://example.github.io/expense-tracker/setup/#update");
  assert.equal(api.safariUrl_("http://localhost:4180/setup/"), "x-safari-http://localhost:4180/setup/");
});

test("from the Home Screen app the page is handed to Safari, not opened inside the app", () => {
  const { api, calls } = env({ standalone: true });
  api.openInSafari_("https://example.github.io/expense-tracker/setup/#update", () => {});
  assert.deepEqual(calls.navigated, ["x-safari-https://example.github.io/expense-tracker/setup/#update"]);
  assert.equal(calls.opened.length, 0);
});

test("in a normal browser tab it is simply a new tab", () => {
  const { api, calls } = env({ standalone: false });
  api.openInSafari_("https://example.github.io/expense-tracker/setup/", () => {});
  assert.deepEqual(calls.opened, [["https://example.github.io/expense-tracker/setup/", "_blank", "noopener"]]);
  assert.equal(calls.navigated.length, 0);
});

test("if the app is still in front a moment later the fallback is shown; if Safari took over it is not", () => {
  let stuck = 0;
  const a = env({ standalone: true });
  a.api.openInSafari_("https://x.example/setup/", () => stuck++);
  a.runTimers();
  assert.equal(stuck, 1, "still visible: tell the person to use the copy button");
  const b = env({ standalone: true });
  b.api.openInSafari_("https://x.example/setup/", () => stuck++);
  b.document.hidden = true;   // Safari opened, so this app went to the background
  b.runTimers();
  assert.equal(stuck, 1, "no message when it worked");
});

test("the Update and Extra features buttons both use it, and both have the copy fallback on screen", () => {
  assert.match(src, /update-open-btn"\)\.addEventListener\("click", \(\) => \{\s*openInSafari_\(updatePageUrl_\(\)/);
  assert.match(src, /extras-open-btn"\)\.addEventListener\("click", \(\) => \{\s*openInSafari_\(siteUrl_\("setup\/"/);
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");
  for (const id of ["update-open-btn", "update-copy-btn", "update-stuck", "extras-open-btn", "extras-copy-btn"]) assert.ok(html.includes(`id="${id}"`), id);
});
