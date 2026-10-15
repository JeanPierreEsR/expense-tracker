/**
 * The welcome questions a new person answers once, on the first open of an app the installer made
 * (friends & family rollout, stage 4b). The app asks for: language, the order they type numeric dates in,
 * and the other currencies they use. Everything lands in the Settings table:
 *
 *   language            'en' | 'es'          (same row the language picker writes)
 *   date_format         'dmy' | 'mdy' | 'ymd' (read by Telegram.gs userDateOrder_ for typed dates)
 *   favorite_currencies 'PEN,USD,EUR'        (the app's quick currency chips, in order; soles always first)
 *   onboarded           'yes'                (stops the app from asking again; see getCapabilities_)
 *
 * Soles (PEN) stay the home currency for every copy: all conversions and reports are built on it.
 */

function saveOnboarding(payload) {
  payload = payload || {};
  var result = {};

  var lang = normalizeLang_(payload.language);
  if (lang) { setSetting_('language', lang); result.language = lang; }

  var order = String(payload.dateOrder || '').toLowerCase();
  if (order === 'dmy' || order === 'mdy' || order === 'ymd') { setSetting_('date_format', order); result.dateOrder = order; }

  var list = ['PEN'];
  (Array.isArray(payload.currencies) ? payload.currencies : []).forEach(function (c) {
    var code = String(c || '').toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && list.indexOf(code) === -1 && list.length < 5) list.push(code);
  });
  setSetting_('favorite_currencies', list.join(','));
  result.currencies = list;

  setSetting_('onboarded', 'yes');
  return result;
}
