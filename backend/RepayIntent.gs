/**
 * A repayment that waits for its loans to be chosen (owner, 2026-11-23; Claude doc "Repayments: choosing which loans they cover").
 *
 * When a bot is told an entry is a repayment ("repayment Ana", the Edit list's Repayment) and there is a real choice of loans (two or
 * more open loans of that friend, direction and currency, and the payment does not cover them all), nothing is recorded yet: the entry
 * waits in Needs review (a confirmed one goes back to waiting, owner's OK) carrying `repay_intent` = {"friend_id", "direction"}. The
 * app then opens its Mark as repayment window on that friend with the loans to choose; the bot's Confirm, and the app's bulk confirm
 * after its question, record it paying the oldest loans first. With no real choice (one loan, or it covers them all) the bots record
 * it at once, as before. Only a WAITING entry's mark counts; confirming it any other way clears the mark.
 */

function ensureEntriesRepayIntentColumn_() {
  ensureColumn_('Entries', 'repay_intent');
}

// The mark of a waiting entry, or null.
function repayIntentOf_(entry) {
  if (!entry || entry.status !== 'pending' || !entry.repay_intent) return null;
  try {
    var it = JSON.parse(String(entry.repay_intent));
    return it && it.friend_id && (it.direction === 'they_owe_me' || it.direction === 'i_owe_them') ? it : null;
  } catch (e) { return null; }
}

// Which way the money moved and through which account (the bots' rule): an expense went out, an income came in; a transfer is read
// from its ends (only a "to" account = it came in). { incoming, accountId } or { error } with the bot's message.
function repayMoneyWay_(entry) {
  if (entry.type === 'expense' || entry.type === 'income') return { incoming: entry.type === 'income', accountId: entry.payment_method_id || '' };
  if (entry.type === 'transfer') {
    var hasFrom = !!entry.payment_method_id, hasTo = !!entry.to_payment_method_id;
    if (hasFrom && hasTo) return { error: tr_('bot.internalTransfer') };
    if (!hasFrom && !hasTo) return { error: tr_('bot.transferNoEnds') };
    return { incoming: hasTo, accountId: hasTo ? entry.to_payment_method_id : entry.payment_method_id };
  }
  return { error: tr_('bot.onlyExpenseIncome', { type: tr_('bot.type.' + entry.type) }) };
}

// A friend's loans with what is left on each. Only reads (getFriendLoanDetail adds a column the first time, which a bot action's
// undo copy would see as a change).
function repayFriendLoans_(friendId) {
  var settled = buildSettlementTotalsByLoan_();
  return getAllRows('Loans').filter(function (l) { return l.friend_id === friendId && l.unreadable_amount === undefined; })
    .map(function (l) { return Object.assign({}, l, { remaining: Number(l.amount) - (settled[l.id] || 0) }); });
}

