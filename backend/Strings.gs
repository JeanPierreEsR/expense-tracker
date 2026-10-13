/**
 * Spanish + English for everything the SERVER says to the person (see
 * specs/language.md). Two parts:
 *
 *  1. BACKEND_STRINGS_ — texts for errors, labels and generated descriptions,
 *     one entry per text with both languages side by side, looked up with
 *     tr_('area.name', { param: value }). tests/backend/server-language.test.js
 *     fails the deploy if a text lacks a language or its {placeholders} differ.
 *  2. CATEGORY_TRANSLATIONS_ — Spanish names for the built-in categories. A
 *     built-in category carries a hidden internal `key` (e.g. 'groceries') in
 *     the Categories sheet and keeps its ENGLISH name stored there forever; the
 *     translation is applied only when the name is shown (categoryLabel_).
 *     A category the owner created, or renamed, shows exactly as typed.
 *
 * Which language: the app sends its own on every request (REQUEST_LANG_);
 * work with no request behind it (Telegram, scheduled scans) uses the
 * `language` row of the Settings sheet; otherwise English.
 */

var SUPPORTED_LANGS_ = ['en', 'es'];
var REQUEST_LANG_ = null;   // set by doPost for the duration of one request

var BACKEND_STRINGS_ = {
  // Added area by area (step 5b onwards).
};

// Built-in categories: key -> { en: stored name, es: shown name }. Names that
// are the same in both languages (acronyms, proper names) need no entry.
var CATEGORY_TRANSLATIONS_ = {
  annual_budget: { en: 'Annual budget', es: 'Presupuesto anual' },
  car: { en: 'Car', es: 'Auto' },
  travel: { en: 'Travel', es: 'Viajes' },
  food_drink: { en: 'Food & Drink', es: 'Comida y bebida' },
  family_personal: { en: 'Family & Personal', es: 'Familia y personal' },
  entertainment: { en: 'Entertainment', es: 'Entretenimiento' },
  home: { en: 'Home', es: 'Hogar' },
  shopping: { en: 'Shopping', es: 'Compras' },
  healthcare: { en: 'Healthcare', es: 'Salud' },
  other: { en: 'Other', es: 'Otros' },
  transport: { en: 'Transport', es: 'Transporte' },
  groceries: { en: 'Groceries', es: 'Supermercado' },
  education: { en: 'Education', es: 'Educación' },
  gifts: { en: 'Gifts', es: 'Regalos' },
  work: { en: 'Work', es: 'Trabajo' },
  party: { en: 'Party', es: 'Fiestas' },
  mobile_phone: { en: 'Mobile Phone', es: 'Celular' },
  donations: { en: 'Donations', es: 'Donaciones' },
  credit_card: { en: 'Credit card', es: 'Tarjeta de crédito' },
  gym: { en: 'Gym', es: 'Gimnasio' },
  psychologist: { en: 'Psychologist', es: 'Psicólogo' },
  ai: { en: 'AI', es: 'IA' },
  sports: { en: 'Sports', es: 'Deporte' },
  bank_fees: { en: 'Bank fees', es: 'Comisiones bancarias' },
  business: { en: 'Business', es: 'Negocio' },
  salary: { en: 'Salary', es: 'Sueldo' },
  insurance_payout: { en: 'Insurance Payout', es: 'Pago de seguro' },
  parental_leave: { en: 'Parental Leave', es: 'Licencia parental' },
  extra_income: { en: 'Extra Income', es: 'Ingreso extra' },
  savings_return: { en: 'Savings return', es: 'Retorno de ahorros' },
  sales: { en: 'Sales', es: 'Ventas' },
  refunds: { en: 'Refunds', es: 'Reembolsos' },
  contribution: { en: 'Contribution', es: 'Aporte' },
  withdrawal: { en: 'Withdrawal', es: 'Retiro' },
  between_accounts: { en: 'Between Accounts', es: 'Entre cuentas' },
  investments: { en: 'Investments', es: 'Inversiones' },
  investment_returns: { en: 'Investment returns', es: 'Rendimiento de inversiones' },
  // Kept only so the one-off cleanup can recognise them (they are removed from
  // the starter list and retired from the owner's sheet).
  savings: { en: 'Savings', es: 'Ahorros' },
  loan: { en: 'Loan', es: 'Préstamo' }
};

