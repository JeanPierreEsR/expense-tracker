// More → Bank emails tells people how to turn on their bank's e-mail alerts (owner's facts, 2026-10-23). These tests pin the facts
// the texts must keep saying, so a later rewording cannot quietly drop them.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const STRINGS = require(path.join(__dirname, "..", "..", "docs", "strings.js"));
const both = (key) => [STRINGS[key].en, STRINGS[key].es];

test("Yape tip: e-mails only for payments you make, from S/ 10, none for money you receive", () => {
  const [en, es] = both("bankMail.tip.Yape");
  assert.match(en, /S\/ 10/);
  assert.match(es, /S\/ 10/);
  assert.match(en, /payments you make/i);
  assert.match(en, /receive sends no email/i);
  assert.match(es, /los pagos que haces tú/i);
  assert.match(es, /Lo que recibes no envía correo/);
});

test("Interbank tip: every operation has its own minimum, set all to S/ 0", () => {
  const [en, es] = both("bankMail.tip.Interbank");
  assert.match(en, /S\/ 0/);
  assert.match(es, /S\/ 0/);
});

test("the 'teach the app my bank' card is merged into Bank emails: no separate More row, texts exist in both languages", () => {
  assert.equal(STRINGS["more.bankSample"], undefined);
  for (const key of ["bankMail.notReadable", "bankMail.teachBank", "bankMail.teachTitle", "bankMail.teachLead", "bankMail.teachLink"]) {
    const [en, es] = both(key);
    assert.ok(en && es && en !== es, `${key} needs English and Spanish`);
  }
  const fs = require("fs");
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");
  assert.doesNotMatch(html, /more-bank-sample-btn/);
  assert.match(html, /id="bm-teach"/);
});

test("the try-it texts name a payment that really sends an e-mail (a card, or a Yape of S/ 10 or more), never S/ 1", () => {
  for (const key of ["bankMail.try", "firstSteps.firstMailWait"]) {
    for (const text of both(key)) {
      assert.match(text, /S\/ 10 /, `${key} must say S/ 10 or more`);
      assert.doesNotMatch(text, /S\/ 1(?![0-9])/, `${key} must not suggest S/ 1`);
    }
  }
});
