/**
 * Projection methods (2026-10-19) — the owner chooses what predicts his
 * expenses best.
 *
 * "Expected" (Projections.gs) is built from a PREDICTOR. A predictor reads one
 * category's MONTHLY SERIES (its non-recurring spend per calendar month: own
 * share, PEN, entries explained by a programmed item and entries tagged Annual
 * left out) and answers "what will each calendar month of the year cost?"
 * (`monthlyBase[1..12]`). Everything else (Actual, Programmed, the period
 * maths, Budgets) is unchanged. A predictor is a small spec:
 *
 *   mode 'level'      level x the category's time-of-year index
 *     window          how far back the level looks: 3, 6, 12 or 24 complete
 *                     months, or 'ytd' (this year's complete months)
 *     seasonYears     0 = no time-of-year shape; 1-5 = learned from that many
 *                     complete past years (median ratio, pulled toward 1 —
 *                     see seasonIndexFromSeries_)
 *   mode 'last_year'  each month = what the category spent in that month of
 *                     the previous calendar year
 *
 * Six named presets plus "custom:<window>:<years>". The default (Settings key
 * `projection_method`, 'balanced' unless changed) applies to every category
 * that has no choice of its own (Categories column `projection_method`).
 *
 * Because a predictor only needs the monthly series and a cut-off month, it
 * can be replayed in the past: compareProjectionMethods forecasts each of the
 * last 12 months using only what was known BEFORE it and measures the error —
 * "which would have worked best for you". Plain arithmetic, nothing fitted.
 */

var PROJECTION_PRESETS_ = [
  { id: 'balanced',  mode: 'level',     window: 12,    seasonYears: 3 },
  { id: 'steady',    mode: 'level',     window: 12,    seasonYears: 0 },
  { id: 'recent',    mode: 'level',     window: 3,     seasonYears: 0 },
  { id: 'seasonal',  mode: 'level',     window: 12,    seasonYears: 5 },
  { id: 'last_year', mode: 'last_year', window: 12,    seasonYears: 0 },
  { id: 'ytd',       mode: 'level',     window: 'ytd', seasonYears: 0 }
];
var PROJECTION_DEFAULT_METHOD_ = 'balanced';
var PROJECTION_CUSTOM_WINDOWS_ = [3, 6, 12, 24];
var PROJECTION_CUSTOM_YEARS_ = [0, 1, 2, 3, 5];
var BACKTEST_MONTHS_ = 12;        // how many past months are replayed
var BACKTEST_MIN_MONTHS_ = 6;     // fewer comparable months = "not enough history"
var BACKTEST_APPLY_MIN_GAIN_ = 0.05;   // "use the best for each category" only when it cuts the error by 5 points or more

// ---- Choosing and parsing a method ----------------------------------------------------

function isValidProjectionMethod_(text) {
  var t = String(text || '').trim();
  if (PROJECTION_PRESETS_.some(function (p) { return p.id === t; })) return true;
  var m = /^custom:(\d+):(\d+)$/.exec(t);
  return !!m && PROJECTION_CUSTOM_WINDOWS_.indexOf(Number(m[1])) !== -1 && PROJECTION_CUSTOM_YEARS_.indexOf(Number(m[2])) !== -1;
}

// A spec for any method id; anything unrecognised reads as the default preset.
function parseProjectionMethod_(text) {
  var t = String(text || '').trim();
  var found = PROJECTION_PRESETS_.filter(function (p) { return p.id === t; })[0];
  if (found) return { id: found.id, mode: found.mode, window: found.window, seasonYears: found.seasonYears };
  var m = /^custom:(\d+):(\d+)$/.exec(t);
  if (m && isValidProjectionMethod_(t)) return { id: t, mode: 'level', window: Number(m[1]), seasonYears: Number(m[2]) };
  var d = PROJECTION_PRESETS_[0];
  return { id: d.id, mode: d.mode, window: d.window, seasonYears: d.seasonYears };
}

function getProjectionDefaultMethod_() {
  var v = getSettingsMap().projection_method;
  return v && isValidProjectionMethod_(v) ? String(v).trim() : PROJECTION_DEFAULT_METHOD_;
}

