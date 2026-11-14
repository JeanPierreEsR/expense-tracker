/**
 * "What fits you?" — the profile answers that decide which categories a person starts with (owner's plan of 2026-10-28,
 * private file "Onboarding and profile - plans 5 7 10 11 together").
 *
 *   - A copy made by the installer starts with the STARTER lists below (8 expense + 5 income categories) instead of the
 *     owner's own long list (EXPENSE_CATEGORIES in Setup.gs, which stays as it is: the owner's copy and every old install are
 *     never changed). The categories the app itself depends on (Other, Bank fees, Refunds, Between Accounts, Contribution,
 *     Withdrawal, Investment returns) are still created the way they always were.
 *   - Each answer ("I have a car", "I study"…) adds ONE extra category. `applyProfile` ADDS it and
 *     remembers the answers in Settings `profile` (comma-separated). It never deletes, renames or hides anything, never adds a
 *     category the copy already has (same name in either language, an equivalent such as "Car" for "Vehicle", or one the
 *     person hid), and can be run again at any time (idempotent): More → Categories → "Add suggested categories" runs it for
 *     people who already use the app.
 *   - Nothing here is sent to the owner.
 *
 * Built-in categories carry a hidden `key` (categoryKeyFromName_) and a Spanish name in CATEGORY_TRANSLATIONS_ (Strings.gs).
 */

var PROFILE_SETTING_ = 'profile';

var STARTER_EXPENSE_CATEGORIES_ = [
  ['Groceries', '🛒'], ['Restaurants', '🍽️'], ['Home', '🏠'], ['Transport', '🚌'],
  ['Travel', '✈️'], ['Sports', '⚽'], ['Bank fees', '🧾'], ['Other', '📦']
];
var STARTER_INCOME_CATEGORIES_ = [
  ['Salary', '💰'], ['Business', '👔'], ['Gifts', '🎁'], ['Refunds', '↩️'], ['Other', '📦']
];

// The two questions, in the order the app shows them ("My responsibilities", "My lifestyle"). Each answer adds EXACTLY ONE category (owner's design
// of 2026-10-29; one exception since 2026-11-14: Trips adds Flights, Lodging and Tours & activities): the picks describe parts of a person's life, never personality traits. Household bills (electricity, water, internet,
// phone) belong in Home; streaming belongs in Subscriptions, games in Hobbies, and Entertainment means live shows and concerts.
var PROFILE_GROUPS_ = {
  life: ['car', 'kids', 'pets', 'study', 'health', 'selfemployed', 'family', 'debt'],
  spheres: ['shopping', 'goingout', 'entertainment', 'personal', 'subscriptions', 'hobbies', 'gifts', 'trips']
};
var PROFILE_PACKS_ = {
  car: { expense: [['Vehicle', '🚗']] },
  kids: { expense: [['Kids', '🧒']] },
  pets: { expense: [['Pets', '🐾']] },
  study: { expense: [['Education', '🎓']] },
  health: { expense: [['Health', '🏥']] },
  selfemployed: { expense: [['Work expenses', '💼']] },
  family: { expense: [['Family support', '👪']] },
  debt: { expense: [['Interest', '💸']] },   // paying the debt itself is not an expense (loans/repayments are not), the interest on it is
  shopping: { expense: [['Shopping', '🛍️']] },
  goingout: { expense: [['Going out', '🍻']] },
  entertainment: { expense: [['Entertainment', '🎭']] },
  personal: { expense: [['Personal care', '💇']] },
  subscriptions: { expense: [['Subscriptions', '🔁']] },
  hobbies: { expense: [['Hobbies', '🎨']] },
  gifts: { expense: [['Gifts & donations', '🎁']] },
  // Trips (owner, 2026-11-14): the one pick that adds three, so a trip's screen splits into the blocks a new trip is planned with
  // (getting there, where you sleep, what you do); food, local transport and shopping stay in their everyday categories, and
  // Travel keeps everything else (visas, travel insurance, SIM cards…).
  trips: { expense: [['Flights', '🛫'], ['Lodging', '🏨'], ['Tours & activities', '🎟️']] }
};
var PROFILE_ORDER_ = PROFILE_GROUPS_.life.concat(PROFILE_GROUPS_.spheres);

