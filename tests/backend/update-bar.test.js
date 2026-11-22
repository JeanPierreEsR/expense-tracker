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
  for (const key of ["banner.backendUpdate", "banner.backendUrgent", "banner.pullAfterUpdate", "update.backBody", "update.backBtn"]) {
    const m = new RegExp(`"${key.replace(".", "\\.")}": \\{ en: "[^"]+", es: "[^"]+" \\}`);
    assert.match(strings, m, key);
  }
});

test("back from the update page: the tap is remembered, a trip away arms the bar, and it lasts until a fresh read says the server is up to date", () => {
  assert.match(html, /<button type="button" id="pull-update-hint"[^>]*hidden/);
  assert.match(html, /id="update-back-box" hidden/);
  assert.match(app, /"update-open-btn"\)\.addEventListener\("click", \(\) => \{\n  noteUpdateOpened_\(\);/);
  assert.match(app, /"update-copy-btn"\)\.addEventListener\("click", async \(\) => \{\n  noteUpdateOpened_\(\);/);
  assert.match(app, /if \(!meta\.fromCache_\) \{ metaReadAt_ = Date\.now\(\); renderPullUpdateHint_\(\); \}/, "only a real server read counts, never the saved startup copy");
  assert.match(app, /updateChecked_ = false;   \/\/ the update check runs again/, "a pull re-checks the server version");
  assert.match(app, /if \(document\.hidden\) noteUpdateTripAway_\(\); else renderPullUpdateHint_\(\);/);
  const src = ["readUpdateOpened_", "writeUpdateOpened_", "noteUpdateOpened_", "noteUpdateTripAway_", "pullUpdateDue_"]
    .map((n) => new RegExp(`function ${n}\\([^)]*\\) \\{[\\s\\S]*?\\n}\\n`).exec(app)[0]).join("\n");
  // A little world: a clock, the phone's storage, what the app last read and whether the server looked behind.
  const world = () => {
    const w = { now: 1e6, store: {}, readAt: 0, behind: true };
    const ls = { getItem: (k) => (k in w.store ? w.store[k] : null), setItem: (k, v) => { w.store[k] = v; }, removeItem: (k) => { delete w.store[k]; } };
    const api = new Function("localStorage", "Date", "w", `const UPDATE_OPENED_KEY = "k"; let metaReadAt_, backendBehind_;
      ${src.replace(/metaReadAt_/g, "w.readAt").replace(/backendBehind_/g, "w.behind")}
      return { tap: noteUpdateOpened_, away: noteUpdateTripAway_, due: pullUpdateDue_ };`)(ls, { now: () => w.now }, w);
    return { w, ...api, kept: () => "k" in w.store };
  };
  let t = world(); t.w.readAt = 1; t.tap(); t.w.now += 2000;
  assert.equal(t.due(), false, "Safari did not open, the person never left: nothing to say");
  t.away(); t.w.now += 60000;
  assert.equal(t.due(), true, "back from Safari: the bar shows");
  t.w.readAt = t.w.now; t.w.behind = false;
  assert.equal(t.due(), false); assert.equal(t.kept(), false, "read since and the server is up to date: done");

  t = world(); t.w.readAt = 1; t.tap(); t.away(); t.w.now += 1000;
  t.w.readAt = t.w.now;   // came back halfway and pulled: the server still looks behind
  assert.equal(t.due(), false); assert.equal(t.kept(), true);
  t.w.now += 1000; t.away(); t.w.now += 1000;
  assert.equal(t.due(), true, "went back to finish and returned: the bar shows again");

  t = world(); t.w.readAt = 1; t.tap(); t.away(); t.w.readAt = t.w.now + 1; t.w.behind = true;
  t.w.now += 2 * 3600 * 1000; t.away();
  assert.equal(t.due(), false, "more than an hour after the tap a trip away no longer arms it");

  t = world(); t.tap(); t.away(); t.w.now += 1000;
  assert.equal(t.due(), false, "a fresh start has read nothing yet: it waits for that read (which ends it)");

  t = world(); t.w.readAt = 1; t.tap(); t.away(); t.w.now += 25 * 3600 * 1000;
  assert.equal(t.due(), false); assert.equal(t.kept(), false, "forgotten after a day");
});
