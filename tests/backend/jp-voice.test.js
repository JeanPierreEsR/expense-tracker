// How the app speaks about its maker (owner's rule, 2026-10-21): everything that INFORMS refers to JP in the third person
// ("Send feedback to JP", "What reaches JP…", "JP cannot open it"); only the messages that ASK FOR HELP are in the first person,
// and they say who is speaking by ending with "— JP". Also: the Spanish Privacy card calls the person's file "archivo de Google Sheets".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", ...p), "utf8");
const strings = read("strings.js"), setup = read("setup/index.html");

function text(key) {
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: "((?:[^"\\\\]|\\\\.)*)", es: "((?:[^"\\\\]|\\\\.)*)" \\}`).exec(strings);
  assert.ok(m, key);
  return { en: m[1], es: m[2] };
}
const privacyKeys = [...strings.matchAll(/"(privacy\.[A-Za-z]+)":/g)].map((m) => m[1]);

test("the messages that ask for help speak as JP and say so: they end with '— JP'", () => {
  for (const k of ["perfShare.body", "bankSample.intro", "bankSample.doneBody", "stmtSample.intro", "stmtSample.doneBody", "tour.statements.bankHelp", "feedback.intro", "feedback.thanks"]) {
    const t = text(k);
    assert.ok(t.en.trimEnd().endsWith("— JP"), `${k} (en)`);
    assert.ok(t.es.trimEnd().endsWith("— JP"), `${k} (es)`);
  }
  // the installer's own request, in both languages
  assert.equal((setup.match(/shareBody: '[^']*— JP'/g) || []).length, 2);
});

test("the Privacy card informs: it never speaks as JP, it names JP in the third person", () => {
  assert.ok(privacyKeys.length >= 20);
  for (const k of privacyKeys) {
    if (k === "privacy.change") continue;                         // the person's own button: "Change what I share"
    const { en, es } = text(k);
    const enClean = en.replace(/“(Help me improve the app|Change what I share)”/g, "");   // names of buttons, in the person's own voice
    const esClean = es.replace(/“Ayúdame a mejorar la app”/g, "");
    assert.ok(!/\b(I|me|my)\b/.test(enClean), `${k} (en): ${en}`);
    assert.ok(!/\b(yo|me|mí|mi)\b|llegarme|avisarme|envíame/i.test(esClean), `${k} (es): ${es}`);
  }
  assert.equal(text("privacy.agreeTitle").en, "What can reach JP if you agree");
  assert.equal(text("privacy.sendTitle").en, "What reaches JP only when you send it");
  assert.equal(text("privacy.neverTitle").en, "Never sent to JP");
  assert.equal(text("privacy.agreeTitle").es, "Qué puede llegarle a JP si aceptas");
  assert.equal(text("privacy.sendTitle").es, "Qué le llega a JP solo cuando tú lo envías");
  assert.equal(text("privacy.neverTitle").es, "Nunca se envía a JP");
  assert.match(text("privacy.live").en, /JP cannot open it/);
  assert.match(text("privacy.live").es, /JP no puede abrirlo/);
});

test("rows, buttons and labels that name the recipient say JP", () => {
  assert.deepEqual(text("more.feedback"), { en: "💬 Send feedback to JP", es: "💬 Enviar comentarios a JP" });
  assert.deepEqual(text("feedback.title"), { en: "Send feedback to JP", es: "Enviar comentarios a JP" });
  assert.deepEqual(text("feedback.send"), { en: "Send to JP", es: "Enviar a JP" });
  assert.deepEqual(text("bankSample.send"), { en: "Send to JP", es: "Enviar a JP" });
  for (const k of ["bankSample.previewTitle", "stmtSample.previewTitle", "feedback.previewTitle"]) {
    assert.equal(text(k).en, "This is exactly what JP will receive", k);
    assert.equal(text(k).es, "Esto es exactamente lo que recibirá JP", k);
  }
  for (const k of ["bankSample.nameLabel", "perfShare.nameLabel", "feedback.nameLabel"]) {
    assert.ok(/\bJP\b/.test(text(k).en) && /\bJP\b/.test(text(k).es), k);
    assert.ok(!/\bI\b/.test(text(k).en), k);
  }
});

test("the installer page names JP in the third person outside its signed request, and never guesses a pronoun for JP", () => {
  assert.match(setup, /Tell JP where I got stuck/);
  assert.match(setup, /so JP knows who to help/);
  assert.match(setup, /Please message JP, who will help you/);
  assert.match(setup, /Escríbele a JP, quien te ayudará/);
  assert.ok(!/JP and he\b|JP y él\b/.test(setup));
});

test("the Spanish Privacy card says 'archivo de Google Sheets' where it speaks of the person's file, and never 'hoja de Google'", () => {
  assert.match(text("privacy.live").es, /se guarda en un archivo de Google Sheets que pertenece a tu propia cuenta de Google/);
  assert.match(text("privacy.live").es, /JP no puede abrirlo, ni nadie más, a menos que tú compartas el archivo\./);
  assert.match(text("privacy.remove").es, /Borra el archivo de Google Sheets llamado “Expense Tracker”/);
  for (const k of privacyKeys) assert.ok(!/hoja de Google/i.test(text(k).es), k);
});
