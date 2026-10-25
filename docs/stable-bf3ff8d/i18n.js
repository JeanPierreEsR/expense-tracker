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
    return setLang(stored);
  }
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
  function fmtDateMedium(d) {
    d = asDate(d);
    if (lang === "es") return `${d.getDate()} ${MONTHS.es.short[d.getMonth()]} ${d.getFullYear()}`;
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }
  // "Sep 5" / "5 sep" — with the year added on request
  function fmtMonthDay(d, withYear) {
    d = asDate(d);
    if (lang === "es") return `${d.getDate()} ${MONTHS.es.short[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;
    return d.toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  }
  // "Sep 5, 2026, 3:07 PM" / "5 sep 2026, 15:07" (Spanish uses 24 hours)
  function fmtDateTime(d) {
    d = asDate(d);
    if (lang === "es") {
      const pad = (n) => String(n).padStart(2, "0");
      return `${fmtDateMedium(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
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
