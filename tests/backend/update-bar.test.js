// The closable "update your app" bar and the link that tells the setup page which server the phone uses.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const root = path.join(__dirname, "..", "..", "docs");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const strings = fs.readFileSync(path.join(root, "strings.js"), "utf8");

test("every capability the app REQUIRES is one the current backend reports as true (a typo would nag everybody forever)", () => {
  const required = JSON.parse(/const REQUIRED_BACKEND_CAPS_ = (\[[^\]]*\]);/.exec(app)[1]);
  assert.ok(required.length >= 1);
  const { rt } = freshApp({ small: true });
  for (const name of required) assert.equal(rt.run(`getCapabilities_()[${JSON.stringify(name)}]`), true, name);
});

test("a server missing a required capability turns on the urgent bar; closing it lasts only until the app is reopened, the ordinary one for 24 hours", () => {
  assert.match(app, /backendUrgent_ = REQUIRED_BACKEND_CAPS_\.some\(\(c\) => !caps\[c\]\);\n  if \(backendUrgent_\) setUpdateAvailable_\(true\)/);
  assert.match(app, /setUpdateAvailable_\(behind \|\| backendUrgent_\)/);
  assert.match(app, /if \(backendUrgent_\) return false;   \/\/ an urgent bar returns at every app open/);
  assert.match(app, /Date\.now\(\) - c\.at < 24 \* 3600 \* 1000/);
  assert.match(app, /document\.getElementById\("backend-update-open"\)\.addEventListener\("click", \(\) => openUpdateModal_\(\)\)/, "tapping the bar opens the same open-in-Safari sheet as More → Update available");
});

test("the bar has its markup, a real close button and the stacking of all the top bars; More shows no server version line", () => {
  assert.ok(!/more-server-version/.test(html) && !/more-server-version/.test(app));
  assert.match(html, /id="backend-update-banner"[^>]*hidden/);
  assert.match(html, /id="backend-update-open"/);
  assert.match(html, /id="backend-update-close"/);
  assert.match(app, /\["update-banner", "backend-update-banner", "save-failed-banner"\]/);
});

test("the update link carries the id of the server this phone uses", () => {
  const fn = /function updatePageUrl_\(\) \{[\s\S]*?\n}\n/.exec(app)[0];
  const run = (apiUrl) => new Function("getApiUrl", "siteUrl_", `${fn}; return updatePageUrl_();`)(() => apiUrl, (p) => "https://site/" + p);
  assert.equal(run("https://script.google.com/macros/s/AKfycbxDEP_1-x/exec"), "https://site/setup/#update&dep=AKfycbxDEP_1-x");
  assert.equal(run(""), "https://site/setup/#update", "no address known: the page falls back to the newest tracker, as before");
});

test("both languages exist for the new texts", () => {
  for (const key of ["banner.backendUpdate", "banner.backendUrgent"]) {
    const m = new RegExp(`"${key.replace(".", "\\.")}": \\{ en: "[^"]+", es: "[^"]+" \\}`);
    assert.match(strings, m, key);
  }
});
