// The welcome question's guess of the person's country (docs/country-guess.js) and the Exchange rates list read against
// the US dollar (docs/rate-quotes.js). Made-up numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CountryGuess = require("../../docs/country-guess.js");
const RateQuotes = require("../../docs/rate-quotes.js");

const doc = (f) => fs.readFileSync(path.join(__dirname, "../../docs", f), "utf8");

test("the phone's region names the country, and the pick is only a pre-selection of three answers", () => {
  const pe = CountryGuess.guess({ languages: ["es-PE"], timeZone: "America/Lima" });
  assert.deepEqual(pe, { country: "PE", currency: "PEN", others: ["USD", "EUR"], dateOrder: "dmy", by: "region" });
  const es = CountryGuess.guess({ languages: ["es-ES"], timeZone: "Europe/Madrid" });
  assert.equal(es.currency, "EUR");
  assert.ok(!es.others.includes("EUR"), "the main currency is never also listed as an 'other' currency");
  const us = CountryGuess.guess({ languages: ["en-US"], timeZone: "America/New_York" });
  assert.equal(us.currency, "USD");
  assert.equal(us.dateOrder, "mdy");
  assert.equal(CountryGuess.guess({ languages: ["ja-JP"], timeZone: "Asia/Tokyo" }).dateOrder, "ymd");
});

test("no region: the time zone decides; nothing known: no guess at all", () => {
  assert.equal(CountryGuess.guess({ languages: ["es"], timeZone: "America/Lima" }).currency, "PEN");
  assert.equal(CountryGuess.guess({ languages: ["es"], timeZone: "America/Lima" }).by, "timezone");
  assert.equal(CountryGuess.guess({ languages: ["en"], timeZone: "Antarctica/Troll" }), null);
  assert.equal(CountryGuess.guess({}), null);
  assert.equal(CountryGuess.guess(), null);
  assert.equal(CountryGuess.guess({ languages: [null, 5, "zz-ZZ"], timeZone: 7 }), null, "junk never breaks it");
});

test("an English-language phone says US or GB by default: a time zone of another country wins over those two only", () => {
  assert.equal(CountryGuess.guess({ languages: ["en-US"], timeZone: "America/Lima" }).currency, "PEN");
  assert.equal(CountryGuess.guess({ languages: ["en-GB"], timeZone: "America/Bogota" }).currency, "COP");
  assert.equal(CountryGuess.guess({ languages: ["en-US"], timeZone: "America/Chicago" }).currency, "USD", "same country: no conflict");
  assert.equal(CountryGuess.guess({ languages: ["en-US"], timeZone: "Antarctica/Troll" }).currency, "USD", "an unknown zone does not override");
  assert.equal(CountryGuess.guess({ languages: ["es-PE"], timeZone: "Europe/Madrid" }).currency, "PEN", "a chosen region (not US/GB) wins over travel");
});

