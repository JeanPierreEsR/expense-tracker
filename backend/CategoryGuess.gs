/**
 * Default-category guessing for auto-captured (email) expenses.
 *
 * Deliberately NOT AI and NOT a hand-kept merchant list: every email-sourced
 * Entry stores the bank's own merchant name in a `merchant` column (cleaned
 * up, never touched when the owner renames the entry's description), and a
 * new email's category is guessed from what the owner already decided for
 * that same merchant before. In order:
 *
 *   0. A rule's own fixed category (`defaultCategory`, e.g. DiDi -> Transport).
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
// Telegram spells out the evidence ("4 of 4 past entries") only for the first
// few times a merchant is guessed — a regular merchant would repeat it on every
// card. The first guess comes at MERCHANT_MIN_ENTRIES past entries, so the next
// AUTO_REASON_FIRST_TIMES_ guesses (2, 3 and 4 past entries) show it; after that
// the card carries just "🤖 auto". (Counted from the past entries, not stored.)
var AUTO_REASON_FIRST_TIMES_ = 3;

// Entries pre-date this column, so it's appended in place the first time
// it's needed — same self-heal as recurring_expense_id.
function ensureEntriesMerchantColumn_() {
  if (memoHasColumns_('Entries', ['merchant'])) return;   // already there (read earlier in this request)
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
  var expenseCatIdByName = {};
  var transferCat = null;
  categories.forEach(function (c) {
    if (c.type === 'expense') { expenseCatIds[c.id] = true; expenseCatIdByName[c.name] = c.id; }
    if (c.type === 'transfer' && !transferCat) transferCat = c;
  });

  var history = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'expense' || !e.merchant || !expenseCatIds[e.category_id] || isPracticeReview_(e)) return;
    if (e.status !== 'confirmed' && e.source !== 'import') return;
    var h = history[e.merchant] || (history[e.merchant] = { counts: {}, total: 0 });
    h.counts[e.category_id] = (h.counts[e.category_id] || 0) + 1;
    h.total++;
  });

  return {
    expenseCatIds: expenseCatIds,
    expenseCatIdByName: expenseCatIdByName,
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
    reason: tr_('guess.history', { n: h.counts[best], total: h.total, merchant: merchant }),
    quiet: h.total >= MERCHANT_MIN_ENTRIES + AUTO_REASON_FIRST_TIMES_
  };
}

// What Telegram's card gets as its "auto" note: the full reason, or `true` for
// a bare "🤖 auto" once the merchant is familiar (see AUTO_REASON_FIRST_TIMES_).
// The app's own screens keep using guess.reason in full.
function telegramAutoReason_(guess) {
  return guess && guess.quiet ? true : (guess ? guess.reason : '');
}

// mode 'payee' (PROPOSED 2026-11-20, not used by the live guess yet; see programmedGuessBacktest_): a Programmed item matches
// only a payee alike its name or alike a payee it was paid to before (payeesAlike_). Without a merchant
// (statement lines) the old amount + date match stays.
function guessFromProgrammed_(fields, dateStr, ctx, mode) {
  var d = new Date(dateStr + 'T00:00:00');
  var start = formatCalendarDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() - RECURRING_MATCH_DAY_WINDOW));
  var end = formatCalendarDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() + RECURRING_MATCH_DAY_WINDOW));

  var hits = ctx.recurring.filter(function (r) {
    if (!ctx.expenseCatIds[r.category_id]) return false;
    var amt = recurringOwnAmount_(r, ctx.recurringSplitSums);
    if (!(amt > 0) || !amountsCloseAcrossCurrencies_(Number(fields.amount), fields.currency, amt, r.currency || homeCurrency_(), dateStr)) return false;
    return recurringExpenseOccurrencesInRange_(r, start, end).length > 0;
  });
  var merchant = mode === 'payee' ? normalizeMerchant_(fields.merchant) : '';
  if (merchant) hits = hits.filter(function (r) { return programmedPayeeFits_(r, merchant, dateStr, ctx); });
  if (!hits.length) return null;

  var catIds = {};
  hits.forEach(function (r) { catIds[r.category_id] = true; });
  if (Object.keys(catIds).length !== 1) return null;
  return { categoryId: hits[0].category_id, reason: tr_('guess.programmed', { name: hits[0].description }), itemName: hits[0].description };
}

// Words too common in payment texts to tie a payee to an item: payment words, wallets, places, company forms, currencies.
var PAYEE_COMMON_WORDS_ = { pago: 1, pagos: 1, compra: 1, payment: 1, purchase: 1, transfer: 1, transferencia: 1, del: 1, los: 1,
  las: 1, the: 1, por: 1, con: 1, para: 1, and: 1, com: 1, www: 1, web: 1, org: 1, plin: 1, yape: 1, dlc: 1, peru: 1, lima: 1,
  san: 1, sac: 1, srl: 1, eirl: 1, tda: 1, shop: 1, store: 1, tienda: 1, online: 1, usd: 1, pen: 1 };

function payeeNameWords_(normalized) {
  return String(normalized || '').split(' ').filter(function (w) { return w.length >= 3 && !PAYEE_COMMON_WORDS_[w]; });
}

// Two payee texts are about the same payee when they share a real word ("rimac rec vh usd" / "rimac usd2 recurrencia"), or one
// holds the other written without spaces ("smartfit" / "Smart Fit").
function payeesAlike_(a, b) {
  var wa = payeeNameWords_(a), wb = payeeNameWords_(b);
  if (wa.some(function (w) { return wb.indexOf(w) !== -1; })) return true;
  var ja = wa.join(''), jb = wb.join('');
  return (jb.length >= 6 && ja.indexOf(jb) !== -1) || (ja.length >= 6 && jb.indexOf(ja) !== -1);
}

function programmedPayeeFits_(r, merchant, dateStr, ctx) {
  if (payeesAlike_(merchant, normalizeMerchant_(r.description))) return true;
  if (!ctx.payees) ctx.payees = programmedPayees_(ctx);
  return (ctx.payees[r.id] || []).some(function (p) { return p.date < dateStr && payeesAlike_(merchant, p.merchant); });
}

// recurring id -> [{ date, merchant }]: confirmed expenses with a merchant that paid that item (linked to it, or its category,
// amount and date, the same test the Programmed items screen uses), oldest first.
function programmedPayees_(ctx) {
  var payees = {};
  var entries = getAllRows('Entries').filter(function (e) {
    return e.type === 'expense' && e.merchant && (e.status === 'confirmed' || e.source === 'import') && !isPracticeReview_(e);
  });
  ctx.recurring.forEach(function (r) {
    var mine = entries.filter(function (e) { return e.recurring_expense_id === r.id || e.category_id === r.category_id; });
    if (!mine.length) return;
    var dates = mine.map(function (e) { return String(e.date); }).sort();
    var occ = recurringExpenseOccurrencesInRange_(r, shiftIsoDays_(dates[0], -40), shiftIsoDays_(dates[dates.length - 1], 40));
    var list = [];
    mine.forEach(function (e) {
      if (entryMatchesRecurringOccurrence_(e, r, occ, null, ctx.recurringSplitSums)) {
        list.push({ date: String(e.date), merchant: normalizeMerchant_(e.merchant) });
      }
    });
    list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    if (list.length) payees[r.id] = list;
  });
  return payees;
}

function shiftIsoDays_(iso, days) {
  var d = new Date(String(iso).substring(0, 10) + 'T00:00:00');
  return formatCalendarDate_(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

// Backtest (owner's copy only, reads only; tools/programmed-guess-backtest.py): replays every confirmed expense with a merchant
// of the last `days`, oldest first, with only what was known before it, and compares the Programmed-item guess of the live rule
// ('old') and of mode 'payee' ('new') with the category the owner kept. `reached` counts only the expenses the merchant
// history did not already answer (where the Programmed step decides).
function programmedGuessBacktest_(p) {
  if (isFriendCopy_()) throw codedError_('backtest_not_here', 'This check runs on the owner\'s copy only.');
  var days = Math.max(1, Math.min(1095, Math.floor(Number((p || {}).days) || 365)));
  var since = shiftIsoDays_(Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd'), -days);
  var ctx = buildGuessContext_();
  ctx.history = {};
  ctx.payees = programmedPayees_(ctx);
  var catName = function (id) { return ctx.categoriesById[id] ? ctx.categoriesById[id].name : (id ? '?' : ''); };
  var blank = function () { return { right: 0, wrong: 0, none: 0 }; };
  var report = { days: days, expenses: 0, all: { old: blank(), 'new': blank() }, reached: { old: blank(), 'new': blank() },
    pipeline: { old: blank(), 'new': blank() }, changed: [] };
  var tally = function (bucket, guess, kept) { bucket[!guess ? 'none' : guess.categoryId === kept ? 'right' : 'wrong']++; };
  var entries = getAllRows('Entries').filter(function (e) {
    return e.type === 'expense' && e.merchant && ctx.expenseCatIds[e.category_id] && !isPracticeReview_(e) &&
      (e.status === 'confirmed' || e.source === 'import');
  }).sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
  entries.forEach(function (e) {
    var merchant = normalizeMerchant_(e.merchant), date = String(e.date);
    if (date >= since) {
      report.expenses++;
      var fields = { amount: Number(e.amount), currency: e.currency, merchant: e.merchant };
      var fromHistory = merchant ? guessFromMerchantHistory_(merchant, ctx) : null;
      var oldG = guessFromProgrammed_(fields, date, ctx), newG = guessFromProgrammed_(fields, date, ctx, 'payee');
      tally(report.all.old, oldG, e.category_id); tally(report.all['new'], newG, e.category_id);
      if (!fromHistory) { tally(report.reached.old, oldG, e.category_id); tally(report.reached['new'], newG, e.category_id); }
      tally(report.pipeline.old, fromHistory || oldG, e.category_id); tally(report.pipeline['new'], fromHistory || newG, e.category_id);
      var oldCat = oldG ? oldG.categoryId : '', newCat = newG ? newG.categoryId : '';
      if (!fromHistory && oldCat !== newCat && report.changed.length < 60) {
        var verdict = function (c) { return !c ? 'none' : c === e.category_id ? 'right' : 'wrong'; };
        report.changed.push({ date: date, payee: merchant, item: oldG ? oldG.itemName : newG.itemName, kept: catName(e.category_id),
          old: verdict(oldCat), 'new': verdict(newCat), oldCategory: catName(oldCat), newCategory: catName(newCat) });
      }
    }
    if (merchant) {   // now known, for the expenses after it
      var h = ctx.history[merchant] || (ctx.history[merchant] = { counts: {}, total: 0 });
      h.counts[e.category_id] = (h.counts[e.category_id] || 0) + 1;
      h.total++;
    }
  });
  return report;
}

/**
 * Returns { categoryId, reason } — reason is '' when the category isn't a
 * guess (a transfer's one possible category) and categoryId is '' when
 * nothing was confident enough.
 */
