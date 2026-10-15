/**
 * The person's main ("home") currency. It is the currency every total, budget, report and exchange rate is
 * expressed in: a rate means "1 unit of <currency> = <rate> of the home currency". It is the Settings row
 * `default_currency` (always seeded 'PEN'), so the owner's copy and every old install stay on soles with no change.
 *
 * A copy made by the installer asks once, in the app's welcome questions (Onboarding.gs). It can be changed at ANY
 * time (More → Main currency, `changeMainCurrency`) and switching back restores exactly what the person had,
 * because exchange rates are NOT stored relative to the main currency but to a fixed BASE currency:
 *
 *   Settings `rate_base` (soles for the owner and old installs; for an installer copy, the first main currency
 *   ever chosen) — a row of the Exchange Rates table means "1 unit of <currency> = <rate> of the BASE currency".
 *   The base never has a row of its own (its rate is 1). The main currency is only the LENS the app looks
 *   through: an amount of currency X shown in the main currency M is   amount × rate(X) / rate(M).
 *
 * So switching main rewrites no stored rate or entry. The screens still speak "1 X = r <main>": the rate list,
 * the rate prompt and `setExchangeRate` translate to and from base terms (Api.gs).
 *
 * Names such as `amount_pen`, `ownAmountPen`, `toPen_` and `balance_pen` are historical: they now hold the amount
 * in the HOME currency. Foreign-currency amounts are still stored in their own currency (principle 5).
 */

var HOME_CURRENCY_MEMO_ = null;   // per request; doPost clears it, setSetting_ clears it on a change

function homeCurrency_() {
  if (HOME_CURRENCY_MEMO_) return HOME_CURRENCY_MEMO_;
  var code = 'PEN';
  try {
    var raw = String(getSettingsMap().default_currency || '').trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(raw)) code = raw;
  } catch (err) { /* sheet unreadable: soles, as before */ }
  HOME_CURRENCY_MEMO_ = code;
  return code;
}

var RATE_BASE_MEMO_ = null;   // per request; doPost clears it, setSetting_ clears it on a change

function rateBase_() {
  if (RATE_BASE_MEMO_) return RATE_BASE_MEMO_;
  var code = 'PEN';
  try {
    var raw = String(getSettingsMap().rate_base || '').trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(raw)) code = raw;
  } catch (err) { /* sheet unreadable: soles, as before */ }
  RATE_BASE_MEMO_ = code;
  return code;
}

// ratesByCurrency: { CUR: [{month, rate}, …] sorted by month }, every rate in BASE terms (see above).
// `currency`'s rate in base terms at `month` (latest on or before). The base itself is 1; unknown is null.
function baseRateAt_(ratesByCurrency, currency, month) {
  if (currency === rateBase_()) return 1;
  return latestRateFromList_(ratesByCurrency[currency], month);
}

// The MAIN currency's own rate in base terms at `month`. When the main currency has no rate that early, its
// EARLIEST rate stands in (an estimate, so older months still convert; refine under Exchange rates).
function mainBaseRateAt_(ratesByCurrency, month) {
  var main = homeCurrency_();
  if (main === rateBase_()) return 1;
  var list = ratesByCurrency[main];
  if (!list || !list.length) return null;
  var r = latestRateFromList_(list, month);
  return r != null ? r : list[0].rate;
}

// THE conversion factor every total, budget, report and projection uses: 1 unit of `currency` = ? of the main
// currency, around `month`. Null when a needed rate is not on file (callers treat it as "no rate yet").
function rateToMain_(ratesByCurrency, currency, month) {
  if (currency === homeCurrency_()) return 1;
  var x = baseRateAt_(ratesByCurrency, currency, month);
  if (x == null) return null;
  var m = mainBaseRateAt_(ratesByCurrency, month);
  if (m == null || !(m > 0)) return null;
  return x / m;
}

function currentMonthKey_() { return nowTimestamp_().substring(0, 7); }

// What the person is told before switching: does the new main currency already have a rate on file (so nothing
// has to be asked), and from which month its first rate starts (earlier months use that first rate, as an estimate).
function previewMainCurrencyChange(payload) {
  var next = String((payload && payload.currency) || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(next)) throw new Error(tr_('err.currencyCode'));
  var current = homeCurrency_();
  var res = { current: current, next: next, base: rateBase_(), same: next === current, needsRate: false, estimatedBefore: null };
  if (res.same || next === res.base) return res;
  var list = buildRatesByCurrency_()[next];
  if (!list || !list.length) res.needsRate = true; else res.estimatedBefore = list[0].month;
  return res;
}

// Switches the main currency. If the new one has no rate yet, `payload.rate` = "1 <current main> = rate <new main>"
// (today's) is needed and is stored as the new main currency's first rate. Nothing else is rewritten.
function changeMainCurrency(payload) {
  var pre = previewMainCurrencyChange(payload);
  if (pre.same) return { main: pre.next, previous: pre.current, changed: false };
  if (pre.needsRate) {
    var rate = Number(payload.rate);
    if (!isFinite(rate) || rate <= 0) {
      var err = new Error(tr_('err.rateNeeded', { old: pre.current, next: pre.next }));
      err.code = 'rate_needed';
      throw err;
    }
    var month = currentMonthKey_();
    var currentInBase = mainBaseRateAt_(buildRatesByCurrency_(), month);   // still the OLD main here
    if (currentInBase == null) throw new Error(tr_('err.rateMainFirst'));
    upsertBaseRate_(pre.next, month, currentInBase / rate);   // 1 old = rate new  =>  1 new = old/rate (base)
  }
  setSetting_('default_currency', pre.next);
  // The quick currency buttons lead with the new main currency.
  var favs = String(getSettingsMap().favorite_currencies || '').split(',').filter(function (c) { return /^[A-Z]{3}$/.test(c) && c !== pre.next; });
  setSetting_('favorite_currencies', [pre.next].concat(favs).slice(0, 5).join(','));
  RATES_MEMO_ = null;
  return { main: pre.next, previous: pre.current, changed: true, estimatedBefore: pre.estimatedBefore };
}
