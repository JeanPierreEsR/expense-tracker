// Fixes from the 2026-10-21 wording review (two context-less reviewers): accuracy, grammar, consistent spelling and a few clarity
// changes the owner approved. These tests keep them from drifting back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const strings = read("docs", "strings.js"), gs = read("backend", "Strings.gs"), index = read("docs", "index.html"), setup = read("docs", "setup", "index.html"), app = read("docs", "app.js");

// every entry as { key, en, es } (the raw text of each side, one/other forms included)
function entries(src) {
  const out = [];
  for (const line of src.split("\n")) {
    const m = /^\s*"([\w.]+)": \{ en: (.*?), es: (.*?)\s?\},?$/.exec(line);
    if (m) out.push({ key: m[1], en: m[2], es: m[3] });
  }
  return out;
}
const S = entries(strings), G = entries(gs);
const get = (key) => S.find((e) => e.key === key) || G.find((e) => e.key === key);
const setupEn = setup.slice(setup.indexOf("  en: {"), setup.indexOf("  es: {"));

test("the Privacy card's update-check line matches the code (every 5 minutes, not once a day)", () => {
  assert.match(app, /setInterval\(checkForUpdate, 5 \* 60 \* 1000\)/);
  assert.match(get("privacy.updates").en, /Every few minutes/);
  assert.match(get("privacy.updates").es, /Cada pocos minutos/);
  assert.ok(!/Once a day|Una vez al día/.test(get("privacy.updates").en + get("privacy.updates").es));
});

