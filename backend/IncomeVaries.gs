/**
 * Income that varies (owner, 2026-11-07; specs/reporting-projections.md § Income that varies).
 *
 *   - Every INCOME category counts as "regular" pay, as income that "varies" (sales, freelance, daily work), or as neither
 *     (gifts, refunds, other: not earnings). The column `income_kind` on Categories holds the person's choice ('regular',
 *     'varies', 'none'); blank = the built-in default by key (Salary regular; Business, Sales, Freelance, Daily work varies).
 *     The column is added the first time a choice is saved, so nothing is needed on older copies.
 *   - The welcome question "How do you get paid?" (and My profile) stores Settings `pay`: 'salary', 'varies:<kind>,<kind>' or 'both:<kind>,<kind>' (2026-11-08), and for
 *     "It varies" adds ONE income category of that kind (Sales, Freelance or Daily work), marked as varying.
 *   - Overview's income figures for varying income (per day, who paid, the 3/6-month average) work for ANYONE with such income,
 *     whatever they answered (incomeVariesSummary_, used by getPeriodSummary).
 */

var PAY_SETTING_ = 'pay';
var INCOME_KIND_BY_KEY_ = { salary: 'regular', business: 'varies', sales: 'varies', freelance: 'varies', daily_work: 'varies' };
var PAY_KIND_PACKS_ = { sales: ['Sales', '🏪'], freelance: ['Freelance', '💻'], daily: ['Daily work', '🛠️'] };

function ensureCategoriesIncomeKindColumn_() {
  var headers = ensureCategoriesHiddenColumn_();
  if (headers.indexOf('income_kind') === -1) {
    var sheet = getSheet('Categories');
    sheet.getRange(1, headers.length + 1).setValue('income_kind');
    headers.push('income_kind');
    if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  }
  return headers;
}

// 'regular', 'varies' or '' (not earnings / not income).
function incomeKindOf_(c) {
  if (!c || c.type !== 'income') return '';
  var v = String(c.income_kind || '');
  if (v === 'regular' || v === 'varies') return v;
  if (v === 'none') return '';
  return INCOME_KIND_BY_KEY_[String(c.key || '')] || '';
}

function setCategoryIncomeKind_(id, kind) {
  if (['regular', 'varies', 'none'].indexOf(kind) === -1) return;
  var headers = ensureCategoriesIncomeKindColumn_();
  var sheet = getSheet('Categories');
  var rowIndex = findRowIndexById(sheet, headers, String(id));
  if (rowIndex !== -1) setCellByRow_(sheet, headers, rowIndex, 'income_kind', kind);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
}

// payload: { pay: 'salary' | 'varies', kind: 'sales' | 'freelance' | 'daily' }. Remembers the answer; "It varies" adds the
// kind's income category (or shows it again when hidden) and marks it as varying. Never deletes anything.
function setPay(payload) {
  payload = payload || {};
  // 'both' (owner, 2026-11-08): a fixed salary AND income that varies. 'none': both un-ticked, the answer is cleared.
  if (payload.pay === 'none') { setSetting_(PAY_SETTING_, ''); return { pay: '', added: null, addedAll: [] }; }
  var pay = payload.pay === 'varies' || payload.pay === 'both' || payload.pay === 'salary' ? payload.pay : '';
  if (!pay) return { pay: getSettingsMap()[PAY_SETTING_] || '', added: null, addedAll: [] };   // nothing recognisable: nothing changes
  // Several kinds since 2026-11-08 (owner): kinds = ['sales', 'daily']; an older phone still sends one `kind`.
  var asked = payload.kinds && payload.kinds.length ? payload.kinds : payload.kind ? [payload.kind] : [];
  var kinds = pay !== 'salary' ? asked.filter(function (k, i) { return PAY_KIND_PACKS_[k] && asked.indexOf(k) === i; }) : [];
  setSetting_(PAY_SETTING_, pay !== 'salary' ? pay + (kinds.length ? ':' + kinds.join(',') : '') : 'salary');
  var addedAll = [];
  if (kinds.length) {
    var headers = ensureCategoriesIncomeKindColumn_();
    kinds.forEach(function (kind) {
      var pack = PAY_KIND_PACKS_[kind];
      var cats = getAllRows('Categories');
      var hidden = starterHiddenRow_(cats, 'income', pack[0]);
      if (hidden) {
        var sheet = getSheet('Categories');
        setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, hidden.id), 'hidden', '');
        setCategoryIncomeKind_(hidden.id, 'varies');
        addedAll.push({ name: categoryLabel_(hidden), restored: true });
      } else if (!incomeCategoryThere_(cats, pack[0])) {
        var row = { id: Utilities.getUuid(), name: pack[0], type: 'income', icon: pack[1],
          color: CATEGORY_COLOR_PALETTE[cats.length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: categoryKeyFromName_(pack[0]), hidden: '', income_kind: 'varies' };
        appendRowObject('Categories', row);
        addedAll.push({ name: categoryLabel_(row) });
      }
      if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
    });
    bumpStructureVersion_();
  }
  return { pay: getSettingsMap()[PAY_SETTING_], added: addedAll[0] || null, addedAll: addedAll };
}

// The same category already there: same built-in key or same name in either language. Not the statement aliases (they read
// "freelance" as Business, and the person asked for Freelance on purpose: owner, 2026-11-07).
function incomeCategoryThere_(cats, name) {
  var key = categoryKeyFromName_(name);
  if (cats.some(function (c) { return c.type === 'income' && c.key === key; })) return true;
  return categoryNameIndex_(cats, true)['income:' + catNameNorm_(name)] !== undefined;
}

