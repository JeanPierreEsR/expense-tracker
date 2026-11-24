/**
 * Business 2, Phase 2, piece 10 (owner's plan "Fase 2 en detalle", approved 2026-11-23): the MONTHLY PACKAGE FOR THE ACCOUNTANT.
 * Company copies only.
 *
 * (1) Three optional facts on a company's expense or income (form → More details): how it was paid (`pay_method`: transfer, cash,
 *     wallet = Yape / Plin, cheque), the receipt (`receipt_type`: boleta, factura, rh = recibo por honorarios, none) with its
 *     series-number (`receipt_no`) and the day it was issued (`receipt_date`; blank = the entry's own date). Columns made on first use,
 *     company copies only; anything else is ignored. A blank pay_method is guessed in the package when it can be: the Cash account =
 *     cash, a bot message that says Yape / Plin = wallet, a transfer = transfer.
 * (2) The package of a month, as CSV files that open in Excel (UTF-8 with BOM; a text that looks like a formula is written as text):
 *     movements (one row per confirmed entry: nature, payment method, receipt type and number, issue and payment dates, "with support",
 *     project, units / tags, the exchange rate of a real currency exchange), account balances (opening and closing, with the bank check
 *     of the month's close), the lenders' and partners' ledger (the yearly statement's figures for that month: Constancia.gs) and what is
 *     pending (still in Needs review, and expenses / income with no support). "With support" = a series-number typed or a receipt photo.
 * (3) Sent by e-mail from the person's own Google account to the accountant's address (typed once, kept in Settings
 *     `accountant_email`), with a copy to the person; or saved on the phone. Sending is written on the month's close (who, when, the
 *     fingerprint then): if the month changes after it was sent, the next one is a CORRECTED package that lists what changed.
 */

var PAY_METHODS_ = { transfer: true, cash: true, wallet: true, cheque: true };
var RECEIPT_TYPES_ = { boleta: true, factura: true, rh: true, none: true };
var RECEIPT_COLUMNS_ = ['pay_method', 'receipt_type', 'receipt_no', 'receipt_date'];

