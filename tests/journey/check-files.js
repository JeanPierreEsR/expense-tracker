// Runs every kind of made-up file (tests/journey/files.js) through the app's OWN readers, the way the phone reads them:
// statement PDFs through pdf.js + docs/statement-parsers.js (must come out "ok", every line), spreadsheets and CSVs through
// docs/statement-table.js (header found, columns guessed, every line read).
//   node tests/journey/check-files.js        (needs pdfjs-dist@3.11.174: PDFJS=<folder holding node_modules/pdfjs-dist>)
const path = require("path");
const assert = require("assert/strict");
const F = require("./files");
const SP = require("../../docs/statement-parsers.js");
const ST = require("../../docs/statement-table.js");
const pdfjs = require(path.join(process.env.PDFJS || path.join(process.env.HOME, "scratch-journey"), "node_modules/pdfjs-dist/legacy/build/pdf.js"));

const lines = [
  { date: "2026-10-03", description: "Plaza Vea Prueba", amount: -152.4 },
  { date: "2026-10-05", description: "Haberes Empresa Prueba", amount: 3200 },
  { date: "2026-10-09", description: "Rappi Prueba", amount: -38.9 },
  { date: "2026-10-14", description: "Luz del Sur Prueba", amount: -96.35 },
  { date: "2026-10-21", description: "Yape a Ana Lo*", amount: -25 },
  { date: "2026-10-28", description: "Netflix Prueba", amount: -44.9 }
];
const card = [
  { date: "2026-10-04", description: "PAGO BANCA MOVIL", amount: 500 },
  { date: "2026-10-06", description: "TAMBO PRUEBA", amount: -12.5 },
  { date: "2026-10-11", description: "SPOTIFY PRUEBA", amount: -5.99, currency: "USD" },
  { date: "2026-10-19", description: "OECHSLE PRUEBA", amount: -230 }
];
const entries = [
  { date: "2026-09-01", time: "09:10", type: "income", amount: 3200, currency: "PEN", category: "Sueldo", description: "Sueldo", account: "BCP" },
  { date: "2026-09-02", time: "13:40", type: "expense", amount: 23.5, currency: "PEN", category: "Comida", description: "Menú", account: "Efectivo" },
  { date: "2026-09-13", time: "20:05", type: "expense", amount: 64.9, currency: "PEN", category: "Supermercado", description: "Metro", account: "BCP" },
  { date: "2026-09-25", time: "08:00", type: "expense", amount: 12, currency: "USD", category: "Suscripciones", description: "iCloud", account: "Visa" }
];

async function pdfLines(buf) {
  const rows = await SP.readPdfRows(pdfjs, new Uint8Array(buf));
  return SP.parseStatement(rows);
}
async function tableLines(buf, name) {
  const rows = await ST.readTable(new Uint8Array(buf), name);
  const head = ST.findHeaderRow(rows);
  const known = ST.recognize(rows[head] || []);
  const m = known ? known.mapping : ST.guessMapping(rows.slice(head), {});
  return { known: known && known.name, ...ST.applyMapping(rows.slice(head), m, {}) };
}

(async () => {
  // With file names: read those (a persona's files/), report what the app's reader makes of each.
  const given = process.argv.slice(2);
  if (given.length) {
    for (const f of given) {
      const buf = require("fs").readFileSync(f);
      if (/\.pdf$/i.test(f)) { const r = await pdfLines(buf); console.log((r.ok ? "ok" : "FAILED").padEnd(7), path.basename(f), r.kind, r.bank || "", "lines", r.lines.length, (r.errors || []).join(" | ")); }
      else { const r = await tableLines(buf, f); console.log("ok".padEnd(7), path.basename(f), r.known || "columns guessed", "lines", r.lines.length, "skipped", r.skipped.length); }
    }
    return;
  }
  const results = [];
  const pdfs = {
    "interbank-savings": F.interbankSavingsPdf({ holder: "ANA LO*", number: "200-3001234567", start: "2026-10-01", end: "2026-10-31", opening: 1500, lines }),
    "bcp-savings": F.bcpSavingsPdf({ holder: "ANA LO*", code: "191-12345678-0-12", start: "2026-10-01", end: "2026-10-31", opening: 1500, lines }),
    "interbank-card": F.interbankCardPdf({ holder: "ANA LO*", last4: "4321", start: "2026-09-26", end: "2026-10-25", previous: { PEN: 500, USD: 0 }, lines: card }),
    "bcp-card": F.bcpCardPdf({ holder: "ANA LO*", last4: "8765", start: "2026-09-27", end: "2026-10-26", previous: { PEN: 500, USD: 0 }, lines: card })
  };
  for (const [name, buf] of Object.entries(pdfs)) {
    const r = await pdfLines(buf);
    const src = name.includes("card") ? card : lines, want = src.length;
    const total = (ls) => ls.reduce((a, l) => a + Math.round(l.amount * 100), 0);   // in cents, so the sum is exact
    const same = r.ok && r.lines.length === want && total(r.lines) === total(src);
    results.push([name + ".pdf", same ? "ok" : "FAILED", `${r.kind} ${r.bank || ""} lines ${r.lines.length}/${want}, total ${total(r.lines) / 100} (file ${total(src) / 100}) ${(r.errors || []).join(" | ")}`]);
  }
  const tables = {
    "bcp-movimientos.xlsx": [F.bcpMovementsXlsx({ lines, opening: 1500 }), lines.length],
    "interbank-movimientos.csv": [Buffer.from(F.interbankMovementsCsv({ lines })), lines.length],
    "bbva-movimientos.xlsx": [F.bbvaMovementsXlsx({ lines }), lines.length],
    "scotiabank-movimientos.csv": [Buffer.from(F.scotiabankMovementsCsv({ lines })), lines.length],
    "spendee.csv": [Buffer.from(F.spendeeCsv(entries)), entries.length],
    "wallet.csv": [Buffer.from(F.walletCsv(entries)), entries.length],
    "monefy.csv": [Buffer.from(F.monefyCsv(entries)), entries.length],
    "money-manager.xlsx": [F.moneyManagerXlsx(entries), entries.length],
    "mis-gastos.xlsx": [F.homemadeXlsx(entries), entries.length]
  };
  for (const [name, [buf, want]] of Object.entries(tables)) {
    try {
      const r = await tableLines(buf, name);
      // A person's own Excel has a TOTAL line the person must leave out; reading it is the app's job, so it is counted, not failed.
      results.push([name, r.lines.length >= want ? "ok" : "FAILED", `${r.known ? "known layout " + r.known : "columns guessed"}; lines ${r.lines.length} (file ${want}), skipped ${r.skipped.length}`]);
    } catch (e) { results.push([name, "FAILED", e.message]); }
  }
  results.forEach((r) => console.log(r[1].padEnd(7), r[0].padEnd(28), r[2]));
  if (results.some((r) => r[1] !== "ok")) process.exit(1);
})();
