// Exchange rates the way banks and the news quote them: every currency against the US dollar ("1 USD = 3.75 PEN",
// "1 USD = 0.92 EUR"). The app stores and asks for rates as "1 <currency> = r <main currency>" (backend/HomeCurrency.gs);
// this only changes how the Exchange rates list READS them, so nothing stored is touched. Pure; used by docs/app.js and
// loaded by Node for tests/backend/rate-quotes.test.js.
//
//   RateQuotes.usdQuotes(rows, main) -> one entry per row, same order:
//       { target: "EUR", per: 0.9174 }   "1 USD = 0.9174 EUR"
//       null                             no US-dollar rate is on file for that month (or before): show the row the old way
//   rows = [{ currency, month: "2026-10", rate }]   (1 currency = rate main, as listExchangeRates answers)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RateQuotes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function usdQuotes(rows, main) {
    var list = Array.isArray(rows) ? rows : [];
    var usd = list.filter(function (r) { return r && r.currency === "USD" && Number(r.rate) > 0; })
      .sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : 0; });
    // What 1 US dollar is worth in the main currency around `month`: the latest dollar rate on or before it.
    function usdInMain(month) {
      if (main === "USD") return 1;
      var best = null;
      for (var i = 0; i < usd.length; i++) if (usd[i].month <= month) best = usd[i];
      return best ? Number(best.rate) : null;
    }
    return list.map(function (r) {
      var rate = Number(r && r.rate);
      if (!r || !(rate > 0) || !r.currency) return null;
      var u = usdInMain(r.month);
      if (r.currency === "USD") return main === "USD" ? null : { target: main, per: rate };   // 1 USD = rate MAIN
      return u == null ? null : { target: r.currency, per: u / rate };                       // 1 X = rate MAIN, 1 USD = u MAIN
    });
  }
  return { usdQuotes: usdQuotes };
});
