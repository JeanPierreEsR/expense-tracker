// Stable and live screens: friends use a frozen copy in docs/stable/ that only `./ship.sh --promote` changes; the owner uses the live
// screens at the site root. Covers the switch at the top of docs/index.html, the address helper, and promote.sh (run in a throwaway repo).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const indexHtml = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");

// ---------------------------------------------------------------- the switch
const channelScript = (() => {
  const from = indexHtml.indexOf('<meta name="app-channel"');
  const start = indexHtml.indexOf("<script>", from) + "<script>".length;
  return indexHtml.slice(start, indexHtml.indexOf("</script>", start));
})();

// Runs the switch the way a browser would; returns what it did.
function runSwitch({ href, stableOn = true, meta = "live", stored = "", api = "" }) {
  const store = stored ? { etChannel: stored } : {};
  if (api) store.apiUrl = api;
  const u = new URL(href);
  const out = { replaced: null, stopped: false, store };
  const ctx = {
    document: { querySelector: () => ({ content: meta }) },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    location: { href, search: u.search, hash: u.hash, hostname: u.hostname, replace: (x) => { out.replaced = x; } },
    URL,
  };
  ctx.window = ctx;
  ctx.stop = () => { out.stopped = true; };
  vm.createContext(ctx);
  vm.runInContext(channelScript.replace(/var STABLE_ON = (true|false);/, `var STABLE_ON = ${stableOn};`), ctx);
  out.siteUrl = ctx.etSiteUrl;
  return out;
}

const LIVE = "https://owner.github.io/expense-tracker/";

test("the switch is built and starts OFF in the code: nothing redirects while STABLE_ON is false", () => {
  assert.match(channelScript, /var STABLE_ON = (true|false);/);
  const r = runSwitch({ href: LIVE, stableOn: false });
  assert.equal(r.replaced, null);
});

test("with the switch on, a friend's device (no flag) is sent to stable/ keeping ?query and #hash", () => {
  const r = runSwitch({ href: LIVE + "?x=1#top" });
  assert.equal(r.replaced, LIVE + "stable/?x=1#top");
  assert.equal(r.stopped, false, "window.stop() would cancel the redirect itself (found in a real browser)");
  assert.equal(runSwitch({ href: LIVE + "index.html" }).replaced, LIVE + "stable/");
});

test("the owner's flag keeps a device on live; ?channel=live sets it and ?channel=stable forgets it", () => {
  assert.equal(runSwitch({ href: LIVE, stored: "live" }).replaced, null);
  const set = runSwitch({ href: LIVE + "?channel=live" });
  assert.equal(set.replaced, null);
  assert.equal(set.store.etChannel, "live");
  const forget = runSwitch({ href: LIVE + "?channel=stable", stored: "live" });
  assert.equal(forget.store.etChannel, undefined);
  assert.ok(forget.replaced.startsWith(LIVE + "stable/"), "a device that forgot the flag sees what friends see");
});

test("the owner's devices are recognised by their backend address, so a Home-Screen icon (its own storage) needs no flag", () => {
  const app = fs.readFileSync(path.join(ROOT, "docs", "app.js"), "utf8");
  const owner = /const OWNER_API_URL = "([^"]+)";/.exec(app)[1];
  assert.ok(channelScript.includes(`"${owner}"`), "index.html's OWNER_API is the same address as OWNER_API_URL in app.js");
  assert.equal(runSwitch({ href: LIVE, api: owner }).replaced, null, "owner's phone stays on live, no flag needed");
  const friend = runSwitch({ href: LIVE, api: "https://script.google.com/macros/s/AKfycbFRIENDSOWN/exec" });
  assert.equal(friend.replaced, LIVE + "stable/", "a friend's own address goes to stable");
  assert.equal(runSwitch({ href: LIVE }).replaced, LIVE + "stable/", "a new phone with no address goes to stable");
  const preview = runSwitch({ href: LIVE + "?channel=stable", api: owner });
  assert.ok(preview.replaced && preview.replaced.startsWith(LIVE + "stable/"), "?channel=stable lets the owner preview what friends see");
});

test("?channel=stable is an explicit preview: it goes to stable/ even while the switch is OFF, on any device, and ?channel=live never does", () => {
  const off = runSwitch({ href: LIVE + "?channel=stable", stableOn: false });
  assert.equal(off.replaced, LIVE + "stable/?channel=stable");
  const owner = fs.readFileSync(path.join(ROOT, "docs", "app.js"), "utf8").match(/const OWNER_API_URL = "([^"]+)";/)[1];
  assert.ok(runSwitch({ href: LIVE + "?channel=stable", stableOn: false, api: owner }).replaced, "also for the owner's own device");
  assert.ok(runSwitch({ href: "http://localhost:4180/?channel=stable", stableOn: false }).replaced, "also on the test harness");
  assert.equal(runSwitch({ href: LIVE + "?channel=live", stableOn: false }).replaced, null);
  assert.equal(runSwitch({ href: LIVE, stableOn: false }).replaced, null, "no link, switch off: nothing moves");
  assert.equal(runSwitch({ href: LIVE + "stable/?channel=stable", stableOn: false, meta: "stable" }).replaced, null, "no loop inside stable/");
});

