// Regression check for the statement readers (docs/statement-parsers.js).
//
//   npm install pdfjs-dist@3.11.174        (once, anywhere on NODE_PATH)
//   node tests/read-statements.js /path/to/folder/with/statement/PDFs
//
// Reads every PDF in the folder exactly as the app does and prints, per file,
// whether the reader's own checks (running balances, subtotals, closing
// totals) passed. Exits non-zero if any statement is not ok. The statements
// themselves are personal — keep them OUT of the repo; only this script lives here.
const fs = require("fs");
const path = require("path");
const SP = require("../docs/statement-parsers.js");

let pdfjs;
try { pdfjs = require("pdfjs-dist/legacy/build/pdf.js"); }
catch (e) { console.error("Install pdfjs-dist@3.11.174 first (see the top of this file)."); process.exit(2); }

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error("Usage: node tests/read-statements.js <folder with statement PDFs>"); process.exit(2); }

(async () => {
  let bad = 0, total = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".pdf")).sort()) {
    total++;
    try {
      const rows = await SP.readPdfRows(pdfjs, new Uint8Array(fs.readFileSync(path.join(dir, f))));
      const r = SP.parseStatement(rows);
      const verdict = !r.kind ? "UNRECOGNISED" : !r.ok ? "FAILED" : r.verified === false ? "read (unverifiable)" : "ok";
      if (verdict === "FAILED" || verdict === "UNRECOGNISED") bad++;
      console.log(`${verdict.padEnd(20)} ${f}  [${r.kind || "?"}, ${(r.lines || []).length} lines]`);
      (r.errors || []).slice(0, 3).forEach((e) => console.log(`    ! ${e}`));
    } catch (err) {
      bad++;
      console.log(`${"ERROR".padEnd(20)} ${f}: ${err.message}`);
    }
  }
  console.log(`\n${total - bad}/${total} statements usable`);
  process.exit(bad ? 1 : 0);
})();
