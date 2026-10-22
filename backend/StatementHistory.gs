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
 *   - a "possible match" to an existing entry → left alone (it may already be there);
 *   - a statement whose account is not in the app → skipped, and listed.
 * Balances are never touched here; the ordinary review does that.
 * Nothing in this file writes to the Sheet.
 */

/**
 * analysis: what analyzeStatements returned. Returns { actions, summary }.
 * `summary.counts` says how many of each; `summary.leftOut` what was not imported and why.
 */
function stmtHistoryPlan_(analysis) {
  var sts = analysis.statements || [];
  var actions = [];
  var counts = { expenses: 0, income: 0, refunds: 0, transfers: 0, fees: 0, linked: 0, completed: 0 };
  var leftOut = { handled: 0, waiting: 0, possible: 0, noAccount: 0 };
  var spent = {};
  var unknownAccounts = {};
  var first = null, last = null;

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
      if (l.waiting) {
        actions.push({ type: 'wait', stmt: si, line: li });
        leftOut.waiting++;
        return;
      }
      if (!(Math.abs(l.amount) > 0)) return;
      if (l.date && (first === null || l.date < first)) first = l.date;
      if (l.date && (last === null || l.date > last)) last = l.date;
      if (l.amount > 0) {
        if (l.reversal) { actions.push({ type: 'add_history_reversal', stmt: si, line: li }); counts.refunds++; }
        else { actions.push({ type: 'add_history_income', stmt: si, line: li }); counts.income++; }
      } else {
        actions.push({ type: 'add_history_expense', stmt: si, line: li });
        counts.expenses++;
        spent[l.currency] = Math.round(((spent[l.currency] || 0) + Math.abs(l.amount)) * 100) / 100;
      }
    });
  });

  return {
    actions: actions,
    summary: {
      counts: counts, leftOut: leftOut, spent: spent,
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
