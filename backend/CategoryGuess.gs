/**
 * Default-category guessing for auto-captured (email) expenses.
 *
 * Deliberately NOT AI and NOT a hand-kept merchant list: every email-sourced
 * Entry stores the bank's own merchant name in a `merchant` column (cleaned
 * up, never touched when the owner renames the entry's description), and a
 * new email's category is guessed from what the owner already decided for
 * that same merchant before. In order:
 *
 *   1. Merchant history — among confirmed/imported expense entries with the
 *      same `merchant`, if there are at least MERCHANT_MIN_ENTRIES of them
 *      and at least MERCHANT_MIN_SHARE of them share one category, use it.
 *   2. Programmed items — an active recurring/programmed expense with the
 *      same currency, an amount within RECURRING_MATCH_TOLERANCE, and an
 *      occurrence within RECURRING_MATCH_DAY_WINDOW days of the email's
 *      date; used only when every matching item agrees on one category.
 *   3. Otherwise blank — a wrong default is worse than none.
 *
 * The Category Keywords sheet is no longer consulted (owner's decision,
 * 2026-09-23). Spendee-imported entries have no `merchant`, so they never
 * feed step 1 — history builds from email-sourced entries only.
 */

var MERCHANT_MIN_ENTRIES = 2;
var MERCHANT_MIN_SHARE = 0.8;

// Entries pre-date this column, so it's appended in place the first time
// it's needed — same self-heal as recurring_expense_id.
function ensureEntriesMerchantColumn_() {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  if (headers.indexOf('merchant') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('merchant');
  }
}

/**
 * Lowercase, no accents, punctuation to spaces, and any token that's a bare
 * number or a long letters+digits code (a terminal/reference id the bank
 * glues on) dropped, plus a trailing "li pe" city/country — so
 * "RAPPI PERU*123456" and "Rappi Peru" normalize to the same "rappi peru".
 */
function normalizeMerchant_(raw) {
  if (!raw) return '';
  var s = String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  var tokens = s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(function (t) {
      return t && !/^\d+$/.test(t) && !(t.length >= 5 && /\d/.test(t));
    });
  // Card networks append the city/country ("... LI PE" = Lima, Peru).
  if (tokens.length > 1 && tokens[tokens.length - 1] === 'pe') tokens.pop();
  if (tokens.length > 1 && tokens[tokens.length - 1] === 'li') tokens.pop();
  return tokens.join(' ');
}

/**
 * Everything the guess needs, read once per processEmails run rather than
 * once per email. Only confirmed or imported expense entries that have a
 * merchant AND an expense-type category feed the history — a pending
 * entry's category is still just a guess, and letting guesses reinforce
 * themselves would make one early miss permanent.
 */
function buildGuessContext_() {
  var categories = getAllRows('Categories');
  var expenseCatIds = {};
  var transferCat = null;
  categories.forEach(function (c) {
    if (c.type === 'expense') expenseCatIds[c.id] = true;
    if (c.type === 'transfer' && !transferCat) transferCat = c;
  });

  var history = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'expense' || !e.merchant || !expenseCatIds[e.category_id]) return;
    if (e.status !== 'confirmed' && e.source !== 'import') return;
    var h = history[e.merchant] || (history[e.merchant] = { counts: {}, total: 0 });
    h.counts[e.category_id] = (h.counts[e.category_id] || 0) + 1;
    h.total++;
  });

  return {
    expenseCatIds: expenseCatIds,
    categoriesById: rowsById_(categories),
    transferCatId: transferCat ? transferCat.id : '',
    history: history,
    recurring: getRecurringExpenseRows_(),
    recurringSplitSums: getRecurringExpenseSplitSums_()
  };
}

function guessFromMerchantHistory_(merchant, ctx) {
  var h = ctx.history[merchant];
  if (!h || h.total < MERCHANT_MIN_ENTRIES) return null;
  var best = null;
  Object.keys(h.counts).forEach(function (catId) {
    if (!best || h.counts[catId] > h.counts[best]) best = catId;
  });
  if (h.counts[best] / h.total < MERCHANT_MIN_SHARE) return null;
  return {
    categoryId: best,
    reason: h.counts[best] + ' of ' + h.total + ' past "' + merchant + '" entries'
  };
}

