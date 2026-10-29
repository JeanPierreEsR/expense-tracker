/**
 * "What fits you?" — the profile answers that decide which categories a person starts with (owner's plan of 2026-10-28,
 * private file "Onboarding and profile - plans 5 7 10 11 together").
 *
 *   - A copy made by the installer starts with the STARTER lists below (about 16 expense + 5 income categories) instead of the
 *     owner's own long list (EXPENSE_CATEGORIES in Setup.gs, which stays as it is: the owner's copy and every old install are
 *     never changed). The categories the app itself depends on (Other, Bank fees, Refunds, Between Accounts, Contribution,
 *     Withdrawal, Investment returns) are still created the way they always were.
 *   - Each answer ("I have a car", "I study"…) is a small PACK of extra categories. `applyProfile` ADDS the pack's categories and
 *     remembers the answers in Settings `profile` (comma-separated). It never deletes, renames or hides anything, never adds a
 *     category the copy already has (same name in either language, an equivalent such as "Mobile Phone" for "Phone", or one the
 *     person hid), and can be run again at any time (idempotent): More → Categories → "Add suggested categories" runs it for
 *     people who already use the app.
 *   - "invest" and "split" add no categories: the answer only decides which welcome step is shown / is remembered.
 *   - Nothing here is sent to the owner.
 *
 * Built-in categories carry a hidden `key` (categoryKeyFromName_) and a Spanish name in CATEGORY_TRANSLATIONS_ (Strings.gs).
 */

var PROFILE_SETTING_ = 'profile';

var STARTER_EXPENSE_CATEGORIES_ = [
  ['Groceries', '🛒'], ['Restaurants', '🍽️'], ['Transport', '🚌'], ['Home', '🏠'],
  ['Bills & utilities', '💡'], ['Phone', '📱'], ['Healthcare', '🏥'], ['Education', '🎓'],
  ['Shopping', '🛍️'], ['Entertainment', '🎭'], ['Subscriptions', '🔁'], ['Insurance', '🛡️'],
  ['Family & Personal', '👪'], ['Gifts & donations', '🎁'], ['Travel', '✈️'], ['Other', '📦']
];
var STARTER_INCOME_CATEGORIES_ = [
  ['Salary', '💰'], ['Business', '👔'], ['Gifts', '🎁'], ['Refunds', '↩️'], ['Other', '📦']
];

// The answers, in the order the app shows them. Each pack: the categories it adds, by type.
var PROFILE_PACKS_ = {
  car: { expense: [['Car', '🚗'], ['Fuel', '⛽'], ['Parking & tolls', '🅿️']] },
  kids: { expense: [['Kids', '🧒'], ['School', '🎒']] },
  pets: { expense: [['Pets', '🐾']] },
  study: { expense: [['Tuition', '📚']] },
  sports: { expense: [['Gym & sports', '🏋️']] },
  health: { expense: [['Therapy', '🧠']] },
  travel: { expense: [['Travel stays', '🏨']] },
  selfemployed: { expense: [['Software & tools', '💻']], income: [['Sales', '🏷️']] },
  invest: {},
  split: {}
};
var PROFILE_ORDER_ = ['car', 'kids', 'pets', 'study', 'sports', 'health', 'travel', 'selfemployed', 'invest', 'split'];

// A new category is skipped when an OLDER category already covers it: the keys of the categories that mean the same thing.
var STARTER_COVERED_BY_ = {
  'expense:phone': ['mobile_phone'],
  'expense:gifts_donations': ['gifts', 'donations'],
  'expense:gym_sports': ['gym', 'sports'],
  'expense:therapy': ['psychologist'],
  'expense:insurance': []
};

function profileAnswersClean_(answers) {
  var out = [];
  (Array.isArray(answers) ? answers : []).forEach(function (a) {
    a = String(a || '');
    if (PROFILE_PACKS_[a] && out.indexOf(a) === -1) out.push(a);
  });
  return PROFILE_ORDER_.filter(function (a) { return out.indexOf(a) !== -1; });
}

function profileAnswers_() {
  return profileAnswersClean_(String(getSettingsMap()[PROFILE_SETTING_] || '').split(','));
}

// Is this starter category already there, in any form? `index` = categoryNameIndex_(cats, true) (names in both languages, hidden too).
function starterCovered_(cats, index, type, name) {
  var norm = catNameNorm_(name);
  if (index[type + ':' + norm] !== undefined) return true;
  if (categoryIdByAlias_(cats, type, norm)) return true;
  var covers = STARTER_COVERED_BY_[type + ':' + categoryKeyFromName_(name)] || [];
  return cats.some(function (c) { return c.type === type && covers.indexOf(c.key) !== -1; });
}

/**
 * payload: { answers: ['car', 'kids', …], basics?: true }.
 * Adds the categories of the chosen packs (and, with `basics`, the starter list's missing ones) and remembers the answers.
 * Returns { added: [{ name, type }], profile: [answers] } — `name` as shown in the person's language.
 */
function applyProfile(payload) {
  payload = payload || {};
  var answers = profileAnswersClean_(payload.answers);
  var wanted = [];   // { name, icon, type }
  if (payload.basics === true) {
    STARTER_EXPENSE_CATEGORIES_.forEach(function (c) { wanted.push({ name: c[0], icon: c[1], type: 'expense' }); });
    STARTER_INCOME_CATEGORIES_.forEach(function (c) { wanted.push({ name: c[0], icon: c[1], type: 'income' }); });
  }
  answers.forEach(function (a) {
    ['expense', 'income'].forEach(function (type) {
      (PROFILE_PACKS_[a][type] || []).forEach(function (c) { wanted.push({ name: c[0], icon: c[1], type: type }); });
    });
  });

  ensureCategoriesHiddenColumn_();
  var cats = getAllRows('Categories');
  var index = categoryNameIndex_(cats, true);
  var rows = [], added = [];
  wanted.forEach(function (w) {
    if (starterCovered_(cats, index, w.type, w.name)) return;
    var n = cats.length + rows.length;
    rows.push({ id: Utilities.getUuid(), name: w.name, type: w.type, icon: w.icon, color: CATEGORY_COLOR_PALETTE[n % CATEGORY_COLOR_PALETTE.length],
      parent_id: '', key: categoryKeyFromName_(w.name), hidden: '' });
    index[w.type + ':' + catNameNorm_(w.name)] = rows[rows.length - 1].id;   // two packs asking for the same name add it once
    added.push({ name: categoryLabel_({ key: categoryKeyFromName_(w.name), name: w.name }), type: w.type });
  });
  if (rows.length) {
    appendRowsBulk_('Categories', rows);
    if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
    bumpStructureVersion_();
  }
  setSetting_(PROFILE_SETTING_, answers.join(','));
  return { added: added, profile: answers };
}
