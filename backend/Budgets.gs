/**
 * Phase 4: budgets per expense category, with Telegram alerts when spend
 * crosses a threshold. Progress reuses the same own_share/rate logic as
 * Reports.gs (getRateForEntryCurrency_, rowsById_), just scoped to one
 * category and one budget's own period instead of the whole Overview.
 */

var DEFAULT_BUDGET_THRESHOLDS = '50,75,100,110,125,150';

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// A budget's kind: 'monthly' (the default), 'yearly' or 'weekly' (Monday to Sunday, owner 2026-11-07).
function budgetKind_(t) { return t === 'yearly' ? 'yearly' : t === 'weekly' ? 'weekly' : 'monthly'; }

// 'YYYY-MM-DD' arithmetic in whole days (no time zone involved).
function isoAddDays_(iso, n) {
  var d = new Date(Date.UTC(Number(iso.substring(0, 4)), Number(iso.substring(5, 7)) - 1, Number(iso.substring(8, 10)) + n));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}
// The Monday of the week holding this day (a week runs Monday to Sunday; the owner's choice).
function mondayOf_(iso) {
  var d = new Date(Date.UTC(Number(iso.substring(0, 4)), Number(iso.substring(5, 7)) - 1, Number(iso.substring(8, 10))));
  return isoAddDays_(iso, -((d.getUTCDay() + 6) % 7));
}
function isoDayCount_(from, to) {   // days from..to, both included
  return Math.round((Date.UTC(+to.substring(0, 4), +to.substring(5, 7) - 1, +to.substring(8, 10)) - Date.UTC(+from.substring(0, 4), +from.substring(5, 7) - 1, +from.substring(8, 10))) / 86400000) + 1;
}

// Monthly budgets reset every calendar month, yearly ones every calendar
// year — periodKey is what Budget Alert Log dedupes alerts against, so a
// threshold already alerted this period never re-fires until the period
// rolls over.
function getBudgetPeriodBounds_(periodType, refDate) {
  var y = refDate.getFullYear();
  var m = refDate.getMonth();
  if (periodType === 'weekly') {   // Monday to Sunday; the key is the Monday ('YYYY-MM-DD')
    var mon = mondayOf_(y + '-' + pad2_(m + 1) + '-' + pad2_(refDate.getDate()));
    return { startDate: mon, endDate: isoAddDays_(mon, 6), periodKey: mon };
  }
  if (periodType === 'yearly') {
    return { startDate: y + '-01-01', endDate: y + '-12-31', periodKey: String(y) };
  }
  var lastDay = new Date(y, m + 1, 0).getDate();
  return {
    startDate: y + '-' + pad2_(m + 1) + '-01',
    endDate: y + '-' + pad2_(m + 1) + '-' + pad2_(lastDay),
    periodKey: y + '-' + pad2_(m + 1)
  };
}

// Progress for every budget needs the same underlying data (all confirmed
// expense entries, all splits, all exchange rates) — reading those sheets
// fresh per budget was the original approach, but with ~6,900+ Entries rows
// that meant one full sheet scan per budget (11 budgets measured at ~14s
// total). Building this context ONCE and computing every budget's progress
// from the in-memory result instead keeps it to a handful of sheet reads
// regardless of how many budgets exist.
// opts.skipPractice: leave out the first-use practices' own entries (the alert check; see Practice.gs).
function buildBudgetContext_(opts) {
  var skipPractice = !!(opts && opts.skipPractice);
  var entries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.type === 'expense' && !(skipPractice && isPracticeEntry_(e));
  });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  // ratesByCurrency keeps every rate on file per currency, sorted — each
  // entry converts at the most recent rate on file at or before its own
  // month (see getLatestRateOnOrBefore_/latestRateAtOrBefore_ — the
  // general fallback rule, since an entry's own PEN figure here is a
  // derived report value, not the act of saving the entry). Unlike a
  // single "latest as of today" cutoff, viewing a past period
  // (Overview-style navigation, see resolveEffectivePeriodType_) needs
  // "latest as of THAT period" for the budget's OWN currency lookups
  // below, so the cutoff is resolved per-lookup rather than baked in here.
  var ratesByCurrency = buildRatesByCurrency_();   // the shared reader: it also knows rows stored as "1 USD = r X" (RatesUsd.gs)
  var ctxForEntryRates = { ratesByCurrency: ratesByCurrency };

  // Entries tagged Annual don't count against a MONTHLY budget (they do count
  // against a yearly one) — flagged here, decided per budget below.
  var annualEntryIds = annualEntryIdSet_();

  var spendEntries = entries.map(function (e) {
    var entryMonth = String(e.date).substring(0, 7);
    var rate = latestRateAtOrBefore_(ctxForEntryRates, e.currency, entryMonth);
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    return {
      category_id: e.category_id,
      annual: annualEntryIds[e.id] === true,
      date: e.date,
      currency: e.currency,
      ownAmount: ownAmount, // in the entry's own original currency
      ownAmountPen: rate != null ? ownAmount * rate : null
    };
  });

  return { spendEntries: spendEntries, ratesByCurrency: ratesByCurrency, budgetHistory: budgetHistory_() };
}

