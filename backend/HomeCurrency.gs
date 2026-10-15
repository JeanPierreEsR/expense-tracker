/**
 * The person's main ("home") currency. It is the currency every total, budget, report and exchange rate is
 * expressed in: a rate means "1 unit of <currency> = <rate> of the home currency". It is the Settings row
 * `default_currency` (always seeded 'PEN'), so the owner's copy and every old install stay on soles with no change.
 *
 * A copy made by the installer asks once, in the app's welcome questions (Onboarding.gs), and then it is LOCKED:
 * changing it later would silently change what every stored rate and total means.
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
