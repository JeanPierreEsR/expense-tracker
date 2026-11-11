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
    if ((e.currency || homeCurrency_()) !== currency) return;
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
    out.reason = tr_('sb.untracked');
    return out;
  }
  out.appAtEnd = stmtBalanceAt_(pm.id, cur, args.end, governing, args.confirmed, args.inboundIds);
  out.diff = Math.round((out.closing - out.appAtEnd) * 100) / 100;

  if (!own) {
    // The currency has no snapshot of its own (it counts from the account's earliest one).
    out.direction = 'forward';
    out.canSet = true;
    out.reason = tr_('sb.noCurrency', { cur: cur });
    // The app counts this currency from 0 on the date of the account's other starting balance. Said on the screen when something is left
    // unexplained (owner, 2026-11-11: an Interbank card had no USD starting balance, and its USD gap was exactly the missing balance).
    out.noAnchor = { date: governing.date || '' };
  } else if (args.end > own.date) {
    out.direction = 'forward';
    out.canSet = true;
    out.reason = tr_('sb.newer', { date: own.date });
  } else if (args.end === own.date) {
    out.direction = 'same-date';
    out.canSet = false;
    out.reason = tr_('sb.sameDay', { date: own.date });
  } else {
    out.direction = 'backward';
    out.canSet = false;
    out.reason = tr_('sb.older', { date: own.date });
  }

  // When the app's figure was built FORWARD from a snapshot, explain the
  // difference with the statement's own lines that are not in the app yet.
  if (out.direction === 'forward') {
    var after = own ? own.date : '';
    var missing = 0, pending = 0, missingN = 0, missingItems = [], pendingN = 0, discounted = 0, discountedN = 0, other = 0, otherN = 0, noAcct = 0, noAcctN = 0;
    // A purchase the card charged in ANOTHER currency (StatementMatch.gs, 'recharge'): until it takes the charge, the line is missing in
    // its currency and the purchase sits in the other one. Both halves are named here instead of looking unexplained.
    (args.lines || []).forEach(function (l) {
      if (!(l.recharge && l.recharge.clear && l.recharge.entryId) || l.currency === cur || l.date <= after) return;
      var re = args.entryById[l.recharge.entryId];
      if (re && re.status === 'confirmed' && (re.currency || homeCurrency_()) === cur && re.payment_method_id === pm.id) { other += Number(re.amount); otherN++; }
    });
    // A line dated on/before the starting balance is inside it, unless its entry was marked "Not yet" when the balance was saved
    // (owner, 2026-11-11): then it counts after the balance, like the entry.
    var notYet = {};
    ((own && own.not_yet) || []).forEach(function (id) { notYet[id] = true; });
    var lineNotYet = function (l) {
      var id = l.entry ? l.entry.id : (l.handled && l.handled.entryId) || (l.discount && l.discount.entryId) || '';
      return !!(id && notYet[id]);
    };
    (args.lines || []).forEach(function (l, li) {
      if (l.currency !== cur || (l.date <= after && !lineNotYet(l))) return;
      if (l.recharge && l.recharge.clear && l.recharge.entryId) { other += Number(l.amount); otherN++; return; }
      // A card line paired with a purchase it charged LESS than (a discount, StatementMatch.gs): the purchase is in the app, only the
      // discount is not yet — it disappears once the purchase takes the bank's amount.
      if (l.discount && l.discount.clear && l.discount.entryId) {
        var de = args.entryById[l.discount.entryId];
        if (de && de.status === 'confirmed') { discounted += Number(l.amount) + Number(de.amount); discountedN++; return; }
      }
      var entryId = l.entry ? l.entry.id : (l.handled && l.handled.entryId) || '';
      var e = entryId ? args.entryById[entryId] : null;
      // The line IS an entry saved with no account (owner, 2026-11-11): not missing, it only needs this account.
      if (l.status === 'matched' && l.entryHadNoAccount && e && e.status === 'confirmed' && !e.payment_method_id && !e.to_payment_method_id) {
        noAcct += Number(l.amount); noAcctN++; return;
      }
      var handledOutcome = l.handled ? l.handled.outcome : '';
      var inApp = l.status !== 'completes' && e && e.status === 'confirmed' &&
        (e.payment_method_id === pm.id || e.to_payment_method_id === pm.id) &&
        handledOutcome !== 'ignored' && handledOutcome !== 'waiting';
      if (inApp) return;
      if (e && e.status === 'pending' && (e.payment_method_id === pm.id) && handledOutcome !== 'ignored') { pending += Number(l.amount); pendingN++; return; }
      missing += Number(l.amount); missingN++;
      missingItems.push({ line: li, amount: Number(l.amount) });
    });
    // `items`: which lines these are, so the screen can recount when the person leaves one out (owner, 2026-11-11).
    out.notInApp = { net: Math.round(missing * 100) / 100, lines: missingN, items: missingItems };
    out.pending = { net: Math.round(pending * 100) / 100, lines: pendingN };
    out.discounted = { net: Math.round(discounted * 100) / 100, lines: discountedN };
    out.otherCurrency = { net: Math.round(other * 100) / 100, lines: otherN };
    out.noAccount = { net: Math.round(noAcct * 100) / 100, lines: noAcctN };
    out.unexplained = Math.round((out.diff - missing - pending - discounted - other - noAcct) * 100) / 100;
    // A card posts what was bought in the last days before the closing on the NEXT statement (owner, 2026-11-10): those purchases are
    // named apart ("probably on the next statement") and no longer count as unexplained.
    // The starting balance itself, checked by this statement (owner's plan, 2026-11-11, step 3).
    if (own && own.date) {
      // (a) A purchase INSIDE the starting balance that the card charged differently, its line dated on/before that balance: taking the
      // bank's amount also moves the starting balance by the difference (StatementApply.gs, use_bank_amount), so it is explained.
      var shift = 0, shiftN = 0;
      (args.lines || []).forEach(function (l) {
        if (l.currency !== cur || l.date > after || !(l.discount && l.discount.clear && l.discount.entryId)) return;
        var se = args.entryById[l.discount.entryId];
        if (!se || se.status !== 'confirmed' || !stmtInsideStart_(se, own)) return;
        shift += Number(l.amount) + Number(se.amount); shiftN++;
      });
      if (shiftN) {
        out.startShift = { net: Math.round(shift * 100) / 100, lines: shiftN };
        out.unexplained = Math.round((out.unexplained - shift) * 100) / 100;
      }
      // (b) What is left equals, to the cent, recent entries the starting balance took as already in the bank: probably still in process
      // when the balance was typed. Offered as a correction (count them after it, "Not yet"); never applied without the person.
      if (out.unexplained) {
        var fix = stmtStartFix_(args, own, out.unexplained);
        if (fix) out.startFix = fix;
      }
    }
    var appOnly = stmtAppOnlyEntries_(args, governing, after);
    if (pm.type === 'credit' && appOnly.all.length) {
      var endDay = stmtDayNumber_(args.end), late = 0, lateItems = [];
      appOnly.all = appOnly.all.filter(function (it) {
        if (endDay - stmtDayNumber_(it.date) > STMT_LATE_DAYS_ || it.amount >= 0) return true;
        late -= it.amount; lateItems.push(it); return false;
      });
      if (lateItems.length) {
        out.late = { net: Math.round(late * 100) / 100, lines: lateItems.length, items: lateItems };
        out.unexplained = Math.round((out.unexplained - late) * 100) / 100;
      }
    }
    if (out.unexplained && appOnly.all.length) {
      var aoNet = appOnly.all.reduce(function (t, it) { return t + it.amount; }, 0);
      out.appOnly = { net: Math.round(aoNet * 100) / 100, n: appOnly.all.length, items: appOnly.all.slice(0, STMT_APP_ONLY_MAX_) };
    }
  }
  return out;
}

