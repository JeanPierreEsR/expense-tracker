/**
 * The welcome questions a new person answers once, on the first open of an app the installer made
 * (friends & family rollout, stage 4b). The app asks for: language, the order they type numeric dates in,
 * and the other currencies they use. Everything lands in the Settings table:
 *
 *   language            'en' | 'es'          (same row the language picker writes)
 *   date_format         'dmy' | 'mdy' | 'ymd' (read by Telegram.gs userDateOrder_ for typed dates)
 *   favorite_currencies 'PEN,USD,EUR'        (the app's quick currency chips, in order; soles always first)
 *   onboarded           'yes'                (stops the app from asking again; see getCapabilities_)
 * default_currency    'PEN' | 'USD' | …    the MAIN (home) currency, first chosen here; changeable later (HomeCurrency.gs)
 *   rate_base           same code            the BASE currency exchange rates are stored against: the first main currency, never changes
 */

function saveOnboarding(payload) {
  payload = payload || {};
  var result = {};
  // Here the main currency is only taken from the FIRST answer; changing it later is changeMainCurrency (More → Main currency).
  var firstAnswer = String(getSettingsMap().onboarded || '') !== 'yes';

  var lang = normalizeLang_(payload.language);
  if (lang) { setSetting_('language', lang); result.language = lang; }

  var order = String(payload.dateOrder || '').toLowerCase();
  if (order === 'dmy' || order === 'mdy' || order === 'ymd') { setSetting_('date_format', order); result.dateOrder = order; }

  var home = homeCurrency_();
  var wantedHome = String(payload.homeCurrency || '').toUpperCase();
  if (firstAnswer && /^[A-Z]{3}$/.test(wantedHome)) { setSetting_('default_currency', wantedHome); home = wantedHome; }
  // Exchange rates are stored against a fixed BASE currency (HomeCurrency.gs): the first main currency ever chosen.
  // The main currency can be changed later (changeMainCurrency); the base never changes.
  if (firstAnswer && !String(getSettingsMap().rate_base || '').trim()) setSetting_('rate_base', home);
  result.homeCurrency = home;

  // Quick currency buttons: the main currency first, then the others they use (max 5 in all).
  var list = [home];
  (Array.isArray(payload.currencies) ? payload.currencies : []).forEach(function (c) {
    var code = String(c || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && list.indexOf(code) === -1 && list.length < 5) list.push(code);
  });
  setSetting_('favorite_currencies', list.join(','));
  result.currencies = list;

  setSetting_('onboarded', 'yes');
  return result;
}
