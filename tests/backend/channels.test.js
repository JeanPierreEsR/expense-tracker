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
function runSwitch({ href, stableOn = true, meta = "live", metas = {}, stored = "", api = "", have = "" }) {
  const store = stored ? { etChannel: stored } : {};
  if (have) store.etBackendRef = have;
  if (api) store.apiUrl = api;
  const u = new URL(href);
  const out = { replaced: null, stopped: false, store };
  const ctx = {
    document: { querySelector: (sel) => { const n = /name="([^"]+)"/.exec(sel); return n && n[1] in metas ? { content: metas[n[1]] } : n && n[1] !== "app-channel" ? null : { content: meta }; } },
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.work, "docs", "setup", "pin.json"), "utf8")).release, "0.1.1", "the pin also says which app release it belongs to (the server version More shows)");
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

// ------------------------------------------------------------ paired screens
const PAIR = { "app-channel": "stable", "app-pin": "bbbbbbb1234", "app-pairs": "aaaaaaa,ccccccc" };
const STABLE_URL = LIVE + "stable/index.html?x=1#h";

test("paired screens: a friend whose backend is an older kept one is sent to that pair's folder, keeping ?query and #hash", () => {
  const r = runSwitch({ href: STABLE_URL, metas: PAIR, have: "aaaaaaa99999" });
  assert.equal(r.replaced, LIVE + "stable-aaaaaaa/?x=1#h");
});

test("paired screens: no redirect when the backend matches this copy, is unknown, is not a kept pair, or this copy is itself a kept one", () => {
  assert.equal(runSwitch({ href: STABLE_URL, metas: PAIR, have: "bbbbbbb0000" }).replaced, null);
  assert.equal(runSwitch({ href: STABLE_URL, metas: PAIR }).replaced, null);
  assert.equal(runSwitch({ href: STABLE_URL, metas: PAIR, have: "ddddddd" }).replaced, null);
  assert.equal(runSwitch({ href: LIVE + "stable-aaaaaaa/", metas: { ...PAIR, "app-archived": "20261101T000000Z", "app-pairs": "" }, have: "ccccccc" }).replaced, null);
});

test("paired screens: the live copy and a copy without the tags never redirect that way", () => {
  assert.equal(runSwitch({ href: LIVE, stableOn: false, have: "aaaaaaa" }).replaced, null);
  assert.equal(runSwitch({ href: STABLE_URL, metas: { "app-channel": "stable" }, have: "aaaaaaa" }).replaced, null);
});

test("paired screens: the app remembers its backend version, a kept older copy moves on once its backend is updated, and the update sheet opens once per version", () => {
  const app = fs.readFileSync(path.join(ROOT, "docs", "app.js"), "utf8");
  assert.match(app, /function syncPairWithBackend_\(\)/);
  assert.match(app, /localStorage\.setItem\("etBackendRef", caps\.backendRef\)/);
  assert.match(app, /m\("app-archived"\)/);
  assert.match(app, /meta = prefetchedMeta \|\| await callApi\("getMeta", \{\}\);\n  syncPairWithBackend_\(\);/);
  assert.match(app, /function promptBackendUpdateOnce_\(latest\)/);
  assert.match(app, /etUpdatePrompted/);
});

test("promote keeps the old screens as stable-<pin>/ when the pin moves, lists them in stable/, and drops one that becomes current again (rollback)", () => {
  const r = makeRepo();
  assert.ok(promote(r.work, "0.1.0").ok);
  assert.ok(fs.readdirSync(path.join(r.work, "docs")).every((d) => !d.startsWith("stable-")), "first promote: nothing to keep");
  const up = promote(r.work, "0.1.1");
  assert.ok(up.ok, up.out);
  const old7 = r.backendOne.slice(0, 7), new7 = r.backendTwo.slice(0, 7);
  const kept = fs.readFileSync(path.join(r.work, "docs", `stable-${old7}`, "index.html"), "utf8");
  assert.match(kept, /content="0\.1\.0"/, "the kept copy is the old release's screens");
  assert.match(kept, new RegExp(`name="app-pin" content="${r.backendOne}"`));
  assert.match(kept, /name="app-archived" content="\d{8}T\d{9}Z"/);
  assert.ok(!/app-pairs/.test(kept));
  const cur = fs.readFileSync(path.join(r.work, "docs", "stable", "index.html"), "utf8");
  assert.match(cur, new RegExp(`name="app-pin" content="${r.backendTwo}"`));
  assert.match(cur, new RegExp(`name="app-pairs" content="${old7}"`));
  assert.ok(!fs.existsSync(path.join(r.work, "docs", `stable-${new7}`)));
  assert.equal(git(r.work, "status", "--porcelain"), "", "everything is committed");
  const back = promote(r.work, "0.1.0");
  assert.ok(back.ok, back.out);
  assert.ok(!fs.existsSync(path.join(r.work, "docs", `stable-${old7}`)), "the pin is current again: its kept copy is gone");
  assert.ok(fs.existsSync(path.join(r.work, "docs", `stable-${new7}`)), "the release rolled back from is kept for friends already on it");
});