// A budget's `category_id` column holds either a single id, a
// comma-separated list of ids (several categories), or the literal string
// 'ALL' (every expense category) — null return means "no filter, match
// anything", an array means "match only these". Existing budgets already
// hold exactly one id, which is just a one-item list under this reading,
// so no migration was needed to support this.
function parseBudgetCategoryIds_(raw) {
  if (raw === 'ALL') return null;
  return String(raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function categoryIdMatches_(categoryIds, entryCategoryId) {
  return categoryIds === null || categoryIds.indexOf(entryCategoryId) !== -1;
}

// categoryIds as above, or a function(entry) -> true/false when the budget's categories (or its existence) changed inside the
// period being shown (budgetPlan_, a monthly budget shown by year).
function entryInBudget_(categoryIds, e) {
  return typeof categoryIds === 'function' ? categoryIds(e) : categoryIdMatches_(categoryIds, e.category_id);
}

function categorySpendPenFromContext_(ctx, categoryIds, startDate, endDate, excludeAnnual) {
  var total = 0;
  ctx.spendEntries.forEach(function (e) {
    if (!entryInBudget_(categoryIds, e) || e.ownAmountPen == null) return;
    if (excludeAnnual && e.annual) return;
    if (e.date < startDate || e.date > endDate) return;
    total += e.ownAmountPen;
  });
  return total;
}

// Sums a category's spend directly in a target currency (a budget's own
// currency) rather than always going PEN total -> re-divide by a rate.
// An entry already recorded in the target currency contributes exactly
// what was paid, no conversion at all — the most accurate figure there
// is, and the whole reason this exists: for a USD budget, USD entries
// (the common case) no longer get converted PEN -> USD through today's
// rate only to drift from what was actually paid whenever that differs
// from the rate used when the entry itself was saved. Anything in a
// different currency still goes through PEN, same as everywhere else.
function categorySpendInCurrencyFromContext_(ctx, categoryIds, startDate, endDate, targetCurrency, cutoffMonth, excludeAnnual) {
  var rate = null;
  if (targetCurrency !== homeCurrency_()) {
    rate = latestRateAtOrBefore_(ctx, targetCurrency, cutoffMonth);
    if (rate == null) return null; // no rate for the budget's own currency at all — can't produce a figure
  }

  var total = 0;
  ctx.spendEntries.forEach(function (e) {
    if (!entryInBudget_(categoryIds, e)) return;
    if (excludeAnnual && e.annual) return;
    if (e.date < startDate || e.date > endDate) return;

    if (e.currency === targetCurrency) {
      total += e.ownAmount;
    } else if (e.ownAmountPen != null) {
      total += targetCurrency === homeCurrency_() ? e.ownAmountPen : e.ownAmountPen / rate;
    }
    // else: no rate on file for THIS entry's own month — silently
    // excluded, same as the plain-PEN sum above has always done.
  });
  return total;
}

// Display name/icon/color for a budget's category set — a real category's
// own icon/color for one category, a generic "combined budget" marker for
// several or ALL (a joined name list gets long, and the row's own CSS
// already ellipsizes long names — see budget-row-name in style.css).
function resolveBudgetCategoryDisplay_(categoryIds, categoryById) {
  if (categoryIds === null) {
    return { name: tr_('budget.allExpense'), icon: '🗂️', color: '' };
  }
  if (categoryIds.length === 1) {
    var cat = categoryById[categoryIds[0]];
    return {
      name: cat ? categoryLabel_(cat) : tr_('label.unknownCategory'),
      icon: cat ? cat.icon : '',
      color: cat ? cat.color : ''
    };
  }
  var names = categoryIds.map(function (id) {
    var c = categoryById[id];
    return c ? categoryLabel_(c) : tr_('label.unknownCategory');
  });
  return { name: names.join(', '), icon: '🗂️', color: '' };
}

// An optional custom name overrides the category-derived one everywhere a
// budget's name is shown (its row, drill-down title, Telegram alerts) —
// blank/whitespace-only falls back to the category name, same as before
// this field existed.
function resolveBudgetDisplayName_(budget, categoryDisplayName) {
  var custom = String(budget.name || '').trim();
  return custom || categoryDisplayName;
}

// A budget set in a foreign currency compares against the best-known rate
// for it as of the period being shown (the most recent month on file, at
// or before that period's own end month) — there's no single "right" rate
// for a period that can span many months (a yearly budget), so this reads
// as "what that spend was worth around then" rather than a re-derived
// period-specific figure. cutoffMonth is the effective period's own end
// month, per CLAUDE.md's "rates are always keyed to calendar months, even
// when viewing custom periods" — using today's rate to judge a past period
// would be inconsistent with how every other rate lookup in the app works.
function latestRateAtOrBefore_(ctx, currency, cutoffMonth) {
  if (currency === homeCurrency_()) return 1;
  return rateToMain_(ctx.ratesByCurrency, currency, cutoffMonth);
}

// The viewing period (Overview-style Month/Year/All-time/Custom) can widen
// what a budget is measured over, but never narrow it — a yearly budget
// always reflects the whole year regardless of what's being browsed, and a
// monthly budget viewed at yearly granularity shows its progress across
// the whole year instead of vanishing back to just the current month.
// All-time/Custom have no month/year size to compare against, so a budget
// just shows its own native period in that case (same as before periods
// were browsable here at all).
function resolveEffectivePeriodType_(budgetPeriodType, displayPeriodType) {
  var kind = budgetKind_(budgetPeriodType);
  if (displayPeriodType === 'year') return 'yearly';
  if (displayPeriodType === 'month' && kind === 'weekly') return 'monthly';   // a weekly budget across a whole month
  return kind;   // a Week view never narrows a monthly or yearly budget: it shows its own month / year
}

// Monthly budgets leave Annual-tagged expenses out; yearly ones count them.
function budgetExcludesAnnual_(budget) {
  return budget.period_type !== 'yearly';
}

function computeBudgetProgressWithContext_(budget, ctx, displayPeriodType, anchorDate) {
  var effectivePeriodType = resolveEffectivePeriodType_(budget.period_type, displayPeriodType);
  var usesAnchor = (displayPeriodType === 'month' || displayPeriodType === 'year' || displayPeriodType === 'week') && anchorDate;
  var refDate = usesAnchor ? new Date(anchorDate + 'T00:00:00') : new Date();
  if (displayPeriodType === 'week' && usesAnchor && effectivePeriodType !== 'weekly') {
    // A monthly or yearly budget in a Week view: the month (year) of today when the week holds today, else of the week's Thursday
    // (a week belongs to the month holding most of its days).
    var mon = mondayOf_(anchorDate), todayIso = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var pick = (todayIso >= mon && todayIso <= isoAddDays_(mon, 6)) ? todayIso : isoAddDays_(mon, 3);
    refDate = new Date(pick + 'T00:00:00');
  }
  var bounds = getBudgetPeriodBounds_(effectivePeriodType, refDate);

  // A monthly budget's amount is a per-month figure — shown across a full
  // year, its natural yearly equivalent is the months' figures added up. (Never
  // the other way around: a yearly budget's amount already IS the whole
  // year's figure, so it's never divided down for a monthly view — see
  // resolveEffectivePeriodType_.)
  var annualized = effectivePeriodType === 'yearly' && budgetKind_(budget.period_type) === 'monthly';
  var weeksWidened = effectivePeriodType !== 'weekly' && budgetKind_(budget.period_type) === 'weekly';
  // What the budget was in the period shown: amount, currency and categories count from their own period on, and a budget
  // exists only from its start to its end (owner, 2026-11-07; see § Budget history below).
  var plan = budgetPlanForRange_(budget, ctx, bounds.startDate, bounds.endDate);
  if (!plan.exists) return { exists: false, effectivePeriodType: effectivePeriodType, annualized: annualized, periodKey: bounds.periodKey, startDate: bounds.startDate, endDate: bounds.endDate };

  // A budget's own period_type decides (not the widened display period): a
  // monthly budget never counts Annual-tagged expenses, even when browsed by year.
  var excludeAnnual = budgetExcludesAnnual_(budget);
  var spentPen = categorySpendPenFromContext_(ctx, plan.match, bounds.startDate, bounds.endDate, excludeAnnual);
  var effectiveAmount = plan.amount;
  var currency = plan.currency;
  var cutoffMonth = bounds.endDate.substring(0, 7);
  var spent = categorySpendInCurrencyFromContext_(ctx, plan.match, bounds.startDate, bounds.endDate, currency, cutoffMonth, excludeAnnual);
  // What the Annual tag kept out of a monthly budget, in the budget's currency, so the row can say so: Overview's category total
  // counts those entries and the two numbers looked like a mismatch (testers, 2026-11-07). 0 for a yearly budget.
  var annualLeftOut = 0;
  if (excludeAnnual && spent != null) {
    var withAnnual = categorySpendInCurrencyFromContext_(ctx, plan.match, bounds.startDate, bounds.endDate, currency, cutoffMonth, false);
    if (withAnnual != null && withAnnual - spent > 0.005) annualLeftOut = withAnnual - spent;
  }
  var percent = (spent != null && effectiveAmount > 0) ? (spent / effectiveAmount) * 100 : null;

  // The actual rate behind spent/percent above, surfaced so a foreign-
  // currency budget can show what it's using rather than leaving the
  // conversion invisible — see categorySpendInCurrencyFromContext_ for how
  // it's applied (only entries NOT already in this currency go through it).
  var rate = latestRateAtOrBefore_(ctx, currency, cutoffMonth);

  return {
    exists: true,
    effectivePeriodType: effectivePeriodType,
    annualized: annualized,
    periodKey: bounds.periodKey,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    spentPen: spentPen,
    spent: spent,
    effectiveAmount: effectiveAmount,
    currency: currency,
    category_ids: plan.categoryIds,       // the period's own categories (null = all expense categories)
    category_id: plan.categoryRaw,
    amountChanged: plan.changed,
    monthsCounted: plan.monthsCounted,    // a monthly budget shown by year: the months it existed in (12 = the whole year)
    weeksWidened: weeksWidened,           // a weekly budget shown by month or year: its weeks, a week cut by the period counted by its days
    weeksCounted: plan.weeksCounted || null,
    countFrom: plan.firstMonth || null,   // …and the first and last of them ('YYYY-MM'), for the drill-down's list
    countTo: plan.lastMonth || null,
    percent: percent,
    annualLeftOut: annualLeftOut,
    rateAvailable: spent != null,
    rate: rate
  };
}

// displayPeriodType/anchorDate come from the app's shared period selector
// (the same one Overview uses) — omitted, budgets fall back to their own
// native period as of right now, e.g. for the automation trigger (see
// checkBudgets) where "what's being browsed" doesn't apply.
function listBudgets(payload) {
  var displayPeriodType = payload && payload.displayPeriodType;
  var anchorDate = payload && payload.anchorDate;

  var categoryById = rowsById_(getAllRows('Categories'));
  var ctx = buildBudgetContext_();
  var rawBudgets = getAllRows('Budgets');

  // "Today's" rate, not the browsed period's — amount_pen and the summary
  // totals below describe standing budget commitments, not spend against a
  // specific past period, so there's no period to key the rate to.
  var currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');

  var budgets = rawBudgets.map(function (b) {
    var categoryIds = parseBudgetCategoryIds_(b.category_id);
    var display = resolveBudgetCategoryDisplay_(categoryIds, categoryById);
    var currency = b.currency || homeCurrency_();
    var rate = latestRateAtOrBefore_(ctx, currency, currentMonth);
    return {
      id: b.id,
      category_id: b.category_id,
      category_ids: categoryIds, // array of specific ids, or null for "ALL"
      all_categories: categoryIds === null,
      name: b.name || '', // raw, for the edit form's own input
      category_name: resolveBudgetDisplayName_(b, display.name), // custom name if set, else the category name
      category_icon: display.icon,
      category_color: display.color,
      amount: Number(b.amount),
      amount_pen: rate != null ? Number(b.amount) * rate : null,
      currency: currency,
      period_type: budgetKind_(b.period_type),
      thresholds: b.thresholds || DEFAULT_BUDGET_THRESHOLDS,
      progress: computeBudgetProgressWithContext_(b, ctx, displayPeriodType, anchorDate),
      active_now: budgetActiveNow_(b, ctx),   // running this month (year): counts in the totals below
      ended: budgetEndedNow_(b, ctx.budgetHistory[String(b.id)]),
      end_deletes: !budgetRanBefore_(b, ctx.budgetHistory[String(b.id)])   // ending it would delete it completely (endBudget)
    };
  });
  // The period's own categories name the row when they were different then (a change of categories counts forward only).
  budgets.forEach(function (x) {
    var p = x.progress;
    if (!p.exists || p.category_id === x.category_id || x.name) return;
    var d = resolveBudgetCategoryDisplay_(p.category_ids, categoryById);
    p.category_name = resolveBudgetDisplayName_({ name: '' }, d.name);
    p.category_icon = d.icon;
  });

  // Yearly budgets first, largest first; monthly budgets after, largest
  // first — grouped by the budget's own definition, not by whatever's
  // currently displayed, so the order doesn't reshuffle as you browse
  // periods. amount_pen makes "largest" comparable across currencies;
  // budgets with no rate on file (amount_pen null) sort last within their
  // group.
  budgets.sort(function (a, b) {
    var KIND_ORDER = { yearly: 0, monthly: 1, weekly: 2 };
    var orderA = KIND_ORDER[a.period_type];
    var orderB = KIND_ORDER[b.period_type];
    if (orderA !== orderB) return orderA - orderB;
    var pa = a.amount_pen == null ? -1 : a.amount_pen;
    var pb = b.amount_pen == null ? -1 : b.amount_pen;
    return pb - pa;
  });

  // ---- Dedup categories before totaling, so an "all categories" budget
  // plus narrower budgets inside it don't get added on top of each other —
  // only the total possible spend matters here, and a budget whose
  // categories are entirely covered by another budget doesn't raise that
  // ceiling any further. Applies regardless of period_type: a monthly and
  // a yearly budget on the very same category are the same case (two caps
  // on one spend pool), not two independent amounts to add together.
  var shown = budgets.filter(function (x) { return x.progress.exists; });
  budgets = budgets.filter(function (x) { return x.active_now; });   // the totals card: standing budgets, whatever period is shown
  var allExpenseCategoryIds = Object.keys(categoryById).filter(function (id) {
    return categoryById[id].type === 'expense';
  });
  function idSetFor_(categoryIds) {
    var ids = categoryIds === null ? allExpenseCategoryIds : categoryIds;
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    return set;
  }
  function isSubset_(small, big) {
    for (var id in small) { if (!big[id]) return false; }
    return true;
  }
  function setSize_(set) { return Object.keys(set).length; }

  var budgetSets = budgets.map(function (b) { return idSetFor_(b.category_ids); });

  // dominated[i] === true means budget i's categories are already fully
  // covered by some other budget j, so i is left out of the total. When
  // two budgets cover the exact same categories, only one survives (the
  // larger PEN amount, tie-broken by id) — otherwise an identical pair
  // would each "contain" the other and both would vanish.
  var dominated = budgets.map(function () { return false; });
  for (var i = 0; i < budgets.length; i++) {
    for (var j = 0; j < budgets.length; j++) {
      if (i === j || !isSubset_(budgetSets[i], budgetSets[j])) continue;
      var equalSets = setSize_(budgetSets[i]) === setSize_(budgetSets[j]);
      if (!equalSets) { dominated[i] = true; break; }
      var pi = budgets[i].amount_pen == null ? -1 : budgets[i].amount_pen;
      var pj = budgets[j].amount_pen == null ? -1 : budgets[j].amount_pen;
      if (pj > pi || (pj === pi && String(budgets[j].id) > String(budgets[i].id))) {
        dominated[i] = true;
        break;
      }
    }
  }

  // Total per month only counts budgets that are actually monthly — a
  // yearly budget's own amount ÷ 12 is just an average, and folding that
  // average into "this month's" total implies a per-month cap that isn't
  // real (a yearly budget lets spending run uneven across months as long
  // as the year-end total holds). Total per year has no such mismatch, so
  // it still counts every surviving budget, converting monthly ones ×12.
  var monthlyPen = 0, yearlyPen = 0, excludedCount = 0;
  budgets.forEach(function (b, idx) {
    if (dominated[idx]) return;
    if (b.amount_pen == null) { excludedCount++; return; }
    // A weekly budget is a real cap every week: 52 of them a year, 52 / 12 a month.
    if (b.period_type === 'monthly') monthlyPen += b.amount_pen;
    if (b.period_type === 'weekly') monthlyPen += b.amount_pen * 52 / 12;
    yearlyPen += b.period_type === 'yearly' ? b.amount_pen : b.period_type === 'weekly' ? b.amount_pen * 52 : b.amount_pen * 12;
  });

  // Budgets that survive the dedup above (none fully contains the other)
  // can still partly overlap — e.g. "Car" and "Monthly essentials" both
  // including Transport. Unlike full containment, there's no single
  // correct total then, so this just surfaces it rather than guessing.
  var overlapNotes = [];
  for (var a = 0; a < budgets.length; a++) {
    if (dominated[a]) continue;
    for (var c = a + 1; c < budgets.length; c++) {
      if (dominated[c]) continue;
      var shared = [];
      for (var sid in budgetSets[a]) {
        if (budgetSets[c][sid]) shared.push(sid);
      }
      if (shared.length === 0) continue;
      var sharedNames = shared.map(function (id) {
        return categoryById[id] ? categoryLabel_(categoryById[id]) : id;
      }).join(', ');
      overlapNotes.push(tr_('budget.overlap', { a: budgets[a].category_name, b: budgets[c].category_name, names: sharedNames }));
    }
  }

  return {
    budgets: shown,
    summary: {
      monthlyPen: monthlyPen,
      yearlyPen: yearlyPen,
      excludedCount: excludedCount,
      overlapNotes: overlapNotes
    }
  };
}

// Feeds the drill-down's line chart: actual spend per day, still-outstanding
// recurring expenses attributed to their actual calendar day within the
// period, and the same year-to-date "Expected" rate Projections uses,
// summed across every category this budget covers — all in the budget's
// own currency, same conversion rule as everywhere else in this file (an
// entry/recurring item already in the budget's currency contributes
// exactly its own amount, no conversion). startDate/endDate come from the
// budget's already-computed progress (see computeBudgetProgressWithContext_),
// so this doesn't re-derive period bounds on its own; periodType (monthly/
// yearly) is needed separately for the same "skip a yearly-only category"
// rule Projections applies.
function getBudgetChartSeries(payload) {
  var startDate = payload.startDate;
  var endDate = payload.endDate;
  var rawBudget = getAllRows('Budgets').filter(function (b) { return b.id === payload.budgetId; })[0];
  if (!rawBudget) throw new Error(tr_('err.budgetNotFound'));

  var ctx = buildBudgetContext_();
  // What the budget was in the period shown (currency, categories, the months it existed in): see § Budget history.
  var plan = budgetPlanForRange_(rawBudget, ctx, startDate, endDate);
  var currency = plan.exists ? plan.currency : (rawBudget.currency || homeCurrency_());
  var categoryIds = plan.exists ? plan.categoryIds : parseBudgetCategoryIds_(rawBudget.category_id);   // programmed / expected: the latest
  var match = plan.exists ? plan.match : function () { return false; };
  var cutoffMonth = endDate.substring(0, 7);
  var rate = latestRateAtOrBefore_(ctx, currency, cutoffMonth);

  var dailySpend = {};
  var excludeAnnual = budgetExcludesAnnual_(rawBudget);
  ctx.spendEntries.forEach(function (e) {
    if (!entryInBudget_(match, e)) return;
    if (excludeAnnual && e.annual) return;
    if (e.date < startDate || e.date > endDate) return;
    var amt = null;
    if (e.currency === currency) {
      amt = e.ownAmount;
    } else if (e.ownAmountPen != null) {
      amt = currency === homeCurrency_() ? e.ownAmountPen : (rate != null ? e.ownAmountPen / rate : null);
    }
    if (amt == null) return;
    dailySpend[e.date] = (dailySpend[e.date] || 0) + amt;
  });

  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var entrySplitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSumByEntry[s.entry_id] = (entrySplitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  // Raw (unshaped) confirmed entries in range — buildBudgetContext_'s own
  // spendEntries strip fields (id, full amount, recurring_expense_id) that
  // entryMatchesRecurringOccurrence_ needs, so this reads them separately
  // rather than reshaping that shared context.
  // Any date, not just the period: an occurrence counts as paid when an entry
  // near ITS date exists, and a custom item's window can reach outside the period.
  var entriesInRange = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && categoryIdMatches_(categoryIds, e.category_id);
  });

  // Only occurrences WITHOUT a matching confirmed entry become a bump —
  // same "Programmed" rule Projections uses (fixed 2026-09-22 here too:
  // this used to include every occurrence in range regardless of whether
  // it was already paid, so an already-recorded rent payment could still
  // show as a phantom future bump on top of its own real entry already
  // sitting in the actual line).
  var recurringOccurrences = [];
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false' || !categoryIdMatches_(categoryIds, r.category_id)) return;
    var reCurrency = r.currency || homeCurrency_();
    var ownAmount = recurringOwnAmount_(r, recurringSplitSums);
    var amt = null;
    if (reCurrency === currency) {
      amt = ownAmount;
    } else {
      var rePen = null;
      if (reCurrency === homeCurrency_()) {
        rePen = ownAmount;
      } else {
        var reRate = latestRateAtOrBefore_(ctx, reCurrency, cutoffMonth);
        rePen = reRate != null ? ownAmount * reRate : null;
      }
      if (rePen != null) amt = currency === homeCurrency_() ? rePen : (rate != null ? rePen / rate : null);
    }
    if (amt == null) return;
    recurringExpenseOccurrencesInRange_(r, startDate, endDate)
      .filter(function (date) {
        return !entriesInRange.some(function (e) {
          return entryMatchesRecurringOccurrence_(e, r, [date], entrySplitSumByEntry, recurringSplitSums);
        });
      })
      .forEach(function (date) {
        recurringOccurrences.push({ date: date, amount: amt, description: r.description || '' });
      });
  });

  // "Expected" — the exact same year-to-date rate Projections computes
  // per category (computeCategoryYtdBreakdown_, Projections.gs), pro-rated
  // to the days actually left (daysLeftInPeriod_, the same "N days left"
  // convention the Projections chart's own caption uses) and summed across
  // every category this budget covers, converted into the budget's own
  // currency the same way a recurring item's amount is above. A category
  // the owner has flagged `period_type: yearly` is skipped in anything but
  // a yearly view, same rule Projections applies — no smoothed monthly
  // guess for a cost that's only ever meaningful once a year.
  var daysLeft = daysLeftInPeriod_(startDate, endDate);
  var allExpenseCategories = getAllRows('Categories').filter(function (c) { return c.type === 'expense'; });
  var budgetCategories = categoryIds === null
    ? allExpenseCategories
    : allExpenseCategories.filter(function (c) { return categoryIds.indexOf(c.id) !== -1; });
  var expectedRemainingPen = 0;
  // The same predictor Projections uses for each category (its own choice or
  // the default — see ProjectionMethods.gs), over the part of THIS budget's
  // period still to come.
  ensureCategoryProjectionMethodColumn_();
  var seriesMap = buildMonthlySeries_(budgetCategories.map(function (c) { return c.id; }));
  var defaultMethodId = getProjectionDefaultMethod_();
  var asOfKey = formatCalendarDate_(new Date()).substring(0, 7);
  budgetCategories.forEach(function (cat) {
    if (String(cat.period_type || '').toLowerCase() === 'yearly' && payload.periodType !== 'yearly') return;
    var prediction = predictCategoryBase_(seriesMap[cat.id], parseProjectionMethod_(categoryMethodId_(cat, defaultMethodId)), asOfKey);
    expectedRemainingPen += forecastForPeriod_(prediction, startDate, endDate).expected;
  });
  var expectedRemaining = currency === homeCurrency_() ? expectedRemainingPen : (rate != null ? expectedRemainingPen / rate : null);

  return {
    currency: currency,
    dailySpend: dailySpend,
    recurringOccurrences: recurringOccurrences,
    expectedRemaining: expectedRemaining || 0,
    daysLeft: daysLeft
  };
}

