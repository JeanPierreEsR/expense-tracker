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
 *         confirmed, inboundIds, entryById, sameDayLines }
 * `sameDayLines`: the lines of every OTHER statement of this account in the same upload, grouped by closing day ({ day: [[lines…], …] }).
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
  // A statement closing on the starting balance's own day: once saved, its lines cover their entries, and an entry such a statement
  // covers is inside that balance (entryCountsAfterOpening_). Everything below is judged as it will be after the save (owner, 2026-11-11:
  // a late bank e-mail the same-day statement shows was corrected AND moved inside by the save, 500 became 564.90).
  // A LATER statement of the same account in the same upload as such a same-day one (owner, 2026-11-11: both loaded together, the later
  // one still counted the late e-mail twice) is judged with that statement's coverage too: they are saved together.
  var undos = [];
  if (own && args.end === own.date) undos.push(stmtForeseeCoverage_(args, own.date));
  if (own && args.end > own.date) ((args.sameDayLines || {})[own.date] || []).forEach(function (lines) {
    undos.push(stmtForeseeCoverage_({ lines: lines }, own.date));
  });
  try {
    return stmtBalanceCheckFrom_(args, out, own, governing);
  } finally {
    undos.reverse().forEach(function (u) { u(); });
  }
}

// The lines of THIS statement that saving will remember as covering an entry (matched, a discount taken, a transfer completed: the
// covering outcomes of Balances.gs), added to the coverage memo under `day` for the time of the check. Returns the undo.
function stmtForeseeCoverage_(args, day) {
  statementCoversEntry_('', day);   // fills the memo
  var added = [];
  var cover = function (id) {
    if (!id) return;
    var m = STMT_COVERAGE_MEMO_[id] || (STMT_COVERAGE_MEMO_[id] = {});
    if (!m[day]) { m[day] = true; added.push(id); }
  };
  (args.lines || []).forEach(function (l) {
    if (l.status === 'matched' && l.entry && l.entry.id) cover(l.entry.id);
    if (l.discount && l.discount.clear && l.discount.entryId) cover(l.discount.entryId);
    if (l.flip && l.flip.clear && l.flip.entryId) cover(l.flip.entryId);
    if (l.completesTransfer && l.completesTransfer.entry && l.completesTransfer.entry.id) cover(l.completesTransfer.entry.id);
  });
  return function () {
    if (!STMT_COVERAGE_MEMO_) return;   // the memo was reset meanwhile: nothing of ours is left in it
    added.forEach(function (id) {
      var m = STMT_COVERAGE_MEMO_[id];
      if (!m) return;
      delete m[day];
      if (!Object.keys(m).length) delete STMT_COVERAGE_MEMO_[id];
    });
  };
}