test("promote keeps at most 3 older copies and COMMITS the removal of the rest (it used to leave them as loose deleted files)", () => {
  const r = makeRepo();
  const more = (rel, n) => {
    write(r.work, "docs/index.html", `<html><head><meta name="app-release" content="${rel}"><meta name="app-channel" content="live"><script>window.etSiteUrl=1</script><link href="style.css?v=${rel}"></head></html>\n`);
    write(r.work, "docs/app.js", `// app ${rel}\n`);
    write(r.work, "docs/version.json", JSON.stringify({ version: `2026-01-0${n}T00:00:00Z`, release: rel }) + "\n");
    write(r.work, "backend/Main.gs", `// backend ${rel}\n`);
    git(r.work, "add", "-A"); git(r.work, "commit", "-q", "-m", `release ${rel}`); git(r.work, "tag", "-a", `v${rel}`, "-m", rel);
    git(r.work, "push", "-q", "origin", "main", "--tags");
  };
  more("0.1.2", 3); more("0.1.3", 4); more("0.1.4", 5); more("0.1.5", 6);
  for (const rel of ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"]) {
    const res = promote(r.work, rel);
    assert.ok(res.ok, res.out);
    assert.equal(git(r.work, "status", "--porcelain"), "", `nothing is left loose after promoting ${rel}`);
  }
  const kept = fs.readdirSync(path.join(r.work, "docs")).filter((d) => d.startsWith("stable-"));
  assert.equal(kept.length, 3, "only the newest 3 older copies stay");
  assert.equal(git(r.work, "ls-files", "docs/stable-*").split("\n").map((f) => f.split("/")[1]).filter((v, i, a) => a.indexOf(v) === i).length, 3, "and git agrees");
});

