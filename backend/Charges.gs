// What a card or account really charged (owner, 2026-11-06; "Card currencies plan (DRAFT 2026-11-06).md", Part B revised).
// An entry's amount and currency are what the account was charged, so balances, reports, budgets and statements need no change.
// paid_amount / paid_currency say what was paid at the place (ARS on a USD card), and are optional.
// charge_pending = '1': only what was paid is known so far. The entry stays in that currency, counted as an estimate at its monthly rate,
// until the charge is filled in, it is kept as it is, or it is deleted. Nothing is ever filled in by itself and nothing is blocked.
var CHARGE_REMINDER_DAYS_ = 45;   // so a statement has time to show the charge first (owner, 2026-11-06)

function ensureEntriesChargeColumns_() {
  ['paid_amount', 'paid_currency', 'charge_pending', 'charge_told'].forEach(function (c) { ensureColumn_('Entries', c); });
}

function isChargePending_(e) {
  return !!e && e.status === 'confirmed' && e.type === 'expense' && String(e.charge_pending || '') === '1' && !isPracticeEntry_(e);
}

// Whole days from a date (yyyy-MM-dd) to today.
function chargeDaysWaiting_(date, today) {
  return Math.round((new Date(today + 'T00:00:00Z') - new Date(String(date).slice(0, 10) + 'T00:00:00Z')) / 86400000);
}

// What Home's small card needs, from the entries the glance has already read.
function pendingChargesSummary_() {
  var today = formatCalendarDate_(new Date());
  var list = getAllRows('Entries').filter(isChargePending_);
  return { count: list.length, old: list.filter(function (e) { return chargeDaysWaiting_(e.date, today) >= CHARGE_REMINDER_DAYS_; }).length };
}

// The list behind the card, oldest first, with what the charge will probably be in (the account's own currencies).
function listPendingCharges() {
  var today = formatCalendarDate_(new Date());
  var pms = rowsById_(getAllRows('Payment Methods'));
  return getAllRows('Entries').filter(isChargePending_).sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; }).map(function (e) {
    var pm = pms[e.payment_method_id];
    return { id: e.id, date: e.date, description: e.description || '', category_id: e.category_id || '', amount: Number(e.amount), currency: e.currency,
      payment_method_id: e.payment_method_id || '', account: pm ? pm.nickname : '', old: chargeDaysWaiting_(e.date, today) >= CHARGE_REMINDER_DAYS_ };
  });
}

// The charge is known: amount and currency become it, and what was paid moves to the paid columns. A shared expense keeps the same
// proportions in the charged currency, and each friend's debt stays exactly what it was in what was paid (saveEntrySplits, Loans.gs).
// payload: { id, amount, currency }
function fillEntryCharge(payload) {
  var entry = getEntryById_(payload.id);
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  var charge = Number(payload.amount), currency = String(payload.currency || '').trim().toUpperCase();
  if (!(charge > 0)) throw new Error(tr_('err.validAmount'));
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (String(entry.charge_pending || '') !== '1') return entry;   // already done (a repeated save)
  var paid = Number(entry.amount);
  var splits = getAllRows('Entry Splits').filter(function (s) { return s.entry_id === entry.id; }).map(function (s) {
    return { friend_id: s.friend_id, amount: Math.round(Number(s.amount) * charge / paid * 1e6) / 1e6 };
  });
  ensureEntriesChargeColumns_();
  var updated = updateEntryFields(entry.id, { amount: charge, currency: currency, paid_amount: paid, paid_currency: entry.currency, charge_pending: '', charge_told: '' });
  if (splits.length) saveEntrySplits(entry.id, splits);
  return updated;
}

// "Keep in ARS": this purchase stays in what was paid and stops asking.
function keepEntryCharge(payload) {
  var entry = getEntryById_(payload.id);
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  ensureEntriesChargeColumns_();
  return updateEntryFields(entry.id, { charge_pending: '', charge_told: '' });
}

// Units of `to` for one unit of `from` on that date, from the rate table; null when the table cannot tell.
function chargeExpectedRatio_(from, to, date) {
  var a = computeAmountPen(1, from, date), b = computeAmountPen(1, to, date);
  return a != null && b != null && b > 0 ? a / b : null;
}

// A bank e-mail waiting in Needs review that is the charge of a purchase left pending on the same card, 5 days apart at most:
// the review card asks "Is this the charge of …?" (owner, 2026-11-07). The best one only: rate closest to the table, then the nearest date.
function chargeMatchForReview_(pending, all) {
  if (pending.type !== 'expense' || !pending.payment_method_id || !(Number(pending.amount) > 0) || isPracticeReview_(pending)) return null;
  var day = function (d) { return Math.round(new Date(String(d).slice(0, 10) + 'T00:00:00Z') / 86400000); };
  var pd = day(pending.date), best = null;
  all.forEach(function (e) {
    if (!isChargePending_(e) || e.payment_method_id !== pending.payment_method_id || e.currency === pending.currency) return;
    var dd = Math.abs(day(e.date) - pd);
    if (dd > STMT_CHARGE_WINDOW_DAYS) return;
    var expected = chargeExpectedRatio_(e.currency, pending.currency, e.date);
    var off = expected ? Math.abs(Number(pending.amount) / Number(e.amount) / expected - 1) : 1;
    if (!best || off < best.off - 1e-9 || (Math.abs(off - best.off) < 1e-9 && dd < best.dd)) best = { e: e, dd: dd, off: off };
  });
  return best ? { entryId: best.e.id, description: best.e.description || '', amount: Number(best.e.amount), currency: best.e.currency, date: best.e.date } : null;
}

// "Yes, same purchase" on that card: the pending purchase gets this e-mail's amount as its charge, and the e-mail's own entry goes.
// payload: { pendingId, entryId }
function fillChargeFromReview(payload) {
  var pending = getEntryById_(payload.pendingId);
  if (!pending || pending.status !== 'pending') throw new Error(tr_('err.entryNotFound'));
  var entry = getEntryById_(payload.entryId);
  if (!entry || String(entry.charge_pending || '') !== '1') throw new Error(tr_('sa.notPendingCharge'));
  fillEntryCharge({ id: entry.id, amount: Math.abs(Number(pending.amount)), currency: pending.currency });
  discardEntryWithRepayments_(pending.id);
  return { done: true };
}

// One Telegram message per card, the day its purchases reach 45 days; never repeated.
function notifyOldPendingCharges_() {
  var today = formatCalendarDate_(new Date());
  var due = getAllRows('Entries').filter(function (e) {
    return isChargePending_(e) && !e.charge_told && chargeDaysWaiting_(e.date, today) >= CHARGE_REMINDER_DAYS_;
  });
  if (!due.length) return 0;
  var byAccount = {};
  due.forEach(function (e) { (byAccount[e.payment_method_id] = byAccount[e.payment_method_id] || []).push(e); });
  var pms = rowsById_(getAllRows('Payment Methods'));
  var sent = 0;
  Object.keys(byAccount).forEach(function (pmId) {
    var list = byAccount[pmId], pm = pms[pmId];
    var text = tr_(list.length === 1 ? 'charges.telegramOne' : 'charges.telegram', { n: list.length, days: CHARGE_REMINDER_DAYS_, account: pm ? pm.nickname : '' });
    if (!sendTelegramText_(text)) return;   // no bot, or no answer: the next run tries again
    list.forEach(function (e) { updateRowFields_('Entries', e.id, { charge_told: '1' }); });
    sent++;
  });
  return sent;
}
