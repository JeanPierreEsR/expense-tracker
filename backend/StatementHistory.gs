/**
 * "Fill my history" — turning bank statements into past entries with ONE approval.
 *
 * The ordinary statement review (Statements.gs / StatementApply.gs) asks the person to decide every line: right for
 * reconciling an app that already has entries, a chore for someone with no history. This mode decides for them, using
 * the same analysis, and the phone then saves the plan as one batch (applyStatementDecisions, one Undo):
 *   - a purchase / income / refund not in the app → a CONFIRMED entry, no category, the bank's wording as description;
 *   - two lines that are one transfer between the person's own accounts → one transfer (never two expenses);
 *   - a bank fee → Bank fees; a line already in the app → just remembered (never duplicated);
 *   - a line that looks like a transfer or card payment but whose other statement is not here → left WAITING, so it
 *     pairs when that statement arrives (counting it now would count a card purchase twice later);
 *   - a charge on a credit card is always a purchase, whatever words its name contains (MercadoPago, "…PAGO…");
 *   - money received from a person by Yape/Plin → set aside, not income (a friend paying their share is not income);
 *   - every line set aside is listed (`summary.aside`) so the person can opt one in (a salary deposit, for example);
 *   - a "possible match" to an existing entry → left alone (it may already be there);
 *   - a statement whose account is not in the app → skipped, and listed.
 * Balances are never touched here; the ordinary review does that.
 * Nothing in this file writes to the Sheet.
 */

// Money that came in from a person by Yape or Plin ("Yape Ana Lo*", "PLIN-ANA"). Usually a friend paying their share, which
// is never income (principle 2), so it is set aside rather than imported — the person can still opt a line in.
function stmtFromPerson_(l) {
  return l.amount > 0 && /\b(YAPE|PLIN)\b/i.test(String(l.description || ''));
}

/**
 * Lines set aside that are the same thing again and again (a salary deposit every month) get one shared `group`, so the
 * person counts them all with one tap. Same account, same currency, same direction, same wording (digits ignored) AND an
 * amount within 10% — "sometimes it has the same description but is another thing" (owner, 2026-10-22). Only lines with an
 * opt-in are grouped; `group` is a number shared by 2 or more lines, otherwise null.
 */