// Five promotes, each moving the pin; returns the pins in order (index 0 = the first release's) and the repo.
function fivePromotes(copiesFile) {
  const r = makeRepo();
  const pins = [r.backendOne, r.backendTwo];
  const more = (rel, n) => {
    write(r.work, "docs/index.html", `<html><head><meta name="app-release" content="${rel}"><meta name="app-channel" content="live"><script>window.etSiteUrl=1</script><link href="style.css?v=${rel}"></head></html>\n`);
    write(r.work, "docs/version.json", JSON.stringify({ version: `2026-01-0${n}T00:00:00Z`, release: rel }) + "\n");
    write(r.work, "backend/Main.gs", `// backend ${rel}\n`);
    git(r.work, "add", "-A"); git(r.work, "commit", "-q", "-m", `release ${rel}`); git(r.work, "tag", "-a", `v${rel}`, "-m", rel);
    git(r.work, "push", "-q", "origin", "main", "--tags");
    pins.push(git(r.work, "rev-parse", "HEAD"));
  };
  more("0.1.2", 3); more("0.1.3", 4); more("0.1.4", 5); more("0.1.5", 6);
  if (copiesFile) process.env.FRIENDS_COPIES_FILE = copiesFile(r, pins);
  try {
    for (const rel of ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"]) { const res = promote(r.work, rel); assert.ok(res.ok, res.out); }
  } finally { delete process.env.FRIENDS_COPIES_FILE; }
  const kept = fs.readdirSync(path.join(r.work, "docs")).filter((d) => d.startsWith("stable-")).map((d) => d.slice(7)).sort();
  return { r, pins, kept, status: git(r.work, "status", "--porcelain") };
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test("a kept copy a friend used recently stays, whatever its age; the unused ones go; the newest 2 stay as a safety net", () => {
  const out = fivePromotes((r, pins) => {
    const f = path.join(r.base, "copies.json");
    fs.writeFileSync(f, JSON.stringify({ updated: daysAgo(0), pins: { [pins[1].slice(0, 7)]: { lastSeen: daysAgo(3), installs: 1 } } }));
    return f;
  });
  const want = [out.pins[1], out.pins[3], out.pins[4]].map((p) => p.slice(0, 7)).sort();   // 0.1.1's pin (in use) + the two newest kept copies
  assert.deepEqual(out.kept, want);
  assert.equal(out.status, "", "and the removals are committed");
});

test("a copy a friend uses that an earlier promote already removed is brought back", () => {
  // Without the list, five promotes keep only the newest 3 copies: the oldest copy (pins[1]) is gone.
  const first = fivePromotes(null);
  const gone = first.pins[1].slice(0, 7);
  assert.ok(!first.kept.includes(gone), "the oldest copy was removed");
  // Now the list says a friend used it recently: the next promote restores it.
  const f = path.join(first.r.base, "copies.json");
  fs.writeFileSync(f, JSON.stringify({ updated: daysAgo(0), pins: { [gone]: { lastSeen: daysAgo(2), installs: 1 } } }));
  process.env.FRIENDS_COPIES_FILE = f;
  try {
    // Re-promoting the same release changes nothing else, so the only change is the restored copy.
    const res = promote(first.r.work, "0.1.5");
    assert.ok(res.ok, res.out);
    assert.match(res.out, new RegExp(`Bringing back stable-${gone}`));
  } finally { delete process.env.FRIENDS_COPIES_FILE; }
  assert.ok(fs.existsSync(path.join(first.r.work, "docs", `stable-${gone}`, "index.html")), "the copy is back");
  assert.match(fs.readFileSync(path.join(first.r.work, "docs", `stable-${gone}`, "index.html"), "utf8"), /name="app-archived"/, "as it was");
  assert.equal(git(first.r.work, "status", "--porcelain"), "", "and it is committed");
});

test("a copy last used over 30 days ago is no longer protected", () => {
  const out = fivePromotes((r, pins) => {
    const f = path.join(r.base, "copies.json");
    fs.writeFileSync(f, JSON.stringify({ updated: daysAgo(0), pins: { [pins[1].slice(0, 7)]: { lastSeen: daysAgo(45), installs: 1 } } }));
    return f;
  });
  assert.deepEqual(out.kept, [out.pins[3], out.pins[4]].map((p) => p.slice(0, 7)).sort());
});

test("without the list the newest 3 stay, as before", () => {
  const out = fivePromotes(null);
  assert.equal(out.kept.length, 3);
});

test("tools/friends-copies.py turns the app-speed reports and the promote log into the list of copies in use", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copies-"));
  const csv = path.join(dir, "perf.csv"), md = path.join(dir, "FRIENDS_VERSIONS.md"), out = path.join(dir, "copies.json");
  fs.writeFileSync(md, "| Date | Release | Backend pin | Note |\n|---|---|---|---|\n| 2026-10-23 | 0.32.1 | a40ff6f | promoted |\n| 2026-10-24 | 0.41.0 | cdc54b1 | promoted |\n| 2026-10-24 | 0.43.0 | 0bfee36 | promoted |\n");
  fs.writeFileSync(csv, [
    "received_at,install_id,label,seq,at,kind,action,total_ms,server_ms,cold,attempts,ok,app_version,device",
    "2026-10-20T10:00:00Z,aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,Ana,1,x,call,a,1,1,no,1,yes,0.32.1,iPhone",
    "2026-10-24T10:00:00Z,aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,Ana,2,x,call,a,1,1,no,1,yes,0.41.0,iPhone",
    "2026-10-22T10:00:00Z,bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb,Ben,1,x,call,a,1,1,no,1,yes,0.41.0,iPhone",
    "2026-10-23T10:00:00Z,cccccccc-cccc-cccc-cccc-cccccccccccc,Owner,1,x,call,a,1,1,no,1,yes,0.43.0,Mac",
    "2026-10-23T10:00:00Z,dddddddd-dddd-dddd-dddd-dddddddddddd,Cy,1,x,call,a,1,1,no,1,yes,0.99.9,iPhone",
  ].join("\n") + "\n");
  const printed = execFileSync("python3", [path.join(ROOT, "tools", "friends-copies.py"), csv, md, out], { encoding: "utf8" });
  const data = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(data.pins, { cdc54b1: { lastSeen: "2026-10-24", installs: 2 } }, "Ana's newest report counts, her older one does not; the owner and an unknown release are left out");
  assert.ok(!/Ana|Ben/.test(JSON.stringify(data)), "the list holds no names");
  assert.match(printed, /Cy.*0\.99\.9.*not counted/);
});

test("a normal ship refuses a branch that changes a kept stable-<pin>/ copy", () => {
  const sh = fs.readFileSync(path.join(ROOT, "ship.sh"), "utf8");
  assert.match(sh, /\^docs\/stable\(-\[0-9a-f\]\+\)\?\//);
});
