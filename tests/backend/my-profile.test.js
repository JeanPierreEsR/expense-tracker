// More tab merge 3 (owner's design, 2026-11-03): "My names" became "My profile" — one screen with My names, What fits me and How I type dates.
// The written dates in the app follow the chosen order (docs/i18n.js); the same Settings row (`date_format`) is what the Telegram bot reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const DOCS = path.join(__dirname, "../../docs");
const read = (f) => fs.readFileSync(path.join(DOCS, f), "utf8");
const html = read("index.html");
const app = read("app.js");
const strings = read("strings.js");
const STRINGS = require(path.join(DOCS, "strings.js"));
const I18n = require(path.join(DOCS, "i18n.js"));
const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));

test("the More row is My profile, in group (2) after My data, and the two old pop-ups are gone", () => {
  assert.ok(html.includes('id="more-my-profile-btn"') && !html.includes("more-owner-names-btn"));
  assert.ok(html.indexOf('id="more-my-data-btn"') < html.indexOf('id="more-my-profile-btn"'));
  assert.ok(!html.includes('id="owner-names-backdrop"') && !html.includes('id="fits-modal-backdrop"'));
  assert.equal(STRINGS["more.myProfile"].en, "My profile");
  assert.equal(STRINGS["more.myProfile"].es, "Mi perfil");
});