// Categories already held real data when this was added: append the column in
// place, once (blank = "use the default"), like period_type.
function ensureCategoryProjectionMethodColumn_() {
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  if (headers.indexOf('projection_method') !== -1) return;
  sheet.getRange(1, headers.length + 1).setValue('projection_method');
}

// The method a category actually uses: its own choice, else the default.
function categoryMethodId_(category, defaultId) {
  var own = category && category.projection_method ? String(category.projection_method).trim() : '';
  return own && isValidProjectionMethod_(own) ? own : defaultId;
}

// ---- The monthly series -----------------------------------------------------------------

function monthKeyAdd_(key, delta) {
  var y = Number(key.substring(0, 4)), m = Number(key.substring(5, 7)) - 1 + delta;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + '-' + pad2_(m + 1);
}

// categoryId -> { firstMonth, totals: {'YYYY-MM': PEN}, annual: {'YYYY-MM': {pen, count}} }
// for every expense/investment category with a confirmed entry (or only the
// ids asked for). `totals` is the NON-recurring spend: own share, PEN at the
// entry's month rate, entries matched to a programmed item left out, entries
// tagged Annual left out of `totals` and counted in `annual` instead (the trace
// reports them). `firstMonth` is the month of the first confirmed entry of any
// type in the category — nothing existed before it, so zero there means nothing.
function buildMonthlySeries_(categoryIds) {
  var wanted = {};
  getAllRows('Categories').forEach(function (c) {
    if (c.type !== 'expense' && c.type !== 'investment') return;
    if (categoryIds && categoryIds.indexOf(c.id) === -1) return;
    wanted[c.id] = c;
  });
  var byCategory = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || !wanted[e.category_id]) return;
    (byCategory[e.category_id] = byCategory[e.category_id] || []).push(e);
  });
  var ids = Object.keys(byCategory);
  var out = {};
  if (!ids.length) return out;

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var recurringByCategory = {};
  getRecurringExpenseRows_().forEach(function (r) {
    if (!wanted[r.category_id]) return;
    // A PAUSED item (Active off) projects nothing, but its past payments are still
    // its own history: they stay out of the averages until the item is DELETED
    // (owner's rule, 2026-10-19). An ended item (end date) already keeps matching
    // up to its end date; this treats a paused one the same way.
    var asHistory = String(r.active) === 'false' ? Object.assign({}, r, { active: 'true' }) : r;
    (recurringByCategory[r.category_id] = recurringByCategory[r.category_id] || []).push(asHistory);
  });
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }
  var annualEntryIds = annualEntryIdSet_();
  var todayStr = formatCalendarDate_(new Date());

  ids.forEach(function (id) {
    var cat = wanted[id];
    var entries = byCategory[id];
    var minDate = '9999-99-99';
    entries.forEach(function (e) { if (String(e.date) < minDate) minDate = String(e.date); });
    var typed = entries.filter(function (e) { return e.type === cat.type; });
    var matched = {};
    (recurringByCategory[id] || []).forEach(function (r) {
      var occ = recurringExpenseOccurrencesInRange_(r, minDate, todayStr);
      if (!occ.length) return;
      typed.forEach(function (e) {
        if (matched[e.id]) return;
        if (entryMatchesRecurringOccurrence_(e, r, occ, splitSumByEntry, recurringSplitSums)) matched[e.id] = true;
      });
    });
    var totals = {}, annual = {};
    typed.forEach(function (e) {
      if (matched[e.id]) return;
      var pen = toPen_(Number(e.amount) - (splitSumByEntry[e.id] || 0), e.currency, e.date);
      if (pen == null) return;
      var key = String(e.date).substring(0, 7);
      if (annualEntryIds[e.id]) {
        var a = annual[key] || (annual[key] = { pen: 0, count: 0 });
        a.pen += pen;
        a.count++;
        return;
      }
      totals[key] = (totals[key] || 0) + pen;
    });
    out[id] = { firstMonth: minDate.substring(0, 7), totals: totals, annual: annual };
  });
  return out;
}

// ---- Predicting ---------------------------------------------------------------------------

