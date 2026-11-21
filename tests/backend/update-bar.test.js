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
  assert.match(app, /\["update-banner", "backend-update-banner", "save-failed-banner", "pull-update-hint"\]/);
});

test("the update link carries the id of the server this phone uses", () => {
  const fn = /function updatePageUrl_\(\) \{[\s\S]*?\n}\n/.exec(app)[0];
  const run = (apiUrl) => new Function("getApiUrl", "siteUrl_", `${fn}; return updatePageUrl_();`)(() => apiUrl, (p) => "https://site/" + p);
  assert.equal(run("https://script.google.com/macros/s/AKfycbxDEP_1-x/exec"), "https://site/setup/#update&dep=AKfycbxDEP_1-x");
  assert.equal(run(""), "https://site/setup/#update", "no address known: the page falls back to the newest tracker, as before");
});

test("both languages exist for the new texts", () => {
  for (const key of ["banner.backendUpdate", "banner.backendUrgent", "banner.pullAfterUpdate"]) {
    const m = new RegExp(`"${key.replace(".", "\\.")}": \\{ en: "[^"]+", es: "[^"]+" \\}`);
    assert.match(strings, m, key);
  }
});

test("back from the update page: the tap is remembered and a pull-down bar shows until the app reads the server again", () => {
  assert.match(html, /id="pull-update-hint"[^>]*hidden/);
  assert.match(app, /"update-open-btn"\)\.addEventListener\("click", \(\) => \{\n  noteUpdateOpened_\(\);/);
  assert.match(app, /"update-copy-btn"\)\.addEventListener\("click", async \(\) => \{\n  noteUpdateOpened_\(\);/);
  assert.match(app, /if \(!meta\.fromCache_\) \{ metaReadAt_ = Date\.now\(\); renderPullUpdateHint_\(\); \}/, "only a real server read ends it, never the saved startup copy");
  assert.match(app, /updateChecked_ = false;   \/\/ the update check runs again/, "a pull re-checks the server version");
  // The rule itself, on a fake page.
  const fn = /function renderPullUpdateHint_\(\) \{[\s\S]*?\n}\n/.exec(app)[0];
  const run = (rec, readAt, now) => {
    const store = { etUpdateOpened: rec ? JSON.stringify(rec) : null };
    const el = { hidden: true, textContent: "" };
    const doc = { hidden: false, getElementById: (id) => (id === "pull-update-hint" ? el : { hidden: true }) };
    const ls = { getItem: (k) => store[k] || null, removeItem: (k) => { store[k] = null; } };
    new Function("document", "localStorage", "tr", "stackTopBanners_", "Date", "metaReadAt_", "UPDATE_OPENED_KEY", `${fn}; renderPullUpdateHint_();`)(
      doc, ls, (k) => k, () => {}, { now: () => now }, readAt, "etUpdateOpened");
    return { shown: !el.hidden, kept: !!store.etUpdateOpened };
  };
  assert.deepEqual(run({ at: 1000 }, 500, 2000), { shown: true, kept: true }, "tapped after the last server read: the bar shows");
  assert.deepEqual(run({ at: 1000 }, 1500, 2000), { shown: false, kept: false }, "the server was read since: done");
  assert.deepEqual(run({ at: 1000 }, 0, 2000), { shown: false, kept: true }, "nothing read yet this open: waits");
  assert.deepEqual(run({ at: 1000 }, 500, 1000 + 25 * 3600 * 1000), { shown: false, kept: false }, "forgotten after a day");
  assert.deepEqual(run(null, 500, 2000), { shown: false, kept: false });
});