// What the app counts on this account inside the statement's period that no line of the statement explains (owner's request,
// 2026-11-10): the other half of an "unexplained" difference. Found on the owner's IBK dolares: a currency exchange's USD 1,000
// recorded on that account, which the bank never received there. Each item's amount is its effect on the account's balance.
// Read-only: it only lists. A purchase the bank posts after the closing date can show here too, so the screen says so.
var STMT_APP_ONLY_MAX_ = 30;
var STMT_LATE_DAYS_ = 3;   // a card purchase this many days (or fewer) before the closing is probably on the next statement (owner, 2026-11-10)
function stmtAppOnlyEntries_(args, governing, after) {
  var pm = args.pm, cur = args.currency;
  var explained = {};
  (args.lines || []).forEach(function (l) {
    if (l.entry && l.entry.id) explained[l.entry.id] = true;
    if (l.gapEntryId) explained[l.gapEntryId] = true;
    if (l.handled && l.handled.entryId) explained[l.handled.entryId] = true;
    if (l.completesTransfer && l.completesTransfer.entry && l.completesTransfer.entry.id) explained[l.completesTransfer.entry.id] = true;
    if (l.fillsCharge && l.fillsCharge.entryId) explained[l.fillsCharge.entryId] = true;
    if (l.discount && l.discount.clear && l.discount.entryId) explained[l.discount.entryId] = true;
    if (l.recharge && l.recharge.clear && l.recharge.entryId) explained[l.recharge.entryId] = true;
  });
  var items = [];
  (args.confirmed || []).forEach(function (e) {
    if ((e.currency || homeCurrency_()) !== cur || explained[e.id]) return;
    var d = String(e.date || '').slice(0, 10);
    if (!d || d > args.end || (args.start && d < args.start) || (after && d <= after && !((governing.not_yet || []).indexOf(String(e.id)) !== -1))) return;
    if (!entryCountsAfterOpening_(e, governing)) return;
    var eff = signedEffectOnPaymentMethod_(e, pm.id, args.inboundIds);
    if (!eff) return;
    items.push({ id: e.id, date: d, description: String(e.description || ''), type: e.type, amount: Math.round(eff * 100) / 100 });
  });
  items.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return { all: items };
}