test("every country in the table points to a currency the app has, and every time zone to a country in the table", () => {
  const codes = [...doc("app.js").matchAll(/\{ code: "([A-Z]{3})", flag:/g)].map((m) => m[1]);
  assert.ok(codes.length > 30);
  const countries = Object.keys(CountryGuess.COUNTRIES);
  assert.ok(countries.length >= 40 && countries.length <= 60, "about 40 countries");
  for (const c of countries) {
    const { cur, others } = CountryGuess.COUNTRIES[c];
    assert.ok(codes.includes(cur), `${c}: ${cur} is not in the app's currency list`);
    (others || []).forEach((o) => assert.ok(codes.includes(o), `${c}: other currency ${o} is not in the app's currency list`));
  }
  for (const [zone, country] of Object.entries(CountryGuess.ZONES)) assert.ok(CountryGuess.COUNTRIES[country], `${zone} -> ${country}`);
  for (const c of countries) assert.equal(CountryGuess.guess({ languages: [`xx-${c}`] }).country, c, `${c} is reachable by its region`);
});

test("regions are read from the usual language tags only", () => {
  assert.equal(CountryGuess.regionOf("es-PE"), "PE");
  assert.equal(CountryGuess.regionOf("zh-Hans-CN"), "CN");
  assert.equal(CountryGuess.regionOf("en"), "");
  assert.equal(CountryGuess.regionOf(""), "");
});

// ---- the rates list, read against the US dollar ----
test("with soles as main: the dollar row is '1 USD = r PEN' and a euro row becomes '1 USD = r EUR'", () => {
  const rows = [
    { currency: "USD", month: "2026-10", rate: 3.75 },
    { currency: "EUR", month: "2026-10", rate: 4.1 }
  ];
  const q = RateQuotes.usdQuotes(rows, "PEN");
  assert.deepEqual(q[0], { target: "PEN", per: 3.75 });
  assert.equal(q[1].target, "EUR");
  assert.ok(Math.abs(q[1].per - 3.75 / 4.1) < 1e-12);
});

test("a currency uses the latest dollar rate on or before ITS month; none on file: the row is read the old way", () => {
  const rows = [
    { currency: "EUR", month: "2026-09", rate: 4 },
    { currency: "EUR", month: "2026-10", rate: 4.2 },
    { currency: "USD", month: "2026-10", rate: 3.8 },
    { currency: "USD", month: "2026-08", rate: 3.6 },
    { currency: "EUR", month: "2026-07", rate: 3.9 }
  ];
  const q = RateQuotes.usdQuotes(rows, "PEN");
  assert.ok(Math.abs(q[0].per - 3.6 / 4) < 1e-12, "September uses the August dollar rate");
  assert.ok(Math.abs(q[1].per - 3.8 / 4.2) < 1e-12, "October uses the October dollar rate");
  assert.equal(q[4], null, "July is before any dollar rate");
  assert.equal(RateQuotes.usdQuotes([{ currency: "EUR", month: "2026-10", rate: 4 }], "PEN")[0], null, "no dollar rate at all");
});

test("with the dollar as main: every row is simply the inverse", () => {
  const q = RateQuotes.usdQuotes([{ currency: "EUR", month: "2026-10", rate: 1.25 }, { currency: "PEN", month: "2026-10", rate: 0.25 }], "USD");
  assert.deepEqual(q, [{ target: "EUR", per: 0.8 }, { target: "PEN", per: 4 }]);
});

test("junk rows never break the list", () => {
  const q = RateQuotes.usdQuotes([null, { currency: "EUR", month: "2026-10", rate: 0 }, { month: "2026-10", rate: 3 }, { currency: "USD", month: "2026-10", rate: "x" }], "PEN");
  assert.deepEqual(q, [null, null, null, null]);
  assert.deepEqual(RateQuotes.usdQuotes(undefined, "PEN"), []);
});

// ---- the screens ----
test("the welcome has an explicit Main currency row, no hidden double-tap, and the list reads against the dollar on friends' copies only", () => {
  const app = doc("app.js");
  const html = doc("index.html");
  assert.match(html, /id="welcome-main-select"/);
  assert.match(html, /country-guess\.js/);
  assert.match(html, /rate-quotes\.js/);
  assert.ok(!/lastTap/.test(app), "the double-tap is gone");
  assert.match(app, /perfIsOwnerCopy_\(\) \? \[\] : RateQuotes\.usdQuotes/);
  const strings = doc("strings.js");
  for (const k of ["welcome.mainTitle", "welcome.mainHint", "welcome.guessNote", "welcome.orderShort.dmy", "welcome.orderShort.mdy", "welcome.orderShort.ymd"]) {
    assert.match(strings, new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ en: .*, es: `), k);
  }
  assert.ok(!/double-tap|dos veces/i.test(strings.slice(strings.indexOf('"welcome.curLabel"'), strings.indexOf('"welcome.curLabel"') + 700)), "no instruction left about double-tapping");
});