function guessCategoryForEmail_(fields, dateStr, ctx) {
  if (fields.type === 'transfer') return { categoryId: ctx.transferCatId, reason: '' };
  if (fields.type !== 'expense') return { categoryId: '', reason: '' };

  // A rule can pin its own category (DiDi is always Transport) — that's
  // certain, not a guess, so it wins over history and shows no "auto" tag.
  if (fields.defaultCategory && ctx.expenseCatIdByName[fields.defaultCategory]) {
    return { categoryId: ctx.expenseCatIdByName[fields.defaultCategory], reason: '' };
  }
  // Same, for a copy that does not have that category (a new install has no "Credit card"): the rule's second choice.
  if (fields.defaultCategoryAlt && ctx.expenseCatIdByName[fields.defaultCategoryAlt]) {
    return { categoryId: ctx.expenseCatIdByName[fields.defaultCategoryAlt], reason: '' };
  }

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

  var tz = personTz_();
  var senders = uniqueSenders_();
  outer:
  for (var s = 0; s < senders.length; s++) {
    var sender = senders[s];
    var messages = gmailSearchMessages_('from:' + sender + ' newer_than:' + days + 'd', { max: 2000 });
    for (var m = 0; m < messages.length; m++) {
      if (Date.now() - startedAt > 270000) { result.partial = true; break outer; }
      var message = messages[m];
      result.messagesScanned++;
      var subject = message.getSubject();
      var body = message.getPlainBody();
      var read = readEmailWithRules_(sender, subject, body);
      if (!read.rule || read.rule.skip) continue;
      var fields = read.fields;
      if (!fields || !fields.merchant) continue;
      var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
      // Entries made before 2026-10-05 carry the message-less key, newer ones the
      // message-id key — try both.
      var extKey = computeEmailExternalId_(sender, dateStr, fields, message.getId());
      var row = rowByExternalId[extKey];
      if (row === undefined) { extKey = computeEmailExternalId_(sender, dateStr, fields); row = rowByExternalId[extKey]; }
      if (row === undefined) continue;
      var merchant = normalizeMerchant_(fields.merchant);
      if (!merchant) continue;
      merchants[row][0] = merchant;
      delete rowByExternalId[extKey];
      result.matched++;
      if (result.sample.length < 15) result.sample.push(merchant);
    }
  }

  if (!dryRun && result.matched) {
    sheet.getRange(2, merchCol + 1, merchants.length, 1).setValues(sheetSafeRows_(merchants));
    bumpStructureVersion_();   // bulk column write — phones reload fully
  }
  return result;
}
