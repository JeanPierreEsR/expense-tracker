// The phone's side of "send this statement" (backend/StatementSamples.gs is the receiving side).
//
// A person whose bank's STATEMENT the app cannot read yet can send the owner that statement's TEXT so a reader can be written. The PDF is read on
// the phone (docs/statement-parsers.js readPdfRows gives rows of cells with their left edge); this module turns the rows into plain text that keeps the
// statement's LAYOUT (which column each piece of text sits in: A is the leftmost, B the next ...) and hides the private details BEFORE anything leaves the phone:
//   - every digit (becomes 9, so amounts and dates keep their SHAPE), e-mail addresses, links, names after labels/greetings, long reference codes
//     (all by docs/bank-sample.js, cell by cell),
//   - the cell that follows a label cell such as "Titular" / "Cliente" / "Domicilio" in the same row,
//   - any words the person adds (matched without caring about capitals or accents).
// It cannot find a payee, shop or person's name that has no label around it: that is why the person reads the whole text first.
//
//   rowsToText(rows, { hide })  -> the safe text (rows as StatementParsers.readPdfRows returns them: { page, cells: [{ x0, str }] })
//   MAX_CHARS                   the most that is ever sent (the backend enforces the same limit)
//
// Used by docs/statements.js; also loaded by Node for tests/backend/statement-sample.test.js. Holds no secrets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./bank-sample.js"));
  else root.StatementSample = factory(root.BankSample);
})(typeof self !== "undefined" ? self : this, function (BankSample) {
  var MAX_CHARS = 200000;
  // A cell that is just one of these words (optionally with a colon) is a label: the next cell in its row holds the private value.
  var LABEL_CELL = /^(titular|cliente|nombre|nombres|apellidos|se[\u00f1n]or|se[\u00f1n]ora|se[\u00f1n]ores|domicilio|direcci[o\u00f3]n|address|tel[e\u00e9]fono|phone|correo|e-?mail|email|dni|ruc|documento|beneficiario|ordenante|destinatario|name|customer)$/i;

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

  function rowsToText(rows, opts) {
    opts = opts || {};
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
      var hideNext = false;
      var cells = (r.cells || []).map(function (c) {
        var s = String(c.str === undefined || c.str === null ? "" : c.str);
        if (hideNext) { hideNext = false; s = "[name]"; }
        else {
          if (LABEL_CELL.test(s.replace(/[:\s]+$/, ""))) hideNext = true;
          s = BankSample.redact(s, { hide: opts.hide, maxChars: 5000 });
        }
        return columnOf(c.x0) + ": " + s;
      });
      lines.push(cells.join("  \u00a6  "));
    });
    var text = lines.join("\n");
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  }

  return { rowsToText: rowsToText, MAX_CHARS: MAX_CHARS };
});