// Thresholds are percentages like "75,100". Anything that isn't a positive
// number is rejected with a message (a "0" fired instantly, and "75%" or
// "abc" used to be silently dropped, leaving a budget that never alerted).
// Returns the cleaned, sorted, de-duplicated "75,100" string.
function normalizeBudgetThresholds_(raw) {
  var text = String(raw === undefined || raw === null || raw === '' ? DEFAULT_BUDGET_THRESHOLDS : raw);
  var seen = {};
  var out = [];
  text.split(',').forEach(function (part) {
    var t = part.trim();
    if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) {
      throw new Error(tr_('budget.thresholds', { value: t }));
    }
    if (!seen[Number(t)]) { seen[Number(t)] = true; out.push(Number(t)); }
  });
  return out.sort(function (a, b) { return a - b; }).join(',');
}

function validateBudgetAmount_(amount) {
  var n = Number(amount);
  if (amount === null || amount === '' || !isFinite(n) || n <= 0) throw new Error(tr_('budget.amountGreater'));
}

// A budget may not repeat EXACTLY the same set of categories as another one
// with the same timeframe (monthly/yearly): that would count the same spending
// twice and alert twice. Anything else coexists — a monthly and a yearly budget
// for one category, a one-category budget alongside a multi-category budget
// that includes it, two multi-category budgets that merely overlap. 'ALL'
// (every expense category) counts as one set, equal only to another 'ALL'.
// Order doesn't matter. `excludeId` is the budget being edited, so saving it
// unchanged is not a conflict with itself.
function assertNoDuplicateBudget_(categoryRaw, periodType, excludeId) {
  var mine = parseBudgetCategoryIds_(categoryRaw);   // null = ALL
  var key = function (ids) { return ids === null ? 'ALL' : ids.slice().sort().join(','); };
  var myKey = key(mine);
  var names = {};
  getAllRows('Categories').forEach(function (c) { names[c.id] = categoryLabel_(c); });

  var history = budgetHistory_();
  getAllRows('Budgets').forEach(function (other) {
    if (other.id === excludeId) return;
    if (budgetEndedNow_(other, history[String(other.id)])) return;   // an ended budget may be made again (owner, 2026-11-07)
    if (budgetKind_(other.period_type) !== periodType) return;
    if (key(parseBudgetCategoryIds_(other.category_id)) !== myKey) return;
    var what = mine === null
      ? tr_('budget.allExpenseLower')
      : mine.map(function (id) { return '"' + (names[id] || tr_('budget.thisCategory')) + '"'; }).join(' + ');
    throw new Error(tr_('budget.duplicate', { period: tr_(periodType === 'yearly' ? 'budget.yearly' : periodType === 'weekly' ? 'budget.weekly' : 'budget.monthly'), what: what }));
  });
}