test("stable/ itself and the local test harness are never redirected", () => {
  assert.equal(runSwitch({ href: LIVE + "stable/", meta: "stable" }).replaced, null);
  for (const host of ["http://localhost:4180/", "http://127.0.0.1:4180/", "http://[::1]:4180/", "http://app.localhost:4180/"]) {
    assert.equal(runSwitch({ href: host }).replaced, null, host);
  }
});

test("etSiteUrl points at the main site from both channels (setup/ and vendor/ live there, not in stable/)", () => {
  assert.equal(runSwitch({ href: LIVE }).siteUrl("setup/#update"), LIVE + "setup/#update");
  assert.equal(runSwitch({ href: LIVE + "index.html" }).siteUrl("vendor/pdfjs/pdf.min.js"), LIVE + "vendor/pdfjs/pdf.min.js");
  assert.equal(runSwitch({ href: LIVE + "stable/", meta: "stable" }).siteUrl("setup/"), LIVE + "setup/");
  assert.equal(runSwitch({ href: LIVE + "stable/index.html?cb=1", meta: "stable" }).siteUrl("vendor/tesseract/"), LIVE + "vendor/tesseract/");
});

test("the channel script comes first in the page and holds no ?v= tag (ship.sh counts those)", () => {
  assert.ok(indexHtml.indexOf('<meta name="app-channel" content="live">') < indexHtml.indexOf("style.css"));
  assert.ok(!channelScript.includes("?v="));
});

test("no screen builds a setup/ or vendor/ address from the page's own location any more", () => {
  const app = fs.readFileSync(path.join(ROOT, "docs", "app.js"), "utf8");
  const stm = fs.readFileSync(path.join(ROOT, "docs", "statements.js"), "utf8");
  for (const src of [app, stm]) {
    assert.ok(!/new URL\("(setup|vendor)\//.test(src));
    assert.ok(!/fetch\("setup\//.test(src));
    assert.ok(!/\.src = "vendor\//.test(src));
    assert.ok(!/`vendor\//.test(src));
  }
  assert.match(app, /function siteUrl_\(path\)/);
  assert.match(app, /siteUrl_\("setup\/pin\.json"\)/);
});

// ------------------------------------------------------------- promote.sh
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}
function write(dir, file, text) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }

// A tiny repo with two releases (0.1.0, then 0.1.1 which also changes backend/), an origin, and the real scripts.
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "promote-"));
  const origin = path.join(base, "origin.git"), work = path.join(base, "work");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  for (const f of ["ship.sh", "promote.sh"]) { fs.copyFileSync(path.join(ROOT, f), path.join(work, f)); fs.chmodSync(path.join(work, f), 0o755); }
  const release = (rel, ver, extra) => {
    write(work, "docs/index.html", `<html><head><meta name="app-release" content="${rel}"><meta name="app-channel" content="live"><script>window.etSiteUrl=1</script><link href="style.css?v=${ver}"></head></html>\n`);
    write(work, "docs/app.js", `// app ${rel}\n`);
    write(work, "docs/style.css", "body{}\n");
    write(work, "docs/version.json", JSON.stringify({ version: ver, release: rel }) + "\n");
    write(work, "docs/vendor/big.js", "// vendor\n");
    write(work, "docs/setup/index.html", "<html>installer</html>\n");
    write(work, "docs/setup-test/index.html", "<html>lab</html>\n");
    write(work, "docs/setup/pin.json", '{ "pin": "" }\n');
    write(work, "tests/backend/ok.test.js", 'require("node:test")("ok", () => {});\n');
    if (extra) extra();
    git(work, "add", "-A"); git(work, "commit", "-q", "-m", `release ${rel}`); git(work, "tag", "-a", `v${rel}`, "-m", rel);
  };
  release("0.1.0", "2026-01-01T00:00:00Z", () => write(work, "backend/Main.gs", "// one\n"));
  const backendOne = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", origin);
  release("0.1.1", "2026-01-02T00:00:00Z", () => write(work, "backend/Main.gs", "// two\n"));
  const backendTwo = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "main", "--tags");
  git(work, "fetch", "-q", "origin");
  return { base, work, origin, backendOne, backendTwo };
}
function promote(work, ...args) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;   // the scripts run their own `node --test`; it must not think it is nested in this one
  try { return { ok: true, out: execFileSync("./ship.sh", ["--promote", ...args], { cwd: work, encoding: "utf8", stdio: "pipe", env }) }; }
  catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; }
}

test("promote copies the chosen release's screens into stable/, marks them stable, leaves setup/ and vendor/ out, and moves the pin with them", () => {
  const r = makeRepo();
  const res = promote(r.work);
  assert.ok(res.ok, res.out);
  const st = (f) => path.join(r.work, "docs", "stable", f);
  assert.match(fs.readFileSync(st("index.html"), "utf8"), /<meta name="app-channel" content="stable">/);
  assert.match(fs.readFileSync(st("index.html"), "utf8"), /content="0\.1\.1"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(st("version.json"), "utf8")), { version: "2026-01-02T00:00:00Z", release: "0.1.1" });
  for (const gone of ["setup", "setup-test", "vendor", "stable"]) assert.ok(!fs.existsSync(st(gone)), `${gone} is not copied into stable/`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.work, "docs", "setup", "pin.json"), "utf8")).pin, r.backendTwo, "the pin is the release's last backend commit");
  assert.match(fs.readFileSync(path.join(r.work, "docs", "index.html"), "utf8"), /app-channel" content="live"/, "live is untouched");
  assert.match(git(r.origin, "tag", "-l", "stable-v0.1.1"), /stable-v0\.1\.1/, "tagged and pushed");
  assert.equal(git(r.origin, "rev-parse", "main"), git(r.work, "rev-parse", "HEAD"), "pushed");
  assert.match(fs.readFileSync(path.join(r.base, "FRIENDS_VERSIONS.md"), "utf8"), /\| 0\.1\.1 \| /);
  const again = promote(r.work);
  assert.ok(again.ok && /Nothing to change/.test(again.out), again.out);
});

test("promoting an older release is a rollback: older screens and the older backend pin", () => {
  const r = makeRepo();
  assert.ok(promote(r.work).ok);
  const back = promote(r.work, "0.1.0");
  assert.ok(back.ok, back.out);
  assert.match(fs.readFileSync(path.join(r.work, "docs", "stable", "index.html"), "utf8"), /content="0\.1\.0"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.work, "docs", "setup", "pin.json"), "utf8")).pin, r.backendOne);
  assert.match(back.out, /pin moved/);
});

