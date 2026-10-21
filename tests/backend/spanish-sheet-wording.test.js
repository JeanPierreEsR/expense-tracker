// In Spanish the person's Google file is "un archivo de Google Sheets" everywhere the app and the installer speak of it
// (owner's wording, 2026-10-21) — never "hoja de Google" (and no lone "hoja" for it on the installer page, which would
// read as a second word for the same thing). "Hoja de movimientos (CSV)" and the bill-split sheet are other things and stay.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", ...p), "utf8");
const setup = read("setup/index.html");
const spanish = setup.slice(setup.indexOf("  es: {"), setup.indexOf("}[LANG]"));

test("the Spanish installer never calls the person's file a 'hoja'", () => {
  assert.ok(spanish.length > 3000, "found the Spanish block");
  assert.ok(!/hoja/i.test(spanish), (/.{30}hoja.{30}/i.exec(spanish) || [""])[0]);
});

test("the Spanish installer names it 'archivo de Google Sheets', with the right gender around it", () => {
  assert.match(spanish, /Creamos un <b>archivo de Google Sheets privado<\/b>/);
  assert.match(spanish, /para que pueda usar ese archivo/);
  assert.match(spanish, /cree el archivo de Google Sheets donde se guardan tus gastos/);
  assert.match(spanish, /use <b>solo su propio archivo de Google Sheets<\/b>/);
  assert.match(spanish, /tu archivo de Google Sheets y tus datos se quedan donde están/);
  assert.match(spanish, /Creando tu archivo de Google Sheets…/);
  assert.match(spanish, /Preparando tu archivo: \{n\} de \{total\}…/);
});

test("the English installer is unchanged: it still says Google Sheet", () => {
  const english = setup.slice(setup.indexOf("  en: {"), setup.indexOf("  es: {"));
  assert.match(english, /private Google Sheet/);
});

test("the app's Spanish texts about the person's file never say 'hoja de Google'", () => {
  assert.ok(!/hoja de Google/i.test(read("strings.js")));
});
