// The phone's side of "send me an e-mail from your bank" (backend/BankSamples.gs is the receiving side).
//
// A person whose bank the app cannot read yet picks one of its e-mails. BEFORE anything leaves the phone this
// module hides the private details, the person sees exactly the text that would be sent (and can edit it), and
// only then taps Send. What it hides:
//   - every digit (becomes 9, so amounts keep their SHAPE: "S/ 1,234.50" -> "S/ 9,999.99"),
//   - e-mail addresses (except the bank's own sender address, which the person typed),
//   - web links (only the site name stays),
//   - names after a greeting ("Dear Ana", "Estimado Juan Perez") and after labels like "Name:", "Beneficiario:",
//   - any words the person adds (their name as the bank writes it, their street ...), matched without caring about
//     capitals or accents,
//   - long reference codes.
// The point is to keep the e-mail's LAYOUT (which words sit around the amount, the merchant, the card digits) because
// that is what a parsing rule is written from, and to lose the values.
//
//   parseSender(text)            -> "name@bank.com" or "" (accepts `Bank <name@bank.com>` too)
//   redact(text, { sender, hide }) -> the safe text
//   MAX_CHARS                    the most that is ever sent (the backend enforces the same limit)
//
// Used by docs/app.js; also loaded by Node for tests/backend/bank-sample.test.js. Holds no secrets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BankSample = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var MAX_CHARS = 6000;
  var ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  var EMAIL_ANYWHERE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;

  function parseSender(text) {
    var s = String(text || "").trim().toLowerCase();
    var angle = /<([^<>\s]+)>/.exec(s);
    if (angle) s = angle[1];
    return ADDRESS.test(s) ? s : "";
  }

  // "Ana" must also hide "ANA" and "Aná": each plain vowel/n/c matches its accented forms.
  var ACCENTS = { a: "aáàäâãå", e: "eéèëê", i: "iíìïî", o: "oóòöôõ", u: "uúùüû", n: "nñ", c: "cç" };
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"); }
  function wordPattern(word) {
    var plain = word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    var out = "";
    for (var i = 0; i < plain.length; i++) {
      var ch = plain.charAt(i);
      out += ACCENTS[ch] ? "[" + ACCENTS[ch] + "]" : escapeRegex(ch);
    }
    return out;
  }

  // The words to hide: each comma/line-separated entry whole, plus each of its words of 3+ letters on its own
  // (a bank may write "LOPEZ ANA" for "Ana Lopez").
  function hideTerms(hide) {
    var seen = {}, terms = [];
    String(hide || "").split(/[,;\n]+/).forEach(function (entry) {
      var whole = entry.trim().replace(/\s+/g, " ");
      if (whole.length < 2) return;
      [whole].concat(whole.length > 3 ? whole.split(" ").filter(function (w) { return w.length >= 3; }) : []).forEach(function (t) {
        var k = t.toLowerCase();
        if (!seen[k]) { seen[k] = true; terms.push(t); }
      });
    });
    // longest first, so "Ana Lopez" goes before "Ana"
    return terms.sort(function (a, b) { return b.length - a.length; });
  }

  var LABELS = "nombre|name|titular|cliente|customer|destinatario|beneficiario|beneficiary|recipient|remitente|sender|" +
    "enviado a|enviado por|sent to|sent by|from|de|para|to|payee|payer|account holder|cuenta de|ordenante";
  var LABEL_LINE = new RegExp("^([ \\t]*(?:" + LABELS + ")[ \\t]*[:\\-][ \\t]*)(\\S.*)$", "gim");
  var GREETING = /^([ \t]*(?:hola|hello|hi|dear|estimad[oa]s?|querid[oa]s?|sr\.?|sra\.?|se[ñn]or(?:a)?)[ \t]+)([^\n,:;!.]+)/gim;

  function redact(text, opts) {
    opts = opts || {};
    var sender = parseSender(opts.sender);
    var s = String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

    // 1. e-mail addresses (the bank's own sender address stays: it is what the rule is written for)
    s = s.replace(EMAIL_ANYWHERE, function (m) { return m.toLowerCase() === sender ? m : "[email]"; });
    // 2. links: the site name stays, the rest (often a personal tracking code) goes
    s = s.replace(/https?:\/\/([^\s\/<>"')]+)[^\s<>"')]*/gi, "https://$1/[link]");
    // 3. names after labels and greetings
    s = s.replace(LABEL_LINE, "$1[name]").replace(GREETING, "$1[name]");
    // 4. the words the person asked to hide
    hideTerms(opts.hide).forEach(function (t) {
      s = s.replace(new RegExp("(^|[^\\p{L}\\p{N}])" + wordPattern(t) + "(?![\\p{L}\\p{N}])", "giu"), "$1[name]");
    });
    // 5. every digit -> 9
    s = s.replace(/[0-8]/g, "9");
    // 6. long reference codes (after step 5 they hold a 9; plain long words do not)
    s = s.replace(/[A-Za-z0-9_-]{16,}/g, function (m) { return m.indexOf("9") >= 0 ? "[code]" : m; });

    s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    var max = opts.maxChars || MAX_CHARS;   // an e-mail is short; a whole statement (docs/statement-sample.js) asks for more
    return s.length > max ? s.slice(0, max) : s;
  }

  return { parseSender: parseSender, redact: redact, MAX_CHARS: MAX_CHARS };
});