function addBudget(payload) {
  validateBudgetAmount_(payload.amount);
  assertNoDuplicateBudget_(payload.category_id, budgetKind_(payload.period_type), null);
  var budget = {
    id: Utilities.getUuid(),
    category_id: payload.category_id,
    amount: Number(payload.amount),
    currency: payload.currency || homeCurrency_(),
    period_type: budgetKind_(payload.period_type),
    thresholds: normalizeBudgetThresholds_(payload.thresholds),
    name: payload.name ? String(payload.name).trim() : ''
  };
  appendRowObject('Budgets', budget);
  // A new budget starts in the month (year) it is made, unless the person picked another start (owner, 2026-11-07).
  var start = budgetStartKey_(budget.period_type, payload.start);
  if (start !== '') writeBudgetHistoryRow_(budget, start, budget, false);
  budget.start = start;
  return budget;
}

function updateBudget(payload) {
  var sheet = getSheet('Budgets');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error(tr_('err.budgetNotFound'));

  if (payload.amount !== undefined) validateBudgetAmount_(payload.amount);
  if (payload.category_id !== undefined || payload.period_type !== undefined) {
    var current = getAllRows('Budgets').find(function (b) { return b.id === payload.id; });
    var newPeriod = payload.period_type !== undefined ? payload.period_type : current.period_type;
    assertNoDuplicateBudget_(
      payload.category_id !== undefined ? payload.category_id : current.category_id,
      budgetKind_(newPeriod),
      payload.id
    );
  }
  if (payload.thresholds !== undefined) payload.thresholds = normalizeBudgetThresholds_(payload.thresholds);
  var before = getAllRows('Budgets').find(function (b) { return b.id === payload.id; });
  if (payload.restart) restartBudget_(before, payload);
  else recordBudgetChange_(before, payload);

  ['category_id', 'amount', 'currency', 'period_type', 'thresholds', 'name'].forEach(function (field) {
    if (payload[field] !== undefined) {
      var value = field === 'name' ? String(payload[field] || '').trim() : payload[field];
      setCellByRow_(sheet, headers, rowIndex, field, value);
    }
  });

  // Alerts are remembered per period ("already told you about 75%"). Changing
  // the amount or thresholds changes what 75% means, so the budget's alert
  // memory is cleared — otherwise raising a budget after an alert, or editing an expense
  // down and back up, would never warn again until next month.
  if (payload.amount !== undefined || payload.thresholds !== undefined) {
    deleteRowsWhere_('Budget Alert Log', function (r) { return r.budget_id === payload.id; });
  }
  return { done: true };
}

