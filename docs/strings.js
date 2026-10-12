// Every piece of user-visible text in the app lives here, ONE ENTRY PER TEXT
// with both languages side by side. To add or change text: edit the entry
// (or add a new one) with BOTH `en` and `es` — tests/backend/i18n.test.js
// fails the deploy if one language is missing, if the {placeholders} differ
// between the two, or if the code asks for a key that doesn't exist.
//
//   "area.name": { en: "Save", es: "Guardar" }
//   "area.count": { en: { one: "{n} entry", other: "{n} entries" },
//                   es: { one: "{n} movimiento", other: "{n} movimientos" } }
//
// Used from code as tr("area.name") / tr("area.count", { n: 3 }), and from
// index.html as data-i18n="area.name" (also data-i18n-placeholder,
// data-i18n-title, data-i18n-aria-label). Texts are plain text, NOT HTML:
// wrap them in escapeHtml() when they go into an innerHTML template.
//
// Vocabulary and style rules: specs/language.md (approved glossary).
(function (root) {
  const STRINGS = {
    // ---- Shell ----
    "banner.update": {
      en: "🔄 New version available — tap to reload",
      es: "🔄 Nueva versión disponible: toca para recargar"
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = STRINGS;
  else root.STRINGS = STRINGS;
})(typeof window !== "undefined" ? window : this);