// The friend's open loans this repayment could pay, oldest first (not the entry's own debts: a shared expense turned into a
// repayment takes those with it). `loans` = repayFriendLoans_'s rows when already read.
function repayOpenLoans_(friendId, direction, currency, entryId, loans) {
  return (loans || repayFriendLoans_(friendId)).filter(function (l) {
    return l.direction === direction && String(l.currency).toUpperCase() === String(currency).toUpperCase() &&
      l.status !== 'forgiven' && l.remaining > 0.004 && !(l.origin === 'entry' && l.entry_id === entryId);
  }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

// { matters, owed, count }: matters = two or more open loans and the payment does not cover them all.
function repayChoiceInfo_(entry, friendId, direction, loans) {
  var open = repayOpenLoans_(friendId, direction, entry.currency, entry.id, loans);
  var total = open.reduce(function (n, l) { return n + l.remaining; }, 0);
  return { matters: open.length >= 2 && Number(entry.amount) < total - 0.004, owed: open.length > 0, count: open.length };
}

// Keep the entry waiting, marked. The checks the conversion itself would make that a bot cannot answer come first, so a marked
// entry is one that can be recorded later.
function markRepayIntent_(entry, friendId, direction) {
  var asPart = repaymentPartInfo_(entry.id);
  if (asPart) throw new Error(tr_(asPart.kind === 'gap' ? 'typeChange.isRepaymentExtra' : 'convert.alreadyMovement'));
  if (entry.type === 'transfer' && (getAllRows('Settlements').some(function (s) { return s.transfer_entry_id === entry.id; }) ||
      getAllRows('Loans').some(function (l) { return l.transfer_entry_id === entry.id; }))) throw new Error(tr_('convert.alreadyMovement'));
  if (entryRepaidLoansSummary_(entry.id).length) throw new Error(tr_('convert.debtHasRepayments'));
  ensureEntriesRepayIntentColumn_();
  setEntryField_(entry.id, 'repay_intent', JSON.stringify({ friend_id: friendId, direction: direction }));
  if (entry.status !== 'pending') setEntryField_(entry.id, 'status', 'pending');
}

// A confirm by any other road (the full form as an expense, the plain Confirm of an older phone): the mark is dropped.
function clearRepayIntent_(entry) {
  if (entry && entry.repay_intent) setEntryField_(entry.id, 'repay_intent', '');
}

// Record a marked entry, paying the oldest loans first (the bot's Confirm, the app's bulk confirm). What recordRepayment does with
// money coming in and nothing owed (refused) or more than owed (the extra waits in Needs review) applies. Answers
// { friend, incoming, overpaid, settlement_id } — the repayment's first real row, for an Undo.
function recordRepayIntent_(entry, loanIds) {
  var it = repayIntentOf_(entry);
  if (!it) throw new Error(tr_('repayIntent.gone'));
  // Loans picked in the chat (one tap on WhatsApp, the checked ones on Telegram): paid oldest first among them until the payment runs
  // out, as the app's list does; what is left goes to the oldest others (recordRepayment). A loan no longer open: nothing is recorded.
  var allocations;
  var picked = [].concat(loanIds || []).filter(Boolean);
  if (picked.length) {
    var open = repayOpenLoans_(it.friend_id, it.direction, entry.currency, entry.id);
    if (picked.some(function (id) { return !open.some(function (l) { return l.id === id; }); })) throw new Error(tr_('bot.repayLoanGone'));
    var left = Number(entry.amount);
    allocations = [];
    open.filter(function (l) { return picked.indexOf(l.id) !== -1; }).forEach(function (l) {
      if (left <= 0.004) return;
      var take = Math.round(Math.min(l.remaining, left) * 100) / 100;
      if (take > 0) { allocations.push({ loan_id: l.id, amount: take }); left = Math.round((left - take) * 100) / 100; }
    });
  }
  var way = repayMoneyWay_(entry);
  if (way.error) throw new Error(way.error);
  var friend = getAllRows('Friends').find(function (f) { return f.id === it.friend_id; });
  if (!friend) throw new Error(tr_('err.friendNotFound'));
  ensureSettlementsTransferEntryColumn_();
  var before = {};
  getAllRows('Settlements').forEach(function (s) { before[s.id] = true; });
  var result = convertEntryInto_({
    entry_id: entry.id, friend_id: friend.id, direction: it.direction,
    amount: Number(entry.amount), currency: entry.currency, date: entry.date, payment_method_id: way.accountId,
    overpay_pending_ok: true, require_owed: way.incoming, allocations: allocations
  }, 'repayment');
  var made = getAllRows('Settlements').filter(function (s) { return !before[s.id] && !s.offset_loan_id; });
  // Which loans it paid and how much each, for the bot's answer (testers 2.68.2: it only said "Marked as a repayment").
  var loansById = {};
  getAllRows('Loans').forEach(function (l) { loansById[l.id] = l; });
  var paid = made.map(function (s) {
    var l = loansById[s.loan_id] || {};
    return tr_('bot.repayPaidItem', { loan: (l.description || tr_('bot.repayLoanWord')) + ' (' + botDate_(l.date) + ')', amount: formatAmountText_(Number(s.amount), entry.currency) });
  });
  return { friend: friend.name, incoming: way.incoming, overpaid: result.overpaid || 0, settlement_id: made.length ? made[0].id : '', paid: paid };
}

// For listPendingEntries: each marked waiting entry gets `repay_intent` = { friend_id, friend_name, direction, matters, owed }.
function attachRepayIntents_(entries) {
  var marked = entries.filter(function (e) { return repayIntentOf_(e); });
  if (!marked.length) return;
  var friends = {};
  getAllRows('Friends').forEach(function (f) { friends[f.id] = f; });
  var loansByFriend = {};
  marked.forEach(function (e) {
    var it = repayIntentOf_(e);
    var loans = loansByFriend[it.friend_id] || (loansByFriend[it.friend_id] = repayFriendLoans_(it.friend_id));
    var info = repayChoiceInfo_(e, it.friend_id, it.direction, loans);
    e.repay_intent = { friend_id: it.friend_id, friend_name: (friends[it.friend_id] || {}).name || '', direction: it.direction, matters: info.matters, owed: info.owed };
  });
  entries.forEach(function (e) { if (e.repay_intent && typeof e.repay_intent === 'string') delete e.repay_intent; });
}

// The bulk confirm's Undo of a marked entry recorded oldest first: the repayment goes (its debts are owed again, its money entry and
// any extra too) and the waiting entry comes back exactly as it was, marked. `before` = { entry, tags } from that confirm.
function undoRepayIntent_(item) {
  var b = item.repaid || {};
  if (!b.entry || !b.entry.id || String(b.entry.id) !== String(item.id)) throw new Error(tr_('err.cannotUnconfirm'));
  if (getEntryById_(item.id)) return;   // already back
  if (b.settlement_id) deleteRepaymentInto_({ id: b.settlement_id });
  ensureEntriesRepayIntentColumn_();
  var row = Object.assign({}, b.entry, { status: 'pending' });
  appendRowObject('Entries', row);
  (b.tags || []).forEach(function (t) { if (t && t.tag_id) appendRowObject('Entry Tags', { entry_id: item.id, tag_id: t.tag_id }); });
}

// ---- the loans in the chat (owner, 2026-11-23: "one tap", the same list on both bots) ----
// Sent under the card of an entry the bot kept waiting: "Oldest first", one row per loan (oldest first, at most 8: a WhatsApp list
// holds 10 rows), "Several → in the app". A loan whose remaining amount is exactly the payment says so.
var REPAY_LIST_MAX_ = 8;
// The rows of that list. Telegram (owner, 2026-11-24: "build Telegram"): a loan's button checks or unchecks it in place (☐ / ☑,
// `wart`), and "Save the checked ones (n)" (`wars`) records them; its buttons can change, a WhatsApp message cannot.
function repayListRows_(entry, it, loans, checked) {
  var tg = !botIsWa_();
  var rows = [{ id: 'warl:' + entry.id + ':oldest', title: tr_('bot.repayOldestRow'), description: tr_('bot.repayOldestDesc') }];
  loans.slice(0, REPAY_LIST_MAX_).forEach(function (l) {
    var exact = Math.abs(l.remaining - Number(entry.amount)) < 0.005;
    var title = botDate_(l.date) + ' · ' + (l.description || tr_('bot.repayLoanWord'));
    rows.push({ id: (tg ? 'wart:' : 'warl:') + entry.id + ':' + l.id, title: tg ? (checked.indexOf(l.id) !== -1 ? '☑ ' : '☐ ') + title : title,
      description: tr_(exact ? 'bot.repayLoanLeftExact' : 'bot.repayLoanLeft', { amount: formatAmountText_(l.remaining, entry.currency) }) });
  });
  if (tg && checked.length) rows.push({ id: 'wars:' + entry.id, title: tr_('bot.repaySaveChecked', { n: checked.length }) });
  rows.push({ id: 'warl:' + entry.id + ':app', title: tr_('bot.repayInAppRow') });
  return rows;
}
function repayCheckedKey_(entryId) { return 'repaychk-' + entryId; }
function repayChecked_(entryId) {
  try { return JSON.parse(CacheService.getScriptCache().get(repayCheckedKey_(entryId)) || '[]'); } catch (e) { return []; }
}
function botRepayLoanList_(entryId, replyTo) {
  var entry = getEntryById_(entryId), it = repayIntentOf_(entry);
  if (!it) return;
  CacheService.getScriptCache().remove(repayCheckedKey_(entryId));   // a new list starts with nothing checked
  var friend = getAllRows('Friends').find(function (f) { return f.id === it.friend_id; }) || {};
  var loans = repayOpenLoans_(it.friend_id, it.direction, entry.currency, entry.id);
  var key = loans.length > REPAY_LIST_MAX_ ? 'bot.repayPickLoanMany' : 'bot.repayPickLoan';
  botChoices_(tr_(botIsWa_() ? key : key + 'Tg', { friend: friend.name || '?', n: REPAY_LIST_MAX_ }), repayListRows_(entry, it, loans, []), replyTo);
}

// Telegram: a loan's button checks or unchecks it; the list's buttons change in place (the message is the list, `p.id`).
function botRepayToggle_(entryId, loanId, p) {
  var entry = getEntryById_(entryId), it = repayIntentOf_(entry);
  if (!entry) return botText_(tr_('bot.entryGone'), p.id);
  if (!it) return botText_(tr_('repayIntent.gone'), p.id);
  var loans = repayOpenLoans_(it.friend_id, it.direction, entry.currency, entry.id);
  var checked = repayChecked_(entryId).filter(function (id) { return loans.some(function (l) { return l.id === id; }); });
  var at = checked.indexOf(loanId);
  if (at === -1) { if (loans.some(function (l) { return l.id === loanId; })) checked.push(loanId); } else checked.splice(at, 1);
  CacheService.getScriptCache().put(repayCheckedKey_(entryId), JSON.stringify(checked), 21600);
  telegramApi_('editMessageReplyMarkup', { chat_id: getOwnerTelegramChatId_(), message_id: p.id, reply_markup: botKeyboard_(repayListRows_(entry, it, loans, checked)) });
}

// A tap on that list. "app": nothing changes, it stays in Needs review.
function botRepayLoanTap_(entryId, choice, p) {
  var entry = getEntryById_(entryId);
  if (!entry) return botText_(tr_('bot.entryGone'), p.id);
  if (!repayIntentOf_(entry)) return botText_(tr_('repayIntent.gone'), p.id);
  if (choice === 'app') return botText_(tr_('bot.repayInApp'), p.id);
  var loanIds = choice === 'checked' ? repayChecked_(entryId) : choice === 'oldest' ? [] : [choice];
  if (choice === 'checked' && !loanIds.length) return botText_(tr_('bot.repayNoneChecked'), p.id);
  botRecorded_('repayment', entryId, [p.id, p.context_id], function () {   // for "deshacer" (BotUndo.gs)
    var reply;
    try {
      var rec = withScriptLockOnce_(function () { return recordRepayIntent_(getEntryById_(entryId), loanIds); });
      reply = tr_(rec.incoming ? 'bot.markedRepaymentFrom' : 'bot.markedRepaymentTo', { friend: rec.friend }) +
        (rec.paid && rec.paid.length ? tr_('bot.repayPaidList', { list: rec.paid.join('; ') }) : '') +
        (rec.overpaid > 0.004 ? tr_(rec.incoming ? 'bot.overpaidIn' : 'bot.overpaidOut', { cur: entry.currency, amount: moneyFmt_(rec.overpaid) }) : '');
    } catch (err) {
      reply = err.message;
    }
    botText_(reply, whatsappCardFor_(entryId) || p.id);
  });
}

// ---- the words after "repayment" / "loan" (owner, 2026-11-23: a tester's "repayment, paid by JP" was read as an edit) ----
// "repayment Ana", "repayment, paid by Ana", "repago de Ana", "repayment to Ana", "repayment Ana, amount 20": the friend may come
// with "paid by / from / to / de / a / para", and every other part after a comma is an edit, applied first. { friend, friendText, edits }.
var DEBT_FRIEND_WORDS_RE_ = /^(?:paid\s+by|pagado\s+por|from|to|de|desde|a|para|hacia)\s+(.+)$/i;
function splitDebtWords_(rest) {
  var segs = [];
  String(rest || '').replace(/^[\s,]+/, '').split(/\s*,\s*/).forEach(function (piece) {
    if (!piece) return;
    if (segs.length && /^\d/.test(piece)) segs[segs.length - 1] += ',' + piece;   // "amount 1,234"
    else segs.push(piece);
  });
  var out = { friend: null, friendText: '', edits: [] };
  segs.forEach(function (seg) {
    var m = DEBT_FRIEND_WORDS_RE_.exec(seg);
    if (!out.friendText && (m || !startsWithEditKeyword_(seg))) {
      out.friend = (m && fuzzyFindFriend_(m[1].trim())) || fuzzyFindFriend_(seg.trim()) || null;
      out.friendText = m ? m[1].trim() : seg.trim();
    } else {
      out.edits.push(seg);
    }
  });
  return out;
}

// The reply-words door for "repayment …" / "loan …": the edits first (all or nothing: one that cannot be applied stops it), then the
// conversion, in one bot action (one "deshacer" takes both back).
function applyDebtWords_(entryId, text, rest) {
  var w = splitDebtWords_(rest);
  var editNote = '';
  if (w.edits.length) {
    var er = applyEditCommand_(entryId, w.edits.join(', '));
    if (er.failed) return { message: er.message + '\n\n' + tr_('bot.debtNotDone'), entry: er.entry, categoryName: er.categoryName };
    editNote = er.message || '';
  }
  var res = applyTerminalReviewAction_(entryId, text, w.friendText, w.friend);
  if (editNote) res.message = editNote + (res.message ? '\n' + res.message : '');
  return res;
}