function normalizeLang_(value) {
  var lang = String(value || '').toLowerCase();
  return SUPPORTED_LANGS_.indexOf(lang) >= 0 ? lang : null;
}

// The language the current work should speak.
function currentLang_() {
  if (REQUEST_LANG_) return REQUEST_LANG_;
  var saved = null;
  try { saved = normalizeLang_(getSettingsMap().language); } catch (err) { /* sheet unreadable: default */ }
  return saved || 'en';
}

// tr_('area.name', { n: 3 }) — a text with { one, other } forms picks "one"
// when params.n is exactly 1. A missing text shows its key (and is logged).
function tr_(key, params, langOverride) {
  var lang = langOverride || currentLang_();
  var entry = BACKEND_STRINGS_[key];
  var value = entry ? (entry[lang] !== undefined ? entry[lang] : entry.en) : undefined;
  if (value === undefined) {
    Logger.log('Missing server text: ' + key);
    return key;
  }
  if (value && typeof value === 'object') {
    value = params && Number(params.n) === 1 ? value.one : value.other;
  }
  if (!params) return value;
  return String(value).replace(/\{(\w+)\}/g, function (whole, name) {
    return params[name] !== undefined ? String(params[name]) : whole;
  });
}

// The internal key a built-in category gets from its English name:
// 'Food & Drink' -> 'food_drink'.
function categoryKeyFromName_(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// What to SHOW for a category row. Only a built-in (it has a key) that still
// carries its original English name is translated; anything else is shown as stored.
function categoryLabel_(cat, langOverride) {
  if (!cat) return '';
  var lang = langOverride || currentLang_();
  var t = cat.key ? CATEGORY_TRANSLATIONS_[cat.key] : null;
  if (t && lang !== 'en' && String(cat.name) === t.en && t[lang]) return t[lang];
  return cat.name;
}

// Both the stored name and its Spanish translation, so the search finds a
// category whichever language the person types (and the phone's saved search
// copy stays valid when the language is switched).
function categorySearchNames_(cat) {
  var t = cat.key ? CATEGORY_TRANSLATIONS_[cat.key] : null;
  if (t && String(cat.name) === t.en && t.es && t.es !== t.en) return cat.name + ' ' + t.es;
  return cat.name;
}

// A copy of the category rows with `name` as it should be shown. Used for what
// the app receives; the stored name never changes and logic keeps using it.
function localizeCategories_(rows, langOverride) {
  return rows.map(function (c) {
    var copy = {};
    Object.keys(c).forEach(function (k) { copy[k] = c[k]; });
    copy.name = categoryLabel_(c, langOverride);
    return copy;
  });
}

// ---- Settings (key/value rows) ----

// Sets (or adds) one Settings row. The Settings table is cached by the
// structure version, so it is bumped to make the change visible at once.
function setSetting_(key, value) {
  var sheet = getSheet('Settings');
  var headers = getHeaders(sheet);
  var keyCol = headers.indexOf('key') + 1;
  var valueCol = headers.indexOf('value') + 1;
  var lastRow = sheet.getLastRow();
  var keys = lastRow >= 2 ? sheet.getRange(2, keyCol, lastRow - 1, 1).getValues() : [];
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) {
      sheet.getRange(i + 2, valueCol).setValue(value);
      if (ROWS_MEMO_) delete ROWS_MEMO_['Settings'];
      bumpStructureVersion_();
      return;
    }
  }
  appendRowObject('Settings', { key: key, value: value });
  bumpStructureVersion_();
}

// The app's language picker: remembered on the phone AND here, so the bot,
// alerts and e-mails (which have no phone) speak the same language.
function setLanguage(payload) {
  var lang = normalizeLang_(payload && payload.lang);
  if (!lang) throw new Error('Unsupported language');
  setSetting_('language', lang);
  return { language: lang };
}
