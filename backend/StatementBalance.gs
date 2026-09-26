/**
 * Milestone 4 — checking a statement's closing balance against the app.
 *
 * A balance in this app is a SNAPSHOT (an Account Opening Balances row: amount,
 * date, exact moment) plus the confirmed entries counted after it (see
 * entryCountsAfterOpening_ in Balances.gs). So "what the app says at date D"
 * is derived one of two ways:
 *   - FORWARD (D is on/after the snapshot's date): snapshot + entries counted
 *     after it that are dated <= D. A difference from the statement is then
 *     entries missing or wrong between the snapshot and D.
 *   - BACKWARD (D is before the snapshot's date): snapshot minus the entries
 *     that sit inside the snapshot but are dated after D. Here the snapshot
 *     (the owner's newer, registered balance) is treated as the truth, so a
 *     difference says entries dated AFTER D are missing or wrong — it says
 *     nothing about the statement's own lines.
 * A statement can SET a balance only when it is newer than the registered
 * one (the newest balance always prevails; the same date → the registered
 * one wins).
 *
 * Pure functions apart from what Balances.gs already provides.
 */

/**
 * The app's balance for one account and currency at the END of `endDate`.
 * opening: the row that governs this currency (openingForCurrency_).
 * confirmed: confirmed entries. inboundIds: from buildInboundTransferIds_().
 */
function stmtBalanceAt_(pmId, currency, endDate, opening, confirmed, inboundIds) {
  var total = (opening.currency === currency) ? Number(opening.amount) : 0;
  var forward = !opening.date || endDate >= opening.date;
  confirmed.forEach(function (e) {
    if ((e.currency || 'PEN') !== currency) return;
    var eff = signedEffectOnPaymentMethod_(e, pmId, inboundIds);
    if (!eff) return;
    var counts = entryCountsAfterOpening_(e, opening);
    if (forward) { if (counts && e.date <= endDate) total += eff; }
    else if (e.date > endDate && !counts) total -= eff;
  });
  return Math.round(total * 100) / 100;
}

/**
 * args: { pm, currency, closing, start, end, lines, openings (this account's rows),
 *         confirmed, inboundIds, entryById }
 * `lines` are the analysis' output lines (status matched / completes /
 * unregistered / handled) for THIS statement.
 */
function stmtBalanceCheck_(args) {
  var pm = args.pm, cur = args.currency;
  var own = (args.openings || []).find(function (o) { return o.currency === cur; }) || null;
  var governing = openingForCurrency_(args.openings || [], cur);
  var out = { currency: cur, closing: Number(args.closing), end: args.end, account: pm.nickname,
    anchor: own ? { date: own.date, amount: own.amount } : null };

  if (!governing) {
    out.direction = 'untracked';
    out.canSet = true;
    out.reason = 'No balance is registered for this account yet — this statement can start it.';
    return out;
  }
  out.appAtEnd = stmtBalanceAt_(pm.id, cur, args.end, governing, args.confirmed, args.inboundIds);
  out.diff = Math.round((out.closing - out.appAtEnd) * 100) / 100;

  if (!own) {
    // The currency has no snapshot of its own (it counts from the account's earliest one).
    out.direction = 'forward';
    out.canSet = true;
    out.reason = 'No balance is registered in ' + cur + ' for this account yet.';
  } else if (args.end > own.date) {
    out.direction = 'forward';
    out.canSet = true;
    out.reason = 'This statement is newer than the balance registered on ' + own.date + '.';
  } else if (args.end === own.date) {
    out.direction = 'same-date';
    out.canSet = false;
    out.reason = 'Your balance registered on ' + own.date + ' is for the same day, so it stays.';
  } else {
    out.direction = 'backward';
    out.canSet = false;
    out.reason = 'Your balance registered on ' + own.date + ' is newer than this statement, so it stays.';
  }

  // When the app's figure was built FORWARD from a snapshot, explain the
  // difference with the statement's own lines that are not in the app yet.
  if (out.direction === 'forward') {
    var after = own ? own.date : '';
    var missing = 0, pending = 0, missingN = 0, pendingN = 0;
    (args.lines || []).forEach(function (l) {
      if (l.currency !== cur || l.date <= after) return;
      var entryId = l.entry ? l.entry.id : (l.handled && l.handled.entryId) || '';
      var e = entryId ? args.entryById[entryId] : null;
      var handledOutcome = l.handled ? l.handled.outcome : '';
      var inApp = l.status !== 'completes' && e && e.status === 'confirmed' &&
        (e.payment_method_id === pm.id || e.to_payment_method_id === pm.id) &&
        handledOutcome !== 'ignored' && handledOutcome !== 'waiting';
      if (inApp) return;
      if (e && e.status === 'pending' && (e.payment_method_id === pm.id) && handledOutcome !== 'ignored') { pending += Number(l.amount); pendingN++; return; }
      missing += Number(l.amount); missingN++;
    });
    out.notInApp = { net: Math.round(missing * 100) / 100, lines: missingN };
    out.pending = { net: Math.round(pending * 100) / 100, lines: pendingN };
    out.unexplained = Math.round((out.diff - missing - pending) * 100) / 100;
  }
  return out;
}