test("counts never produce '1 transferencias' / '1 lines': the labels come before the numbers or the text has one/other forms", () => {
  for (const k of ["stmt.undone", "stmt.batchCounts", "stmt.savedRemembered"]) assert.ok(/\{n\}/.test(get(k).en) && !/\{n\} (entries|lines|movimientos|líneas)/.test(get(k).en + get(k).es), k);
  const created = get("stmt.savedCreated");
  assert.ok(!/\{[tfpir]\} (transfers|fees|purchases|income|reversals|transferencias|comisiones|compras|ingresos|reversiones)/.test(created.en + created.es), "inner counts are 'label: number'");
  for (const k of ["gaps.chipOpen", "gaps.coverageOpen"]) assert.ok(/one:/.test(get(k).es) && /one:/.test(get(k).en), k);
  assert.match(get("gaps.chipOpen").es, /⚠ \{n\} abierta"/);
});

test("English texts use one spelling: email, tap, check/uncheck, US forms", () => {
  const texts = [...S.map((e) => e.en), ...G.map((e) => e.en), setupEn, index.replace(/<script[\s\S]*?<\/script>/g, "")].join("\n");
  assert.ok(!/\b[Ee]-mail/.test(texts), "e-mail");
  assert.ok(!/\b(un)?tick(ed|s)?\b/i.test(texts.replace(/\/\/[^\n]*/g, "")), "tick");
  assert.ok(!/\bpress(ed|ing)?\b(?! and hold)/i.test(S.map((e) => e.en).join("\n")), "press");
  assert.ok(!/recognis|cancelled/i.test(texts), "UK spelling");
});

test("Spanish texts say 'p. ej.', never 'e.g.'", () => {
  for (const e of [...S, ...G]) assert.ok(!/\be\.g\./.test(e.es), e.key);
});

test("grammar and clarity fixes from the review stay fixed", () => {
  assert.match(get("projOverride.hintTotal").en, /already confirmed/);
  assert.match(get("transfer.hintLoanIPaid").en, /owe you this amount/);
  assert.match(get("transfer.hintLoanTheyPaid").en, /owe them this amount/);
  assert.ok(!/this icon|este ícono/.test(get("extras.hint").en + get("extras.hint").es));
  assert.match(get("recModal.variableHintNew").es, /Cada vez que vence/);
  assert.equal(get("stmt.balMatches").es, JSON.stringify("✓ Coincide al céntimo."));
  assert.ok(!/traspaso/.test(get("delete.isLoan").es + get("loan.entryIsMovement").es));
  assert.match(get("convert.undoFailed").es, /y además no se pudo/);
  assert.match(setup, /¿Te atascaste\?/);
  assert.match(get("stmt.readHint").en, /Nothing is saved until you tap Save/);
  assert.ok(!/Nothing is saved from this screen yet|Por ahora no se guarda/.test(get("stmt.readHint").en + get("stmt.readHint").es));
});

test("'my app' means this app everywhere: balance checks speak of the bank or wallet app", () => {
  for (const k of ["balance.check", "balance.checkPlaceholder", "balance.more", "balance.less"]) assert.match(get(k).en, /bank or wallet app/, k);
  assert.match(get("balance.check").es, /app de mi banco o billetera/);
});

test("signing out says the data stays in the Google Sheet, and no text calls the sign-in a 'session key'", () => {
  assert.match(get("signin.confirmSignOut").en, /stays safe in your Google Sheet/);
  assert.match(get("signin.confirmSignOut").es, /siguen seguros en tu archivo de Google Sheets/);
  assert.ok(!/session key|clave de sesión/i.test(get("devices.statusCode").en + get("devices.statusSession").en + get("devices.statusCode").es + get("devices.statusSession").es));
  assert.ok(!/earlier method|método anterior/.test(get("projMethod.ytd.desc").en + get("projMethod.ytd.desc").es));
  for (const k of ["check.failed.review", "check.failed.entries", "check.failed.meta", "check.failed.recurring"]) assert.ok(!/Couldn't confirm|No se pudo confirmar/.test(get(k).en + get(k).es), k);
  assert.match(get("stmt.ignorePeople").en, /statement's currency/);
});

test("'Pro' is now 'Advanced' (it suggested a paid tier)", () => {
  for (const k of ["tourChoice.pro", "tour.proTag", "tour.openPro", "tour.more.body"]) assert.ok(!/\bPro\b/.test(get(k).en + get(k).es), k);
  assert.match(get("tourChoice.pro").en, /Advanced features/);
  assert.match(get("tourChoice.pro").es, /Funciones avanzadas/);
  assert.ok(!/Pro features/.test(index));
});

test("two kinds of 'update' are told apart: the More row is about the person's own app in Google, and says so", () => {
  assert.match(get("more.update").en, /Update my app \(in my Google account\)/);
  assert.match(get("more.update").es, /Actualizar mi app \(en mi cuenta de Google\)/);
});

// update.body used to spell out how this differs from the "tap to reload" banner; the owner traded that
// explanation for a one-line pop-up (2026-10-24) — the More row's own wording above still tells them apart.
test("the 'update your app' pop-up stays to the point", () => {
  assert.match(get("update.body").en, /^"A newer version of the app is ready\."$/);
  assert.match(get("update.body").es, /^"Hay una versión más nueva de la app\."$/);
});

test("programmed items: the app says it does not make the payments, and one word is used for them", () => {
  assert.match(get("recurring.intro").en, /does not make these payments/);
  assert.match(get("recurring.intro").es, /no hace estos pagos/);
  for (const k of ["recurring.empty", "recurring.hidePast", "recurring.showPast", "recurring.noCurrent", "recModal.add", "programmed.hint"]) assert.ok(!/recurring|recurrente/i.test(get(k).en + get(k).es), k);
});

test("JP introduces themself once, in the first help-asking messages, without a new screen; no technical example remains", () => {
  assert.match(get("perfShare.body").en, /^"I'm JP, who made this app\./);
  assert.match(get("perfShare.body").es, /^"Soy JP, quien hizo esta app\./);
  assert.match(setup, /shareBody: 'I’m JP, who made this app\./);
  assert.match(setup, /shareBody: 'Soy JP, quien hizo esta app\./);
  assert.ok(!/listEntries/.test(get("perfShare.body").en + get("perfShare.body").es));
  assert.match(get("bankNote.text").en, /^"Your account at \{banks\} works fully/);
  assert.match(get("bankNote.text").es, /^"Tu cuenta en \{banks\} funciona completa/);
});