// A new category is skipped when an OLDER category already covers it: the keys of the categories that mean the same thing.
var STARTER_COVERED_BY_ = {
  'expense:vehicle': ['car'],
  'expense:health': ['healthcare'],
  'expense:work_expenses': ['work'],
  'expense:family_support': ['family_personal'],
  'expense:going_out': ['party'],
  'expense:personal_care': ['family_personal'],
  'expense:gifts_donations': ['gifts', 'donations']
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

// Is this starter category there AND visible? Same rules as starterCovered_, but a hidden category does not count.
function starterVisible_(cats, type, name) {
  var visible = cats.filter(function (c) { return String(c.hidden || '') !== 'yes'; });
  return starterCovered_(visible, categoryNameIndex_(visible, true), type, name);
}

// The HIDDEN category that stands for this starter one (same name in either language, or an equivalent key), or null.
function starterHiddenRow_(cats, type, name) {
  var hidden = cats.filter(function (c) { return String(c.hidden || '') === 'yes'; });
  var id = categoryNameIndex_(hidden, true)[type + ':' + catNameNorm_(name)];
  if (id !== undefined) return hidden.filter(function (c) { return c.id === id; })[0] || null;
  var covers = STARTER_COVERED_BY_[type + ':' + categoryKeyFromName_(name)] || [];
  return hidden.filter(function (c) { return c.type === type && covers.indexOf(c.key) !== -1; })[0] || null;
}

/**
 * My profile → What fits me: which of the person's saved answers still have their category (a hidden or deleted one does not).
 * Returns { active: [answers] } in the app's order. A pick is active only when EVERY category of its pack is there and visible.
 */
function getProfileState() {
  ensureCategoriesHiddenColumn_();
  var cats = getAllRows('Categories');
  var active = profileAnswers_().filter(function (a) {
    return ['expense', 'income'].every(function (type) {
      return (PROFILE_PACKS_[a][type] || []).every(function (c) { return starterVisible_(cats, type, c[0]); });
    });
  });
  return { active: active };
}

/**
 * payload: { answers: ['car', 'kids', …], basics?: true }.
 * Adds the categories of the chosen packs (and, with `basics`, the starter list's missing ones) and remembers the answers.
 * A chosen pack whose category the person hid is shown again, one they deleted is made again (`restored` lists the first kind).
 * Returns { added: [{ name, type }], restored: [{ name, type }], profile: [answers] } — `name` as shown in the person's language.
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
      (PROFILE_PACKS_[a][type] || []).forEach(function (c) { wanted.push({ name: c[0], icon: c[1], type: type, pick: true }); });
    });
  });

  var headers = ensureCategoriesHiddenColumn_();
  var cats = getAllRows('Categories');
  var index = categoryNameIndex_(cats, true);
  var rows = [], added = [], restored = [], made = {};
  wanted.forEach(function (w) {
    var key = w.type + ':' + catNameNorm_(w.name);
    if (w.pick) {
      // A PICK whose category the person hid or deleted comes back (owner, 2026-11-04): a hidden one is shown again, a deleted one is made
      // again below. (The starter basics keep the old rule: a category the person hid is never re-added.)
      if (made[key] || starterVisible_(cats, w.type, w.name)) return;
      var hiddenRow = starterHiddenRow_(cats, w.type, w.name);
      if (hiddenRow) {
        var sheet = getSheet('Categories');
        setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, hiddenRow.id), 'hidden', '');
        hiddenRow.hidden = '';
        restored.push({ name: categoryLabel_(hiddenRow), type: w.type });
        return;
      }
    } else if (starterCovered_(cats, index, w.type, w.name)) return;
    var n = cats.length + rows.length;
    rows.push({ id: Utilities.getUuid(), name: w.name, type: w.type, icon: w.icon, color: CATEGORY_COLOR_PALETTE[n % CATEGORY_COLOR_PALETTE.length],
      parent_id: '', key: categoryKeyFromName_(w.name), hidden: '' });
    index[key] = rows[rows.length - 1].id;   // two packs asking for the same name add it once
    made[key] = true;
    added.push({ name: categoryLabel_({ key: categoryKeyFromName_(w.name), name: w.name }), type: w.type });
  });
  if (rows.length) appendRowsBulk_('Categories', rows);
  if (rows.length || restored.length) {
    if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
    bumpStructureVersion_();
  }
  setSetting_(PROFILE_SETTING_, answers.join(','));
  // "These days…" (what the person does) is saved in this same call (speed rules: one save, one call).
  var occ = payload.occupation ? applyOccupation_(payload.occupation) : null;
  if (occ) occ.changed.forEach(function (c) { (c.restored ? restored : added).push({ name: c.name, type: 'income' }); });
  return { added: added, restored: restored, profile: answers, occupation: occ ? occ.occupation : undefined, pay: occ ? occ.pay : undefined };
}