// An entry the starting balance takes as already inside it (dated on/before its day, recorded before it, not marked "Not yet").
function stmtInsideStart_(e, own) {
  var d = String(e.date || '').slice(0, 10);
  return !!(own && own.date && d && d <= own.date && !entryCountsAfterOpening_(e, own));
}

// The smallest set of entries of the starting balance's last days (START_NOT_YET_DAYS_) that it took as inside, whose effect on the
// account adds up EXACTLY to the unexplained amount: any number of entries of that window (owner, 2026-11-11: "a window of days, not
// entries"; was 1 to 3). Only when exactly one set of that size fits; otherwise nothing (a guess between two answers is not offered).
// Counting them after the balance moves the app by their effect, which closes the gap. The 14 newest entries of the window at most.
var STMT_START_FIX_MAX_ = 14;
function stmtStartFix_(args, own, unexplained) {
  var pm = args.pm, cur = args.currency, from = startNotYetFrom_(own.date), target = Math.round(unexplained * 100);
  var cands = [];
  (args.confirmed || []).forEach(function (e) {
    if ((e.currency || homeCurrency_()) !== cur) return;
    var d = String(e.date || '').slice(0, 10);
    if (d < from || d > own.date || !stmtInsideStart_(e, own)) return;
    var eff = signedEffectOnPaymentMethod_(e, pm.id, args.inboundIds);
    if (!eff) return;
    cands.push({ id: e.id, date: d, description: String(e.description || ''), type: e.type, amount: Math.round(eff * 100) / 100, cents: Math.round(eff * 100) });
  });
  cands.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  cands = cands.slice(0, STMT_START_FIX_MAX_);
  var n = cands.length;
  for (var size = 1; size <= n; size++) {
    var found = [];
    var walk = function (start, picked, sum) {
      if (found.length > 1) return;
      if (picked.length === size) { if (sum === target) found.push(picked.slice()); return; }
      for (var i = start; i < n; i++) { picked.push(i); walk(i + 1, picked, sum + cands[i].cents); picked.pop(); }
    };
    walk(0, [], 0);
    if (found.length === 1) {
      return { date: own.date, amount: own.amount, items: found[0].map(function (i) {
        var c = cands[i]; return { id: c.id, date: c.date, description: c.description, type: c.type, amount: c.amount }; }) };
    }
    if (found.length > 1) return null;
  }
  return null;
}