// For getPeriodSummary: the period's income split into regular and varying, the varying part per payer and the days it came in,
// and (for a whole month) the varying income of each of the 6 complete months before it.
// entries: the period's confirmed entries (already scoped); allEntries: every confirmed entry in the same scope.
function incomeVariesSummary_(entries, allEntries, categoryById, startDate, endDate) {
  var kindOf = {};
  Object.keys(categoryById).forEach(function (id) { kindOf[id] = incomeKindOf_(categoryById[id]); });
  var regular = 0, varies = 0, days = {}, payers = {};
  entries.forEach(function (e) {
    if (e.type !== 'income') return;
    var k = kindOf[e.category_id] || '';
    if (!k) return;
    var rate = getRateForEntryCurrency_(e.currency, e.date);
    if (rate == null) return;
    var pen = Number(e.amount) * rate;
    if (k === 'regular') { regular += pen; return; }
    varies += pen;
    days[e.date] = true;
    var who = e.paid_by && e.paid_by !== 'me' && e.paid_by !== '__add_payor__' ? String(e.paid_by) : '';
    var p = payers[who] || (payers[who] = { id: who, amount: 0, count: 0 });
    p.amount += pen; p.count++;
  });
  var anyKind = Object.keys(kindOf).some(function (id) { return kindOf[id] === 'varies'; });
  if (!anyKind) return null;
  var payorById = rowsById_(getAllRows('Payors'));
  var byPayer = Object.keys(payers).map(function (k) {
    var p = payers[k];
    return { id: p.id, name: p.id ? ((payorById[p.id] && payorById[p.id].name) || '') : '', amount: p.amount, count: p.count };
  }).sort(function (a, b) { return b.amount - a.amount; });

  // The 6 complete months before a whole-month period (newest first); months before the first entry are left out, a month with
  // no varying income inside that range counts as 0 (it really happened).
  var months = null;
  if (startDate && endDate && /-01$/.test(startDate) && startDate.substring(0, 7) === endDate.substring(0, 7)) {
    var first = allEntries.reduce(function (m, e) { return !m || e.date < m ? e.date : m; }, '');
    var keys = [];
    var y = Number(startDate.substring(0, 4)), mo = Number(startDate.substring(5, 7));
    for (var i = 1; i <= 6; i++) {
      var d = new Date(y, mo - 1 - i, 1);
      var key = d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
      if (!first || key < first.substring(0, 7)) break;
      keys.push(key);
    }
    var sum = {};
    keys.forEach(function (k) { sum[k] = 0; });
    allEntries.forEach(function (e) {
      if (e.type !== 'income' || kindOf[e.category_id] !== 'varies') return;
      var k = String(e.date).substring(0, 7);
      if (sum[k] === undefined) return;
      var rate = getRateForEntryCurrency_(e.currency, e.date);
      if (rate != null) sum[k] += Number(e.amount) * rate;
    });
    months = keys.map(function (k) { return { month: k, amount: sum[k] }; });
  }
  // A week (Monday to Sunday): the 8 complete weeks before it, newest first (owner, 2026-11-08: "a usual week", 4 or 8). A whole
  // year: its complete months (up to last month for the current year), for "a usual month this year". Same rules as the months above.
  var first2 = null;
  var firstDate = function () { if (first2 === null) first2 = allEntries.reduce(function (m, e) { return !m || e.date < m ? e.date : m; }, ''); return first2; };
  var sumVaries = function (buckets, keyOf) {
    allEntries.forEach(function (e) {
      if (e.type !== 'income' || kindOf[e.category_id] !== 'varies') return;
      var k = keyOf(String(e.date).substring(0, 10));
      if (k == null || buckets[k] === undefined) return;
      var rate = getRateForEntryCurrency_(e.currency, e.date);
      if (rate != null) buckets[k] += Number(e.amount) * rate;
    });
  };
  var weeks = null;
  if (startDate && endDate && isoDayCount_(startDate, endDate) === 7 && mondayOf_(startDate) === startDate) {
    var wkeys = [];
    for (var w = 1; w <= 8; w++) {
      var mon = isoAddDays_(startDate, -7 * w);
      if (!firstDate() || isoAddDays_(mon, 6) < firstDate()) break;
      wkeys.push(mon);
    }
    var wsum = {};
    wkeys.forEach(function (k) { wsum[k] = 0; });
    sumVaries(wsum, function (d) { return mondayOf_(d); });
    weeks = wkeys.map(function (k) { return { week: k, amount: wsum[k] }; });
  }
  var yearMonths = null;
  if (startDate && endDate && /-01-01$/.test(startDate) && endDate === startDate.substring(0, 4) + '-12-31') {
    var yr = startDate.substring(0, 4), nowKey = formatCalendarDate_(new Date()).substring(0, 7);
    var ykeys = [];
    for (var m = 1; m <= 12; m++) {
      var yk = yr + '-' + pad2_(m);
      if (yk >= nowKey) break;
      if (firstDate() && yk < firstDate().substring(0, 7)) continue;
      if (firstDate()) ykeys.push(yk);
    }
    var ysum = {};
    ykeys.forEach(function (k) { ysum[k] = 0; });
    sumVaries(ysum, function (d) { return d.substring(0, 7); });
    yearMonths = ykeys.map(function (k) { return { month: k, amount: ysum[k] }; });
  }
  return { regular: regular, varies: varies, daysWithIncome: Object.keys(days).length, byPayer: byPayer, months: months, weeks: weeks, yearMonths: yearMonths };
}
