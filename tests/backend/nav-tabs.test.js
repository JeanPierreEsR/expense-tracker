// My tabs (owner, 2026-11-15): the person chooses the tab bar's tabs and their order in More → My profile. Home and More always stay
// (Home can move, More is always last), at most 6 tabs; saved per person in Settings `nav_tabs`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const DOCS = path.join(__dirname, "../../docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const STRINGS = require(path.join(DOCS, "strings.js"));
const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));

test("saveNavTabs keeps a valid bar in Settings and refuses anything else; getMeta hands it back; the capability says so", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(post(rt, "getMeta", {}).data.capabilities.navTabs, true);
  const ok = post(rt, "saveNavTabs", { tabs: ["trips", "entries", "loans", "my-data"] });
  assert.deepEqual(ok.data.tabs, ["trips", "entries", "loans", "my-data"]);
  assert.equal(rt.rows("Settings").find((r) => r.key === "nav_tabs").value, "trips,entries,loans,my-data");
  assert.equal(post(rt, "getMeta", {}).data.settings.nav_tabs, "trips,entries,loans,my-data");
  for (const tabs of [["overview"], ["entries", "more"], ["entries", "entries"], ["entries", "overview", "budgets", "projections", "loans", "trips"], "entries", ["entries", "nope"]]) {
    const bad = post(rt, "saveNavTabs", { tabs });
    assert.equal(bad.ok, false, JSON.stringify(tabs) + " is refused");
  }
  assert.equal(rt.rows("Settings").find((r) => r.key === "nav_tabs").value, "trips,entries,loans,my-data", "a refusal changes nothing");
  const es = post(rt, "saveNavTabs", { tabs: [] }, "es");
  assert.match(es.error, /Inicio/);
});

test("navClean_ always gives Home, known tabs once each, at most 5 before More", () => {
  const code = app.slice(app.indexOf("const NAV_DEFAULT_"), app.indexOf("function navInBar_"));
  const clean = new Function(code + "; return navClean_;")();
  assert.deepEqual(clean(["overview", "loans"]), ["entries", "overview", "loans"]);
  assert.deepEqual(clean(["loans", "entries", "loans", "more", "x"]), ["loans", "entries"]);
  assert.deepEqual(clean(["overview", "budgets", "projections", "loans", "trips", "recurring", "entries"]), ["overview", "budgets", "projections", "loans", "entries"]);
  assert.deepEqual(clean(null), ["entries"]);
});

test("the bar, More and My profile have what the choice needs, in both languages", () => {
  for (const t of ["trips", "recurring", "my-data"]) assert.match(html, new RegExp(`class="nav-btn" data-screen="${t}"[^>]*hidden`), t + " tab, hidden until chosen");
  const nav = html.slice(html.indexOf('id="bottom-nav"'), html.indexOf("</nav>"));
  assert.ok(nav.lastIndexOf('data-screen="more"') > nav.lastIndexOf('data-screen="my-data"'), "More is last");
  for (const t of ["overview", "budgets", "projections", "loans"]) assert.ok(html.includes(`id="more-tab-${t}"`), t + " row in More");
  assert.ok(html.includes('id="my-profile-tabs-card"') && html.includes('id="tabs-list"') && html.includes('id="tabs-reset-btn"'));
  assert.match(app, /my-profile-tabs-card"\)\.hidden = !caps\.navTabs/, "an older backend hides the card");
  for (const k of ["nav.tripsTab", "nav.programmedTab", "prof.tabsHead", "prof.tabsHint", "prof.tabsCount", "prof.tabsFull", "prof.tabsOut", "prof.tabsReset", "prof.tabsDrag", "prof.tabsShow", "tabs.spotHidden", "tabs.spotRow", "spot.d.s8tab"])
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
});

test("tutorials that send the person to a main tab go through More when that tab is out of the bar", () => {
  assert.ok(!/\{ target: '\.nav-btn\[data-screen="(overview|loans|budgets|projections)"\]'/.test(app.replace(/\.\.\.tabSteps_\("\w+", \{ target/g, "")), "every such step is wrapped in tabSteps_");
  assert.match(app, /navInBar_\("my-data"\)\s*\? \{ target: '\.nav-btn\[data-screen="my-data"\]'/);
});

test("My profile opened from the fast-start snapshot (an older backend's capabilities) shows My tabs once the fresh data lands", () => {
  const fn = app.slice(app.indexOf("function syncNavFromMeta_"), app.indexOf('document.getElementById("tabs-toggle").addEventListener'));
  assert.ok(fn.indexOf("meta.fromCache_") < fn.indexOf('my-profile-tabs-card'));
  assert.match(fn, /card\.hidden && meta\.capabilities && meta\.capabilities\.navTabs\) \{ card\.hidden = false; drawTabsCard_\(\); \}/);
});

test("the order is changed by dragging a grip (owner, 2026-11-16), not by arrows; a lift anywhere on the page ends the drag", () => {
  assert.ok(!app.includes("data-tab-move"), "the arrows are gone");
  assert.match(app, /class="tabs-grip" data-tab-grip=/);
  assert.match(app, /window\.addEventListener\("pointerup", drop\)/);
  assert.match(app, /window\.addEventListener\("pointercancel", drop\)/);
  assert.ok(!("prof.tabsUp" in STRINGS) && !("prof.tabsDown" in STRINGS));
});
