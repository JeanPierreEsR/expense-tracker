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

// A payment with a person: through a wallet ("Yape Ana Lopez", "PLIN-CARLA", "ABON PLIN-LUIS M") or a bank transfer with a person's name in it
// ("TRANSF MARCO"). Strong wallets (Yape, Plin, Lukita, Tunki, Ligo): the line is a payment with a person even when no name can be read.
// Other wallets and banks that carry names (SIP, Banco Falabella, Bim, Agora…) and plain bank transfers count only when what is left
// after the wording looks like a PERSON'S name — not a company, a bank or a service.
// English wording works too ("Transfer to Jane Doe", "Zelle payment to…", "Venmo…", "PayPal…", "Sent to…", "Received from…").
var STMT_WALLET_RE = /\b(YAPE|PLIN|LUKITA|TUNKI|LIGO|ZELLE|VENMO)\b/i;
var STMT_WALLET2_RE = /\b(BIM|AGORA|SIP|FALABELLA|DAVIPLATA|CMR|PAYPAL|CASH ?APP)\b/i;
// Only words that say "a transfer": "ABONO SUELDO" or "DE INVERSIONES" are too generic to read a person out of.
var STMT_TRANSFER_PREFIX_RE = /^\s*(TRANSF(ERENCIA)?|TRANSFER|TRF|TRAN|ENVIO|PAGO A|PAYMENT (TO|FROM)|SENT TO|RECEIVED FROM|WIRE|ONLINE TRANSFER|MOBILE TRANSFER|ACH|INCOMING|OUTGOING)\b[.\s:\-]*/i;
// Words that say the rest of the line is NOT a person.
var STMT_NOT_A_NAME_ = ['BCO', 'BANCO', 'INTERBA', 'INTERBANK', 'INTERBANCARIA', 'INTER', 'INTERNACIONAL', 'BCP', 'BBVA', 'SCOTIA', 'SCOTIABANK', 'BPI',
  'SIP', 'FALABELLA', 'CMAC', 'CAJA', 'RECIBIDA', 'ENVIADA', 'ENTRE', 'MIS', 'CUENTAS', 'CTAS', 'TERC', 'TERCEROS', 'BM', 'IBANC', 'INVERSIONES', 'INVERSION',
  'SAC', 'SRL', 'EIRL', 'SA', 'INC', 'LLC', 'CORP', 'COMPANIA', 'CIA', 'EMPRESA', 'SERVICIOS', 'SERVICIO', 'GRUPO', 'PERU', 'LIMA', 'TARJETA', 'CREDITO',
  'DEUDA', 'TOT', 'APP', 'PAGO', 'PAGOS', 'PPA', 'PRVNG', 'SHOP', 'STORE', 'MARKET', 'TIENDA', 'RESTAURANTE', 'FARMACIA', 'GYM', 'CLUB', 'AGORA', 'BIM',
  'CUENTA', 'OTRA', 'OTRO', 'PROPIA', 'PROPIO', 'MISMO', 'TITULAR', 'SUELDO', 'PLANILLA', 'HABERES', 'INTERES', 'INTERESES', 'COMISION', 'RETIRO', 'DEPOSITO',
  'EFECTIVO', 'AHORRO', 'AHORROS', 'CORRIENTE', 'CTA', 'COBRO', 'REEMBOLSO', 'DEVOLUCION', 'PLAZO', 'OPERACION', 'MOVIL', 'DIGITAL', 'WEB', 'ONLINE', 'BANCA', 'INTERNET',
  // English
  'THANK', 'YOU', 'PAYMENT', 'DEPOSIT', 'WITHDRAWAL', 'ATM', 'INTEREST', 'SALARY', 'PAYROLL', 'ACCOUNT', 'SAVINGS', 'CHECKING', 'CARD', 'CREDIT', 'DEBIT',
  'FEE', 'FEES', 'BANK', 'LTD', 'CO', 'COMPANY', 'CHARGE', 'REFUND', 'REVERSAL', 'MOBILE', 'INTERNATIONAL', 'SERVICE', 'RESTAURANT', 'PHARMACY', 'GROUP',
  'TRANSFER', 'BALANCE', 'AUTOPAY', 'AUTO', 'PMT', 'ACH', 'DIRECT', 'DEP', 'CHECK', 'CHK', 'WIRE', 'STATEMENT', 'ONLINE', 'MORTGAGE', 'LOAN', 'RENT', 'UTILITY'];
function stmtWalletLine_(l) { return STMT_WALLET_RE.test(String(l.description || '')); }

