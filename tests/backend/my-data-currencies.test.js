// More tab merges (owner's design, 2026-11-03): Exchange rates + Main currency became "Currencies"; Statements, Import data, Tidy my history
// and Export data became one row, "My data" (a small hub), placed in group (2) so the fourth group is gone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "../../docs", f), "utf8");
const html = read("index.html");
const app = read("app.js");
const stmt = read("statements.js");
const strings = read("strings.js");

const group2 = () => {
  const start = html.indexOf('<div class="card more-group more-group-az">');
  const end = html.indexOf('<div class="card more-group">', start);
  return html.slice(start, end);
};

test("group (2) is alphabetical with Currencies and My data, and the old fourth group is gone", () => {
  const ids = [...group2().matchAll(/id="more-([a-z-]+)-btn"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["accounts", "bank-mail", "categories", "exchange-rates", "friends", "my-data", "owner-names"]);
  assert.equal((html.match(/more-group-az/g) || []).length, 1, "only one A-Z group is left");
  ["more-main-currency-btn", "more-export-btn", "more-import-btn", "more-statements-btn", "more-tidy-btn"].forEach((id) => {
    assert.ok(!html.includes('id="' + id + '"'), id + " no longer exists");
  });
});

test("the hub has its four rows in three headed groups, and each opens the screen it used to", () => {
  const hub = html.slice(html.indexOf('id="screen-my-data"'), html.indexOf('id="screen-statements"'));
  ["data-statements-btn", "data-import-btn", "data-tidy-btn", "data-export-btn"].forEach((id) => assert.ok(hub.includes('id="' + id + '"'), id));
  assert.equal((hub.match(/class="md-head"/g) || []).length, 3);
  assert.match(stmt, /\$\("data-statements-btn"\)\.addEventListener\("click", \(\) => showStatementsScreen\("bank"\)\)/);
  assert.match(stmt, /\$\("data-import-btn"\)\.addEventListener\("click", \(\) => showStatementsScreen\("import"\)\)/);
  assert.match(app, /data-tidy-btn"\)\.addEventListener\("click", showTidyScreen\)/);
  assert.match(app, /data-export-btn"\)\.addEventListener\("click", showExportScreen\)/);
});

test("Back from the four screens returns to My data; Back from My data returns to More", () => {
  assert.match(app, /export-back-btn"\)\.addEventListener\("click", showMyDataScreen\)/);
  assert.match(app, /tidy-back-btn"\)\.addEventListener\("click", showMyDataScreen\)/);
  assert.match(stmt, /statements-back-btn"\)\.addEventListener\("click", \(\) => \{ sessionPasswords = \[\]; showMyDataScreen\(\); \}\)/);
  assert.match(app, /my-data-back-btn"\)\.addEventListener\("click", \(\) => showScreen\("more"\)\)/);
});

test("tab memory knows the hub, and Home's first-statement step goes through its row", () => {
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"my-data"'));
  assert.match(app, /getElementById\("data-statements-btn"\)\.click\(\); renderFirstSteps_/);
});

test("Statements has a two-way switch instead of the two text links", () => {
  assert.match(html, /id="stmt-mode-tabs"/);
  assert.ok(!html.includes("statement-to-import-btn") && !html.includes("statement-to-bank-btn"));
  assert.match(stmt, /\$\("stmt-mode-tabs"\)\.addEventListener\("click"/);
  assert.match(stmt, /tab\.setAttribute\("aria-selected"/);
});

test("Currencies: the main currency is the first card above the rates, and Change goes straight to the picker", () => {
  const screen = html.slice(html.indexOf('id="screen-exchange-rates"'), html.indexOf('id="screen-perf"'));
  assert.ok(screen.indexOf('id="currencies-main-code"') < screen.indexOf('id="exchange-rates-list"'));
  assert.match(screen, /data-i18n="cur\.title"/);
  assert.match(app, /currencies-main-change-btn"\)\.addEventListener\("click", \(\) => openCurrencyModal\("main-change"\)\)/);
  const open = app.slice(app.indexOf("function showExchangeRatesScreen()"), app.indexOf("function refreshCurrentPeriodScreen"));
  assert.ok(open.includes("renderCurrenciesMain_();"), "the main currency is filled in each time the screen opens");
});

test("every new text exists in both languages", () => {
  ["more.currencies", "more.myData", "cur.title", "md.title", "md.bringIn", "md.tidyHead", "md.takeOut", "md.bank", "md.import", "md.tidy", "md.export",
    "md.bankSub", "md.importSub", "md.tidySub", "md.exportSub"].forEach((k) => {
    const row = strings.match(new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ en: "([^"]+)", es: "([^"]+)" \\}'));
    assert.ok(row, k + " needs English and Spanish");
  });
});

test("no text sends a person to a row that no longer exists", () => {
  const body = strings.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const gone = ["More → Exchange rates", "More → Main currency", "More → Statements", "More → Import data", "More → Export data", "More → Tidy my history",
    "More › Tidy my history", "More, Statements", "More → Not captured automatically",
    "Más → Tipos de cambio", "Más → Moneda principal", "Más → Estados de cuenta", "Más → Importar datos", "Más → Exportar datos", "Más › Ordenar mi historial",
    "Más, Estados de cuenta", "Más → Lo que no se registra solo"];
  gone.forEach((phrase) => assert.ok(!body.includes(phrase), "still says: " + phrase));
});

test("the old row labels and links are gone from the strings", () => {
  ["more.exchangeRates", "more.mainCurrency", "more.import", "more.export", "more.statements", "more.tidy", "stmt.toImport", "imp.toBank"].forEach((k) => {
    assert.ok(!strings.includes('"' + k + '":'), k);
  });
});