function stmtBalanceCheckFrom_(args, out, own, governing) {
  var pm = args.pm, cur = args.currency;
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
    // The statement closes on the starting balance's own day (owner, 2026-11-11: it used to check nothing and could not replace it).
    // It is checked like a later one (the app's figure is the typed balance plus that day's entries counted after it) and may replace
    // the typed balance: a statement is exact. The phone asks first (sameDay).
    out.direction = 'forward';
    out.sameDay = true;
    out.canSet = true;
    out.reason = tr_('sb.newer', { date: own.date });
  } else {
    out.direction = 'backward';
    out.canSet = false;
    out.reason = tr_('sb.older', { date: own.date });
  }

  // When the app's figure was built FORWARD from a snapshot, explain the
  // difference with the statement's own lines that are not in the app yet.
  if (out.direction === 'forward') {
    var after = own ? own.date : '';
    var insideShift = 0, insideShiftN = 0, insidePairs = [];
    var pairOf = function (l, e) {   // a purchase inside the starting balance the card charged differently
      return { id: e.id, date: String(e.date || '').slice(0, 10), description: String(e.description || ''), type: e.type,
        recorded: Number(e.amount), charged: Math.round(-Number(l.amount) * 100) / 100, shift: Math.round((Number(l.amount) + Number(e.amount)) * 100) / 100 };
    };
    var missing = 0, pending = 0, missingN = 0, missingItems = [], pendingN = 0, discounted = 0, discountedN = 0, other = 0, otherN = 0, noAcct = 0, noAcctN = 0, flipped = 0, flippedN = 0;
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
      // A line that IS an entry saved the wrong way round (StatementMatch.gs, 'flipped'): the app counts that entry the other way, so the
      // fix moves the balance by twice the line (once when the entry had no account yet: it gets this one).
      if (l.flip && l.flip.clear && l.flip.entryId) {
        var fe = args.entryById[l.flip.entryId];
        if (fe && fe.status === 'confirmed') {
          flipped += (fe.payment_method_id === pm.id || fe.to_payment_method_id === pm.id ? 2 : 1) * Number(l.amount); flippedN++; return;
        }
      }
      // A card line paired with a purchase it charged LESS than (a discount, StatementMatch.gs): the purchase is in the app, only the
      // discount is not yet — it disappears once the purchase takes the bank's amount.
      if (l.discount && l.discount.clear && l.discount.entryId) {
        var de = args.entryById[l.discount.entryId];
        // A purchase INSIDE the starting balance (its charge posted after it): taking the bank's amount moves the starting balance, so it
        // is counted with the other starting-balance differences below (insideShift), not as a plain discount.
        if (de && de.status === 'confirmed' && own && stmtInsideStart_(de, own)) { insideShift += Number(l.amount) + Number(de.amount); insideShiftN++; insidePairs.push(pairOf(l, de)); return; }
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
    out.flipped = { net: Math.round(flipped * 100) / 100, lines: flippedN };
    out.unexplained = Math.round((out.diff - missing - pending - discounted - other - noAcct - flipped - insideShift) * 100) / 100;
    // A card posts what was bought in the last days before the closing on the NEXT statement (owner, 2026-11-10): those purchases are
    // named apart ("probably on the next statement") and no longer count as unexplained.
    // The starting balance itself, checked by this statement (owner's plan, 2026-11-11, step 3).
    if (own && own.date) {
      // (a) A purchase INSIDE the starting balance that the card charged differently, its line dated on/before that balance: taking the
      // bank's amount also moves the starting balance by the difference (StatementApply.gs, use_bank_amount), so it is explained.
      var shift = insideShift, shiftN = insideShiftN;
      (args.lines || []).forEach(function (l) {
        if (l.currency !== cur || l.date > after || !(l.discount && l.discount.clear && l.discount.entryId)) return;
        var se = args.entryById[l.discount.entryId];
        if (!se || se.status !== 'confirmed' || !stmtInsideStart_(se, own)) return;
        shift += Number(l.amount) + Number(se.amount); shiftN++;
        insidePairs.push(pairOf(l, se));
      });
      if (shiftN) {
        out.startShift = { net: Math.round(shift * 100) / 100, lines: shiftN };
        out.unexplained = Math.round((out.unexplained - (shift - insideShift)) * 100) / 100;   // insideShift is already out of it
      }
      // (b) What is left equals, to the cent, recent entries the starting balance took as already in the bank: probably still in process
      // when the balance was typed. Offered as a correction (count them after it, "Not yet"); never applied without the person.
      // (c) A phone that knows it (`startBank`) also gets each such purchase as a candidate the other way round: ALREADY charged at the
      // bank's amount when the balance was typed, so the number must not move (owner, 2026-11-11: SIP, PV 134.58 charged 112.33 before
      // the balance was typed; moving it by 22.25 made the statement disagree). The phone redoes the search with the person's picks.
      var bank = args.startBank ? insidePairs : [];
      var cands = stmtStartCands_(args, own, bank);
      if (args.startBank) out.startCands = cands;
      if (out.unexplained) {
        var fix = stmtStartFix_(cands, own, out.unexplained);
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
    if (l.flip && l.flip.clear && l.flip.entryId) explained[l.flip.entryId] = true;
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

// The starting balance's correction (owner's plan step 3, both directions since 2026-11-11). Candidates: the account's entries of the
// balance's last days (START_NOT_YET_DAYS_) in this currency that the BANK REALLY POSTED (a line of this statement, or of a statement
// saved earlier, is that entry), each on the side the app put it:
//   'in'  — taken as already inside the balance; if the bank had not posted it yet, the number should take its effect (weight = +effect);
//   'out' — counted after the balance (marked "Not yet", a late bank e-mail, recorded after the balance on its day); if the bank had
//           already posted it, the number should not have it counted again (weight = −effect).
// The ONE smallest set whose weights add up EXACTLY to the unexplained amount is offered; none when two sets fit. "Posted" keeps out a
// payment the bank cancelled while in process and a duplicate entry (only one of two twins is ever on a statement line). The 14 newest
// candidates at most. The number moves by the sum of the weights (StatementApply.gs, start_not_yet).
var STMT_START_FIX_MAX_ = 14;
// The entries a starting-balance correction may be made of (see stmtStartFix_), newest first, at most STMT_START_FIX_MAX_. `bank`: purchases
// inside the balance the card charged differently, as "already charged" (side 'bank', weight: the shift it would no longer make).
function stmtStartCands_(args, own, bank) {
  var pm = args.pm, cur = args.currency, from = startNotYetFrom_(own.date);
  var posted = stmtExplainedIds_(args);
  var cands = [];
  (args.confirmed || []).forEach(function (e) {
    if ((e.currency || homeCurrency_()) !== cur) return;
    var d = String(e.date || '').slice(0, 10);
    if (d < from || d > own.date) return;
    var side = stmtInsideStart_(e, own) ? 'in' : 'out';
    // posted: 'in' — on any statement line (a card line carries the purchase date, not the day it posted); 'out' — on a line dated on or
    // before the balance's day (a line after it shows it rightly counts after: the duplicate test, 2026-11-11)
    if (side === 'in' ? !(posted[e.id] || statementCoversAny_(e.id)) : !((posted[e.id] && posted[e.id] <= own.date) || statementCoversUpTo_(e.id, own.date))) return;
    var eff = signedEffectOnPaymentMethod_(e, pm.id, args.inboundIds);
    if (!eff) return;
    var w = side === 'in' ? eff : -eff;
    cands.push({ id: e.id, date: d, description: String(e.description || ''), type: e.type, side: side,
      amount: Math.round(eff * 100) / 100, weight: Math.round(w * 100) / 100, cents: Math.round(w * 100) });
  });
  (bank || []).forEach(function (b) {
    if (!b.shift) return;
    cands.push({ id: b.id, date: b.date, description: b.description, type: b.type, side: 'bank', recorded: b.recorded, charged: b.charged,
      amount: -b.charged, weight: -b.shift, cents: Math.round(-b.shift * 100) });
  });
  cands.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return cands.slice(0, STMT_START_FIX_MAX_);
}

// The fewest candidates whose weights add up, to the cent, to what is left unexplained, when exactly ONE such set exists; else null.
function stmtStartFix_(cands, own, unexplained) {
  var target = Math.round(unexplained * 100);
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
        var c = cands[i], it = { id: c.id, date: c.date, description: c.description, type: c.type, side: c.side, amount: c.amount, weight: c.weight };
        if (c.side === 'bank') { it.recorded = c.recorded; it.charged = c.charged; }
        return it; }) };
    }
    if (found.length > 1) return null;
  }
  return null;
}

