// Everything the app says about its maker is in the FIRST person ("me", "I", signed "— JP"), never "JP" in the third person
// ("send it to JP", "JP knows", "Escríbele a JP"). Owner's rule 2026-10-21: keep the texts personal. Also: the Spanish Privacy card
// calls the person's file "archivo de Google Sheets" (owner's wording), never "hoja de Google".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", ...p), "utf8");
const strings = read("strings.js"), index = read("index.html"), setup = read("setup/index.html");

// The only places the name appears: the sign-off ("— JP") and the one introduction ("what little can reach me, JP, who made this app").
function thirdPersonMentions(text) {
  const out = [];
  for (const m of text.matchAll(/JP(?!Y)/g)) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    const around = text.slice(Math.max(0, m.index - 4), m.index + 22);
    if (/[—–-] $/.test(before)) continue;                       // "— JP"
    if (/\bme, $/.test(before) && /^JP, (who|quien)/.test(text.slice(m.index, m.index + 12))) continue;   // "me, JP, who made this app"
    if (/\bmí, $/.test(before) && /^JP, (who|quien)/.test(text.slice(m.index, m.index + 12))) continue;   // "a mí, JP, quien hizo esta app"
    out.push(around.replace(/\s+/g, " "));
  }
  return out;
}

test("no text of the app speaks about JP in the third person", () => {
  assert.deepEqual(thirdPersonMentions(strings), []);
  assert.deepEqual(thirdPersonMentions(index), []);
});

test("nor does the installer page, in either language", () => {
  assert.deepEqual(thirdPersonMentions(setup), []);
});

test("the headings of the Privacy card are in the first person, with short 'never' wording", () => {
  const get = (k) => /\{ en: "(.*?)", es: "(.*?)" \}/.exec(new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ en: ".*?", es: ".*?" \\}`).exec(strings)[0]).slice(1);
  assert.deepEqual(get("privacy.neverTitle"), ["Never sent", "Nunca se envía"]);
  assert.deepEqual(get("privacy.sendTitle"), ["What reaches me only when you send it", "Qué me llega solo cuando tú lo envías"]);
  assert.deepEqual(get("privacy.agreeTitle"), ["What can reach me if you agree", "Qué me puede llegar si aceptas"]);
  assert.deepEqual(get("more.feedback"), ["💬 Send me feedback", "💬 Envíame comentarios"]);
});

test("the Spanish Privacy card says 'archivo de Google Sheets' where it speaks of the person's file, and never 'hoja de Google'", () => {
  const es = (k) => new RegExp(`"${k.replace(/\./g, "\\.")}": \\{ en: ".*?", es: "(.*?)" \\}`).exec(strings)[1];
  assert.match(es("privacy.live"), /se guarda en un archivo de Google Sheets que pertenece a tu propia cuenta de Google/);
  assert.match(es("privacy.live"), /Yo no puedo abrirlo, ni nadie más, a menos que tú compartas el archivo\./);
  assert.match(es("privacy.remove"), /Borra el archivo de Google Sheets llamado “Expense Tracker”/);
  for (const k of ["privacy.intro", "privacy.live", "privacy.readsMail", "privacy.readsFiles", "privacy.agree", "privacy.send", "privacy.never", "privacy.updates", "privacy.signin", "privacy.remove"]) {
    assert.ok(!/hoja de Google/i.test(es(k)), k);
  }
});
