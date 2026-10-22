// The setup page (docs/setup/index.html) is where a new person makes the "Help me improve the app" choice; it travels with the sign-in
// and the app does not ask again. So what the setup page SAYS must be what the app's own pop-up says: the same list of counts, the same
// checkbox words. If one is edited and the other is not, this fails the deploy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const STRINGS = require("../../docs/strings.js");
const html = fs.readFileSync(path.join(__dirname, "../../docs/setup/index.html"), "utf8");

// The setup page keeps its words in `const TEXT = { en: {...}, es: {...} }`-style objects; read the two languages out of the page itself.
function pageTexts() {
  const out = {};
  for (const lang of ["en", "es"]) {
    const keys = {};
    for (const key of ["shareBody", "optShareLabel", "shareWhat"]) {
      // the FIRST line with this key inside the block of this language (`const T = { en: {…}, es: {…} }`)
      const from = html.indexOf("\n  " + lang + ": {", html.indexOf("const T = {"));
      assert.ok(from > 0, lang + " block found");
      const re = new RegExp("\\n\\s*" + key + ": ('(?:[^'\\\\]|\\\\.)*'),", "g");
      re.lastIndex = from;
      const m = re.exec(html);
      assert.ok(m, lang + " " + key + " found in the setup page");
      keys[key] = vm.runInNewContext(m[1]);
    }
    out[lang] = keys;
  }
  return out;
}

test("the setup page lists the same counts as the app's own consent pop-up, in both languages", () => {
  const page = pageTexts();
  const sentence = {
    en: (s) => s.match(/small counts:[^]*?each screen\./)[0],
    es: (s) => s.match(/conteos pequeños:[^]*?cada pantalla\./)[0]
  };
  for (const lang of ["en", "es"]) {
    const app = STRINGS["perfShare.body"][lang];
    const want = sentence[lang](app);
    assert.ok(page[lang].shareBody.includes(want), lang + ": the setup page's list of counts is the app's: " + want.slice(0, 60) + "…");
  }
});

test("the checkbox on the setup page has the app's own words", () => {
  const page = pageTexts();
  for (const lang of ["en", "es"]) {
    const plain = page[lang].optShareLabel.replace(/<[^>]+>/g, "");
    assert.equal(plain, STRINGS["perfShare.check"][lang], lang);
  }
});

test("the setup page says where the person can change the choice later", () => {
  const page = pageTexts();
  assert.ok(page.en.shareBody.includes(STRINGS["more.privacy"].en.replace(/^\S+\s/, "")), "English names More → Privacy");
  assert.ok(page.es.shareBody.includes(STRINGS["more.privacy"].es.replace(/^\S+\s/, "")), "Spanish names Más → Privacidad");
});
