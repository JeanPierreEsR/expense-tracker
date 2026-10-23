// The phone's side of "send this statement" (backend/StatementSamples.gs is the receiving side).
//
// A person whose bank's STATEMENT the app cannot read yet can send the owner that statement's TEXT so a reader can be written. The PDF is read on
// the phone (docs/statement-parsers.js readPdfRows gives rows of cells with their left edge); this module turns the rows into plain text that keeps the
// statement's LAYOUT (which column each piece of text sits in: A is the leftmost, B the next ...). The ONLY thing hidden is every digit (it becomes 9, so
// card and account numbers, house numbers, amounts and dates keep their SHAPE but not their value). Names, streets, shops, payees and e-mail addresses
// are sent as they are (owner's decision, 2026-10-23); the screen tells the person so, and there is no preview step.
//
//   rowsToText(rows)  -> the text to send (rows as StatementParsers.readPdfRows returns them: { page, cells: [{ x0, str }] })
//   MAX_CHARS         the most that is ever sent (the backend enforces the same limit)
//
// Used by docs/statements.js; also loaded by Node for tests/backend/statement-sample.test.js. Holds no secrets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StatementSample = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var MAX_CHARS = 200000;

  // Left edges that are within a few points of each other are the same column; columns are lettered left to right.
  function columns(rows) {
    var xs = [];
    rows.forEach(function (r) { (r.cells || []).forEach(function (c) { xs.push(c.x0); }); });
    xs.sort(function (a, b) { return a - b; });
    var out = [];
    xs.forEach(function (x) { if (!out.length || x - out[out.length - 1] > 6) out.push(x); });
    return out;
  }
  function letters(i) {
    var s = "";
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  function rowsToText(rows) {
    rows = rows || [];
    var cols = columns(rows);
    function columnOf(x) {
      var best = 0, gap = Infinity;
      cols.forEach(function (c, i) { var g = Math.abs(c - x); if (g < gap) { gap = g; best = i; } });
      return letters(best);
    }
    var lines = ["Columns A, B, C... run from the left edge of the page to the right. Each line is one row of the page."];
    var page = null;
    rows.forEach(function (r) {
      if (page !== null && r.page !== page) lines.push("--- next page ---");
      page = r.page;
      var cells = (r.cells || []).map(function (c) {
        var s = String(c.str === undefined || c.str === null ? "" : c.str).replace(/[0-8]/g, "9");
        return columnOf(c.x0) + ": " + s;
      });
      lines.push(cells.join("  ¦  "));
    });
    var text = lines.join("\n");
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  }

  return { rowsToText: rowsToText, MAX_CHARS: MAX_CHARS };
});
