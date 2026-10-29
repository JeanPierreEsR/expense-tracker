// Stage 4a of the friends & family rollout: docs/setup/Install.gs, the file the installer page adds to a
// new person's own copy of the backend. It runs on top of the REAL backend files, on the fake Google layer
// (with a recording stand-in for triggers and for the approval page). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const INSTALL = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "setup", "Install.gs"), "utf8");
const RETURN = "https://jeanpierreesr.github.io/expense-tracker/setup/";
const MAIN = "https://script.google.com/macros/s/AKfycbMadeUpInstallerAddr/exec";

// Adds Install.gs the way the installer page does (placeholders replaced) and fakes what a web app has.
function withInstall({ release = "r1", code = "made-up-code-0123456789abcdef", url = "", features = "base", ref = "", appRelease = "" } = {}) {
  const { rt } = freshApp({ small: true });
  const triggers = [];
  rt.ctx.__triggers = triggers;
  rt.run(`
    ScriptApp = {
      getProjectTriggers: () => __triggers.slice(),
      deleteTrigger: (t) => { const i = __triggers.indexOf(t); if (i >= 0) __triggers.splice(i, 1); },
      newTrigger: (fn) => { const t = { fn: fn, every: 0, getHandlerFunction: () => fn };
        const b = { timeBased: () => b, everyMinutes: (n) => { t.every = n; return b; }, create: () => { __triggers.push(t); return t; } }; return b; },
      getAuthorizationInfo: () => ({ getAuthorizationStatus: () => 'NOT_REQUIRED' }),
      AuthMode: { FULL: 'FULL' }, AuthorizationStatus: { REQUIRED: 'REQUIRED' }
    };
    HtmlService = { createHtmlOutput: (html) => { const o = { _html: html, getContent: () => html, setTitle: () => o, addMetaTag: () => o }; return o; } };
  `);
  const load = (opts) => {
    const o = Object.assign({ release, code, url, features, ref, appRelease }, opts);
    let src = INSTALL.replace("__RELEASE__", o.release).replace("__CODE__", o.code).replace("__MAINURL__", o.url).replace("__FEATURES__", o.features);
    if (o.ref) src = src.replace("__BACKENDREF__", o.ref);
    if (o.appRelease) src = src.replace("__APPRELEASE__", o.appRelease);
    rt.run(src);
  };
  load();
  const get = (params) => {
    rt.ctx.__params = params;
    const out = rt.run("doGet({ parameter: __params })");
    return out.getContent();
  };
  const json = (params) => JSON.parse(get(params));
  return { rt, triggers, load, get, json };
}

test("ping answers at once", () => {
  const { json } = withInstall();
  assert.deepEqual(json({ check: "ping" }), { ok: true });
});

test("first visit, basics only: applies the access code and FEATURES, creates no timers, offers Continue", () => {
  const { rt, triggers, get } = withInstall({ features: "base" });
  const page = get({ return: RETURN });
  assert.equal(rt.svc.props.get("ACCESS_CODE"), "made-up-code-0123456789abcdef");
  assert.equal(rt.svc.props.get("FEATURES"), "base");
  assert.equal(triggers.length, 0);
  assert.ok(page.includes(RETURN + "#done"), "Continue link goes back to the installer with #done");
});

test("first visit with both extras: one visit approves and starts the REAL timers", () => {
  const { rt, triggers, get } = withInstall({ features: "base,keepawake,gmail" });
  get({ return: RETURN });
  assert.equal(rt.svc.props.get("FEATURES"), "base,keepawake,gmail");
  const byFn = Object.fromEntries(triggers.map((t) => [t.fn, t.every]));
  assert.deepEqual(byFn, { pingWebApp_: 5, runAutomation: 15 });
  // visiting again (Google sometimes loads the page twice) does not duplicate anything
  get({ return: RETURN });
  assert.equal(triggers.length, 2);
});

test("with FEATURES set by the installer, the real backend honours it (keep-awake ping needs the address too)", () => {
  const { rt, load } = withInstall({ features: "base,keepawake", url: MAIN });
  load();
  rt.run("doGet({ parameter: {} })");
  assert.equal(rt.svc.props.get("WEB_APP_URL"), MAIN);
  rt.run("pingWebApp_()");
  assert.ok(rt.svc.fetchLog.some((f) => f.url === MAIN), "ping goes to this copy's own address");
  assert.equal(rt.run('featureOn_("gmail")'), false);
});

test("a return address outside the installer is not offered as a link", () => {
  const { get } = withInstall();
  const page = get({ return: "https://evil.example/setup/" });
  assert.ok(!page.includes("evil.example"));
  assert.ok(page.includes("close this page"));
});