function flatIndex_() {
  var index = [];
  for (var i = 0; i < 12; i++) index.push(1);
  return index;
}

function medianOfNumbers_(numbers) {
  var sorted = numbers.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// How much this category usually spends in each calendar month relative to its
// own average month (1.0 = average), learned from the last `maxYears` COMPLETE
// calendar years before asOfYear. Per year, a month's ratio = that month's
// spend / the year's monthly average; across years the MEDIAN ratio (the mean
// of 2; the single value of 1), pulled toward 1 by weight n/(n+1), clamped to
// 0.3-3 and rescaled so the 12 indexes average exactly 1 (the yearly total
// never changes, only its shape). A year counts only if the category already
// had an entry before that January 1st and spent something in it. With
// maxYears 0 or no usable year: flat (all 1).
function seasonIndexFromSeries_(series, asOfYear, maxYears) {
  var flat = { index: flatIndex_(), years: [] };
  if (!series || maxYears <= 0) return flat;
  var firstYear = Number(series.firstMonth.substring(0, 4));
  var ratiosByMonth = [[], [], [], [], [], [], [], [], [], [], [], []];
  var years = [];
  for (var y = asOfYear - 1; y >= asOfYear - maxYears; y--) {
    if (!(firstYear < y)) continue;
    var months = [];
    for (var m = 1; m <= 12; m++) months.push(series.totals[y + '-' + pad2_(m)] || 0);
    var total = months.reduce(function (a, b) { return a + b; }, 0);
    if (!(total > 0)) continue;
    var mean = total / 12;
    years.push(y);
    months.forEach(function (v, i) { ratiosByMonth[i].push(v / mean); });
  }
  if (!years.length) return flat;
  var n = years.length;
  var weight = n / (n + 1);
  var index = ratiosByMonth.map(function (ratios) {
    var typical = n >= 3 ? medianOfNumbers_(ratios) : ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length;
    return Math.min(SEASON_MAX_INDEX, Math.max(SEASON_MIN_INDEX, 1 + weight * (typical - 1)));
  });
  var sum = index.reduce(function (a, b) { return a + b; }, 0);
  return { index: index.map(function (s) { return s * 12 / sum; }), years: years };
}

// What `spec` predicts for each calendar month of the year, knowing only the
// COMPLETE months before asOfKey ('YYYY-MM' of the current month). Returns
//   monthlyBase[0..11]   the prediction for Jan..Dec
//   level, ratePerMonth  the monthly level / the plain average of the window
//   windowMonths         the complete months the level was learned from
//   index, seasonalYears, seasonalYearList   the time-of-year shape used
//   methodUsed           the spec actually applied (differs when it fell back)
//   fallback             '' or 'last_year_history' (no previous year to copy)
//   lastYear             { year, months[12] } for mode last_year, else null
function predictCategoryBase_(series, spec, asOfKey) {
  var empty = {
    monthlyBase: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], level: 0, ratePerMonth: 0, windowMonths: [],
    index: flatIndex_(), seasonalYears: 0, seasonalYearList: [], methodUsed: spec.id, fallback: '', lastYear: null
  };
  if (!series) return empty;
  var asOfYear = Number(asOfKey.substring(0, 4));

  if (spec.mode === 'last_year') {
    var lyYear = asOfYear - 1;
    if (series.firstMonth < lyYear + '-01') {
      var lyMonths = [];
      for (var m = 1; m <= 12; m++) lyMonths.push(series.totals[lyYear + '-' + pad2_(m)] || 0);
      var lyTotal = lyMonths.reduce(function (a, b) { return a + b; }, 0);
      empty.monthlyBase = lyMonths;
      empty.level = lyTotal / 12;
      empty.ratePerMonth = lyTotal / 12;
      empty.windowMonths = lyMonths.map(function (v, i) { return lyYear + '-' + pad2_(i + 1); });
      empty.lastYear = { year: lyYear, months: lyMonths };
      return empty;
    }
    // Nothing to copy from: be the default method, and say so.
    var fb = predictCategoryBase_(series, parseProjectionMethod_(PROJECTION_DEFAULT_METHOD_), asOfKey);
    fb.fallback = 'last_year_history';
    return fb;
  }

  // mode 'level'
  var keys = [];
  var asOfMonth = Number(asOfKey.substring(5, 7));
  if (spec.window === 'ytd') {
    for (var ym = 1; ym < asOfMonth; ym++) keys.push(asOfYear + '-' + pad2_(ym));
    if (!keys.length) {   // January: no month of this year yet — look back 12 months instead
      for (var back = 12; back >= 1; back--) keys.push(monthKeyAdd_(asOfKey, -back));
    }
  } else {
    for (var i = spec.window; i >= 1; i--) keys.push(monthKeyAdd_(asOfKey, -i));
  }
  var windowMonths = keys.filter(function (k) { return k > series.firstMonth; });
  var season = seasonIndexFromSeries_(series, asOfYear, spec.seasonYears);
  var idxSum = 0, total = 0;
  windowMonths.forEach(function (k) {
    idxSum += season.index[Number(k.substring(5, 7)) - 1];
    total += series.totals[k] || 0;
  });
  var level = idxSum > 0 ? total / idxSum : 0;
  empty.level = level;
  empty.ratePerMonth = windowMonths.length > 0 ? total / windowMonths.length : 0;
  empty.windowMonths = windowMonths;
  empty.index = season.index;
  empty.seasonalYears = season.years.length;
  empty.seasonalYearList = season.years;
  empty.monthlyBase = season.index.map(function (s) { return level * s; });
  return empty;
}