function deleteBudget(id) {
  var sheet = getSheet('Budgets');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex !== -1) deleteSheetRows_(sheet, rowIndex, 1);

  // Its alert history is meaningless once the budget is gone.
  var logSheet = getSheet('Budget Alert Log');
  var logHeaders = getHeaders(logSheet);
  var budgetIdCol = logHeaders.indexOf('budget_id');
  var lastRow = logSheet.getLastRow();
  if (lastRow > 1) {
    var data = logSheet.getRange(2, 1, lastRow - 1, logHeaders.length).getValues();
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][budgetIdCol] === id) deleteSheetRows_(logSheet, i + 2, 1);
    }
  }
  if (budgetHistorySheetExists_()) deleteRowsWhere_('Budget History', function (r) { return String(r.budget_id) === String(id); });
  return { done: true };
}

// Several budgets at once (More → Budgets → Edit, owner's request 2026-11-02): ONE call, rows that sit together go in one sheet call
// (deleteRowsWhere_), and the alert history of every deleted budget goes with them. Entries are never touched (a budget only watches them).
// Answers which ids were deleted and which no longer existed (another device deleted them first), so the app can say so.
function deleteBudgets(payload) {
  var ids = (payload && payload.ids) || [];
  var want = {}, order = [];
  ids.forEach(function (id) { id = String(id); if (id && !want[id]) { want[id] = true; order.push(id); } });
  if (!order.length) return { deleted: [], missing: [] };
  var present = {};
  getAllRows('Budgets').forEach(function (b) { present[String(b.id)] = true; });
  var deleted = order.filter(function (id) { return present[id]; });
  var missing = order.filter(function (id) { return !present[id]; });
  if (deleted.length) {
    deleteRowsWhere_('Budgets', function (r) { return want[String(r.id)] === true; });
    deleteRowsWhere_('Budget Alert Log', function (r) { return want[String(r.budget_id)] === true; });
    if (budgetHistorySheetExists_()) deleteRowsWhere_('Budget History', function (r) { return want[String(r.budget_id)] === true; });
  }
  return { deleted: deleted, missing: missing };
}

// Same shape as adminDebugProjectionOverrides (Projections.gs) — a raw
// dump for diagnosing why an alert fired (or didn't), same
// diagnostic-only spirit.
function adminDebugBudgetAlertLog() {
  var sheet = getSheet('Budget Alert Log');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rows: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return {
    headers: headers,
    rows: values.map(function (row) {
      return row.map(function (cell) { return { value: cell, jsType: typeof cell, str: String(cell) }; });
    })
  };
}

// Runs on the same 15-minute automation cycle as the email scan. A
// budget can cross several thresholds between runs (a big purchase, or —
// a real incident, see CHANGELOG.md § Budgets — a miscategorized entry
// that temporarily inflated a category — can jump 40% straight to
// 1900%+ in one check). Every newly-crossed threshold still gets its own
// Budget Alert Log row, so the per-threshold dedup stays exactly as
// precise as before and nothing is silently skipped — but only ONE
// Telegram message goes out per budget per run (fixed 2026-09-22, after
// the owner asked why they got 6 near-identical alerts in a row for one
// run that had legitimately crossed all 6 thresholds at once): the
// message already reports the current live percentage, not the specific
// threshold, so 6 messages in a row never said anything a single one
// didn't already cover.
function checkBudgets() {
  // The 15-minute trigger and a manual run can overlap; without the lock both
  // read the alert log before either writes and send the same alert twice.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return checkBudgetsLocked_();
  } finally {
    lock.releaseLock();
  }
}

// The first-use Budgets practice names its budget like this (both languages); the alert check leaves it alone.
function isPracticeBudget_(budget) {
  return /^(Practice budget|Presupuesto de pr\u00e1ctica)$/.test(String((budget && budget.name) || '').trim());
}

// First-use Budgets practice cleanup in one call: deletes every budget named like the practice's own (and its alert history).
function removePracticeBudgets() {
  var removed = 0;
  getAllRows('Budgets').forEach(function (b) {
    if (isPracticeBudget_(b)) { deleteBudget(b.id); removed++; }
  });
  return { removed: removed };
}

