// A guess of the person's country from what the phone already tells every web page: the language REGION of its settings
// ("es-PE") and its time zone ("America/Lima"). No permission prompt, nothing is sent anywhere, no location is read.
// It only PRE-SELECTS the first welcome question (main currency, the usual other currencies, how dates are typed); the
// person always sees it as a visible choice and can change it ("We chose Peruvian sol — change?").
//
//   CountryGuess.guess({ languages: ["es-PE"], timeZone: "America/Lima" })
//     -> { country: "PE", currency: "PEN", others: ["USD", "EUR"], dateOrder: "dmy", by: "region" | "timezone" }
//     -> null when neither signal names a country in the table
//
// Region first (the person's own Region setting is where their money is), time zone second (the fallback when the phone has
// no region, e.g. plain "es"). Used by docs/app.js; also loaded by Node for tests/backend/country-guess.test.js. Holds no secrets.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CountryGuess = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // country -> main currency. `others` (optional) = the usual other currencies there, at most 2; the default is USD and EUR.
  var COUNTRIES = {
    PE: { cur: "PEN" }, US: { cur: "USD", others: ["EUR", "GBP"] }, ES: { cur: "EUR", others: ["USD", "GBP"] },
    MX: { cur: "MXN" }, CO: { cur: "COP" }, CL: { cur: "CLP" }, AR: { cur: "ARS" }, BR: { cur: "BRL" },
    EC: { cur: "USD", others: ["EUR", "PEN"] }, BO: { cur: "BOB" }, UY: { cur: "UYU" }, PY: { cur: "PYG" }, VE: { cur: "VES" },
    PA: { cur: "USD", others: ["EUR", "PEN"] }, CR: { cur: "CRC" }, GT: { cur: "GTQ" }, DO: { cur: "DOP" },
    GB: { cur: "GBP", others: ["EUR", "USD"] }, DE: { cur: "EUR" }, FR: { cur: "EUR" }, IT: { cur: "EUR" }, PT: { cur: "EUR" },
    NL: { cur: "EUR" }, BE: { cur: "EUR" }, IE: { cur: "EUR", others: ["GBP", "USD"] }, AT: { cur: "EUR" }, FI: { cur: "EUR" },
    GR: { cur: "EUR" }, CH: { cur: "CHF" }, SE: { cur: "SEK" }, NO: { cur: "NOK" }, DK: { cur: "DKK" }, PL: { cur: "PLN" },
    TR: { cur: "TRY" }, CA: { cur: "CAD", others: ["USD", "EUR"] }, AU: { cur: "AUD" }, NZ: { cur: "NZD", others: ["AUD", "USD"] },
    JP: { cur: "JPY" }, CN: { cur: "CNY" }, HK: { cur: "HKD" }, SG: { cur: "SGD" }, KR: { cur: "KRW" }, IN: { cur: "INR" },
    ZA: { cur: "ZAR" }, AE: { cur: "AED" }, IL: { cur: "ILS" }, TH: { cur: "THB" }
  };
  // Dates people type: month first in the US, Canada; year first in Japan, China, Korea, Sweden; day first everywhere else.
  var MDY = { US: 1, CA: 1 }, YMD = { JP: 1, CN: 1, KR: 1, SE: 1 };
  var DEFAULT_ENGLISH = { US: 1, GB: 1 };
  // The time zones of the countries above (a zone names a city, so the list is by zone, not by pattern).
  var ZONES = {
    "America/Lima": "PE", "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
    "America/Phoenix": "US", "America/Anchorage": "US", "Pacific/Honolulu": "US", "America/Detroit": "US",
    "Europe/Madrid": "ES", "Atlantic/Canary": "ES", "America/Mexico_City": "MX", "America/Bogota": "CO", "America/Santiago": "CL",
    "America/Argentina/Buenos_Aires": "AR", "America/Buenos_Aires": "AR", "America/Sao_Paulo": "BR", "America/Guayaquil": "EC",
    "America/La_Paz": "BO", "America/Montevideo": "UY", "America/Asuncion": "PY", "America/Caracas": "VE", "America/Panama": "PA",
    "America/Costa_Rica": "CR", "America/Guatemala": "GT", "America/Santo_Domingo": "DO", "Europe/London": "GB", "Europe/Berlin": "DE",
    "Europe/Paris": "FR", "Europe/Rome": "IT", "Europe/Lisbon": "PT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE",
    "Europe/Dublin": "IE", "Europe/Vienna": "AT", "Europe/Helsinki": "FI", "Europe/Athens": "GR", "Europe/Zurich": "CH",
    "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Warsaw": "PL", "Europe/Istanbul": "TR",
    "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Halifax": "CA",
    "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU", "Australia/Perth": "AU",
    "Pacific/Auckland": "NZ", "Asia/Tokyo": "JP", "Asia/Shanghai": "CN", "Asia/Hong_Kong": "HK", "Asia/Singapore": "SG",
    "Asia/Seoul": "KR", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Africa/Johannesburg": "ZA", "Asia/Dubai": "AE",
    "Asia/Jerusalem": "IL", "Asia/Bangkok": "TH"
  };

  function regionOf(tag) {
    var m = /^[a-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})(?:-|$)/.exec(String(tag || ""));
    return m ? m[1].toUpperCase() : "";
  }
  function build(country, by) {
    var c = COUNTRIES[country];
    var others = (c.others || ["USD", "EUR"]).filter(function (x) { return x !== c.cur; }).slice(0, 2);
    return { country: country, currency: c.cur, others: others, dateOrder: MDY[country] ? "mdy" : YMD[country] ? "ymd" : "dmy", by: by };
  }
  function guess(signals) {
    var s = signals || {};
    var langs = Array.isArray(s.languages) ? s.languages : [];
    var z = ZONES[String(s.timeZone || "")];
    for (var i = 0; i < langs.length; i++) {
      var r = regionOf(langs[i]);
      if (!r || !COUNTRIES[r]) continue;
      // "en-US" / "en-GB" are what an English-language phone carries by default, wherever its owner lives: when the time zone
      // names ANOTHER country, the zone is the better evidence. Any other region is the person's own choice and wins.
      if (DEFAULT_ENGLISH[r] && z && z !== r) break;
      return build(r, "region");
    }
    return z ? build(z, "timezone") : null;
  }
  return { guess: guess, COUNTRIES: COUNTRIES, ZONES: ZONES, regionOf: regionOf };
});