test("the screen has the three cards, opens with Loading… and shows them only when the names have arrived", () => {
  const screen = html.slice(html.indexOf('id="screen-my-profile"'), html.indexOf('id="screen-statements"'));
  ["owner-names-list", "owner-names-add-btn", "fits-chips", "fits-add-btn", "my-profile-dates", "my-profile-dates-example"].forEach((id) => assert.ok(screen.includes('id="' + id + '"'), id));
  ["dmy", "mdy", "ymd"].forEach((o) => assert.ok(screen.includes('data-profile-order="' + o + '"'), o));
  assert.match(screen, /id="my-profile-body" hidden/);
  const fn = app.slice(app.indexOf("async function showMyProfileScreen"), app.indexOf("function drawProfileDates_"));
  assert.ok(fn.indexOf("loadingHtml_()") < fn.indexOf('callApi("getOwnerNames"') && fn.indexOf('callApi("getOwnerNames"') < fn.indexOf("body.hidden = false"));
  assert.match(fn, /catch \(e\)[\s\S]*e\.message/, "a failed load shows its error in the same spot");
  assert.match(fn, /my-profile-fits-card"\)\.hidden = !caps\.profile/);
  assert.match(fn, /my-profile-dates-card"\)\.hidden = !caps\.dateOrder/, "an older backend hides the dates card");
});

test("tab memory and the beta screen list know the screen; Categories keeps a one-line link to it", () => {
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"my-profile"'));
  const beta = fs.readFileSync(path.join(__dirname, "../../backend/BetaEvents.gs"), "utf8");
  assert.match(beta, /my_profile: 1/);
  assert.match(app, /categories-suggest-btn"\)\.addEventListener\("click", showMyProfileScreen\)/);
  assert.equal(STRINGS["categories.suggest"].en, "What fits me ›");
  assert.ok(!("fits.title" in STRINGS), "the old pop-up title is gone");
});

test("no text sends the person to a row that no longer exists", () => {
  assert.ok(!/More → My names|Más → Mis nombres/.test(strings));
  assert.ok(!/Add suggested categories|Agregar categorías sugeridas/.test(strings));
  assert.ok(/More → My profile/.test(STRINGS["wa.nameHint"].en) && /Más → Mi perfil/.test(STRINGS["wa.nameHint"].es));
});

test("saveDateOrder writes the same Settings row the welcome wrote, and refuses anything else; the capability says so", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(post(rt, "getMeta", {}).data.capabilities.dateOrder, true);
  const ok = post(rt, "saveDateOrder", { dateOrder: "YMD" });
  assert.equal(ok.data.dateOrder, "ymd");
  assert.equal(rt.rows("Settings").find((r) => r.key === "date_format").value, "ymd");
  assert.equal(JSON.parse(rt.run("JSON.stringify(userDateOrder_())")), "ymd", "the Telegram bot reads the same choice");
  const bad = post(rt, "saveDateOrder", { dateOrder: "xyz" });
  assert.ok(bad.error && /day-month-year/.test(bad.error));
  assert.equal(rt.rows("Settings").find((r) => r.key === "date_format").value, "ymd", "a refused value changes nothing");
  const es = post(rt, "saveDateOrder", { dateOrder: "" }, "es");
  assert.match(es.error, /día-mes-año/);
});

test("written dates: nothing chosen = exactly what each language showed before; each order writes day, month and year as chosen", () => {
  const d = new Date(2026, 8, 5, 15, 7);
  I18n.setDateOrder("", true);
  I18n.setLang("en");
  assert.equal(I18n.fmtDateMedium(d), "Sep 5, 2026");
  assert.equal(I18n.fmtMonthDay(d), "Sep 5");
  assert.equal(I18n.fmtMonthDay(d, true), "Sep 5, 2026");
  assert.equal(I18n.fmtDateTime(d), "Sep 5, 2026, 3:07 PM");
  I18n.setLang("es");
  assert.equal(I18n.fmtDateMedium(d), "5 sep 2026");
  assert.equal(I18n.fmtMonthDay(d), "5 sep");
  assert.equal(I18n.fmtMonthDay(d, true), "5 sep 2026");
  assert.equal(I18n.fmtDateTime(d), "5 sep 2026, 15:07");

  I18n.setLang("en");
  I18n.setDateOrder("dmy", true);
  assert.equal(I18n.fmtDateMedium(d), "5 Sep 2026");
  assert.equal(I18n.fmtMonthDay(d), "5 Sep");
  assert.equal(I18n.fmtMonthDay(d, true), "5 Sep 2026");
  assert.equal(I18n.fmtDateTime(d), "5 Sep 2026, 3:07 PM");
  I18n.setDateOrder("ymd", true);
  assert.equal(I18n.fmtDateMedium(d), "2026 Sep 5");
  assert.equal(I18n.fmtMonthDay(d), "Sep 5");
  assert.equal(I18n.fmtMonthDay(d, true), "2026 Sep 5");
  I18n.setDateOrder("mdy", true);
  assert.equal(I18n.fmtDateMedium(d), "Sep 5, 2026");

  I18n.setLang("es");
  I18n.setDateOrder("mdy", true);
  assert.equal(I18n.fmtDateMedium(d), "sep 5, 2026");
  I18n.setDateOrder("ymd", true);
  assert.equal(I18n.fmtDateMedium(d), "2026 sep 5");
  assert.equal(I18n.fmtDateTime(d), "2026 sep 5, 15:07");
  I18n.setDateOrder("dmy", true);
  assert.equal(I18n.fmtDateMedium(d), "5 sep 2026");

  assert.equal(I18n.setDateOrder("nonsense", true), "", "anything else means not chosen");
  assert.equal(I18n.fmtMonthYear(d), "Septiembre de 2026", "a month and year has no order to change");
  I18n.setLang("en");
  assert.equal(I18n.fmtDateAs(new Date(2026, 8, 25), "dmy"), "25 Sep 2026");
  assert.equal(I18n.fmtDateAs(new Date(2026, 8, 25), "mdy"), "Sep 25, 2026");
  assert.equal(I18n.fmtDateAs(new Date(2026, 8, 25), "ymd"), "2026 Sep 25");
  I18n.setDateOrder("", true);
});

test("the phone takes the order from the Settings on every open, and a change reloads the app", () => {
  assert.match(app, /if \(meta\.settings\) I18n\.setDateOrder\(String\(meta\.settings\.date_format \|\| ""\)\.toLowerCase\(\)\)/);
  const click = app.slice(app.indexOf("document.querySelectorAll(\"[data-profile-order]\").forEach((b) => b.addEventListener"), app.indexOf("document.querySelectorAll(\"[data-profile-order]\").forEach((b) => b.addEventListener") + 1400);
  assert.ok(click.indexOf('callApi("saveDateOrder"') < click.indexOf("window.location.reload()"));
  assert.match(click, /prof\.datesFailed/, "a refusal is said in the same spot, not silently");
});