function guessFromProgrammed_(fields, dateStr, ctx) {
  var d = new Date(dateStr + 'T00:00:00');
  var start = formatCalendarDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() - RECURRING_MATCH_DAY_WINDOW));
  var end = formatCalendarDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() + RECURRING_MATCH_DAY_WINDOW));

  var hits = ctx.recurring.filter(function (r) {
    if (!ctx.expenseCatIds[r.category_id]) return false;
    if ((r.currency || 'PEN') !== fields.currency) return false;
    var amt = recurringOwnAmount_(r, ctx.recurringSplitSums);
    if (!(amt > 0) || Math.abs(Number(fields.amount) - amt) > amt * RECURRING_MATCH_TOLERANCE) return false;
    return recurringExpenseOccurrencesInRange_(r, start, end).length > 0;
  });
  if (!hits.length) return null;

  var catIds = {};
  hits.forEach(function (r) { catIds[r.category_id] = true; });
  if (Object.keys(catIds).length !== 1) return null;
  return { categoryId: hits[0].category_id, reason: 'matches programmed "' + hits[0].description + '"' };
}

/**
 * Returns { categoryId, reason } — reason is '' when the category isn't a
 * guess (a transfer's one possible category) and categoryId is '' when
 * nothing was confident enough.
 */
function guessCategoryForEmail_(fields, dateStr, ctx) {
  if (fields.type === 'transfer') return { categoryId: ctx.transferCatId, reason: '' };
  if (fields.type !== 'expense') return { categoryId: '', reason: '' };

  var merchant = normalizeMerchant_(fields.merchant);
  var guess = (merchant && guessFromMerchantHistory_(merchant, ctx)) ||
    guessFromProgrammed_(fields, dateStr, ctx);
  return guess || { categoryId: '', reason: '' };
}

// ---- One-time backfill of `merchant` onto existing email-sourced entries ----

/**
 * Re-reads the owner's past bank emails, re-runs each rule's extractor to
 * get the merchant, and matches it to the existing Entry by the same
 * external_id fingerprint used to dedupe at capture time (the bank's own
 * operation number, or the sender+date+amount+description hash — which is
 * computed from the email's ORIGINAL description, so it still matches even
 * after the owner renamed the entry). Only fills entries whose merchant is
 * blank; safe to re-run, and stops itself before Apps Script's 6-minute
 * limit (`partial: true` — just run it again to continue).
 *
 * payload: { dryRun (default TRUE — pass false to write), days (default 1095) }
 */
function backfillEntryMerchants(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var days = (payload && Number(payload.days)) || 1095;
  var startedAt = Date.now();
  ensureEntriesMerchantColumn_();

  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var result = { dryRun: dryRun, messagesScanned: 0, matched: 0, alreadyHadMerchant: 0, partial: false, sample: [] };
  if (lastRow < 2) return result;

  var extCol = headers.indexOf('external_id');
  var merchCol = headers.indexOf('merchant');
  var extIds = sheet.getRange(2, extCol + 1, lastRow - 1, 1).getValues();
  var merchants = sheet.getRange(2, merchCol + 1, lastRow - 1, 1).getValues();
  var rowByExternalId = {};
  extIds.forEach(function (r, i) {
    if (!r[0]) return;
    if (merchants[i][0]) { result.alreadyHadMerchant++; return; }
    rowByExternalId[r[0]] = i;
  });

  var tz = Session.getScriptTimeZone();
  var senders = uniqueSenders_();
  outer:
  for (var s = 0; s < senders.length; s++) {
    var sender = senders[s];
    for (var start = 0; ; start += 100) {
      var threads = GmailApp.search('from:' + sender + ' newer_than:' + days + 'd', start, 100);
      if (!threads.length) break;
      for (var t = 0; t < threads.length; t++) {
        var messages = threads[t].getMessages();
        for (var m = 0; m < messages.length; m++) {
          if (Date.now() - startedAt > 270000) { result.partial = true; break outer; }
          var message = messages[m];
          result.messagesScanned++;
          var subject = message.getSubject();
          var body = message.getPlainBody();
          var rule = EMAIL_RULES.filter(function (r) { return r.sender === sender; })
            .find(function (r) { return r.match(subject, body); });
          if (!rule || rule.skip) continue;
          var fields = rule.extract(subject, body);
          if (!fields || !fields.merchant) continue;
          var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
          var row = rowByExternalId[computeEmailExternalId_(sender, dateStr, fields)];
          if (row === undefined) continue;
          var merchant = normalizeMerchant_(fields.merchant);
          if (!merchant) continue;
          merchants[row][0] = merchant;
          delete rowByExternalId[computeEmailExternalId_(sender, dateStr, fields)];
          result.matched++;
          if (result.sample.length < 15) result.sample.push(merchant);
        }
      }
    }
  }

  if (!dryRun && result.matched) {
    sheet.getRange(2, merchCol + 1, merchants.length, 1).setValues(merchants);
  }
  return result;
}