function stmtNameTokens_(description) {
  var t = String(description || '').replace(/\*/g, ' ');
  t = t.replace(STMT_TRANSFER_PREFIX_RE, ' ').replace(STMT_WALLET_RE, ' ').replace(STMT_WALLET2_RE, ' ')
    .replace(/^(\s*(A|DE|DEL|TO|FROM|TRANSFER|WIRE|PAYMENT|ONLINE|MOBILE|ACH|INCOMING|OUTGOING|SENT|RECEIVED)\b)+/i, ' ').replace(/\b(ABONO|ABON|TRANSF(ERENCIA)?)\b/ig, ' ').replace(STMT_WALLET_RE, ' ').replace(STMT_WALLET2_RE, ' ')
    .replace(/\b(USD|PEN|SOLES|DOLARES)\b/ig, ' ');
  return t.replace(/[-.:_0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Is this line a payment with a person? Returns { key, name } (key '' when no name could be read) or null. Rule-based.
 */
function stmtPersonLine_(l) {
  var d = String(l.description || '');
  if (STMT_WALLET_RE.test(d)) return stmtPersonName_(d);
  if (!STMT_WALLET2_RE.test(d) && !STMT_TRANSFER_PREFIX_RE.test(d)) return null;
  if (STMT_WALLET2_RE.test(d) && /\b(PAYPAL|CASH ?APP)\s*\*/i.test(d)) return null;   // "PAYPAL *SPOTIFY": the card descriptor of a purchase, not a person
  var rest = stmtNameTokens_(d);
  // The person's OWN name ("TRANSF EVA" on their own statement) is money moving between their accounts, never a person (OwnerNames.gs).
  if (isOwnNameText_(rest)) return null;
  var tokens = rest ? rest.split(' ') : [];
  if (tokens.length < 1 || tokens.length > 4 || rest.length > 32) return null;
  var ok = tokens.every(function (tk) {
    var up = tk.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!/^[A-ZÑ]+$/.test(up)) return false;
    if (up === 'DE' || up === 'DEL' || up === 'LA') return true;       // "Maria de la Cruz"
    return STMT_NOT_A_NAME_.indexOf(up) === -1;
  });
  var hasWord = tokens.some(function (tk) { return tk.length >= 3; });
  if (!ok || !hasWord) return null;
  return stmtPersonName_(d);
}

// Money that came in from a person is usually a friend paying their share, which is never income (principle 2): it is set aside
// rather than imported, and the person decides in the "Payments with people" group.
function stmtFromPerson_(l) {
  return l.amount > 0 && !!stmtPersonLine_(l);
}

/**
 * Who a wallet line is with, read from its wording: "Yape Ana Lopez" → "Ana Lopez", "PLIN-CARLA" → "Carla", "ABON PLIN-LUIS M" →
 * "Luis M". Returns { key, name }; a line with no name in it ("Yape USD") gets key '' (shown as "other wallet payments").
 * Rule-based: a bank that cuts a name short makes a different person.
 */
function stmtPersonName_(description) {
  var t = stmtNameTokens_(description);
  if (t.length < 2) return { key: '', name: '' };
  var key = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return { key: key, name: stmtTitleCase_(t) };
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
    if (a.reason === 'person') return;   // people are grouped by person, in their own group
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
 * Pairs that look like a currency exchange: money leaving in one currency and arriving in another within 24 hours (the
 * same day or the next — a statement line has a date, not a time; owner: "exchanges happen on a 24h window"), whose
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
      if (gap > 1) return;   // an exchange settles within 24 hours; statement lines carry a date, not a time, so same or next day
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
// Which investment platform a line names ("PAGO A HAPI INC" → Hapi): its nickname appears in the wording, accents and case ignored.
// Rule-based and optional: no match leaves the platform blank, and the person can pick one.
function stmtPlatformGuess_(description, platforms) {
  var text = ' ' + String(description || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ') + ' ';
  var hit = (platforms || []).filter(function (p) {
    var name = String(p.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    return name.length >= 3 && text.indexOf(' ' + name + ' ') !== -1;
  })[0];
  return hit ? hit.id : '';
}

/**
 * Which charge does a refund on a card reverse, and is it the same month? Looks at (1) charges already in the app that the analysis
 * found (`l.reversal.candidates`) and (2) charges on the same account in the statements being uploaded now: same currency and
 * amount, up to 45 days before. Best = a shared word in the wording, then the closest date. Returns { offset: boolean, entryId? }:
 * offset (a negative expense) only when that charge is in the refund's own month; otherwise the refund is income in "Refunds".
 */
function stmtRefundDecision_(sts, st, si, li, l, usedCharges) {
  var month = String(l.date).substring(0, 7);
  var words = significantWords_(String(l.description || '').replace(/^\s*REV\.?\s*/i, ''));
  // 1) a charge that is already an entry
  var existing = ((l.reversal && l.reversal.candidates) || []).filter(function (c) { return String(c.entry.date).substring(0, 7) === month; })[0];
  if (existing) return { offset: true, entryId: existing.entry.id };
  // 2) a charge in these statements
  var best = null;
  var lo = covAddDays_(l.date, -45);
  sts.forEach(function (st2, sj) {
    if (!st2.account || st2.account.id !== st.account.id) return;
    st2.lines.forEach(function (m, mj) {
      if (m.status === 'handled' || !(m.amount < 0) || m.currency !== l.currency || Math.abs(Math.abs(m.amount) - l.amount) >= 0.005) return;
      if (m.date > l.date || m.date < lo || usedCharges[sj + ':' + mj]) return;
      var shared = significantWords_(m.description || '').some(function (w) { return words.indexOf(w) >= 0; }) ? 1 : 0;
      var gap = Math.round((new Date(l.date + 'T00:00:00Z') - new Date(m.date + 'T00:00:00Z')) / 86400000);
      if (!best || shared > best.shared || (shared === best.shared && gap < best.gap)) best = { key: sj + ':' + mj, shared: shared, gap: gap, month: String(m.date).substring(0, 7) };
    });
  });
  if (best) {
    usedCharges[best.key] = true;
    return { offset: best.month === month };
  }
  return { offset: false };
}

// The other ways a line that is counted by default can be classified (each is the action that would replace its default one):
// one side of a transfer, an investment (or withdrawal), something to finish in Needs review (a loan, a repayment…), or left out.
function stmtChoicesFor_(si, li, l, platforms) {
  return {
    optInTransfer: { type: 'record_transfer_leg', stmt: si, line: li },
    optInInvestment: { type: 'add_history_investment', stmt: si, line: li, platformId: stmtPlatformGuess_(l.description, platforms) },
    optInReview: { type: 'add_history_pending', stmt: si, line: li },
    optInLeave: { type: 'ignore', stmt: si, line: li }
  };
}

function stmtHistoryPlan_(analysis, platforms) {
  var sts = analysis.statements || [];
  var actions = [];
  var aside = [];
  var counts = { expenses: 0, income: 0, refunds: 0, refundIncome: 0, transfers: 0, fees: 0, linked: 0, completed: 0 };
  var usedCharges = {};   // a charge is reversed by one refund only
  var leftOut = { handled: 0, waiting: 0, possible: 0, noAccount: 0, fromPeople: 0 };
  function setAside(si, li, st, l, reason) {
    // Money arriving on a credit card that looks like a payment is the card being paid — never income, so no "count as
    // income"; it can still be counted as a transfer (the other end is whatever account paid it).
    var cardPaid = st.account.type === 'credit' && l.amount > 0 && reason === 'waiting';
    var row = { stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency,
      account: st.account.nickname, reason: reason,
      optIn: cardPaid ? null : { type: l.amount > 0 ? 'add_history_income' : 'add_history_expense', stmt: si, line: li },
      // One side of a transfer whose other end is not in the app (yet): when that account's statement arrives, the open
      // transfer is completed by its line (the existing "complete transfer" rule), so nothing is counted twice.
      optInTransfer: { type: 'record_transfer_leg', stmt: si, line: li },
      // A loan or a repayment (or anything else to finish by hand): a pending expense/income in Needs review with Split, Mark as
      // repayment and Convert to loan.
      optInReview: { type: 'add_history_pending', stmt: si, line: li },
      // Money into (or out of) an investment platform. Never for the card being paid.
      optInInvestment: cardPaid ? null : { type: 'add_history_investment', stmt: si, line: li, platformId: stmtPlatformGuess_(l.description, platforms) } };
    // A line held back because it looks like an entry already in the app: say which one, so the person can judge.
    if (reason === 'person') {
      var who = stmtPersonLine_(l) || stmtPersonName_(l.description);
      row.person = who.key; row.personName = who.name;
    }
    if (reason === 'possible' && l.possible && l.possible.entry) {
      var pe = l.possible.entry;
      row.maybe = { date: pe.date, description: pe.description, amount: pe.amount, currency: pe.currency, account: pe.account };
    }
    aside.push(row);
  }
  var spent = {};
  var unknownAccounts = {};
  var first = null, last = null;
  var imported = [];   // lines the plan turns into an expense or an income, for the exchange picker
  var incomeLines = [];  // income imported by default (a salary…): each can be turned into a transfer, an investment withdrawal, a loan/repayment…
  var peopleOut = [];  // payments YOU made through a wallet: spending by default, the person can send one to Needs review or leave it out

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
      if (l.possible) { leftOut.possible++; setAside(si, li, st, l, 'possible'); return; }
      // A charge on a credit card is never money moving between the person's own accounts (card payments arrive as credits),
      // so "MDOPAGO*…" or "…PAGO…" in a merchant's name is just a purchase.
      var cardCharge = st.account.type === 'credit' && l.amount < 0 && l.section !== 'payments';
      // Words like "Yape" or a person's name mean something on a bank line, nothing in an app export's own notes.
      var personLine = st.source === 'app' ? null : stmtPersonLine_(l);
      // Money from a person: their own group, whether it looks like a transfer or not.
      if (personLine && l.amount > 0 && !l.reversal) {
        leftOut.fromPeople++;
        setAside(si, li, st, l, 'person');
        return;
      }
      // A transfer with a person's name that you SENT is a payment to a person (spending by default), not "waiting for another statement".
      if (l.waiting && !cardCharge && !(personLine && l.amount < 0)) {
        if (!l.rememberedWaiting) actions.push({ type: 'wait', stmt: si, line: li });   // already remembered by an earlier upload
        leftOut.waiting++;
        setAside(si, li, st, l, 'waiting');
        return;
      }
      if (!(Math.abs(l.amount) > 0)) return;
      if (l.date && (first === null || l.date < first)) first = l.date;
      if (l.date && (last === null || l.date > last)) last = l.date;
      if (l.amount > 0) {
        if (l.reversal) {
          // The owner's refund rule (the line-by-line comparison's): a refund in the SAME month as the charge it reverses cancels
          // it (a negative expense); in any other month — or when no matching charge is found — it is income in "Refunds".
          var rf = stmtRefundDecision_(sts, st, si, li, l, usedCharges);
          if (rf.offset) {
            actions.push(rf.entryId ? { type: 'add_history_reversal', stmt: si, line: li, entryId: rf.entryId } : { type: 'add_history_reversal', stmt: si, line: li });
            counts.refunds++;
          } else {
            actions.push({ type: 'add_history_refund', stmt: si, line: li });
            counts.refundIncome++;
          }
        }
        else {
          actions.push({ type: 'add_history_income', stmt: si, line: li }); counts.income++;
          incomeLines.push(Object.assign({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: st.account.nickname },
            stmtChoicesFor_(si, li, l, platforms)));
          imported.push({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: st.account.nickname, kind: 'imported' });
        }
      } else {
        actions.push({ type: 'add_history_expense', stmt: si, line: li });
        imported.push({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: st.account.nickname, kind: 'imported' });
        if (personLine) {
          peopleOut.push(Object.assign({ stmt: si, line: li, date: l.date, description: l.description, amount: l.amount, currency: l.currency, account: st.account.nickname,
            person: personLine.key, personName: personLine.name }, stmtChoicesFor_(si, li, l, platforms)));
        }
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
      counts: counts, leftOut: leftOut, spent: spent, aside: aside, peopleOut: peopleOut, incomeLines: incomeLines, platforms: (platforms || []).map(function (p) { return { id: p.id, name: p.name }; }),
      candidates: candidates, exchangeSuggestions: stmtExchangeSuggestions_(candidates),
      unknownAccounts: Object.keys(unknownAccounts),
      from: first, to: last,
      importable: counts.expenses + counts.income + counts.refunds + counts.refundIncome + counts.transfers + counts.fees
    }
  };
}

/**
 * payload: the same { statements } analyzeStatements takes. Returns the plan the phone shows and then saves with
 * applyStatementDecisions (dry run first, then for real). Writes nothing.
 */
function planStatementHistory(payload) {
  var analysis = analyzeStatements(payload);
  var platforms = getAllRows('Payment Methods').filter(function (pm) { return pm.type === 'investment'; }).map(function (pm) { return { id: pm.id, name: pm.nickname }; });
  var plan = stmtHistoryPlan_(analysis, platforms);
  // Balances: the same checks the old line-by-line comparison showed, with the account's name, so the phone can offer to set them.
  var checks = (analysis.balance_checks || []).map(function (c) {
    var st = (analysis.statements || [])[c.stmt];
    return Object.assign({}, c, { accountName: st && st.account ? st.account.nickname : '' });
  });
  return { actions: plan.actions, summary: plan.summary, balance_checks: checks };
}
