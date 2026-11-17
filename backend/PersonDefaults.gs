/**
 * Defaults that were the owner's own habits, and what everyone else gets instead (owner, 2026-11-16; private file
 * "Not tailored to me - plan (DRAFT 2026-11-16).md").
 *
 *  - A NEW person's copy (made by the installer from now on) is marked in Settings `new_person_defaults` = `yes` (seedSettings,
 *    Setup.gs). Only such a copy gets the new defaults below; the owner's copy and every copy installed earlier keep how they
 *    worked, so nobody's app changes under them.
 *      - Travel is NOT marked Annual by itself. Making an "Everything marked Annual" budget asks once whether it should be
 *        (Settings `travel_annual`: `yes` / `no`; empty = not asked yet).
 *      - A loan with a friend gets no due date unless one is typed (the owner's copy keeps "a week out").
 *  - Budget alerts, every copy: a budget with no percentages typed alerts at 75% and 100%; the owner's at 75%, 100% and 125%
 *    (his existing budgets are switched by the owner-only heal `owner-budget-alerts-75-100-125`).
 *  - Each person's own time zone: the phone sends the zone it is in, and the Sheet's zone follows it (applyPhoneTimeZone_);
 *    personTz_ (Api.gs) reads it. Travelling moves it too (owner: expenses count in the zone the person is in).
 */

var NEW_PERSON_DEFAULTS_SETTING_ = 'new_person_defaults';
var TRAVEL_ANNUAL_SETTING_ = 'travel_annual';
var OWNER_BUDGET_THRESHOLDS_ = '75,100,125';
var NEW_BUDGET_THRESHOLDS_ = '75,100';
var TZ_FROM_PHONE_PROPERTY_ = 'TZ_FROM_PHONE';
// An IANA zone name as a phone reports it ("America/Lima", "America/Argentina/Buenos_Aires", "Etc/GMT+5") or plain UTC.
var PHONE_TZ_RE_ = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+\-]+){1,2})$/;

function newPersonDefaults_() {
  return String(getSettingsMap()[NEW_PERSON_DEFAULTS_SETTING_] || '') === 'yes';
}

// ---- Budget alerts ----

function budgetDefaultThresholds_() {
  return isFriendCopy_() ? NEW_BUDGET_THRESHOLDS_ : OWNER_BUDGET_THRESHOLDS_;
}

// Every budget's alert percentages become `value`. Alerts already sent stay in the log (no alert is sent twice).
function setAllBudgetThresholds_(value) {
  var sheet = getSheet('Budgets');
  var headers = getHeaders(sheet);
  var col = headers.indexOf('thresholds');
  var last = sheet.getLastRow();
  if (col === -1 || last < 2) return 0;
  var range = sheet.getRange(2, col + 1, last - 1, 1);
  var values = range.getValues();
  var changed = 0;
  values.forEach(function (row) {
    if (String(row[0]) !== value) { row[0] = value; changed++; }
  });
  if (changed) range.setValues(values);
  return changed;
}

// ---- Travel as Annual ----

function travelAnnualOn_() {
  var v = String(getSettingsMap()[TRAVEL_ANNUAL_SETTING_] || '');
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return !newPersonDefaults_();
}

// Asked once, when a new person makes an "Everything marked Annual" budget.
function travelAnnualAskDue_() {
  return newPersonDefaults_() && String(getSettingsMap()[TRAVEL_ANNUAL_SETTING_] || '') === '';
}

// The answer to "Count Travel expenses as annual too?". Yes also marks the Travel expenses already recorded.
function setTravelAnnual(payload) {
  var on = !!(payload && payload.on === true);
  setSetting_(TRAVEL_ANNUAL_SETTING_, on ? 'yes' : 'no');
  var tagged = on ? adminTagTravelAnnual({ dryRun: false }).tagged : 0;
  return { on: on, tagged: tagged };
}

// ---- Loans ----

function loanDueWeekOn_() {
  return !newPersonDefaults_();
}

// ---- What the phone is told (getMeta settings) ----

function addPersonDefaultsToSettings_(map) {
  map.budget_thresholds_default = budgetDefaultThresholds_();
  map.travel_annual_on = travelAnnualOn_() ? 'yes' : 'no';
  map.travel_annual_ask = travelAnnualAskDue_() ? 'yes' : '';
  map.loan_due_week = loanDueWeekOn_() ? 'yes' : 'no';
  return map;
}

// ---- Time zone ----

// The phone's own zone becomes the person's (the Sheet's). Never breaks the request it rides on. True when it changed.
function applyPhoneTimeZone_(tz) {
  tz = String(tz || '').trim();
  if (!PHONE_TZ_RE_.test(tz)) return false;
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(TZ_FROM_PHONE_PROPERTY_) !== 'yes') props.setProperty(TZ_FROM_PHONE_PROPERTY_, 'yes');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss.getSpreadsheetTimeZone() === tz) return false;
    ss.setSpreadsheetTimeZone(tz);   // a date cell holds the day as written, so no recorded date changes
    if (ROWS_MEMO_) delete ROWS_MEMO_['@tz'];
    return true;
  } catch (err) {
    console.error('time zone ' + tz + ': ' + err);
    return false;
  }
}

// The phone noticed it is in another zone (a trip) while the app stayed open.
function setTimeZone(payload) {
  var changed = applyPhoneTimeZone_(payload && payload.tz);
  return { tz: personTz_(), changed: changed };
}