// Entries a line of THIS statement is (matched, completed, filled, charged differently…), the same reading as stmtAppOnlyEntries_:
// entry id -> that line's date.
function stmtExplainedIds_(args) {
  var ids = {};
  var put = function (id, l) { if (id && (!ids[id] || l.date < ids[id])) ids[id] = String(l.date || ''); };
  (args.lines || []).forEach(function (l) {
    if (l.entry && l.entry.id) put(l.entry.id, l);
    if (l.gapEntryId) put(l.gapEntryId, l);
    if (l.handled && l.handled.entryId && l.handled.outcome !== 'ignored' && l.handled.outcome !== 'waiting') put(l.handled.entryId, l);
    if (l.completesTransfer && l.completesTransfer.entry && l.completesTransfer.entry.id) put(l.completesTransfer.entry.id, l);
    if (l.fillsCharge && l.fillsCharge.clear && l.fillsCharge.entryId) put(l.fillsCharge.entryId, l);
    if (l.discount && l.discount.clear && l.discount.entryId) put(l.discount.entryId, l);
    if (l.recharge && l.recharge.clear && l.recharge.entryId) put(l.recharge.entryId, l);
    if (l.flip && l.flip.clear && l.flip.entryId) put(l.flip.entryId, l);
  });
  return ids;
}


