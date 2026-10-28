// The Business pack is HIDDEN FROM NEW PEOPLE until the owner says otherwise (owner's rule, 2026-10-27). A "new person's copy" is
// one made by the installer (Script Property FEATURES present). Made-up data on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const friendCopy = () => {
  const { rt } = freshApp({ entries: 10 });
  rt.svc.props.set("FEATURES", "base,gmail");
  return rt;
};
const ownerCopy = () => freshApp({ entries: 10 }).rt;

test("the owner's own copy is always offered the pack, and everything works as before", () => {
  const rt = ownerCopy();
  assert.equal(rt.api("getMeta", {}).capabilities.businessOffered, true);
  rt.api("setBusinessFeatures", { on: true });
  assert.equal(rt.api("getMeta", {}).capabilities.business, true);
  assert.ok(rt.api("addCompany", { name: "Studio A" }).id);
});

test("a new person's copy is not offered the pack: it is reported as not offered and switching it on is refused", () => {
  const rt = friendCopy();
  const caps = rt.api("getMeta", {}).capabilities;
  assert.equal(caps.businessOffered, false);
  assert.equal(caps.business, false);
  assert.throws(() => rt.api("setBusinessFeatures", { on: true }), /not available yet/i);
  assert.equal(rt.api("getMeta", {}).capabilities.business, false);
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies')`), "no business tab is ever created");
  assert.throws(() => rt.api("addCompany", { name: "Studio A" }), /turned off/i);
});

test("a Settings row that already says yes is ignored on a new person's copy (one choke point)", () => {
  const rt = friendCopy();
  rt.run(`setSetting_('business_features', 'yes')`);
  const meta = rt.api("getMeta", {});
  assert.equal(meta.capabilities.business, false);
  assert.deepEqual(meta.companies, []);
  assert.deepEqual(meta.projects, []);
  assert.throws(() => rt.api("listCompaniesAndProjects", {}), /turned off/i);
  assert.throws(() => rt.api("getCompanyIgv", { id: "x" }), /turned off/i);
});

test("switching the pack OFF is always allowed, even where it is not offered", () => {
  const rt = friendCopy();
  assert.doesNotThrow(() => rt.api("setBusinessFeatures", { on: false }));
});

test("the owner can open it for ONE friend's copy with a Settings row, and close it again without losing anything", () => {
  const rt = friendCopy();
  rt.run(`setSetting_('business_offered', 'yes')`);
  assert.equal(rt.api("getMeta", {}).capabilities.businessOffered, true);
  rt.api("setBusinessFeatures", { on: true });
  const co = rt.api("addCompany", { name: "Studio A" });
  assert.equal(rt.api("getMeta", {}).capabilities.business, true);
  rt.run(`setSetting_('business_offered', 'no')`);
  assert.equal(rt.api("getMeta", {}).capabilities.business, false, "hidden again");
  assert.deepEqual(rt.api("getMeta", {}).companies, []);
  assert.equal(rt.rows("Companies").length, 1, "nothing was deleted");
  rt.run(`setSetting_('business_offered', 'yes')`);
  assert.equal(rt.api("getMeta", {}).companies[0].id, co.id, "it all comes back");
});

test("opening it to everyone is one constant, and nothing else changes", () => {
  const rt = friendCopy();
  assert.equal(rt.api("getMeta", {}).capabilities.businessOffered, false);
  rt.run(`BUSINESS_OPEN_TO_FRIENDS_ = true`);
  assert.equal(rt.api("getMeta", {}).capabilities.businessOffered, true);
  rt.api("setBusinessFeatures", { on: true });
  assert.equal(rt.api("getMeta", {}).capabilities.business, true);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "..", "backend", "Business.gs"), "utf8").includes("var BUSINESS_OPEN_TO_FRIENDS_ = false;"),
    "the shipped value is false: a promote must never open it by accident");
});

test("on the phone the two doors are closed in the page itself and opened only by the server's say-so", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(html, /id="more-business-features-btn" hidden/);
  assert.match(html, /<div id="wb-block" hidden>/);
  assert.match(app, /document\.getElementById\("more-business-features-btn"\)\.hidden = !businessOffered\(\);/);
  assert.match(app, /waEl_\("wb-block"\)\.hidden = !businessOffered\(\);/);
  assert.match(app, /if \(!businessOffered\(\)\) welcome_\.business = false;/);
  // start-up data saved before this existed has no such key: it must not open the door on a new person's copy
  const fn = app.match(/function businessOffered\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /c\.businessOffered !== undefined \? !!c\.businessOffered : !!\(c\.business \|\| c\.perfLog\)/);
  const strings = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "Strings.gs"), "utf8");
  assert.match(strings, /"business\.notOffered": \{ en: "[^"]+", es: "[^"]+"/);
});