function checkBudgetsLocked_() {
  var budgets = getAllRows('Budgets');
  // The first run on an existing copy only writes down what is already over a limit, without alerting (Notices.gs § Alerts only from now on).
  var baseline = alertBaselinePending_('budgets');
  if (!budgets.length) {
    syncBudgetNotices_({});   // the last budget was deleted: its alert goes with it
    if (baseline) markAlertBaselineDone_('budgets');
    return { checked: 0, alertsSent: 0 };
  }

  var categoryById = rowsById_(getAllRows('Categories'));
  var ctx = buildBudgetContext_({ skipPractice: true });   // a practice's own expense never sets off an alert (Practice.gs)
  var alertedSet = {};
  getAllRows('Budget Alert Log').forEach(function (a) {
    alertedSet[a.budget_id + '|' + a.period + '|' + a.threshold] = true;
  });

  var alertsSent = 0;
  var staleKeys = {};
  var nowByBudget = {};   // what each budget's open alert should say (syncBudgetNotices_)
  budgets.forEach(function (budget) {
    nowByBudget[budget.id] = { unknown: true };
    if (isPracticeBudget_(budget)) return; // the first-use practice's own budget (any amount typed): never alerts, it is deleted minutes later
    var progress = computeBudgetProgressWithContext_(budget, ctx);
    if (!progress.exists) return; // not running this period (ended, or starts later)
    if (progress.percent == null) return; // no exchange rate on file yet for this budget's currency

    var thresholds = String(budget.thresholds || DEFAULT_BUDGET_THRESHOLDS)
      .split(',')
      .map(function (t) { return Number(String(t).trim()); })
      .filter(function (t) { return !isNaN(t); })
      .sort(function (a, b) { return a - b; });
    nowByBudget[budget.id] = {
      periodKey: progress.periodKey,
      over: thresholds.length > 0 && progress.percent >= thresholds[0],
      text: budgetAlertText_(budget, resolveBudgetDisplayName_(budget, resolveBudgetCategoryDisplay_(parseBudgetCategoryIds_(budget.category_id), categoryById).name), progress)
    };

    // Spend fell back below a threshold already alerted this period (an
    // expense was discarded/deleted/edited down) -> forget that alert, so
    // crossing it again warns again.
    thresholds.forEach(function (threshold) {
      if (progress.percent < threshold) {
        var staleKey = budget.id + '|' + progress.periodKey + '|' + threshold;
        if (alertedSet[staleKey]) { staleKeys[staleKey] = true; delete alertedSet[staleKey]; }
      }
    });

    var newlyCrossed = thresholds.filter(function (threshold) {
      if (progress.percent < threshold) return false;
      return !alertedSet[budget.id + '|' + progress.periodKey + '|' + threshold];
    });
    if (!newlyCrossed.length) return;

    var display = resolveBudgetCategoryDisplay_(parseBudgetCategoryIds_(budget.category_id), categoryById);
    var highestThreshold = newlyCrossed[newlyCrossed.length - 1];
    // In-app notice always, plus Telegram when linked (Notices.gs). One open notice per budget and period: a later threshold updates it.
    var sent = baseline ? true : deliverNotice_('budget', 'budget|' + budget.id + '|' + progress.periodKey,
      budgetAlertText_(budget, resolveBudgetDisplayName_(budget, display.name), progress));
    if (!sent) return; // a linked Telegram refused — don't mark any as alerted, try again next cycle

    newlyCrossed.forEach(function (threshold) {
      var key = budget.id + '|' + progress.periodKey + '|' + threshold;
      appendRowObject('Budget Alert Log', {
        id: Utilities.getUuid(),
        budget_id: budget.id,
        threshold: threshold,
        period: progress.periodKey,
        sent_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
      });
      alertedSet[key] = true;
    });
    if (!baseline) alertsSent++;
  });

  if (Object.keys(staleKeys).length) {
    deleteRowsWhere_('Budget Alert Log', function (r) {
      return staleKeys[r.budget_id + '|' + r.period + '|' + r.threshold] === true;
    });
  }
  syncBudgetNotices_(nowByBudget);
  if (baseline) markAlertBaselineDone_('budgets');
  return { checked: budgets.length, alertsSent: alertsSent };
}

// Spending under the lowest alert level (the expense deleted or edited down, the budget raised), or the budget deleted: the alert goes, as if it
// had never been crossed. Still over: it shows today's figures. A notice of an earlier period, or a budget that cannot be worked out now, stays.
function syncBudgetNotices_(nowByBudget) {
  syncOpenNotices_('budget', function (notice) {
    var parts = String(notice.key).split('|');   // budget|<id>|<period>
    var now = nowByBudget[parts[1]];
    if (!now) return CLOSE_NOTICE_;
    if (now.unknown || now.periodKey !== parts[2]) return '';
    return now.over ? now.text : CLOSE_NOTICE_;
  });
}

// One-off convenience: seed monthly budgets for the owner's biggest expense
// categories, valued at what they actually spend on average. Not exposed in
// the app UI — same pattern as the other one-time admin scripts in this
// project (mergeDuplicatePaymentMethods, addCreatedAtColumnToEntries).
// Window is the last N *complete* calendar months, excluding the current
// one in progress — a partial month would understate the average and skew
// which categories rank highest.
function computeCategoryMonthlyAverages_(startDate, endDate, monthCount) {
  var entries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.type === 'expense' && e.date >= startDate && e.date <= endDate;
  });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  // These averages suggest MONTHLY budgets, which don't count Annual-tagged expenses.
  var annualEntryIds = annualEntryIdSet_();
  var totals = {};
  entries.forEach(function (e) {
    if (annualEntryIds[e.id]) return;
    var rate = getRateForEntryCurrency_(e.currency, e.date);
    if (rate == null) return;
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    var key = e.category_id || '';
    totals[key] = (totals[key] || 0) + ownAmount * rate;
  });

  var averages = {};
  Object.keys(totals).forEach(function (catId) {
    averages[catId] = totals[catId] / monthCount;
  });
  return averages;
}

function generateTopCategoryBudgets(payload) {
  var topN = (payload && payload.topN) || 10;
  var monthCount = (payload && payload.monthCount) || 12;

  var today = new Date();
  var endMonthDate = new Date(today.getFullYear(), today.getMonth(), 0); // last day of the previous month
  var startMonthDate = new Date(endMonthDate.getFullYear(), endMonthDate.getMonth() - (monthCount - 1), 1);

  var startDate = startMonthDate.getFullYear() + '-' + pad2_(startMonthDate.getMonth() + 1) + '-01';
  var endLastDay = new Date(endMonthDate.getFullYear(), endMonthDate.getMonth() + 1, 0).getDate();
  var endDate = endMonthDate.getFullYear() + '-' + pad2_(endMonthDate.getMonth() + 1) + '-' + pad2_(endLastDay);

  var averages = computeCategoryMonthlyAverages_(startDate, endDate, monthCount);
  var categoryById = rowsById_(getAllRows('Categories'));

  var ranked = Object.keys(averages)
    .filter(function (catId) { return catId && categoryById[catId] && categoryById[catId].type === 'expense'; })
    .map(function (catId) { return { category_id: catId, avg: averages[catId] }; })
    .sort(function (a, b) { return b.avg - a.avg; })
    .slice(0, topN);

  var created = ranked.map(function (r) {
    var budget = addBudget({
      category_id: r.category_id,
      amount: Math.round(r.avg * 100) / 100,
      currency: homeCurrency_(),
      period_type: 'monthly',
      thresholds: DEFAULT_BUDGET_THRESHOLDS
    });
    return {
      id: budget.id,
      category_id: r.category_id,
      category_name: categoryLabel_(categoryById[r.category_id]),
      amount: budget.amount
    };
  });

  return { startDate: startDate, endDate: endDate, monthCount: monthCount, created: created };
}


