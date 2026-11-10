// Fixes from the full testers round on the More tab (2026-11-09).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const app = read("docs", "app.js"), html = read("docs", "index.html"), strings = read("docs", "strings.js");

test("a category's name, icon and color can never run as code on Home", () => {
  assert.match(app, /title: `\$\{marker\}\$\{escapeHtml\(categoryName\(entry\.category_id\)\)\}`/);
  assert.match(app, /background:\$\{safeColor_\(cat\.color\)\}">\$\{escapeHtml\(cat\.icon\)\}/);
});

test("banners stay under every pop-up window", () => {
  assert.match(read("docs", "style.css"), /\.update-banner \{[^}]*z-index: 240;/);
});

test("a lost connection offers Try again instead of losing what was typed; no phone alert in the save path", () => {
  const body = app.slice(app.indexOf("function saveBehindScreen_"), app.indexOf("// What has to refresh behind the sheet"));
  assert.match(body, /err\.code !== "unreachable"/);
  assert.match(body, /common\.tryAgain/);
  assert.ok(!/\balert\(/.test(body));
});

test("the bank e-mail sample is sent without showing the person its text, still cleaned on the phone", () => {
  for (const id of ["bs-preview", "bs-hide", "bs-redo", "bs-subject"]) assert.ok(!html.includes(`id="${id}"`), id);
  assert.match(app, /text: bsCleaned_\(bs_\.raw\)/);
  assert.match(app, /function bsCleaned_\(text\) \{ return BankSample\.redact\(/);
});

test("the privacy card's sample sentence speaks only of digits, and owns up to the full version", () => {
  const send = /"privacy\.send": \{ en: "([^"]*)", es: "([^"]*)"/.exec(strings);
  assert.match(send[1], /every digit turns into a 9/);
  assert.match(send[1], /unless you choose to send the full version/);
  assert.ok(!/exact text|names and email/.test(send[1]));
  assert.match(send[2], /cada dígito se convierte en 9/);
});

test("WhatsApp number: a country list by name sits on the left of the number, Peru first chosen", () => {
  for (const id of ["person-phone", "loan-remind-phone"]) assert.match(html, new RegExp(`<div class="phone-row"><select id="${id}-cc"[^>]*></select><input type="tel" id="${id}"`));
  assert.match(app, /select\.value = region \|\| "PE"/);
  assert.match(app, /Intl\.DisplayNames/);
});

test("a last-4 that the Sheet turned into a number gets its leading zero back; 4 digits stay as they are", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(run(rt, `pmLast4_(123)`), "0123");
  assert.equal(run(rt, `pmLast4_("6622")`), "6622");
  assert.equal(run(rt, `pmLast4_("")`), "");
});

test("the entries file translates type, status and source; a hand-typed value is written as it is", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(run(rt, `tr_('export.v.type.expense', null, 'es')`), "gasto");
  assert.equal(run(rt, `tr_('export.v.status.confirmed', null, 'es')`), "confirmado");
  assert.equal(run(rt, `exportValue_('type', 'weird')`), "weird");
});

test("Import keeps text written with care; ALL CAPS is still tidied", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(run(rt, `stmtCleanDescription_("October pay")`), "October pay");
  assert.equal(run(rt, `stmtCleanDescription_("SUPERMERCADOS WONG")`), "Supermercados Wong");
});

test("Never sent to JP lists only what a sample can never contain", () => {
  const never = /"privacy\.never": \{ en: "([^"]*)"/.exec(strings)[1];
  assert.ok(!/description|names of|emails/i.test(never), never);
});

test("while a new person is getting started no bank alert is drawn, and the reason ends with Getting started or after 21 days", () => {
  const quiet = app.slice(app.indexOf("function bankAlertsQuiet_"), app.indexOf("function renderFirstSteps_"));
  assert.match(quiet, /perfIsOwnerCopy_\(\) \|\| fsFlag_\("etFirstStepsHidden"\) \|\| fsFlag_\("etFirstStepsDone"\)/);
  assert.match(app, /const BANK_QUIET_DAYS_ = 21;/);
  assert.match(app, /const unread = bankAlertsQuiet_\(\) \? \[\] : \(data\.unread \|\| \[\]\);/);
  assert.match(app, /\|\| quiet;/);
  assert.ok(!/⚠/.test(/"be\.unreadLink": [^\n]*/.exec(strings)[0]));
});