test("version check reports release, code, extras and timers", () => {
  const { json, get } = withInstall({ features: "base,keepawake" });
  get({});
  const v = json({ check: "version" });
  assert.equal(v.release, "r1");
  assert.equal(v.codeFor, "r1");
  assert.equal(v.features, "base,keepawake");
  assert.equal(v.keepAwake, true);
  assert.equal(v.scanning, false);
  assert.equal(v.setUp, false);
});

test("build: real progress, sets 'set up', and a second call is harmless", () => {
  const { rt, json } = withInstall();
  const first = json({ check: "build" });
  assert.equal(first.ok, true);
  const p = json({ check: "progress" });
  assert.equal(p.setUp, true);
  assert.equal(p.done, p.total);
  assert.ok(p.total > 5);
  assert.equal(json({ check: "build" }).already, true);
  assert.equal(rt.svc.props.get("INSTALL_SETUP_DONE"), "yes");
});

test("adding extras LATER: the side-copy visit starts the timers but leaves live settings alone; the main copy applies them", () => {
  const { rt, triggers, load, get, json } = withInstall({ release: "r1", features: "base" });
  get({});                                   // first visit, basics only
  assert.equal(rt.svc.props.get("FEATURES"), "base");
  load({ release: "r2", features: "base,keepawake,gmail" });   // the installer pushed a new version with both extras
  const page = get({ add: "keepawake,gmail", return: RETURN });
  assert.equal(rt.svc.props.get("FEATURES"), "base", "the live app is unchanged until the person finishes");
  assert.equal(rt.svc.props.get("INSTALL_CODE_SET_FOR"), "r1");
  assert.deepEqual(triggers.map((t) => t.fn).sort(), ["pingWebApp_", "runAutomation"]);
  assert.ok(page.includes(RETURN + "#approved=extras"));
  // the installer switches the main address to the new version, then asks it for its status
  const v = json({ check: "version" });
  assert.equal(v.release, "r2");
  assert.equal(rt.svc.props.get("FEATURES"), "base,keepawake,gmail");
  assert.equal(v.keepAwake, true);
  assert.equal(v.scanning, true);
});

test("adding only e-mail reading later does not start the keep-awake timer", () => {
  const { triggers, load, get } = withInstall({ features: "base" });
  get({});
  load({ release: "r2", features: "base,gmail" });
  get({ add: "gmail", return: RETURN });
  assert.deepEqual(triggers.map((t) => t.fn), ["runAutomation"]);
});

test("e-mail check only counts, never opens", () => {
  const { rt, get, json } = withInstall({ features: "base,gmail" });
  get({});
  const calls = [];
  const orig = rt.svc.gmail.advanced.Users.Messages.get;
  rt.svc.gmail.advanced.Users.Messages.get = (...a) => { calls.push(a); return orig(...a); };
  const g = json({ check: "gmail" });
  assert.equal(g.ok, true);
  assert.equal(typeof g.count, "number");
  assert.equal(calls.length, 0, "no e-mail was opened");
});

test("the backend version this copy was built from is reported (check=version and the app's capabilities); an unstamped copy reports none", () => {
  const stamped = withInstall({ ref: "abc1234def" });
  stamped.get({});
  assert.equal(stamped.json({ check: "version" }).backendRef, "abc1234def");
  assert.equal(stamped.rt.run("getCapabilities_().backendRef"), "abc1234def");
  const bare = withInstall();   // the placeholder is never replaced (e.g. the owner's own testing)
  bare.get({});
  assert.equal(bare.json({ check: "version" }).backendRef, "");
  assert.equal(bare.rt.run("getCapabilities_().backendRef"), "");
});

test("the app release the backend was promoted with is reported next to its version (More shows both); an unstamped copy reports none; every copy says it reads dates in the Sheet's zone", () => {
  const stamped = withInstall({ ref: "abc1234def", appRelease: "1.26.1" });
  stamped.get({});
  assert.equal(stamped.rt.run("getCapabilities_().backendRelease"), "1.26.1");
  assert.equal(stamped.rt.run("getCapabilities_().sheetDates"), true);
  const bare = withInstall({ ref: "abc1234def" });   // a pin from before releases were recorded in it: the placeholder stays
  bare.get({});
  assert.equal(bare.rt.run("getCapabilities_().backendRelease"), "");
});

test("an UPDATE sent without an access code keeps the one this copy already has (so the person's other phone keeps working)", () => {
  const { rt, load, get } = withInstall({ release: "r1", code: "first-code-0123456789abcdef", features: "base" });
  get({});
  assert.equal(rt.svc.props.get("ACCESS_CODE"), "first-code-0123456789abcdef");
  load({ release: "r2", code: "" });   // an update pushed from a phone that does not know the code
  get({});
  assert.equal(rt.svc.props.get("ACCESS_CODE"), "first-code-0123456789abcdef");
});

