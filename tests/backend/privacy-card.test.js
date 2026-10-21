// More → Privacy (docs/index.html, docs/app.js, docs/strings.js) and the rule for when "Help me improve the app" is shown.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const PerfShare = require("../../docs/perf-share.js");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
const html = read("index.html"), strings = read("strings.js"), app = read("app.js");

test("the 'Help me improve the app' row is shown only to a friend who has not agreed to what is shared today", () => {
  const S = PerfShare.SCOPE;
  assert.equal(PerfShare.showImproveRow({}, false), true, "never asked");
  assert.equal(PerfShare.showImproveRow({ asked: true, on: false, scope: S }, false), true, "said no: can change their mind");
  assert.equal(PerfShare.showImproveRow({ asked: true, on: true, scope: S - 1 }, false), true, "agreed to an older version");
  assert.equal(PerfShare.showImproveRow({ asked: true, on: true }, false), true, "agreed before versions existed");
  assert.equal(PerfShare.showImproveRow({ asked: true, on: true, scope: S }, false), false, "agreed: changes it from Privacy instead");
  assert.equal(PerfShare.showImproveRow({ asked: true, on: true, scope: S }, true), false);
  assert.equal(PerfShare.showImproveRow({}, true), false, "never on the owner's phone");
  assert.equal(PerfShare.showImproveRow(null, false), true);
});

test("the Privacy row and pop-up exist, the row is hidden on the owner's copy, and the row for 'Help me improve' follows the rule", () => {
  for (const id of ["more-privacy-btn", "privacy-modal-backdrop", "privacy-close", "privacy-done-btn", "privacy-change-btn", "privacy-share-status"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(app, /more-perf-share-btn"\)\.hidden = !PerfShare\.showImproveRow\(perfShareState_\(\), owner\)/);
  assert.match(app, /more-privacy-btn"\)\.hidden = owner/);
  // the row is refreshed right after the person saves their choice, so it disappears at once
  assert.match(app, /perf-share-save"\)\.addEventListener\("click"[\s\S]*?refreshPerfShareRow_\(\);/);
});

test("the Privacy row sits before 'Help me improve the app' in More, with the other friends-only rows", () => {
  assert.ok(html.indexOf('id="more-privacy-btn"') < html.indexOf('id="more-perf-share-btn"'));
  assert.ok(html.indexOf('id="more-perf-share-btn"') < html.indexOf('id="more-feedback-btn"'));
});

test("every text of the Privacy pop-up exists in both languages, and the page uses only keys that exist", () => {
  const keys = [...html.slice(html.indexOf('id="privacy-modal-backdrop"'), html.indexOf('id="bank-ready-backdrop"')).matchAll(/data-i18n="(privacy\.[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 18, "the page has all its sections");
  for (const k of [...keys, "more.privacy", "privacy.statusOn", "privacy.statusOff", "privacy.statusOld"]) {
    assert.ok(new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ en: ".+", es: ".+" \\}`).test(strings), k);
  }
});

test("what the card promises is what the app does: it names every kind of count, and says the files stay on the phone", () => {
  const en = /"privacy\.agree": \{ en: "([^"]*)"/.exec(strings)[1];
  for (const part of ["how fast", "failed", "confirmed", "changed or discarded", "screen"]) assert.ok(en.includes(part), part);
  const never = /"privacy\.never": \{ en: "([^"]*)"/.exec(strings)[1];
  for (const part of ["amounts", "emails", "photos", "sign-in"]) assert.ok(never.includes(part), part);
  assert.match(/"privacy\.readsFiles": \{ en: "([^"]*)"/.exec(strings)[1], /not uploaded/);
  // the statement and receipt readers really are on-device (the promise would be false otherwise)
  assert.match(app, /Nothing is uploaded and the photo is not\s+\/\/ kept/);
  assert.match(read("statements.js"), /the file\s+\/\/ never leaves the device/);
});

test("the consent pop-up and the Privacy card describe the same things (the card is not allowed to promise less or more)", () => {
  const body = /"perfShare\.body": \{ en: "([^"]*)"/.exec(strings)[1];
  const agree = /"privacy\.agree": \{ en: "([^"]*)"/.exec(strings)[1];
  for (const part of ["how fast each action ran", "which action failed", "short code", "never what is in it", "how many times you open each screen"]) {
    assert.ok(body.includes(part), "pop-up: " + part);
    assert.ok(agree.includes(part), "card: " + part);
  }
});
