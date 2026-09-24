/**
 * Matches bank-statement lines against the entries already in the app, and
 * pairs the lines that are really one transfer between two of the owner's
 * own accounts. Pure logic — no Sheet/Apps Script calls — so it can be run
 * and tested anywhere; Statements.gs feeds it real data.
 *
 * A statement line's `amount` is its effect on the account (money in +,
 * out or card charge −), always in `currency`.
 */

var STMT_WINDOW_DAYS = { savings: 2, visa: 5, diners: 5 };
var STMT_PAIR_WINDOW_DAYS = 3;
// The bank's small transaction tax (ITF) is real money leaving the account
// and must be recorded for a balance to match to the cent. Anything labeled
// "ITF" but larger than this is a mislabeled transfer, not the tax.
var STMT_FEE_MAX = 5;

function stmtDayNumber_(iso) {
  var p = String(iso).split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

function stmtWords_(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (w) { return w.length >= 3; });
}

function stmtSimilarity_(a, b) {
  var wa = stmtWords_(a), wb = stmtWords_(b);
  var n = 0;
  wa.forEach(function (w) { if (wb.some(function (x) { return x === w || x.indexOf(w) === 0 || w.indexOf(x) === 0; })) n++; });
  return n;
}

/**
 * The effect an entry would have on the account `pmId`, as the amounts it
 * could plausibly appear as on a statement. An entry with no account yet
 * (the Spendee import) is a candidate for any account. Returns null when
 * the entry belongs to a different account, or an array of signed amounts.
 */
function stmtEntryEffects_(entry, pmId) {
  var amt = Number(entry.amount);
  var from = entry.payment_method_id || '', to = entry.to_payment_method_id || '';
  var out = -amt, inn = amt;
  if (from === pmId || to === pmId) {
    if (entry.type === 'transfer') {
      if (to === pmId) return [inn];
      return to ? [out] : [out, inn]; // loan-linked transfer: direction not on the row
    }
    return [entry.type === 'income' ? inn : out];
  }
  if (!from && !to) {
    if (entry.type === 'income') return [inn];
    if (entry.type === 'transfer') return [out, inn];
    return [out];
  }
  return null;
}

function stmtClassifyLine_(line) {
  var d = String(line.description || '').toUpperCase();
  if (/^ITF\b/.test(d) && Math.abs(line.amount) < STMT_FEE_MAX) return 'fee';
  if (line.section === 'fees') return 'fee';
  if (line.section === 'payments') return 'payment'; // a card bill payment
  return line.amount > 0 ? 'income' : 'expense';
}

/**
 * statements: [{ key, pmId, kind, lines: [{ date, description, amount, currency, section }] }]
 * entries:    Entries rows (any status)
 * Returns { perLine: { key: [ { status: 'matched'|'unregistered', entryId, dayDiff,
 *           entryHadNoAccount, guess } ] }, pairs: [ { a:{key,idx}, b:{key,idx} } ] }
 */