// ---- The part of a period still to come, month by month ----------------------------------------

// Each remaining day of [startDate, endDate] counts 1 / (the days of ITS month),
// so a whole month is always exactly 1 (28-day February = 31-day July). Returns
// [{ month: 1..12, key: 'YYYY-MM', share }] for the months touched. A period
// that hasn't started counts whole; one that has ended has nothing left.
function remainingMonthShares_(startDate, endDate) {
  var todayStr = formatCalendarDate_(new Date());
  var shares = [];
  if (todayStr > endDate) return shares;
  var from;
  if (todayStr < startDate) {
    from = startDate;
  } else {
    var t = new Date(todayStr + 'T00:00:00');
    from = formatCalendarDate_(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1));
  }
  if (from > endDate) return shares;
  var y = Number(from.substring(0, 4)), m = Number(from.substring(5, 7));
  for (var guard = 0; guard < 600; guard++) {
    var monthStart = y + '-' + pad2_(m) + '-01';
    var lastDay = new Date(y, m, 0).getDate();
    var monthEnd = y + '-' + pad2_(m) + '-' + pad2_(lastDay);
    if (monthStart > endDate) break;
    var lo = from > monthStart ? from : monthStart;
    var hi = endDate < monthEnd ? endDate : monthEnd;
    var count = daysBetweenDates_(hi, lo) + 1;
    if (count > 0) shares.push({ month: m, key: y + '-' + pad2_(m), share: count / lastDay });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return shares;
}