// "Not on this statement: the bank may never have charged it" (owner's plan, 2026-11-26, Part B): the expenses and incomes saved on this
// account, inside the statement's period (its own dates, else its lines' first and last), that no line of this upload's statements of the
// account explains, that no saved statement covers and that the person did not already keep. A card's money out of the last
// STMT_LATE_DAYS_ before the closing is left to "probably on the next statement". A repayment's extra and an income not received yet are
// never asked (no account moved). Strongest first: from a bank e-mail or Apple Pay ('email'), or the same amount and place twice within
// 2 days ('twice'); then the rest, oldest first. `effect` is the entry's effect on this account, `counted` whether a balance check of
// this currency counts it (so the phone can recount when the person removes or moves it). Each entry is asked once (`asked`).
var STMT_NOT_CHARGED_MAX_ = 50;
function stmtNotCharged_(args) {
  var pm = args.pm, s = args.statement, lines = args.lines || [];
  var dates = (s.lines || []).map(function (l) { return String(l.date || ''); }).filter(Boolean).sort();
  var start = (s.period && s.period.start) || dates[0] || '', end = (s.period && s.period.end) || dates[dates.length - 1] || '';
  if (!start || !end) return [];
  var currencies = {};
  (s.lines || []).forEach(function (l) { if (l.currency) currencies[l.currency] = true; });
  Object.keys(s.balances || {}).forEach(function (c) { currencies[c] = true; });
  if (!Object.keys(currencies).length) return [];
  var explained = {};
  var put = function (id) { if (id) explained[id] = true; };
  (args.sameAccount || [lines]).forEach(function (ls) {
    ls.forEach(function (l) {
      if (l.entry) put(l.entry.id);
      put(l.gapEntryId);
      if (l.handled) put(l.handled.entryId);
      if (l.completesTransfer && l.completesTransfer.entry) put(l.completesTransfer.entry.id);
      if (l.possible && l.possible.entry) put(l.possible.entry.id);
      [l.fillsCharge, l.discount, l.recharge, l.flip].forEach(function (x) { if (x) { put(x.entryId); (x.options || []).forEach(function (o) { put(o.id); }); } });
      if (l.reversal) (l.reversal.candidates || []).forEach(function (c) { if (c.entry) put(c.entry.id); });
    });
  });
  var endDay = stmtDayNumber_(end);
  var mine = (args.confirmed || []).filter(function (e) {
    return (e.type === 'expense' || e.type === 'income') && e.payment_method_id === pm.id && !e.to_payment_method_id;
  });
  var key = function (e) { return [e.currency || homeCurrency_(), Number(e.amount).toFixed(2), String(e.merchant || e.description || '').toLowerCase().replace(/[^a-z0-9]+/g, '')].join('|'); };
  var byKey = {};
  mine.forEach(function (e) { (byKey[key(e)] = byKey[key(e)] || []).push(e); });
  var items = [];
  mine.forEach(function (e) {
    var d = String(e.date || '').slice(0, 10), cur = e.currency || homeCurrency_();
    if (!d || d < start || d > end || !currencies[cur] || explained[e.id] || args.kept[e.id] || args.asked[e.id]) return;
    if (String(e.income_waiting || '') === '1' || args.locked[e.id] === 'repayment' || isPracticeEntry_(e)) return;
    if (pm.type === 'credit' && e.type === 'expense' && endDay - stmtDayNumber_(d) <= STMT_LATE_DAYS_) return;
    if (statementCoversAny_(e.id)) return;
    var eff = signedEffectOnPaymentMethod_(e, pm.id, args.inboundIds);
    if (!eff) return;
    var twin = (byKey[key(e)] || []).some(function (o) { return o.id !== e.id && Math.abs(stmtDayNumber_(String(o.date).slice(0, 10)) - stmtDayNumber_(d)) <= 2; });
    var reason = String(e.source || '') === 'email' || String(e.source || '') === 'shortcut' || String(e[APPLE_PAY_COLUMN_] || '') ? 'email' : twin ? 'twice' : '';
    var governing = openingForCurrency_(args.openings || [], cur);
    args.asked[e.id] = true;
    items.push({ id: e.id, date: d, description: String(e.description || ''), type: e.type, amount: Number(e.amount), currency: cur,
      effect: Math.round(eff * 100) / 100, reason: reason, shared: args.locked[e.id] === 'shared', shares: (args.sharesOf || {})[e.id] || undefined,
      counted: !!(governing && entryCountsAfterOpening_(e, governing) && d <= end) });
  });
  items.sort(function (a, b) { return ((b.reason ? 1 : 0) - (a.reason ? 1 : 0)) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
  // Entries still WAITING in Needs review on this account inside the period that no line shows (testers 2.75.0, Valeria): never offered
  // here (they count nowhere yet), only counted, so the screen can say to check them before confirming.
  if (args.waitingOut) (args.pending || []).forEach(function (e) {
    var d = String(e.date || '').slice(0, 10), cur = e.currency || homeCurrency_();
    if ((e.type !== 'expense' && e.type !== 'income') || e.payment_method_id !== pm.id || !d || d < start || d > end || !currencies[cur] || explained[e.id] || args.asked[e.id]) return;
    args.asked[e.id] = true;
    args.waitingOut.push({ id: e.id, date: d, description: String(e.description || ''), amount: Number(e.amount), currency: cur, type: e.type });
  });
  return items.slice(0, STMT_NOT_CHARGED_MAX_);
}