function stmtGroupAside_(aside) {
  var buckets = {};
  aside.forEach(function (a) {
    a.group = null;
    if (!a.optIn) return;
    var words = String(a.description || '').toUpperCase().replace(/[0-9*._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    var k = [a.account, a.currency, a.amount > 0 ? 'in' : 'out', words].join('|');
    (buckets[k] = buckets[k] || []).push(a);
  });
  var gid = 0;
  Object.keys(buckets).forEach(function (k) {
    var list = buckets[k].slice().sort(function (x, y) { return Math.abs(x.amount) - Math.abs(y.amount); });
    var i = 0;
    while (i < list.length) {
      var anchor = Math.abs(list[i].amount), j = i + 1;
      while (j < list.length && Math.abs(list[j].amount) <= anchor * 1.1) j++;
      if (j - i >= 2) { gid++; for (var m = i; m < j; m++) list[m].group = gid; }
      i = j;
    }
  });
}

/**
 * Pairs that look like a currency exchange: money leaving in one currency and arriving in another within 3 days, whose
 * amounts agree (within 15%) once both are converted with the rates ON FILE. Needs a rate for both currencies, so a person
 * with no rates gets no suggestions (the picker still works). Best pairs first, each line used once, at most 10.
 */
function stmtExchangeSuggestions_(candidates) {
  var outs = candidates.filter(function (c) { return c.amount < 0; });
  var ins = candidates.filter(function (c) { return c.amount > 0; });
  function toMain(c, amt) {
    var r = getLatestRateOnOrBefore_(c.currency, String(c.date).substring(0, 7));
    return r === null || r === undefined ? null : Math.abs(amt) * r;
  }
  function days(a, b) { return Math.abs(Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000)); }
  var pairs = [];
  ins.forEach(function (i) {
    var inMain = toMain(i, i.amount);
    if (inMain === null || inMain < 20) return;
    outs.forEach(function (o) {
      if (o.currency === i.currency) return;
      var gap = days(o.date, i.date);
      if (gap > 3) return;
      var outMain = toMain(o, o.amount);
      if (outMain === null) return;
      var ratio = outMain / inMain;
      if (ratio < 0.85 || ratio > 1.15) return;
      pairs.push({ out: o, in: i, gap: gap, off: Math.abs(ratio - 1) });
    });
  });
  pairs.sort(function (x, y) { return (x.gap - y.gap) || (x.off - y.off); });
  var usedOut = {}, usedIn = {}, result = [];
  pairs.forEach(function (p) {
    var ko = p.out.stmt + ':' + p.out.line, ki = p.in.stmt + ':' + p.in.line;
    if (usedOut[ko] || usedIn[ki] || result.length >= 10) return;
    usedOut[ko] = true; usedIn[ki] = true;
    result.push({ out: p.out, in: p.in });
  });
  return result;
}

/**
 * analysis: what analyzeStatements returned. Returns { actions, summary }.
 * `summary.counts` says how many of each; `summary.leftOut` what was not imported and why.
 * `summary.aside` lists the lines set aside that the person might want anyway (a salary deposit whose wording looks like a
 * payment, a purchase at a payment app, a friend's money that really was income); each carries `optIn`, the action that
 * would import it, which replaces the `wait` action (if any) for that line.
 */
function stmtHistoryPlan_(analysis) {
  var sts = analysis.statements || [];
  var actions = [];
  var aside = [];
  var counts = { expenses: 0, income: 0, refunds: 0, transfers: 0, fees: 0, linked: 0, completed: 0 };
  var leftOut = { handled: 0, waiting: 0, possible: 0, noAccount: 0, fromPeople: 0 };
  function setAside(si, li, st, l, reason) {
    // Money arriving on a credit card that looks like a payment is the card being paid — never income, so no opt-in.
    var cardPaid = st.account.type === 'credit' && l.amount > 0 && reason === 'waiting';
    aside.push({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency,
      account: st.account.nickname, reason: reason,
      optIn: cardPaid ? null : { type: l.amount > 0 ? 'add_history_income' : 'add_history_expense', stmt: si, line: li } });
  }
  var spent = {};
  var unknownAccounts = {};
  var first = null, last = null;
  var imported = [];   // lines the plan turns into an expense or an income, for the exchange picker

  sts.forEach(function (st, si) {
    if (!st.account) unknownAccounts[st.key] = true;
    st.lines.forEach(function (l, li) {
      var ref = { stmt: si, line: li };
      if (l.status === 'handled') { leftOut.handled++; return; }
      if (!st.account) { leftOut.noAccount++; return; }
      if (l.status === 'completes') {
        actions.push({ type: 'complete_transfer', stmt: si, line: li, entryId: l.completesTransfer.entry.id, side: l.completesTransfer.side });
        counts.completed++;
        return;
      }
      if (l.status === 'matched') {
        actions.push(l.entryHadNoAccount
          ? { type: 'assign_account', stmt: si, line: li, entryId: l.entry.id }
          : { type: 'link', stmt: si, line: li, entryId: l.entry.id });
        counts.linked++;
        return;
      }
      if (l.pairedWith) {
        var pw = l.pairedWith;
        if (pw.stored) {
          actions.push(l.amount < 0
            ? { type: 'record_transfer', out: ref, in: { stored: pw.lineKey } }
            : { type: 'record_transfer', out: { stored: pw.lineKey }, in: ref });
          counts.transfers++;
        } else if (!sts[pw.statement] || !sts[pw.statement].account) {
          leftOut.noAccount++;
        } else if (l.amount < 0) {
          actions.push({ type: 'record_transfer', out: ref, in: { stmt: pw.statement, line: pw.line } });
          counts.transfers++;
        }
        // the incoming half is covered by the outgoing line's action
        return;
      }
      if (l.guess === 'fee' && l.amount < 0) {
        actions.push({ type: 'record_fee', stmt: si, line: li });
        counts.fees++;
        return;
      }
      if (l.possible) { leftOut.possible++; return; }
      // A charge on a credit card is never money moving between the person's own accounts (card payments arrive as credits),
      // so "MDOPAGO*…" or "…PAGO…" in a merchant's name is just a purchase.
      var cardCharge = st.account.type === 'credit' && l.amount < 0 && l.section !== 'payments';
      if (l.waiting && !cardCharge) {
        actions.push({ type: 'wait', stmt: si, line: li });
        leftOut.waiting++;
        setAside(si, li, st, l, 'waiting');
        return;
      }
      if (stmtFromPerson_(l) && !l.reversal) {
        leftOut.fromPeople++;
        setAside(si, li, st, l, 'person');
        return;
      }
      if (!(Math.abs(l.amount) > 0)) return;
      if (l.date && (first === null || l.date < first)) first = l.date;
      if (l.date && (last === null || l.date > last)) last = l.date;
      if (l.amount > 0) {
        if (l.reversal) { actions.push({ type: 'add_history_reversal', stmt: si, line: li }); counts.refunds++; }
        else {
          actions.push({ type: 'add_history_income', stmt: si, line: li }); counts.income++;
          imported.push({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: st.account.nickname, kind: 'imported' });
        }
      } else {
        actions.push({ type: 'add_history_expense', stmt: si, line: li });
        imported.push({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: st.account.nickname, kind: 'imported' });
        counts.expenses++;
        spent[l.currency] = Math.round(((spent[l.currency] || 0) + Math.abs(l.amount)) * 100) / 100;
      }
    });
  });

  stmtGroupAside_(aside);
  var candidates = imported.concat(aside.filter(function (a) { return a.optIn; }).map(function (a) {
    return { stmt: a.stmt, line: a.line, date: a.date, description: a.description, amount: a.amount, currency: a.currency, account: a.account, kind: 'aside' };
  }));

  return {
    actions: actions,
    summary: {
      counts: counts, leftOut: leftOut, spent: spent, aside: aside,
      candidates: candidates, exchangeSuggestions: stmtExchangeSuggestions_(candidates),
      unknownAccounts: Object.keys(unknownAccounts),
      from: first, to: last,
      importable: counts.expenses + counts.income + counts.refunds + counts.transfers + counts.fees
    }
  };
}

/**
 * payload: the same { statements } analyzeStatements takes. Returns the plan the phone shows and then saves with
 * applyStatementDecisions (dry run first, then for real). Writes nothing.
 */
function planStatementHistory(payload) {
  var analysis = analyzeStatements(payload);
  var plan = stmtHistoryPlan_(analysis);
  return { actions: plan.actions, summary: plan.summary };
}