function matchStatements_(statements, entries) {
  var used = {};
  var perLine = {};

  statements.forEach(function (st) {
    var windowDays = STMT_WINDOW_DAYS[st.kind] || 3;
    var res = st.lines.map(function (l) {
      return { status: 'unregistered', guess: stmtClassifyLine_(l) };
    });
    perLine[st.key] = res;

    // Every plausible (line, entry) pair, best first: nearest date, then
    // the most words in common, then an entry already on this account.
    var pairs = [];
    st.lines.forEach(function (l, li) {
      var ld = stmtDayNumber_(l.date);
      entries.forEach(function (e) {
        if (e.currency !== l.currency) return;
        var dd = Math.abs(stmtDayNumber_(e.date) - ld);
        if (dd > windowDays) return;
        var effects = stmtEntryEffects_(e, st.pmId);
        if (!effects || !effects.some(function (x) { return Math.abs(x - l.amount) < 0.005; })) return;
        pairs.push({
          li: li, e: e, dd: dd,
          sim: stmtSimilarity_(l.description, e.description + ' ' + (e.merchant || '')),
          own: (e.payment_method_id === st.pmId || e.to_payment_method_id === st.pmId) ? 1 : 0
        });
      });
    });
    pairs.sort(function (a, b) { return (a.dd - b.dd) || (b.sim - a.sim) || (b.own - a.own); });
    pairs.forEach(function (p) {
      if (res[p.li].status === 'matched' || used[p.e.id]) return;
      used[p.e.id] = true;
      res[p.li] = {
        status: 'matched', entryId: p.e.id, dayDiff: p.dd,
        entryHadNoAccount: !p.e.payment_method_id && !p.e.to_payment_method_id,
        guess: res[p.li].guess
      };
    });
  });

  // Second look for whatever is still unmatched: an entry with the same
  // amount and date that is assigned to a DIFFERENT account (e.g. a salary
  // logged as "Bank transfer"). Never auto-matched — offered as a possible
  // match for the owner to confirm, since it could equally be a different
  // payment that happens to share an amount.
  statements.forEach(function (st) {
    var windowDays = STMT_WINDOW_DAYS[st.kind] || 3;
    st.lines.forEach(function (l, li) {
      var r = perLine[st.key][li];
      if (r.status !== 'unregistered') return;
      var ld = stmtDayNumber_(l.date);
      var best = null;
      entries.forEach(function (e) {
        if (used[e.id] || e.currency !== l.currency) return;
        var dd = Math.abs(stmtDayNumber_(e.date) - ld);
        if (dd > windowDays) return;
        var amt = Number(e.amount);
        var sign = e.type === 'income' ? 1 : (e.type === 'transfer' ? 0 : -1);
        var effects = sign === 0 ? [amt, -amt] : [sign * amt];
        if (!effects.some(function (x) { return Math.abs(x - l.amount) < 0.005; })) return;
        if (!best || dd < best.dd) best = { entryId: e.id, dd: dd };
      });
      if (best) r.possibleEntry = best;
    });
  });

  // Own-account transfers: an unmatched outflow on one account and an
  // unmatched inflow of the same amount on another, within a few days.
  var pairsOut = [];
  var open = [];
  statements.forEach(function (st) {
    st.lines.forEach(function (l, i) {
      if (perLine[st.key][i].status === 'unregistered' && perLine[st.key][i].guess !== 'fee') open.push({ key: st.key, i: i, l: l });
    });
  });
  var cand = [];
  open.forEach(function (a) {
    open.forEach(function (b) {
      if (a.key === b.key || a.l.amount >= 0 || b.l.amount <= 0) return;
      if (a.l.currency !== b.l.currency || Math.abs(a.l.amount + b.l.amount) >= 0.005) return;
      var dd = Math.abs(stmtDayNumber_(a.l.date) - stmtDayNumber_(b.l.date));
      if (dd > STMT_PAIR_WINDOW_DAYS) return;
      cand.push({ a: a, b: b, dd: dd });
    });
  });
  cand.sort(function (x, y) { return x.dd - y.dd; });
  var taken = {};
  cand.forEach(function (c) {
    var ka = c.a.key + '#' + c.a.i, kb = c.b.key + '#' + c.b.i;
    if (taken[ka] || taken[kb]) return;
    taken[ka] = taken[kb] = true;
    perLine[c.a.key][c.a.i].guess = 'transfer';
    perLine[c.b.key][c.b.i].guess = 'transfer';
    perLine[c.a.key][c.a.i].pairedWith = { key: c.b.key, i: c.b.i };
    perLine[c.b.key][c.b.i].pairedWith = { key: c.a.key, i: c.a.i };
    pairsOut.push({ a: { key: c.a.key, i: c.a.i }, b: { key: c.b.key, i: c.b.i } });
  });

  return { perLine: perLine, pairs: pairsOut };
}