test("the owner's own copy (no installer file) reports no backend version", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.run("getCapabilities_().backendRef"), "");
});

// More → Extra features: an extra can be switched off without deleting anything, and an update must not switch it back on.
test("switching an extra off removes it from FEATURES, stops its timer and survives an update", () => {
  const { rt, triggers, load } = withInstall({ features: "base,keepawake,gmail", url: MAIN });
  rt.run("doGet({ parameter: {} })");
  rt.svc.props.set("ACCESS_CODE", rt.ACCESS_CODE);   // the installer wrote its own code; the harness signs in with its own
  assert.ok(triggers.some((t) => t.fn === "pingWebApp_"));
  const r = rt.api("setExtraOff", { name: "keepawake" });
  assert.equal(r.capabilities.keepAwake, false);
  assert.equal(r.capabilities.bankEmails, true);
  assert.equal(rt.svc.props.get("FEATURES"), "base,gmail");
  assert.ok(!triggers.some((t) => t.fn === "pingWebApp_"), "keep-awake timer removed");
  load({ release: "r2" });   // "Update my app": a new release rewrites FEATURES from the installer's own list
  rt.run("doGet({ parameter: {} })");
  assert.equal(rt.svc.props.get("FEATURES"), "base,gmail", "the update did not turn it back on");
  assert.ok(!triggers.some((t) => t.fn === "pingWebApp_"), "and did not restart its timer");
});

test("switching Gmail off never leaves FEATURES empty (empty would mean everything on)", () => {
  const { rt } = withInstall({ features: "base,gmail" });
  rt.run("doGet({ parameter: {} })");
  rt.svc.props.set("ACCESS_CODE", rt.ACCESS_CODE);
  rt.api("setExtraOff", { name: "gmail" });
  assert.equal(rt.svc.props.get("FEATURES"), "base");
  assert.equal(rt.run('featureOn_("gmail")'), false);
  assert.equal(rt.run("isFriendCopy_()"), true);
});

test("approving an extra again on the setup page clears the opt-out", () => {
  const { rt, load } = withInstall({ features: "base,gmail" });
  rt.run("doGet({ parameter: {} })");
  rt.svc.props.set("ACCESS_CODE", rt.ACCESS_CODE);
  rt.api("setExtraOff", { name: "gmail" });
  assert.equal(rt.svc.props.get("FEATURES_OFF"), "gmail");
  rt.run('doGet({ parameter: { add: "gmail" } })');
  assert.equal(rt.svc.props.get("FEATURES_OFF"), "");
  assert.equal(rt.svc.props.get("FEATURES"), "base", "the live app is unchanged until the person finishes");
  load({ release: "r3", features: "base,gmail" });
  rt.run("doGet({ parameter: {} })");
  assert.equal(rt.svc.props.get("FEATURES"), "base,gmail");
});

test("opt-out is refused on the owner's copy and for an unknown name", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.api("setExtraOff", { name: "gmail" }), /only for copies/);
  assert.throws(() => rt.api("takeBackPermissions", { confirm: true }), /only for copies/);
  rt.svc.props.set("FEATURES", "base,gmail");
  assert.throws(() => rt.api("setExtraOff", { name: "telegram" }), /does not exist/);
});

test("taking back all permissions keeps the data and the sign-ins, stops every timer and needs confirmation", () => {
  const { rt, triggers } = withInstall({ features: "base,keepawake,gmail", url: MAIN });
  rt.run("doGet({ parameter: {} })");
  rt.svc.props.set("ACCESS_CODE", rt.ACCESS_CODE);
  assert.ok(triggers.length > 0);
  const rowsBefore = rt.svc.ss.getSheets().reduce((n, s) => n + s.getLastRow(), 0);
  assert.throws(() => rt.api("takeBackPermissions", {}), /confirmation/);
  assert.equal(rt.svc.props.get("FEATURES"), "base,keepawake,gmail", "nothing changed without confirmation");
  rt.run("ScriptApp.invalidateAuth = () => {};");   // the installer test double has no such call
  const r = rt.api("takeBackPermissions", { confirm: true });
  assert.equal(r.permissionRevoked, true);
  assert.equal(triggers.length, 0);
  assert.equal(rt.svc.props.get("FEATURES"), "base");
  assert.equal(rt.svc.ss.getSheets().reduce((n, s) => n + s.getLastRow(), 0), rowsBefore, "no data touched");
  assert.ok(rt.svc.props.get("ACCESS_CODE"), "sign-in kept");
});