// The calendar months a whole period covers, 1..12 each (a Month view: one; a
// Year view: all twelve).
function periodCalendarMonths_(startDate, endDate) {
  var months = [];
  var y = Number(startDate.substring(0, 4)), m = Number(startDate.substring(5, 7));
  var endKey = endDate.substring(0, 7);
  for (var guard = 0; guard < 600; guard++) {
    if (y + '-' + pad2_(m) > endKey) break;
    months.push(m);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

// What a prediction says for a period: the whole period (`base`) and the part
// still to come (`expected`, with `monthsLeft` months of it).
function forecastForPeriod_(prediction, startDate, endDate) {
  var base = 0;
  periodCalendarMonths_(startDate, endDate).forEach(function (m) { base += prediction.monthlyBase[m - 1]; });
  var expected = 0, monthsLeft = 0;
  remainingMonthShares_(startDate, endDate).forEach(function (s) {
    expected += s.share * prediction.monthlyBase[s.month - 1];
    monthsLeft += s.share;
  });
  var reference = prediction.level * monthsLeft;
  return { base: base, expected: expected, monthsLeft: monthsLeft, factor: reference > 0 ? expected / reference : 1 };
}

// ---- "Which would have worked best for you" ---------------------------------------------------------

// Replays every method over the last BACKTEST_MONTHS_ complete months of one
// category: for month t, forecast t knowing only the months before t, compare
// with what was really spent (non-recurring, like the forecast). A month a
// method cannot forecast (no previous year to copy, no history before t) is
// left out for that method. Returns { methods: [{id, months, errorPct, biasPct}],
// best, enough } — error = sum |forecast - actual| / sum actual.
function backtestSeries_(series, methodIds, asOfKey) {
  var stats = {};
  methodIds.forEach(function (id) { stats[id] = { id: id, months: 0, abs: 0, actual: 0, forecast: 0 }; });
  if (series) {
    for (var back = BACKTEST_MONTHS_; back >= 1; back--) {
      var t = monthKeyAdd_(asOfKey, -back);
      if (!(t > series.firstMonth)) continue;   // the category did not exist yet
      var actual = series.totals[t] || 0;
      methodIds.forEach(function (id) {
        var p = predictCategoryBase_(series, parseProjectionMethod_(id), t);
        if (p.fallback || !p.windowMonths.length) return;
        var forecast = p.monthlyBase[Number(t.substring(5, 7)) - 1];
        var s = stats[id];
        s.months++;
        s.abs += Math.abs(forecast - actual);
        s.actual += actual;
        s.forecast += forecast;
      });
    }
  }
  var methods = methodIds.map(function (id) {
    var s = stats[id];
    return {
      id: id, months: s.months,
      errorPct: s.months > 0 && s.actual > 0.005 ? s.abs / s.actual : null,
      biasPct: s.months > 0 && s.actual > 0.005 ? (s.forecast - s.actual) / s.actual : null,
      _abs: s.abs, _actual: s.actual
    };
  });
  return methods;
}

function bestOfMethods_(methods, currentId) {
  var usable = methods.filter(function (m) { return m.months >= BACKTEST_MIN_MONTHS_ && m.errorPct != null; });
  if (!usable.length) return { best: null, enough: false };
  usable.sort(function (a, b) {
    if (Math.abs(a.errorPct - b.errorPct) < 0.005) {   // a tie goes to what is already in use, then the default
      var pa = a.id === currentId ? 0 : a.id === PROJECTION_DEFAULT_METHOD_ ? 1 : 2;
      var pb = b.id === currentId ? 0 : b.id === PROJECTION_DEFAULT_METHOD_ ? 1 : 2;
      if (pa !== pb) return pa - pb;
    }
    return a.errorPct - b.errorPct;
  });
  return { best: usable[0].id, enough: true };
}

// payload: { categoryId } for one category, none for every category.
function compareProjectionMethods(payload) {
  ensureCategoryProjectionMethodColumn_();
  var defaultId = getProjectionDefaultMethod_();
  var asOfKey = formatCalendarDate_(new Date()).substring(0, 7);
  var ids = payload && payload.categoryId ? [payload.categoryId] : null;
  var seriesMap = buildMonthlySeries_(ids);
  var categoryById = rowsById_(getAllRows('Categories'));
  var presetIds = PROJECTION_PRESETS_.map(function (p) { return p.id; });

  var categories = [];
  var overall = {};
  Object.keys(seriesMap).forEach(function (categoryId) {
    var cat = categoryById[categoryId];
    var currentId = categoryMethodId_(cat, defaultId);
    var methodIds = presetIds.slice();
    if (methodIds.indexOf(currentId) === -1) methodIds.push(currentId);   // a custom choice is compared too
    var methods = backtestSeries_(seriesMap[categoryId], methodIds, asOfKey);
    var pick = bestOfMethods_(methods, currentId);
    var currentStat = methods.filter(function (m) { return m.id === currentId; })[0];
    var bestStat = methods.filter(function (m) { return m.id === pick.best; })[0];
    categories.push({
      category_id: categoryId,
      category_name: categoryLabel_(cat),
      category_icon: cat.icon || '',
      current: currentId,
      currentIsDefault: currentId === defaultId && !(cat.projection_method && String(cat.projection_method).trim()),
      best: pick.best,
      enough: pick.enough,
      gain: pick.enough && currentStat && currentStat.errorPct != null && bestStat ? currentStat.errorPct - bestStat.errorPct : 0,
      methods: methods.map(function (m) { return { id: m.id, months: m.months, errorPct: m.errorPct, biasPct: m.biasPct }; })
    });
    methods.forEach(function (m) {
      if (m.months < BACKTEST_MIN_MONTHS_) return;
      var o = overall[m.id] || (overall[m.id] = { id: m.id, abs: 0, actual: 0, categories: 0 });
      o.abs += m._abs;
      o.actual += m._actual;
      o.categories++;
    });
  });
  var overallList = Object.keys(overall).map(function (id) {
    var o = overall[id];
    return { id: id, errorPct: o.actual > 0.005 ? o.abs / o.actual : null, categories: o.categories };
  }).filter(function (o) { return o.errorPct != null; });
  var overallBest = overallList.slice().sort(function (a, b) { return a.errorPct - b.errorPct; })[0];
  categories.sort(function (a, b) { return a.category_name.localeCompare(b.category_name); });
  return {
    monthsBack: BACKTEST_MONTHS_,
    minMonths: BACKTEST_MIN_MONTHS_,
    defaultMethod: defaultId,
    categories: categories,
    overall: overallList,
    overallBest: overallBest ? overallBest.id : null
  };
}

// ---- Saving the choice ------------------------------------------------------------------------------------

function projectionMethodSettings() {
  ensureCategoryProjectionMethodColumn_();
  var overrides = {};
  getAllRows('Categories').forEach(function (c) {
    var own = c.projection_method ? String(c.projection_method).trim() : '';
    if (own && isValidProjectionMethod_(own)) overrides[c.id] = own;
  });
  return { defaultMethod: getProjectionDefaultMethod_(), overrides: overrides, presets: PROJECTION_PRESETS_.map(function (p) { return p.id; }) };
}

function assertProjectionMethod_(method) {
  if (!isValidProjectionMethod_(method)) throw new Error(tr_('err.projectionMethod'));
  return String(method).trim();
}

function setCategoryProjectionMethod_(categoryId, method) {
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, categoryId);
  if (rowIndex === -1) throw new Error(tr_('err.categoryNotFound'));
  setCellByRow_(sheet, headers, rowIndex, 'projection_method', method);
}

// payload: { method } alone = the default for categories with no choice of their
// own; { categoryId, method } = that category's own choice ('' = back to the default).
function setProjectionMethod(payload) {
  ensureCategoryProjectionMethodColumn_();
  if (payload.categoryId) {
    var method = payload.method ? assertProjectionMethod_(payload.method) : '';
    setCategoryProjectionMethod_(payload.categoryId, method);
  } else {
    setSetting_('projection_method', assertProjectionMethod_(payload.method));
  }
  return projectionMethodSettings();
}

// "Use this for every category": the default becomes `method` and every
// category's own choice is cleared.
function applyProjectionMethodToAll(payload) {
  ensureCategoryProjectionMethodColumn_();
  var method = assertProjectionMethod_(payload.method);
  setSetting_('projection_method', method);
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  getAllRows('Categories').forEach(function (c) {
    if (!c.projection_method) return;
    var rowIndex = findRowIndexById(sheet, headers, c.id);
    if (rowIndex !== -1) setCellByRow_(sheet, headers, rowIndex, 'projection_method', '');
  });
  return projectionMethodSettings();
}

// "Use the best for each category": only where there is enough history and the
// best beats the current choice by 5 points or more; it becomes that
// category's own choice (or clears it when it IS the default).
function applyBestProjectionMethods() {
  var result = compareProjectionMethods({});
  var defaultId = result.defaultMethod;
  var changed = [];
  result.categories.forEach(function (c) {
    if (!c.enough || !c.best || c.best === c.current || c.gain < BACKTEST_APPLY_MIN_GAIN_) return;
    setCategoryProjectionMethod_(c.category_id, c.best === defaultId ? '' : c.best);
    changed.push({ category_id: c.category_id, category_name: c.category_name, from: c.current, to: c.best, gain: c.gain });
  });
  return { changed: changed, settings: projectionMethodSettings() };
}