// ---- Budget history: a budget changes forward only (owner, 2026-11-07) ----
// A change of amount, currency or categories counts from the CURRENT period on (this month for a monthly budget, this year for a
// yearly one); every earlier period keeps what the budget was then. A new budget starts in the period it is made (or a start the
// person picked: an earlier period, the next one, or "always"); ending a budget stops it from this period on and earlier periods
// keep it. The Budgets row always holds today's values. The tab "Budget History" holds one row per change: from_period ('' = from
// the very start, else 'YYYY-MM' / 'YYYY'), and the budget's amount, currency and categories from that period on, or ended = yes.
// A budget with no rows has always existed as it is today (budgets made before this update, until their first change).
// The tab is made on the first write, so a copy made earlier needs nothing. Changing monthly ↔ yearly starts the budget again from
// this period (the old periods were of another length).

function ensureBudgetHistorySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Budget History')) return;
  var sheet = ss.insertSheet('Budget History');
  var headers = TABLE_DEFINITIONS['Budget History'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // "2026-11" / "2026" would be turned into a date or a number by Sheets (same as Projection Overrides' period_key).
  DATE_LIKE_COLUMNS['Budget History'].forEach(function (name) {
    var col = headers.indexOf(name) + 1;
    if (col > 0) sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

function budgetHistorySheetExists_() {
  return !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Budget History');
}

// { budgetId: [rows sorted by from_period] } — read once per request with the rest of the budget context.
function budgetHistory_() {
  var out = {};
  if (!budgetHistorySheetExists_()) return out;
  getAllRows('Budget History').forEach(function (r) {
    var id = String(r.budget_id);
    (out[id] = out[id] || []).push({
      from: String(r.from_period || ''), amount: Number(r.amount), currency: r.currency || homeCurrency_(),
      category_id: String(r.category_id || ''), ended: r.ended === true || String(r.ended).toLowerCase() === 'yes' || String(r.ended).toLowerCase() === 'true'
    });
  });
  Object.keys(out).forEach(function (id) { out[id].sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; }); });
  return out;
}

// This period's key for a budget of this kind, today; `step` moves it (-1 the period before, +1 the next).
function budgetCurrentPeriodKey_(periodType, step) {
  var tz = Session.getScriptTimeZone();
  var now = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
  var y = Number(now.substring(0, 4)), m = Number(now.substring(5, 7));
  if (periodType === 'yearly') return String(y + (step || 0));
  if (periodType === 'weekly') return isoAddDays_(mondayOf_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd')), 7 * (step || 0));
  var d = new Date(y, m - 1 + (step || 0), 1);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
}

// payload.start: undefined / 'current' = this period; 'next'; 'always' = every period before too; or a key of the budget's kind.
function budgetStartKey_(periodType, start) {
  if (start === 'always') return '';
  if (start === 'next') return budgetCurrentPeriodKey_(periodType, 1);
  if (periodType === 'weekly' && start && /^\d{4}-\d{2}-\d{2}$/.test(String(start))) return mondayOf_(String(start));
  var ok = periodType === 'yearly' ? /^\d{4}$/ : /^\d{4}-\d{2}$/;
  if (periodType !== 'weekly' && start && ok.test(String(start))) return String(start);
  return budgetCurrentPeriodKey_(periodType, 0);
}

// What the budget was in one of its own periods: { exists, amount, currency, category_id }.
// The latest row stands for the Budgets row itself (today's values), so a hand edit of the Budgets tab still counts.
function budgetStateAt_(budget, rows, key) {
  var own = { exists: true, amount: Number(budget.amount), currency: budget.currency || homeCurrency_(), category_id: String(budget.category_id || '') };
  if (!rows || !rows.length) return own;
  var hit = null;
  rows.forEach(function (r) { if (r.from <= key) hit = r; });
  if (!hit || hit.ended) return { exists: false };
  if (hit === rows[rows.length - 1]) return own;
  return { exists: true, amount: hit.amount, currency: hit.currency, category_id: hit.category_id || own.category_id };
}

// Ended: not running now and nothing planned later (a budget that starts next month is not ended).
function budgetEndedNow_(budget, rows) {
  if (!rows || !rows.length) return false;
  var key = budgetCurrentPeriodKey_(budgetKind_(budget.period_type), 0);
  if (budgetStateAt_(budget, rows, key).exists) return false;
  return !rows.some(function (r) { return r.from > key && !r.ended; });
}

// Did the budget run in some period before this one (so ending it leaves something to show)?
function budgetRanBefore_(budget, rows) {
  var key = budgetCurrentPeriodKey_(budgetKind_(budget.period_type), 0);
  return !rows || !rows.length || rows.some(function (r) { return r.from < key && !r.ended; });
}

function budgetActiveNow_(budget, ctx) {
  var rows = ctx && ctx.budgetHistory ? ctx.budgetHistory[String(budget.id)] : budgetHistory_()[String(budget.id)];
  return budgetStateAt_(budget, rows, budgetCurrentPeriodKey_(budgetKind_(budget.period_type), 0)).exists;
}

// What the budget is measured with in the period shown. key: a monthly budget's month or a yearly budget's year.
// yearOfMonthly: a monthly budget shown across a whole year ('YYYY') — only the months it existed in count: their own amounts
// added up (a month in another currency turned into the last month's through the main currency) and only those months' expenses,
// each month with the categories it had then.
// { exists, amount, currency, categoryIds (the last state's), categoryRaw, match (ids or a function of the entry), changed, monthsCounted }
function budgetPlan_(budget, ctx, yearOfMonthly, key) {
  var rows = (ctx && ctx.budgetHistory && ctx.budgetHistory[String(budget.id)]) || null;
  var todayCats = String(budget.category_id || '');
  if (!yearOfMonthly) {
    var st = budgetStateAt_(budget, rows, key);
    if (!st.exists) return { exists: false };
    var ids = parseBudgetCategoryIds_(st.category_id);
    return { exists: true, amount: st.amount, currency: st.currency, categoryIds: ids, categoryRaw: st.category_id, match: ids,
      changed: st.amount !== Number(budget.amount) || st.currency !== (budget.currency || homeCurrency_()) || st.category_id !== todayCats, monthsCounted: null };
  }
  var states = {}, months = [], last = null;
  for (var m = 1; m <= 12; m++) {
    var k = yearOfMonthly + '-' + pad2_(m);
    var s = budgetStateAt_(budget, rows, k);
    if (!s.exists) continue;
    s.ids = parseBudgetCategoryIds_(s.category_id);
    states[k] = s; months.push(k); last = s;
  }
  if (!last) return { exists: false };
  var total = 0, sameCats = true;
  months.forEach(function (k) {
    var at = states[k], amt = at.amount;
    if (at.currency !== last.currency) {
      var from = latestRateAtOrBefore_(ctx, at.currency, k), to = latestRateAtOrBefore_(ctx, last.currency, k);
      amt = (from != null && to) ? at.amount * from / to : last.amount;   // no rate on file: that month counts at the last month's amount
    }
    total += amt;
    if (at.category_id !== last.category_id) sameCats = false;
  });
  total = Math.round(total * 100) / 100;
  var match = (months.length === 12 && sameCats) ? last.ids : function (e) {
    var at = states[String(e.date).substring(0, 7)];
    return !!at && categoryIdMatches_(at.ids, e.category_id);
  };
  return { exists: true, amount: total, currency: last.currency, categoryIds: last.ids, categoryRaw: last.category_id, match: match,
    firstMonth: months[0], lastMonth: months[months.length - 1],
    changed: Math.abs(total - Number(budget.amount) * 12) > 0.005 || last.currency !== (budget.currency || homeCurrency_()) || last.category_id !== todayCats,
    monthsCounted: months.length };
}

function writeBudgetHistoryRow_(budget, fromKey, values, ended) {
  ensureBudgetHistorySheet_();
  var id = String(budget.id);
  deleteRowsWhere_('Budget History', function (r) { return String(r.budget_id) === id && String(r.from_period) === fromKey; });
  appendRowObject('Budget History', { id: Utilities.getUuid(), budget_id: id, from_period: fromKey,
    amount: ended ? '' : Number(values.amount), currency: ended ? '' : (values.currency || homeCurrency_()),
    category_id: ended ? '' : String(values.category_id || ''), ended: ended ? 'yes' : '', changed_at: new Date().toISOString() });
}

function budgetRows_(budgetId) {
  return budgetHistory_()[String(budgetId)] || [];
}

// Called by updateBudget BEFORE the row changes. The new values count from this period on; a budget with no rows first gets
// its old values written as "always" so earlier periods keep them. A budget that has not started yet takes the new values on
// its planned start. A budget that has ended keeps its rows (it is started again with restart).
function recordBudgetChange_(current, payload) {
  if (!current) return;
  var oldType = budgetKind_(current.period_type);
  var newType = payload.period_type !== undefined ? budgetKind_(payload.period_type) : oldType;
  var after = {
    amount: payload.amount !== undefined ? Number(payload.amount) : Number(current.amount),
    currency: payload.currency !== undefined && payload.currency ? payload.currency : (current.currency || homeCurrency_()),
    category_id: payload.category_id !== undefined ? String(payload.category_id) : String(current.category_id || '')
  };
  var rows = budgetRows_(current.id);
  if (newType !== oldType) {
    // Another length of period: the budget starts again from this period, in its new kind (the old periods meant something else).
    if (budgetHistorySheetExists_()) deleteRowsWhere_('Budget History', function (r) { return String(r.budget_id) === String(current.id); });
    writeBudgetHistoryRow_(current, budgetCurrentPeriodKey_(newType, 0), after, false);
    return;
  }
  var before = { amount: Number(current.amount), currency: current.currency || homeCurrency_(), category_id: String(current.category_id || '') };
  if (Math.abs(after.amount - before.amount) < 0.005 && after.currency === before.currency && after.category_id === before.category_id) return;
  var key = budgetCurrentPeriodKey_(oldType, 0);
  if (!budgetStateAt_(current, rows, key).exists) {
    var planned = rows.filter(function (r) { return r.from > key && !r.ended; });
    if (planned.length) writeBudgetHistoryRow_(current, planned[0].from, after, false);   // not started yet: its start takes the change
    return;   // ended: nothing runs now (restart starts it again)
  }
  if (!rows.length) writeBudgetHistoryRow_(current, '', before, false);
  writeBudgetHistoryRow_(current, key, after, false);
}

// End a budget (owner, 2026-11-07): it stops from this period on; earlier periods keep it. A budget that never ran before this
// period (made this month, or starting later) has nothing to keep and is deleted completely.
function endBudget(payload) {
  var id = String(payload && payload.id || '');
  var b = getAllRows('Budgets').find(function (x) { return String(x.id) === id; });
  if (!b) return { done: true, missing: true };
  var type = budgetKind_(b.period_type);
  var key = budgetCurrentPeriodKey_(type, 0);
  var rows = budgetRows_(id);
  if (!budgetRanBefore_(b, rows)) { deleteBudget(id); return { done: true, deleted: true }; }
  if (!rows.length) writeBudgetHistoryRow_(b, '', b, false);
  deleteRowsWhere_('Budget History', function (r) { return String(r.budget_id) === id && String(r.from_period) > key; });   // a planned change after now
  writeBudgetHistoryRow_(b, key, null, true);
  deleteRowsWhere_('Budget Alert Log', function (r) { return String(r.budget_id) === id; });
  return { done: true, ended: key };
}

function endBudgets(payload) {
  var ids = (payload && payload.ids) || [];
  var ended = [], deleted = [], missing = [];
  ids.forEach(function (id) {
    var r = endBudget({ id: id });
    (r.missing ? missing : r.deleted ? deleted : ended).push(String(id));
  });
  return { ended: ended, deleted: deleted, missing: missing };
}

// Start an ended budget again from this period, with the values in the form (payload as updateBudget's, restart: true).
function restartBudget_(current, payload) {
  if (!current) return;
  var type = payload.period_type !== undefined ? budgetKind_(payload.period_type) : budgetKind_(current.period_type);
  if (type !== budgetKind_(current.period_type) && budgetHistorySheetExists_()) {
    deleteRowsWhere_('Budget History', function (r) { return String(r.budget_id) === String(current.id); });
  }
  writeBudgetHistoryRow_(current, budgetCurrentPeriodKey_(type, 0), {
    amount: payload.amount !== undefined ? payload.amount : current.amount,
    currency: payload.currency || current.currency || homeCurrency_(),
    category_id: payload.category_id !== undefined ? payload.category_id : current.category_id
  }, false);
}

// What the budget is measured with over a date range (the period shown or the chart's): its own period (one month, one year, one
// week), a monthly budget across a year, or a weekly budget across a month or a year.
function budgetPlanForRange_(budget, ctx, startDate, endDate) {
  var kind = budgetKind_(budget.period_type);
  if (kind === 'yearly') return budgetPlan_(budget, ctx, null, startDate.substring(0, 4));
  if (kind === 'monthly') {
    return startDate.substring(0, 7) === endDate.substring(0, 7)
      ? budgetPlan_(budget, ctx, null, startDate.substring(0, 7))
      : budgetPlan_(budget, ctx, endDate.substring(0, 4), null);
  }
  if (mondayOf_(startDate) === startDate && isoAddDays_(startDate, 6) === endDate) return budgetPlan_(budget, ctx, null, startDate);
  return weeklyBudgetAcross_(budget, ctx, startDate, endDate);
}

// A weekly budget across a longer period: every week that overlaps it, each with the amount, currency and categories it had that
// week, a week cut by the period's edge counted by its days (4 days of a week = 4/7 of its amount). Amounts in another currency are
// turned into the last week's through the main currency.
function weeklyBudgetAcross_(budget, ctx, startDate, endDate) {
  var rows = (ctx && ctx.budgetHistory && ctx.budgetHistory[String(budget.id)]) || null;
  var weeks = [], states = {}, last = null, overlapping = 0;
  for (var mon = mondayOf_(startDate); mon <= endDate; mon = isoAddDays_(mon, 7)) {
    overlapping++;
    var st = budgetStateAt_(budget, rows, mon);
    if (!st.exists) continue;
    var from = mon < startDate ? startDate : mon, sun = isoAddDays_(mon, 6), to = sun > endDate ? endDate : sun;
    st.ids = parseBudgetCategoryIds_(st.category_id);
    st.share = isoDayCount_(from, to) / 7;
    states[mon] = st; weeks.push(mon); last = st;
  }
  if (!last) return { exists: false };
  var total = 0, counted = 0, sameCats = true;
  weeks.forEach(function (mon) {
    var at = states[mon], amt = at.amount;
    if (at.currency !== last.currency) {
      var k = mon.substring(0, 7);
      var fr = latestRateAtOrBefore_(ctx, at.currency, k), to = latestRateAtOrBefore_(ctx, last.currency, k);
      amt = (fr != null && to) ? at.amount * fr / to : last.amount;
    }
    total += amt * at.share;
    counted += at.share;
    if (at.category_id !== last.category_id) sameCats = false;
  });
  total = Math.round(total * 100) / 100;
  var weekOf = {};
  var match = (weeks.length === overlapping && sameCats) ? last.ids : function (e) {
    var d = String(e.date);
    var at = states[weekOf[d] || (weekOf[d] = mondayOf_(d))];
    return !!at && categoryIdMatches_(at.ids, e.category_id);
  };
  return { exists: true, amount: total, currency: last.currency, categoryIds: last.ids, categoryRaw: last.category_id, match: match,
    firstMonth: (weeks[0] < startDate ? startDate : weeks[0]).substring(0, 7), lastMonth: (isoAddDays_(weeks[weeks.length - 1], 6) > endDate ? endDate : isoAddDays_(weeks[weeks.length - 1], 6)).substring(0, 7),
    changed: last.category_id !== String(budget.category_id || '') || last.currency !== (budget.currency || homeCurrency_()),
    weeksCounted: Math.round(counted * 10) / 10 };
}
