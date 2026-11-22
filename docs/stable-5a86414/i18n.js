// Language engine: which language is active, looking up text, and showing
// dates in that language. The texts themselves are in strings.js; the rules
// (vocabulary, tone, formats) are in specs/language.md.
//
// - The phone remembers the choice (localStorage "lang"); the picker is in
//   More. Changing it reloads the app, so every screen is rebuilt in the new
//   language (nothing is left half-translated).
// - Money stays Peruvian in BOTH languages ("S/ 1,234.50"): those call
//   toLocaleString("en-US", ...) directly and do not go through here.
// - English dates are exactly what they were before (the browser's own
//   en-US formatting). Spanish dates use the month tables below rather than
//   the device's built-in ones, so they look the same on every phone.
(function (root) {
  const SUPPORTED = ["es", "en"];
  // Becomes "es" in the last step of the Spanish rollout (CHANGELOG.md).
  const DEFAULT_LANG = "en";
  const STORAGE_KEY = "lang";

  const MONTHS = {
    es: {
      long: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
      short: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
    },
    en: {
      long: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
      short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    }
  };

  let lang = DEFAULT_LANG;
  // The order written dates take: "dmy" | "mdy" | "ymd" (More → My profile → How I type dates). "" = never chosen, so the language decides
  // exactly as it always did (English month first, Spanish day first). Remembered on the phone so the first screen already uses it.
  const DATE_ORDERS = ["dmy", "mdy", "ymd"];
  const ORDER_KEY = "dateOrder";
  let dateOrder = "";

  function strings() {
    if (root.STRINGS) return root.STRINGS;
    return typeof require === "function" ? require("./strings.js") : {};
  }

  function setLang(next) {
    lang = SUPPORTED.indexOf(next) >= 0 ? next : DEFAULT_LANG;
    if (typeof document !== "undefined") document.documentElement.lang = lang;
    return lang;
  }
  function getLang() { return lang; }

  function loadStoredLang() {
    let stored = null;
    try { stored = root.localStorage.getItem(STORAGE_KEY); } catch (err) { /* blocked storage: use the default */ }
    try { setDateOrder(root.localStorage.getItem(ORDER_KEY), true); } catch (err) { /* blocked storage: the language decides */ }
    return setLang(stored);
  }
  // Anything that is not one of the three orders means "not chosen". `skipStore` is for reading what is already stored.
  function setDateOrder(next, skipStore) {
    dateOrder = DATE_ORDERS.indexOf(next) >= 0 ? next : "";
    if (!skipStore) {
      try { if (dateOrder) root.localStorage.setItem(ORDER_KEY, dateOrder); else root.localStorage.removeItem(ORDER_KEY); } catch (err) { /* ignore */ }
    }
    return dateOrder;
  }
  function getDateOrder() { return dateOrder; }
  // The order actually used: the chosen one, otherwise the one that goes with the language.
  function effectiveDateOrder() { return dateOrder || (lang === "es" ? "dmy" : "mdy"); }
  // True once the person has picked a language on this phone (rather than the default).
  function hasChosenLang() {
    try { return !!root.localStorage.getItem(STORAGE_KEY); } catch (err) { return false; }
  }
  // Saves the choice on this phone; the caller reloads the app afterwards.
  function saveLang(next) {
    const chosen = setLang(next);
    try { root.localStorage.setItem(STORAGE_KEY, chosen); } catch (err) { /* ignore */ }
    return chosen;
  }

  // tr("area.name", { n: 3, name: "Ana" }). A text with {one, other} forms
  // picks "one" when params.n is exactly 1. A missing text shows its key
  // (and logs once) rather than a blank, so a gap is visible, never silent.
  function tr(key, params) {
    const entry = strings()[key];
    let value = entry && (entry[lang] !== undefined ? entry[lang] : entry.en);
    if (value === undefined) {
      if (typeof console !== "undefined") console.warn("Missing text:", key);
      return key;
    }
    if (value && typeof value === "object") {
      value = params && Number(params.n) === 1 ? value.one : value.other;
    }
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (whole, name) => (params[name] !== undefined ? String(params[name]) : whole));
  }

  // ---- Dates ----
  function capitalize(w) { return w.charAt(0).toUpperCase() + w.slice(1); }
  function asDate(d) { return d instanceof Date ? d : new Date(d); }

  // "September 2026" / "Septiembre de 2026" (a month that starts a text is
  // capitalised; pass midText = true when it sits inside a sentence)
  function fmtMonthYear(d, midText) {
    d = asDate(d);
    if (lang === "es") return `${midText ? MONTHS.es.long[d.getMonth()] : capitalize(MONTHS.es.long[d.getMonth()])} de ${d.getFullYear()}`;
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  // "Sep 5, 2026" / "5 sep 2026"
  // The day, month and year written in the chosen order, with the month as a word ("5 Sep 2026", "Sep 5, 2026", "2026 Sep 5").
  function joinDate(d, order, withYear) {
    const day = d.getDate(), mon = MONTHS[lang].short[d.getMonth()], year = d.getFullYear();
    if (order === "dmy") return `${day} ${mon}${withYear ? " " + year : ""}`;
    if (order === "ymd") return `${withYear ? year + " " : ""}${mon} ${day}`;
    return `${mon} ${day}${withYear ? ", " + year : ""}`;
  }
  // One date written in a given order (for the examples on the My profile screen).
  function fmtDateAs(d, order) { return joinDate(asDate(d), order, true); }
  function fmtDateMedium(d) {
    d = asDate(d);
    if (lang === "es" && effectiveDateOrder() === "dmy") return `${d.getDate()} ${MONTHS.es.short[d.getMonth()]} ${d.getFullYear()}`;
    if (lang === "en" && effectiveDateOrder() === "mdy") return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    return joinDate(d, effectiveDateOrder(), true);
  }
  // "Sep 5" / "5 sep" — with the year added on request
  function fmtMonthDay(d, withYear) {
    d = asDate(d);
    if (lang === "es" && effectiveDateOrder() === "dmy") return `${d.getDate()} ${MONTHS.es.short[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;
    if (lang === "en" && effectiveDateOrder() === "mdy") return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
    return joinDate(d, effectiveDateOrder(), !!withYear);
  }
  // "Sep 5, 2026, 3:07 PM" / "5 sep 2026, 15:07" (Spanish uses 24 hours)
  function fmtDateTime(d) {
    d = asDate(d);
    if (lang === "es") {
      const pad = (n) => String(n).padStart(2, "0");
      return `${fmtDateMedium(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (effectiveDateOrder() !== "mdy") return `${fmtDateMedium(d)}, ${d.toLocaleTimeString("en-US", { timeStyle: "short" })}`;
    return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }
  // 0 = January. "Sep" in English; Spanish is "sep", or "Sep" when the month
  // starts the text (axis labels, list rows) — pass startOfText = true.
  function monthShort(index, startOfText) {
    const m = MONTHS[lang].short[index];
    return lang === "es" && startOfText ? capitalize(m) : m;
  }

  // Fills in the fixed text in index.html (data-i18n* attributes).
  function applyStatic(scope) {
    if (typeof document === "undefined") return;
    const rootEl = scope || document;
    rootEl.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.getAttribute("data-i18n")); });
    ["placeholder", "title", "aria-label"].forEach((attr) => {
      rootEl.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => { el.setAttribute(attr, tr(el.getAttribute(`data-i18n-${attr}`))); });
    });
  }

  const api = {
    SUPPORTED, DEFAULT_LANG, MONTHS,
    DATE_ORDERS, fmtDateAs, setDateOrder, getDateOrder, effectiveDateOrder,
    tr, setLang, getLang, loadStoredLang, saveLang, hasChosenLang, applyStatic,
    fmtMonthYear, fmtDateMedium, fmtMonthDay, fmtDateTime, monthShort
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.I18n = api;
    root.tr = tr;
    loadStoredLang();
    applyStatic();
  }
})(typeof window !== "undefined" ? window : this);