test("a dry run changes nothing; an unknown release or a release from before the split is refused", () => {
  const r = makeRepo();
  const before = git(r.work, "rev-parse", "HEAD");
  const dry = promote(r.work, "--dry-run");
  assert.ok(dry.ok && /DRY RUN OK/.test(dry.out), dry.out);
  assert.equal(git(r.work, "rev-parse", "HEAD"), before);
  assert.ok(!fs.existsSync(path.join(r.work, "docs", "stable")));
  assert.ok(!promote(r.work, "9.9.9").ok);
  fs.writeFileSync(path.join(r.work, "docs", "index.html"), "<html><head><meta name=\"app-channel\" content=\"live\"></head></html>\n");
  git(r.work, "add", "-A"); git(r.work, "commit", "-q", "-m", "old style"); git(r.work, "tag", "-a", "v0.0.9", "-m", "old"); git(r.work, "push", "-q", "origin", "main", "--tags");
  const old = promote(r.work, "0.0.9");
  assert.ok(!old.ok && /cannot run from stable/.test(old.out), old.out);
});

test("a normal ship refuses a branch that changes docs/stable/ (only promote may)", () => {
  const r = makeRepo();
  assert.ok(promote(r.work).ok);
  git(r.work, "switch", "-q", "-c", "sneaky");
  write(r.work, "docs/stable/app.js", "// hand edit\n");
  git(r.work, "add", "-A"); git(r.work, "commit", "-q", "-m", "hand edit");
  git(r.work, "switch", "-q", "main");
  let out = "";
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  try { execFileSync("./ship.sh", ["sneaky", "msg"], { cwd: r.work, encoding: "utf8", stdio: "pipe", env }); } catch (e) { out = String(e.stderr) + String(e.stdout); }
  assert.match(out, /docs\/stable\//);
});

test("promote refuses to run from a chat's own worktree", () => {
  const r = makeRepo();
  const wt = path.join(r.base, "wt");
  git(r.work, "worktree", "add", "-q", "-b", "chat", wt, "main");
  const res = promote(wt);
  assert.ok(!res.ok && /ONLY from the main folder/.test(res.out), res.out);
});
