// Guards the two-language text system (docs/strings.js + docs/i18n.js):
// nothing may exist in only one language, placeholders must match, and the
// code may only ask for texts that exist. See specs/language.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "docs");
const STRINGS = require(path.join(DOCS, "strings.js"));
const I18n = require(path.join(DOCS, "i18n.js"));

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
}
function forms(value) {
  return typeof value === "object" ? { one: value.one, other: value.other } : { text: value };
}

test("every text exists in both languages, filled in, with the same {placeholders}", () => {
  for (const [key, entry] of Object.entries(STRINGS)) {
    assert.ok(entry && entry.en !== undefined && entry.es !== undefined, `${key}: needs both en and es`);
    assert.deepEqual(Object.keys(forms(entry.en)), Object.keys(forms(entry.es)), `${key}: en and es must both be plain text or both have one/other`);
    const en = forms(entry.en), es = forms(entry.es);
    for (const form of Object.keys(en)) {
      assert.ok(String(en[form] || "").trim(), `${key}.${form}: English is empty`);
      assert.ok(String(es[form] || "").trim(), `${key}.${form}: Spanish is empty`);
      assert.equal(placeholders(es[form]), placeholders(en[form]), `${key}.${form}: {placeholders} differ between English and Spanish`);
    }
  }
});

test("no text is defined twice (a duplicate would silently override the first)", () => {
  const src = fs.readFileSync(path.join(DOCS, "strings.js"), "utf8");
  const seen = new Set();
  for (const m of src.matchAll(/^\s*"([\w.\-]+)":\s*\{/gm)) {
    assert.ok(!seen.has(m[1]), `duplicate key ${m[1]}`);
    seen.add(m[1]);
  }
  assert.equal(seen.size, Object.keys(STRINGS).length);
});

test("every text the code or index.html asks for exists", () => {
  const keys = Object.keys(STRINGS);
  const files = fs.readdirSync(DOCS).filter((f) => /\.(js|html)$/.test(f) && f !== "strings.js" && f !== "i18n.js");
  for (const file of files) {
    const src = fs.readFileSync(path.join(DOCS, file), "utf8");
    const used = [
      ...[...src.matchAll(/\btr\(\s*["'`]([\w.\-]+)["'`]/g)].map((m) => m[1]),
      ...[...src.matchAll(/data-i18n(?:-[a-z-]+)?="([\w.\-]+)"/g)].map((m) => m[1])
    ];
    for (const key of used) {
      // tr("area." + name) is checked as a prefix: some text must start with it.
      const ok = key.endsWith(".") ? keys.some((k) => k.startsWith(key)) : keys.includes(key);
      assert.ok(ok, `${file}: asks for a text that doesn't exist: ${key}`);
    }
  }
});

test("lookup, fallback, placeholders and one/other forms", () => {
  STRINGS["test.plain"] = { en: "Hello {name}", es: "Hola {name}" };
  STRINGS["test.count"] = { en: { one: "{n} entry", other: "{n} entries" }, es: { one: "{n} movimiento", other: "{n} movimientos" } };
  STRINGS["test.englishOnly"] = { en: "Only English" };
  const warn = console.warn; console.warn = () => {};
  try {
    I18n.setLang("en");
    assert.equal(I18n.tr("test.plain", { name: "Ana" }), "Hello Ana");
    assert.equal(I18n.tr("test.count", { n: 1 }), "1 entry");
    assert.equal(I18n.tr("test.count", { n: 0 }), "0 entries");
    I18n.setLang("es");
    assert.equal(I18n.tr("test.plain", { name: "Ana" }), "Hola Ana");
    assert.equal(I18n.tr("test.count", { n: 1 }), "1 movimiento");
    assert.equal(I18n.tr("test.count", { n: 2 }), "2 movimientos");
    assert.equal(I18n.tr("test.englishOnly"), "Only English", "falls back to English rather than showing nothing");
    assert.equal(I18n.tr("test.doesNotExist"), "test.doesNotExist", "a missing text shows its key");
    assert.equal(I18n.tr("test.plain"), "Hola {name}", "a missing parameter is left visible");
    assert.equal(I18n.setLang("fr"), I18n.DEFAULT_LANG, "unknown language falls back to the default");
  } finally {
    console.warn = warn;
    delete STRINGS["test.plain"]; delete STRINGS["test.count"]; delete STRINGS["test.englishOnly"];
  }
});

test("dates: English is unchanged, Spanish uses the capitalised month names and 24-hour times", () => {
  const d = new Date(2026, 8, 5, 15, 7);
  const am = new Date(2026, 0, 31, 0, 5);
  I18n.setLang("en");
  assert.equal(I18n.fmtMonthYear(d), "September 2026");
  assert.equal(I18n.fmtDateMedium(d), "Sep 5, 2026");
  assert.equal(I18n.fmtMonthDay(d, false), "Sep 5");
  assert.equal(I18n.fmtMonthDay(d, true), "Sep 5, 2026");
  assert.equal(I18n.fmtDateTime(d), "Sep 5, 2026, 3:07 PM");
  assert.equal(I18n.monthShort(8), "Sep");
  I18n.setLang("es");
  assert.equal(I18n.fmtMonthYear(d), "Septiembre de 2026");
  assert.equal(I18n.fmtDateMedium(d), "5 sep 2026");
  assert.equal(I18n.fmtMonthDay(d, false), "5 sep");
  assert.equal(I18n.fmtMonthDay(d, true), "5 sep 2026");
  assert.equal(I18n.fmtDateTime(d), "5 sep 2026, 15:07");
  assert.equal(I18n.fmtDateTime(am), "31 ene 2026, 00:05");
  assert.equal(I18n.monthShort(0), "ene");
  assert.equal(I18n.monthShort(8, true), "Sep");
  assert.equal(I18n.MONTHS.es.long.length, 12);
  assert.equal(I18n.MONTHS.es.short.length, 12);
  I18n.setLang("en");
});