function ensureReceiptColumns_() {
  RECEIPT_COLUMNS_.forEach(function (c) { ensureColumn_('Entries', c); });
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  ['receipt_no', 'receipt_date'].forEach(function (c) {   // text: a series like 0001-123 or a date must never become a number / Date
    var col = headers.indexOf(c);
    if (col !== -1) sheet.getRange(1, col + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

// The receipt fields of a request, cleaned; {} outside a company copy or when none is sent. Refuses a bad value.
function receiptFieldsFrom_(src) {
  if (!src || !RECEIPT_COLUMNS_.some(function (k) { return src[k] !== undefined; })) return {};
  if (!isCompanyCopy_()) return {};
  var out = {};
  if (src.pay_method !== undefined) {
    out.pay_method = String(src.pay_method || '');
    if (out.pay_method && !PAY_METHODS_[out.pay_method]) throw new Error(tr_('pkg.badPayMethod'));
  }
  if (src.receipt_type !== undefined) {
    out.receipt_type = String(src.receipt_type || '');
    if (out.receipt_type && !RECEIPT_TYPES_[out.receipt_type]) throw new Error(tr_('pkg.badReceiptType'));
  }
  if (src.receipt_no !== undefined) out.receipt_no = String(src.receipt_no || '').trim().slice(0, 40);
  if (src.receipt_date !== undefined) {
    out.receipt_date = String(src.receipt_date || '');
    if (out.receipt_date && !validIsoDate_(out.receipt_date)) throw new Error(tr_('err.dateRequired'));   // a real day (2026-13-45 was taken; testers 2.68.2)
  }
  ensureReceiptColumns_();
  return out;
}

// For updateEntryFields: the receipt keys cleaned (or dropped outside a company copy), everything else as it was.
function receiptFieldsForUpdate_(fields) {
  if (!fields || !RECEIPT_COLUMNS_.some(function (k) { return fields[k] !== undefined; })) return fields;
  var clean = receiptFieldsFrom_(fields);
  var out = {};
  Object.keys(fields).forEach(function (k) { if (RECEIPT_COLUMNS_.indexOf(k) === -1) out[k] = fields[k]; });
  return Object.assign(out, clean);
}

// ---- The package ----

function pkgMonthRange_(month) {
  validMonth_(month);
  return { start: month + '-01', end: monthLastDay_(month) };
}

function pkgCsv_(rows) {
  return '﻿' + rows.map(function (r) {
    return r.map(function (v) { return typeof v === 'number' ? exportMoney_(v) : csvCell_(v); }).join(',');
  }).join('\r\n') + '\r\n';
}

function pkgYesNo_(b) { return tr_(b ? 'pkg.yes' : 'pkg.no'); }

// What an entry is, for the accountant (in the request's language).
function pkgNature_(e, links, inbound, sunatId) {
  var link = links[e.id];
  if (e.type === 'expense') return tr_('pkg.n.expense');
  if (e.type === 'income') return tr_(Number(e.amount) < 0 ? 'pkg.n.refundOut' : 'pkg.n.income');
  if (e.type === 'investment') return tr_('pkg.n.investment');
  if (link && link.partner_id) return tr_('pkg.n.' + link.kind);
  if (link && link.friend_id) {
    if (link.friend_id === sunatId) return tr_('pkg.n.withholding');
    if (link.kind === 'loan') return tr_(link.direction === 'i_owe_them' ? 'pkg.n.loanIn' : 'pkg.n.loanOut');
    if (link.kind === 'repayment') return tr_(link.direction === 'i_owe_them' ? 'pkg.n.repaymentOut' : 'pkg.n.repaymentIn');
  }
  if (e.exchange === '1' || /^(Currency exchange|Cambio de moneda)/i.test(String(e.description || ''))) return tr_('pkg.n.exchange');
  return tr_('pkg.n.transfer');
}

// A month that has started (a package for 2099 was sent; testers 2.68.2).
function pkgMonthOk_(month) {
  var m = validMonth_(month);
  if (m > businessToday_().slice(0, 7)) throw new Error(tr_('pkg.futureMonth'));
  return m;
}

// SUNAT's code for each receipt type (Tabla 10): factura 01, recibo por honorarios 02, boleta 03; none = 00.
var PKG_SUNAT_CODES_ = { factura: '01', rh: '02', boleta: '03', none: '00' };

// An account's name in the package's language: the built-in Cash follows it ("Cash" / "Efectivo"), as on the phone (testers 2.68.2).
function pkgAccountName_(pm) {
  var name = String((pm && pm.nickname) || '');
  if (pm && (pm.builtin === 'cash' || pm.type === 'cash') && /^(cash|efectivo)$/i.test(name.trim())) return tr_('pm.cashName');
  return name;
}

function pkgPayMethod_(e, pmById) {
  var stored = String(e.pay_method || '');
  if (stored) return stored;
  var pm = pmById[e.payment_method_id] || pmById[e.to_payment_method_id];
  if (pm && (pm.type === 'cash' || pm.builtin === 'cash' || /^(cash|efectivo|caja)$/i.test(String(pm.nickname || '').trim()))) return 'cash';
  if ((e.source === 'whatsapp' || e.source === 'telegram') && /\b(yape|plin)\b/i.test(String(e.description || ''))) return 'wallet';
  if (e.type === 'transfer' || /transf/i.test(String(e.description || ''))) return 'transfer';
  return '';
}

function buildAccountantPackage_(month) {
  var r = pkgMonthRange_(month);
  var home = homeCurrency_();
  var all = getAllRows('Entries');
  var entries = all.filter(function (e) { var d = d10_(e.date); return e.status === 'confirmed' && d >= r.start && d <= r.end; })
    .sort(function (a, b) { return d10_(a.date) < d10_(b.date) ? -1 : (d10_(a.date) > d10_(b.date) ? 1 : 0); });
  var cats = {}, pms = {}, projects = {}, tags = {}, tagsByEntry = {};
  getAllRows('Categories').forEach(function (c) { cats[c.id] = c; });
  getAllRows('Payment Methods').forEach(function (p) { pms[p.id] = p; });
  getProjectRows_().forEach(function (p) { projects[p.id] = p; });
  getAllRows('Tags').forEach(function (t) { tags[t.id] = t; });
  getAllRows('Entry Tags').forEach(function (t) { if (tags[t.tag_id]) (tagsByEntry[t.entry_id] = tagsByEntry[t.entry_id] || []).push(String(tags[t.tag_id].name)); });
  var links = buildTransferLinkMap_();
  var inbound = buildInboundTransferIds_();
  var sunat = getAllRows('Friends').find(function (f) { return String(f.name).trim().toLowerCase() === String(tr_('bank.withholdingPerson')).toLowerCase(); });
  var sunatId = sunat ? sunat.id : '';
  // A real currency exchange's rate: the main-currency leg of the same day divided by the other leg.
  var homeLegByDay = {};
  entries.forEach(function (e) { if (e.type === 'transfer' && e.exchange === '1' && e.currency === home) homeLegByDay[d10_(e.date)] = e; });
  var files = [];

  // 1. Movements
  var mv = [[tr_('pkg.h.payDate'), tr_('pkg.h.issueDate'), tr_('pkg.h.nature'), tr_('pkg.h.description'), tr_('pkg.h.category'),
    tr_('pkg.h.project'), tr_('pkg.h.units'), tr_('pkg.h.amount'), tr_('pkg.h.currency'), tr_('pkg.h.igv'), tr_('pkg.h.account'),
    tr_('pkg.h.payMethod'), tr_('pkg.h.receiptType'), tr_('pkg.h.receiptNo'), tr_('pkg.h.support'), tr_('pkg.h.fx'),
    // For the purchase and sales books (owner, 2026-11-24, after the testers): SUNAT's receipt code, and the amount split into its base,
    // IGV and total. Added at the end, so the columns an accountant already uses stay where they were.
    tr_('pkg.h.receiptCode'), tr_('pkg.h.base'), tr_('pkg.h.total')]];
  var unsupported = [];
  entries.forEach(function (e) {
    var signed = e.type === 'transfer' ? (inbound[e.id] || (e.to_payment_method_id && !e.payment_method_id) ? 1 : -1) * Math.abs(Number(e.amount))
      : (e.type === 'expense' || (e.type === 'investment' && Number(e.amount) > 0) ? -Math.abs(Number(e.amount)) : Math.abs(Number(e.amount)));
    if (e.type === 'income' && Number(e.amount) < 0) signed = Number(e.amount);
    var support = !!String(e.receipt_no || '').trim() || e.source === 'photo';
    if ((e.type === 'expense' || e.type === 'income') && !support) unsupported.push(e);
    var fx = '';
    if (e.type === 'transfer' && e.exchange === '1' && e.currency !== home && homeLegByDay[d10_(e.date)] && Number(e.amount)) {
      fx = (Math.round(Math.abs(Number(homeLegByDay[d10_(e.date)].amount)) / Math.abs(Number(e.amount)) * 10000) / 10000).toFixed(4);
    }
    var pay = pkgPayMethod_(e, pms);
    var account = pms[e.payment_method_id] || pms[e.to_payment_method_id];
    mv.push([d10_(e.date), String(e.receipt_date || '') || d10_(e.date), pkgNature_(e, links, inbound, sunatId), String(e.description || ''),
      cats[e.category_id] && e.type !== 'transfer' ? categoryLabel_(cats[e.category_id]) : '', projects[e.project_id] ? String(projects[e.project_id].name) : '',
      (tagsByEntry[e.id] || []).join(' / '), signed, String(e.currency || home), Number(e.igv_amount) || 0, account ? pkgAccountName_(account) : '',
      pay ? tr_('pkg.pm.' + pay) : '', e.receipt_type ? tr_('pkg.rt.' + e.receipt_type) : '', String(e.receipt_no || ''),
      e.type === 'expense' || e.type === 'income' ? pkgYesNo_(support) : '', fx,
      e.receipt_type ? (PKG_SUNAT_CODES_[e.receipt_type] || '') : '',
      e.type === 'expense' || e.type === 'income' ? round2_(Math.abs(Number(e.amount)) - (Number(e.igv_amount) || 0)) : '',
      e.type === 'expense' || e.type === 'income' ? round2_(Math.abs(Number(e.amount))) : '']);
  });
  files.push({ kind: 'movements', name: tr_('pkg.file.movements', { month: month }), rows: mv.length - 1, text: pkgCsv_(mv) });

  // 2. Account balances (opening = the end of the previous month), with the month's bank check when it was closed
  var prevEnd = dayBeforeIso_(r.start);
  var opening = {};
  accountBalancesAt_(prevEnd).forEach(function (b) { opening[b.payment_method_id + '|' + b.currency] = b.amount; });
  // A starting balance dated the 1st is that month's opening, before its movements (owner, 2026-11-24, after Elena's test: the file
  // said opening 0.00 and closing 211,771.49, so opening + movements did not give the closing).
  var openingsByPm = buildOpeningsByPm_(getAllRows('Payment Methods'));
  Object.keys(openingsByPm).forEach(function (pmId) {
    openingsByPm[pmId].forEach(function (o) {
      if (String(o.date).slice(0, 10) === String(r.start).slice(0, 10)) opening[pmId + '|' + o.currency] = round2_(o.amount);
    });
  });
  var closeRow = monthCloseRows_().filter(function (c) { return c.month === month && c.status === 'closed'; })[0];
  var bank = {};
  if (closeRow) { try { JSON.parse(closeRow.bank_check || '[]').forEach(function (b) { bank[b.payment_method_id + '|' + b.currency] = b; }); } catch (err) { /* none */ } }
  var bal = [[tr_('pkg.h.account'), tr_('pkg.h.currency'), tr_('pkg.h.opening'), tr_('pkg.h.closing'), tr_('pkg.h.bank'), tr_('pkg.h.difference')]];
  accountBalancesAt_(r.end).forEach(function (b) {
    var k = b.payment_method_id + '|' + b.currency, chk = bank[k];
    bal.push([pkgAccountName_(pms[b.payment_method_id] || { nickname: b.nickname }), b.currency, opening[k] || 0, b.amount, chk && chk.bank_amount !== null ? chk.bank_amount : '', chk && chk.difference !== null ? chk.difference : '']);
  });
  files.push({ kind: 'balances', name: tr_('pkg.file.balances', { month: month }), rows: bal.length - 1, text: pkgCsv_(bal) });

  // 3. Lenders' and partners' ledger for the month (the yearly statement's rules, Constancia.gs)
  var ctx = constanciaRangeContext_(month, r.start, r.end);
  var led = [[tr_('pkg.h.person'), tr_('pkg.h.role'), tr_('pkg.h.currency'), tr_('pkg.h.opening'), tr_('pkg.h.received'), tr_('pkg.h.interestGross'),
    tr_('pkg.h.interestWithholding'), tr_('pkg.h.interestNet'), tr_('pkg.h.returned'), tr_('pkg.h.closing'), tr_('pkg.h.contributed'),
    tr_('pkg.h.pending'), tr_('pkg.h.distributedGross'), tr_('pkg.h.distributedWithholding'), tr_('pkg.h.distributedNet')]];
  Object.keys(ctx.friends).forEach(function (id) {
    var f = ctx.friends[id], role = friendRoleOf_(f);
    if ((role !== 'lender' && role !== 'partner') || f.trip_id) return;
    var s = yearStatement_(id, ctx);
    s.lines.forEach(function (l) {
      // The tax office's withholding is a tax still to pay, not a lender (testers 2.68.2, Carlos).
      var isSunat = String(id) === String(companySunatId_());
      led.push([s.name, tr_(isSunat ? 'pkg.role.sunat' : role === 'partner' ? 'pkg.role.partner' : 'pkg.role.lender'), l.currency, l.opening, l.received, l.interest_gross,
        l.interest_withholding, l.interest_net, l.returned, l.closing, l.contributed_year, l.pending_total, l.distributed_gross,
        l.distributed_withholding, l.distributed_net]);
    });
  });
  files.push({ kind: 'ledger', name: tr_('pkg.file.ledger', { month: month }), rows: led.length - 1, text: pkgCsv_(led) });

  // 4. Pending: still in Needs review (that month), and expenses / income with no support
  var pen = [[tr_('pkg.h.what'), tr_('pkg.h.payDate'), tr_('pkg.h.description'), tr_('pkg.h.amount'), tr_('pkg.h.currency')]];
  all.filter(function (e) { var d = d10_(e.date); return e.status === 'pending' && d >= r.start && d <= r.end; }).forEach(function (e) {
    pen.push([tr_('pkg.pendingReview'), d10_(e.date), String(e.description || ''), Math.abs(Number(e.amount)), String(e.currency || home)]);
  });
  unsupported.forEach(function (e) { pen.push([tr_('pkg.pendingSupport'), d10_(e.date), String(e.description || ''), Math.abs(Number(e.amount)), String(e.currency || home)]); });
  files.push({ kind: 'pending', name: tr_('pkg.file.pending', { month: month }), rows: pen.length - 1, text: pkgCsv_(pen) });

  return { month: month, files: files, closed: !!closeRow, fingerprint: monthFingerprint_(month) };
}

function requireCompanyPackage_() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
}

// The files, for the phone to save (read-only). payload: { month }
function getAccountantPackage(payload) {
  requireCompanyPackage_();
  var built = buildAccountantPackage_(pkgMonthOk_(payload && payload.month));
  return { month: built.month, files: built.files.map(function (f) { return { kind: f.kind, name: f.name + '.csv', rows: f.rows, mime: 'text/csv', text: f.text }; }) };
}

function accountantEmail_() { return String(getSettingsMap().accountant_email || ''); }

// The package's sending state for a month: { email, sent_at, sent_to, corrected (it changed after it was sent), changes_since }.
function packageState_(month) {
  var row = monthCloseRows_().filter(function (c) { return c.month === month; })[0];
  var out = { email: accountantEmail_(), sent_at: '', sent_to: '', changed_since: false };
  if (!row || !row.package_sent_at) return out;
  out.sent_at = row.package_sent_at;
  out.sent_to = row.package_to || '';
  out.changed_since = !!row.package_fingerprint && row.package_fingerprint !== monthFingerprint_(month);
  return out;
}

/**
 * Sends the month's package from the person's own Google account. payload: { month, to, cc_me }. The address is kept for next time.
 * A month changed since its last package goes as a CORRECTED package listing the change-log lines since then.
 */
function sendAccountantPackage(payload) {
  requireCompanyPackage_();
  var month = pkgMonthOk_(payload && payload.month);
  var to = String(payload.to || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) throw new Error(tr_('export.badEmail'));
  var built = buildAccountantPackage_(month);
  var row = monthCloseRows_().filter(function (c) { return c.month === month; })[0];
  var corrected = !!(row && row.package_sent_at && row.package_fingerprint && row.package_fingerprint !== built.fingerprint);
  var changesText = '';
  if (corrected) {
    var lines = listChangeLog({ month: month, limit: 200 }).lines.filter(function (l) { return l.at > row.package_sent_at && l.table !== 'Month Closes'; });
    // Each line starts with the ENTRY's date (the day of the change read as the transaction's date) and names the field in words
    // (testers 2.68.2, Carlos: "receipt_no"); the change's own day goes at the end.
    changesText = lines.map(function (l) {
      var what = l.what ? ((l.what.date ? String(l.what.date).slice(0, 10) + ' ' : '') + l.what.description + ' ' + l.what.currency + ' ' + exportMoney_(l.what.amount)) : l.table;
      var fieldKey = 'pkg.field.' + l.field;
      var fieldName = l.field ? (tr_(fieldKey) !== fieldKey ? tr_(fieldKey) : l.field) : '';
      return '- ' + what + (l.field ? ': ' + fieldName + ' ' + l.before + ' → ' + l.after : ' (' + l.action + ')') + ' · ' + tr_('pkg.changedOn', { day: l.at.slice(0, 10) });
    }).join('\n') || tr_('pkg.handEdited');
  }
  // A month changed after its close, sent for the first time: said too, so the accountant knows (testers 2.68.2).
  var closeState = built.closed ? monthCloseState_(month) : null;
  var changedNote = !corrected && closeState && closeState.changed ? '\n\n' + tr_('pkg.changedAfterClose') : '';
  var company = getCompanyRows_()[0];
  var subject = tr_(corrected ? 'pkg.subjectCorrected' : 'pkg.subject', { company: company ? String(company.name) : '', month: month });
  var body = tr_('pkg.body', { month: month, files: built.files.map(function (f) { return '- ' + f.name + ' (' + f.rows + ')'; }).join('\n') }) +
    (built.closed ? '' : '\n\n' + tr_('pkg.notClosed')) +
    (corrected ? '\n\n' + tr_('pkg.correctedIntro') + '\n' + changesText : '') + changedNote + '\n\n' + tr_('const.notice');
  var attachments = built.files.map(function (f) { return Utilities.newBlob(f.text, 'text/csv', f.name + '.csv'); });
  var me = '';
  try { me = Session.getEffectiveUser().getEmail(); } catch (err) { me = ''; }
  if (!me) { try { me = Session.getActiveUser().getEmail(); } catch (err2) { me = ''; } }   // (the copy's owner: the web app runs as them)
  var opts = { attachments: attachments, name: company ? String(company.name) : 'Expense Tracker' };
  if (payload.cc_me !== false && me && me.toLowerCase() !== to.toLowerCase()) opts.cc = me;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error(tr_('export.quota'));
    MailApp.sendEmail(Object.assign({ to: to, subject: subject, body: body }, opts));
  } catch (err) {
    var e2 = new Error(tr_('pkg.sendFailed', { error: String(err && err.message || err) }));
    e2.code = 'send_failed';
    throw e2;
  }
  setSetting_('accountant_email', to);
  ensureMonthClosesSheet_();
  ['package_sent_at', 'package_to', 'package_fingerprint'].forEach(function (c) { ensureColumn_('Month Closes', c); });
  var stamp = nowStamp_();
  if (row) updateRowFields_('Month Closes', row.id, { package_sent_at: stamp, package_to: to, package_fingerprint: built.fingerprint });
  else appendRowObject('Month Closes', { id: Utilities.getUuid(), month: month, status: '', package_sent_at: stamp, package_to: to, package_fingerprint: built.fingerprint });
  if (ROWS_MEMO_) delete ROWS_MEMO_['Month Closes'];
  changeNoteEvent_('package', month, JSON.stringify({ to: to, corrected: corrected }));
  return { sent: true, corrected: corrected, to: to, cc: opts.cc || '', files: built.files.map(function (f) { return { name: f.name, rows: f.rows }; }) };
}
