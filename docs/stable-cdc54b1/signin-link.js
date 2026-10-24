// The "sign-in" text that carries a new person's app from the setup page to the app on
// their phone. An app added to the iPhone Home Screen has storage of its own that Safari
// (and so the setup page) cannot write to, so the setup page puts this text on the
// clipboard and the app's first screen has a "Paste my sign-in" button that reads it.
//
//   make(url, code)  -> "ETSIGNIN1:<base64url of {u, c}>"
//   parse(text)      -> { url, code } or null   (never throws)
//
// Used by docs/setup-test/index.html (make) and docs/app.js (parse); also loaded by Node
// for tests/backend/signin-link.test.js. Holds no secrets itself.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SigninLink = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var PREFIX = "ETSIGNIN1:";
  // Only a real Apps Script web-app address (or, for tests on the Mac, localhost) is accepted.
  var URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
  var LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[A-Za-z0-9_\/.-]*$/;
  var CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;   // letters, digits, - and _ only

  function enc(text) {
    var b64 = typeof Buffer !== "undefined"
      ? Buffer.from(text, "utf8").toString("base64")
      : btoa(unescape(encodeURIComponent(text)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function dec(token) {
    var b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return typeof Buffer !== "undefined"
      ? Buffer.from(b64, "base64").toString("utf8")
      : decodeURIComponent(escape(atob(b64)));
  }

  function isValidUrl(url, allowLocal) {
    return URL_RE.test(url) || (!!allowLocal && LOCAL_RE.test(url));
  }

  // The person's "Help me improve the app" choice, made on the setup page, travels with the sign-in so the app does not ask the same
  // thing again: { on: boolean, label: first name (≤30 letters/digits/space/- ' .), scope: the consent version the setup page showed }.
  var LABEL_RE = /^[\p{L}\p{N} '._\-]{0,30}$/u;
  function cleanShare(s) {
    if (!s || typeof s !== "object") return null;
    var scope = Number(s.scope);
    if (typeof s.on !== "boolean" || !(scope >= 1 && scope <= 99) || Math.floor(scope) !== scope) return null;
    var label = typeof s.label === "string" ? s.label.trim() : "";
    if (!LABEL_RE.test(label)) label = "";
    return { on: s.on, label: label, scope: scope };
  }

  function make(url, code, share) {
    if (!isValidUrl(url, true) || !CODE_RE.test(String(code))) throw new Error("not a valid sign-in");
    var o = { u: url, c: code };
    var sh = cleanShare(share);
    if (sh) o.s = { o: sh.on ? 1 : 0, l: sh.label, v: sh.scope };
    return PREFIX + enc(JSON.stringify(o));
  }

  function tryParse(text, allowLocal) {
    var m = new RegExp(PREFIX + "([A-Za-z0-9_-]+)").exec(text);
    if (!m) return null;
    try {
      var o = JSON.parse(dec(m[1]));
      if (!o || !isValidUrl(o.u, allowLocal) || !CODE_RE.test(String(o.c))) return null;
      var out = { url: o.u, code: String(o.c) };
      var sh = o.s && cleanShare({ on: o.s.o === 1, label: o.s.l, scope: o.s.v });
      if (sh) out.share = sh;   // absent when the setup page did not carry a choice (older page, owner's tests): the app then asks itself
      return out;
    } catch (e) {
      return null;
    }
  }

  // Tolerates surrounding words and a phone that wrapped the text over several lines.
  function parse(text, opts) {
    var allowLocal = !!(opts && opts.allowLocal);
    var s = String(text || "");
    return tryParse(s, allowLocal) || tryParse(s.replace(/\s+/g, ""), allowLocal);
  }

  return { make: make, parse: parse, isValidUrl: isValidUrl, PREFIX: PREFIX };
});
