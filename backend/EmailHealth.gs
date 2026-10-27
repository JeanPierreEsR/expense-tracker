/**
 * Is the bank e-mail scan working? (specs/review-telegram-email.md § E-mail health)
 *
 * Two problems found on the first friends' copies: a scan that failed on every e-mail told nobody (the only warning went to Telegram, which
 * a friend does not have), and the scan only looked back 3 days, so e-mails that arrived during an outage were lost for good once it ended.
 *
 * A "good" scan is one that finished with no e-mail erroring. Each scan (timer or app-opened, all through scanEmailsGuarded_) leaves a
 * small record in the Script Property EMAIL_HEALTH (not in the Sheet: it changes every few minutes and must not bump the sheet caches):
 *
 *   lastOk       when the last good scan finished (epoch ms)
 *   lastAttempt  when the last scan finished, good or not
 *   fails        scans in a row that were not good (0 after a good one)
 *   error        why the last bad one failed: 'quota' | 'auth' | 'time' | 'read_errors' | 'other' (never the raw message: it is shown to people)
 *   errors       how many e-mails errored in that scan
 *
 * The search window follows the last good scan instead of being a fixed 3 days: days since it, plus one, never under 3 and never over 30.
 * Safe because every e-mail already read is remembered (Processed Emails, external_id), so a wide window only costs the listing.
 * The record also goes to the app (getEmailInfo_().health, and the checkEmailsNow answer) so it can say "last checked 12 min ago" or
 * warn. The thresholds live here, in one place; the app only shows what it is told.
 */

var EMAIL_HEALTH_KEY_ = 'EMAIL_HEALTH';
var EMAIL_LOOKBACK_MIN_DAYS_ = 3;
var EMAIL_LOOKBACK_MAX_DAYS_ = 30;
var EMAIL_STALE_MS_ = 6 * 3600 * 1000;   // no good scan for this long while e-mail reading is on: tell the person
var EMAIL_FAILS_BEFORE_WARNING_ = 2;     // one failed scan can be a hiccup; two in a row is a problem

function emailHealthRead_() {
  try {
    var h = JSON.parse(PropertiesService.getScriptProperties().getProperty(EMAIL_HEALTH_KEY_) || '{}');
    return (h && typeof h === 'object') ? h : {};
  } catch (err) { return {}; }
}

function emailHealthWrite_(h) {
  try { PropertiesService.getScriptProperties().setProperty(EMAIL_HEALTH_KEY_, JSON.stringify(h)); }
  catch (err) { console.error('email health: ' + err); }   // keeping the record must never break a scan
}

// A scan finished. `results` is processEmails' answer; any e-mail that errored makes it "not good" (those e-mails are retried).
function recordEmailScanDone_(results) {
  var h = emailHealthRead_();
  var now = Date.now();
  var errors = Number(results && results.errors) || 0;
  h.lastAttempt = now;
  if (errors === 0) {
    h.lastOk = now;
    h.fails = 0;
    h.error = '';
    h.errors = 0;
  } else {
    h.fails = (Number(h.fails) || 0) + 1;
    h.error = 'read_errors';
    h.errors = errors;
  }
  emailHealthWrite_(h);
}

// A scan stopped with an exception (Gmail refused, a daily limit, the run was cut off at 6 minutes).
function recordEmailScanFailed_(err) {
  var h = emailHealthRead_();
  h.lastAttempt = Date.now();
  h.fails = (Number(h.fails) || 0) + 1;
  h.error = emailErrorKind_(err);
  h.errors = 0;
  emailHealthWrite_(h);
}

// Only a kind, never the message: Google's wording can carry an address, and the person sees what we show.
function emailErrorKind_(err) {
  if (err === 'time') return 'time';
  var text = String(err && err.message ? err.message : err || '');
  if (/too many times|quota|rate limit|limit exceeded|userRateLimit|daily/i.test(text)) return 'quota';
  if (/authori[sz]|permission|scope|unauthenticated|unauthorized|forbidden|access not configured|insufficient/i.test(text)) return 'auth';
  if (/timed? ?out|time limit|maximum execution/i.test(text)) return 'time';
  return 'other';
}

// How many days back the normal scan searches (see the header). No record yet → the usual 3.
function emailLookbackDays_() {
  var last = Number(emailHealthRead_().lastOk) || 0;
  if (!last) return EMAIL_LOOKBACK_MIN_DAYS_;
  var days = Math.ceil((Date.now() - last) / 86400000) + 1;
  return Math.max(EMAIL_LOOKBACK_MIN_DAYS_, Math.min(EMAIL_LOOKBACK_MAX_DAYS_, days));
}

/**
 * What the app is told. `problem` is the only thing that should make it warn:
 *   null        nothing to say (no scan recorded yet, or the last good scan is recent and nothing is failing)
 *   'stale'     no good scan for 6 hours or more, with nothing recorded as the cause
 *   <a kind>    scans are failing for that reason (see emailErrorKind_), two or more in a row
 * `now` (the server's clock, so "12 minutes ago" does not depend on the phone's) is only added when `withNow` is true, i.e. in the
 * checkEmailsNow answer. getMeta's copy leaves it out on purpose: a value that changes every millisecond would make two reads of the
 * same data differ (the app-open cache test), and the app falls back to its own clock when it is missing.
 */
function emailHealthForApp_(withNow) {
  var h = emailHealthRead_();
  var now = Date.now();
  var lastOk = Number(h.lastOk) || 0;
  var fails = Number(h.fails) || 0;
  var problem = null;
  if (fails >= EMAIL_FAILS_BEFORE_WARNING_) problem = String(h.error || 'other');
  else if (lastOk && now - lastOk >= EMAIL_STALE_MS_) problem = 'stale';
  var out = {
    lastOk: lastOk,
    lastAttempt: Number(h.lastAttempt) || 0,
    fails: fails,
    problem: problem,
    lookbackDays: emailLookbackDays_()
  };
  if (withNow) out.now = now;
  return out;
}
