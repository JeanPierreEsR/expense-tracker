// The company test copy (owner's copy, 2026-11-27; plan "Empresa de prueba en el teléfono"): the real backend running on the phone
// (docs/company-demo/), its made-up company, and the guards that keep it away from the owner's real copy. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..", "..");
const core = require(path.join(ROOT, "docs", "company-demo", "engine-core.js"));
const { seed } = require(path.join(ROOT, "docs", "company-demo", "seed.js"));
const sources = () => ({
  fakeGoogle: fs.readFileSync(path.join(ROOT, "tests", "harness", "fake-google.js"), "utf8"),
  files: fs.readdirSync(path.join(ROOT, "backend")).filter((f) => f.endsWith(".gs"))
    .map((f) => ({ name: f, source: fs.readFileSync(path.join(ROOT, "backend", f), "utf8") }))
});
const app = fs.readFileSync(path.join(ROOT, "docs", "app.js"), "utf8");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());

test("the phone's digests are the same as Google's (SHA-256 and MD5)", () => {
  for (const s of ["", "abc", "Ñandú — 漢字 ".repeat(40)]) {
    assert.deepEqual(core.sha256_([...Buffer.from(s)]), [...crypto.createHash("sha256").update(s).digest()], s);
    assert.deepEqual(core.md5_([...Buffer.from(s)]), [...crypto.createHash("md5").update(s).digest()], s);
  }
  const b = core.DemoBuffer.from("héllo", "utf8");
  assert.equal(core.DemoBuffer.from(b.toString("base64"), "base64").toString("utf8"), "héllo");
  assert.equal(b.toString("base64url"), Buffer.from("héllo").toString("base64url"));
});

test("a new test copy is a brand-new COMPANY copy: the welcome by sector, the pack always on", () => {
  const e = core.create(sources());
  const caps = e.api("getMeta", {}).capabilities;
  assert.equal(caps.companyCopy, true);
  assert.equal(caps.business, true);
  assert.equal(caps.onboarding, true, "empty start: the company welcome runs");
});

test("the made-up company: lenders and SUNAT owed, the building's funding, partners, units, waiting entries", () => {
  const e = core.create(sources());
  seed(e);
  assert.equal(e.api("getMeta", {}).capabilities.onboarding, false, "with data: no welcome");
  const co = e.api("getPeriodSummary", { startDate: today().slice(0, 8) + "01", endDate: today() }).company;
  const owed = co.owed.map((p) => p.name);
  assert.ok(owed.includes("Inversiones Demo EIRL") && owed.includes("Carmen Prestamista Demo"), owed.join());
  assert.ok(co.owed.some((p) => /SUNAT/.test(p.name)), "the withholding kept from the installments paid");
  assert.deepEqual(co.funding.map((f) => [f.name, f.amount, f.currency]), [["Edificio Los Pinos", 350000, "USD"]], "the closed project is left out");
  assert.ok(co.partners.length >= 2, "two partners with their contributions");
  assert.equal(e.rows("Entries").filter((x) => x.status === "pending").length, 4);
  assert.equal(e.rows("Tags").filter((t) => /^Depa /.test(t.name)).length, 40);
  assert.equal(e.rows("Companies").length, 1);
  // Made-up names only: every person in it is marked "Demo" (or is SUNAT's withholding).
  e.rows("Friends").forEach((f) => assert.match(f.name, /Demo|SUNAT/, f.name));
});

test("what is kept on the phone brings the same copy back", () => {
  const src = sources();
  const e = core.create(src);
  seed(e);
  const snap = structuredClone(e.snapshot());   // what IndexedDB keeps (Dates included)
  const again = core.create(src, snap);
  const range = { startDate: today().slice(0, 8) + "01", endDate: today() };
  assert.deepEqual(again.api("getPeriodSummary", range).company, e.api("getPeriodSummary", range).company);
  assert.equal(again.api("getMeta", {}).capabilities.companyCopy, true);
  assert.equal(again.rows("Entries").length, e.rows("Entries").length);
});

test("the app keeps the test copy away from the real one", () => {
  // Every request of the test copy goes to the engine, never to Google or the owner's relay.
  assert.match(app, /res = await \(apiUrl === COMPANY_DEMO_API_ \? companyDemoFetch_ : fetch\)\(apiUrl, \{/);
  assert.match(app, /function companyDemoNetGuard_\(\) \{\n  if \(!companyDemoOn_\(\) \|\| !window\.fetch\) return;/);
  assert.ok(app.includes("/script\\.google(usercontent)?\\.com|googleapis\\.com|workers\\.dev|"), "Google and the relay are refused");
  // Its own saved search copy, no update offers, no sharing question.
  assert.match(app, /indexedDB\.open\(companyDemoOn_\(\) \? "expense-tracker-company-demo" : "expense-tracker", 1\)/);
  assert.match(app, /function setUpdateAvailable_\(on\) \{\n  if \(companyDemoOn_\(\)\) on = false;/);
  assert.match(app, /if \(companyDemoOn_\(\)\) return;   \/\/ the company test copy always runs the newest backend/);
  assert.match(app, /if \(companyDemoOn_\(\)\) return;   \/\/ the company test copy sends nothing to anyone/);
  // The real copy's settings are kept aside before anything is replaced, and checked.
  assert.match(app, /await companyDemoSwap_\("real", real\);\n    const kept = await companyDemoSwap_\("real"\);\n    if \(!kept \|\| Object\.keys\(kept\)\.length !== Object\.keys\(real\)\.length\) throw/);
  // The button is on the owner's copy only (inside the invitation block).
  const html = fs.readFileSync(path.join(ROOT, "docs", "index.html"), "utf8");
  assert.match(html, /<div id="business-demo" class="business-invite" hidden>/, "hidden until the app knows it is the owner's copy");
  assert.match(app, /document\.getElementById\("business-demo"\)\.hidden = !perfIsOwnerCopy_\(\) \|\| companyDemoOn_\(\);/);
  // The worker loads exactly the files that exist.
  const worker = fs.readFileSync(path.join(ROOT, "docs", "company-demo", "worker.js"), "utf8");
  (/importScripts\(([^)]*)\)/.exec(worker)[1].match(/"[^"]+"/g) || []).forEach((f) => {
    const name = JSON.parse(f).split("?")[0];
    assert.ok(fs.existsSync(path.join(ROOT, "docs", "company-demo", name)), name);
  });
});
