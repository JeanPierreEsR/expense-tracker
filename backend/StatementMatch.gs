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
// Words a bank uses for money moving between accounts (own or otherwise).
var STMT_TRANSFER_HINT = /TRANSF|PAGO|DINERS|I-BANC|INTERBANK|BPI|AHORRA|TARJ|CUENTAS|\bTC\b|\bSIP\b/i;

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
function stmtEntryEffects_(entry, pmId, amountOverride) {
  var amt = amountOverride !== undefined ? amountOverride : Number(entry.amount);
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

// An entry can explain one statement line — except a transfer, which shows
// up on TWO statements (out of one account, into the other), once each.
function stmtUsedKey_(entry, pmId) {
  return entry.type === 'transfer' ? entry.id + '|' + pmId : entry.id;
}

// The owner records a shared expense at his OWN share and often writes the
// bill's full amount in the description ("Dinner (200 total - 40 Ana - 60 Beto)",
// "Market (90.50 total - 12.00 shared)") — which is what the bank statement
// shows. That full amount is a valid amount for matching that entry.
function stmtDescribedTotal_(entry) {
  // "200 total", "1,250.00 total" (thousands comma) or "90,50 total" (decimal comma)
  var m = String(entry.description || '').match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*total/i);
  if (!m) return null;
  var raw = m[1];
  return parseFloat(/,\d{3}(?!\d)/.test(raw) && raw.indexOf('.') !== -1 || /^\d{1,3}(,\d{3})+$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.'));
}

function stmtClassifyLine_(line) {
  var d = String(line.description || '').toUpperCase();
  if (/^(IMPUESTO\s+)?ITF\b/.test(d) && Math.abs(line.amount) < STMT_FEE_MAX) return 'fee';
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
        var ok = effects && effects.some(function (x) { return Math.abs(x - l.amount) < 0.005; });
        var viaTotal = false;
        if (!ok) {
          var t = stmtDescribedTotal_(e);
          var alt = t ? stmtEntryEffects_(e, st.pmId, t) : null;
          if (alt && alt.some(function (x) { return Math.abs(x - l.amount) < 0.005; })) { ok = true; viaTotal = true; }
        }
        if (!ok) return;
        pairs.push({ viaTotal: viaTotal,
          li: li, e: e, dd: dd,
          sim: stmtSimilarity_(l.description, e.description + ' ' + (e.merchant || '')),
          own: (e.payment_method_id === st.pmId || e.to_payment_method_id === st.pmId) ? 1 : 0
        });
      });
    });
    pairs.sort(function (a, b) { return (a.dd - b.dd) || (b.sim - a.sim) || (b.own - a.own); });
    pairs.forEach(function (p) {
      if (res[p.li].status === 'matched' || used[stmtUsedKey_(p.e, st.pmId)]) return;
      used[stmtUsedKey_(p.e, st.pmId)] = true;
      res[p.li] = {
        status: 'matched', entryId: p.e.id, dayDiff: p.dd,
        entryHadNoAccount: !p.e.payment_method_id && !p.e.to_payment_method_id,
        viaTotal: !!p.viaTotal,
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
        if (used[stmtUsedKey_(e, st.pmId)] || e.currency !== l.currency) return;
        // A transfer between two other accounts says nothing about this one —
        // this pass is for an income/expense logged under the wrong account.
        if (e.type === 'transfer') return;
        var dd = Math.abs(stmtDayNumber_(e.date) - ld);
        if (dd > windowDays) return;
        var amt = Number(e.amount);
        var effects = [e.type === 'income' ? amt : -amt];
        if (!effects.some(function (x) { return Math.abs(x - l.amount) < 0.005; })) return;
        if (!best || dd < best.dd) best = { entryId: e.id, dd: dd };
      });
      if (best) r.possibleEntry = best;

      // Or the owner's 1/N share of a bill split N ways: the statement shows
      // the whole bill (90.00), the entry his third (30.00). An exact
      // multiple on the same date is a strong hint, never an auto-match.
      if (!r.possibleEntry && l.amount < 0) {
        entries.forEach(function (e) {
          if (used[stmtUsedKey_(e, st.pmId)] || e.currency !== l.currency || e.type !== 'expense') return;
          if (e.payment_method_id && e.payment_method_id !== st.pmId) return;
          var dd = Math.abs(stmtDayNumber_(e.date) - ld);
          if (dd > windowDays) return;
          if (Number(e.amount) < 10) return; // tiny amounts × N coincide too easily
          for (var n = 2; n <= 4; n++) {
            if (Math.abs(Number(e.amount) * n + l.amount) < 0.01) {
              if (!r.possibleEntry || dd < r.possibleEntry.dd) r.possibleEntry = { entryId: e.id, dd: dd, shareOf: n };
            }
          }
        });
      }
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
  // Both sides of a real own-account transfer: opposite signs, same amount
  // and currency, different accounts, a few days apart — AND at least one
  // side must say it is a transfer/payment (a bare "YAPE-…" against another
  // "Yape …" of the same amount is just two unrelated payments). Among the
  // possible pairings, take the one that resolves the MOST lines (a chain
  // A -> B -> C has two transfers of the same amount, and closest-first can
  // pair A with C and strand B), preferring the closest dates within that.
  var outs = open.filter(function (o) { return o.l.amount < 0; });
  var ins = open.filter(function (o) { return o.l.amount > 0; });
  var edges = {};
  outs.forEach(function (a, ai) {
    edges[ai] = [];
    ins.forEach(function (b, bi) {
      if (a.key === b.key || a.l.currency !== b.l.currency || Math.abs(a.l.amount + b.l.amount) >= 0.005) return;
      var dd = Math.abs(stmtDayNumber_(a.l.date) - stmtDayNumber_(b.l.date));
      if (dd > STMT_PAIR_WINDOW_DAYS) return;
      if (!STMT_TRANSFER_HINT.test(a.l.description) && !STMT_TRANSFER_HINT.test(b.l.description)) return;
      edges[ai].push({ bi: bi, dd: dd });
    });
    edges[ai].sort(function (x, y) { return x.dd - y.dd; });
  });
  var matchOfIn = {};
  function augment(ai, seen) {
    for (var k = 0; k < edges[ai].length; k++) {
      var bi = edges[ai][k].bi;
      if (seen[bi]) continue;
      seen[bi] = true;
      if (matchOfIn[bi] === undefined || augment(matchOfIn[bi], seen)) { matchOfIn[bi] = ai; return true; }
    }
    return false;
  }
  // Closest pairs first, so ties resolve toward the nearest dates.
  Object.keys(edges).map(Number)
    .sort(function (x, y) { return (edges[x][0] ? edges[x][0].dd : 99) - (edges[y][0] ? edges[y][0].dd : 99); })
    .forEach(function (ai) { augment(ai, {}); });
  Object.keys(matchOfIn).forEach(function (bi) {
    var a = outs[matchOfIn[bi]], b = ins[+bi];
    perLine[a.key][a.i].guess = 'transfer';
    perLine[b.key][b.i].guess = 'transfer';
    perLine[a.key][a.i].pairedWith = { key: b.key, i: b.i };
    perLine[b.key][b.i].pairedWith = { key: a.key, i: a.i };
    pairsOut.push({ a: { key: a.key, i: a.i }, b: { key: b.key, i: b.i } });
  });

  return { perLine: perLine, pairs: pairsOut };
}
