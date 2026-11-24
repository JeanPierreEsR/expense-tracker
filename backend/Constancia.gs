/**
 * Business 2, Phase 2, piece 9 (owner's plan "Fase 2 en detalle", approved 2026-11-23): the yearly "Constancia informativa" for one
 * LENDER or PARTNER of the company. Company copies only. Read-only: it stores nothing.
 *
 * Per currency, never added across currencies:
 *   - what they lent the company: the loans' amount ("contracted" = the loans' own amount until the contracts exist), the balance
 *     owed on 1 January, what was received in the year, the capital returned in the year (repayments and installment principals,
 *     cancel-outs included), anything forgiven in the year, and the balance on 31 December
 *     (= balance on 1 January + received − returned − forgiven);
 *   - the interest paid in the year (installments paid in the year): gross, the withholding the person recorded, net;
 *   - for a partner: the capital contributed in the year and in total up to 31 December, money still "to be decided", and the profit
 *     distributions of the year with the withholding recorded (piece 7).
 * It says which months of the year are not closed (piece 8). Its name is "Constancia informativa" (never "certificado") and it carries
 * the notice "Prepared by the management. Not accounting or a certification." (the phone shows both; the texts are the app's).
 * Only loans the COMPANY owes the person ("I owe them") are counted: money the company lent them is not part of this document.
 */

function requireCompanyConstancia_() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
}

function validYear_(year) {
  var y = String(year || '');
  if (!/^\d{4}$/.test(y)) throw new Error(tr_('const.badYear'));
  return y;
}

// Everything the statements of `year` need, read once (for one person or for all).
function constanciaContext_(year) {
  return constanciaRangeContext_(year, year + '-01-01', year + '-12-31');
}
// The same for any period (the accountant's monthly package uses one month: AccountantPackage.gs). `label` is what `year` carries.
function constanciaRangeContext_(label, start, end) {
  var year = String(start).slice(0, 4);
  var ctx = { year: label, start: start, end: end };
  ctx.loans = getAllRows('Loans').filter(function (l) { return l.direction === 'i_owe_them'; });
  ctx.settlements = {};
  getAllRows('Settlements').forEach(function (s) { (ctx.settlements[s.loan_id] = ctx.settlements[s.loan_id] || []).push(s); });
  ctx.entries = {};
  getAllRows('Entries').forEach(function (e) { ctx.entries[e.id] = e; });
  ctx.contributions = contributionRows_();
  ctx.distributions = distributionRows_();
  ctx.friends = {};
  getAllRows('Friends').forEach(function (f) { ctx.friends[f.id] = f; });
  // Months of the year that have ended and are not closed (piece 8).
  var closed = {};
  closedMonths_().forEach(function (m) { closed[m] = true; });
  var today = Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd');
  ctx.openMonths = [];
  for (var m = 1; m <= 12; m++) {
    var key = year + '-' + ('0' + m).slice(-2);
    if (key < start.slice(0, 7) || key > end.slice(0, 7)) continue;
    if (monthLastDay_(key) < today && !closed[key]) ctx.openMonths.push(key);
  }
  var company = getCompanyRows_()[0];
  ctx.company = company ? { name: String(company.name || ''), tax_id: String(company.tax_id || '') } : null;
  return ctx;
}

function dayBeforeIso_(iso) {
  var d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) - 1));
  return d.toISOString().slice(0, 10);
}
function d10_(v) { return changeText_(v).slice(0, 10); }

// What one loan still owed at the end of day `day` (a date before the loan = 0): its amount minus repayments and forgiven parts dated
// up to then, minus the remainder of a whole forgiveness dated up to then.
function loanOwedAt_(loan, ctx, day) {
  if (d10_(loan.date) > day) return 0;
  var settled = (ctx.settlements[loan.id] || []).reduce(function (n, s) { return d10_(s.date) <= day ? n + Number(s.amount) : n; }, 0);
  var parts = loanForgivenParts_(loan).reduce(function (n, p) { return d10_(p.date) <= day ? n + Number(p.amount) : n; }, 0);
  var owed = Number(loan.amount) - settled - parts;
  if (loan.status === 'forgiven' && loan.forgiveness_entry_id) {
    var fe = ctx.entries[loan.forgiveness_entry_id];
    if (fe && d10_(fe.date) <= day) owed = 0;
  }
  return Math.max(0, round2_(owed));
}

function yearStatement_(friendId, ctx) {
  var friend = ctx.friends[friendId];
  if (!friend) throw new Error(tr_('err.friendNotFound'));
  var role = friendRoleOf_(friend);
  var byCur = {};
  var line = function (cur) {
    return byCur[cur] = byCur[cur] || { currency: cur, contracted: 0, opening: 0, received: 0, returned: 0, forgiven: 0, closing: 0,
      interest_gross: 0, interest_withholding: 0, interest_net: 0,
      contributed_year: 0, contributed_total: 0, pending_total: 0,
      distributed_gross: 0, distributed_withholding: 0, distributed_net: 0 };
  };
  var dayBefore = dayBeforeIso_(ctx.start);
  var loansShown = [];
  ctx.loans.filter(function (l) { return l.friend_id === friendId; }).forEach(function (l) {
    var cur = String(l.currency || homeCurrency_());
    var opening = loanOwedAt_(l, ctx, dayBefore), closing = loanOwedAt_(l, ctx, ctx.end);
    var date = d10_(l.date);
    var inYear = date >= ctx.start && date <= ctx.end;
    var returned = (ctx.settlements[l.id] || []).reduce(function (n, s) { var d = d10_(s.date); return d >= ctx.start && d <= ctx.end ? n + Number(s.amount) : n; }, 0);
    var installments = loanInstallmentsOf_(l.id).filter(function (r) { return r.paid && r.paid_date >= ctx.start && r.paid_date <= ctx.end; });
    if (!opening && !closing && !inYear && !returned && !installments.length) return;   // nothing to do with this year
    var x = line(cur);
    x.contracted = round2_(x.contracted + Number(l.amount));
    x.opening = round2_(x.opening + opening);
    if (inYear) x.received = round2_(x.received + Number(l.amount));
    x.returned = round2_(x.returned + returned);
    x.closing = round2_(x.closing + closing);
    installments.forEach(function (r) {
      x.interest_gross = round2_(x.interest_gross + r.interest);
      x.interest_withholding = round2_(x.interest_withholding + r.withholding);
    });
    x.interest_net = round2_(x.interest_gross - x.interest_withholding);
    // What is left over is forgiven (or a whole forgiveness): opening + received − returned − closing.
    x.forgiven = round2_(x.opening + x.received - x.returned - x.closing);
    loansShown.push({ id: l.id, date: date, amount: Number(l.amount), currency: cur, description: String(l.description || '') });
  });
  ctx.contributions.forEach(function (r) {
    if (r.partner_id !== friendId) return;
    var e = ctx.entries[r.entry_id];
    if (!e || e.status !== 'confirmed') return;
    var d = d10_(e.date);
    if (d > ctx.end) return;
    var x = line(String(e.currency));
    if (r.kind === 'pending') { x.pending_total = round2_(x.pending_total + Number(e.amount)); return; }
    x.contributed_total = round2_(x.contributed_total + Number(e.amount));
    if (d >= ctx.start) x.contributed_year = round2_(x.contributed_year + Number(e.amount));
  });
  ctx.distributions.forEach(function (r) {
    if (r.partner_id !== friendId) return;
    var e = ctx.entries[r.entry_id];
    if (!e || e.status !== 'confirmed') return;
    var d = d10_(e.date);
    if (d < ctx.start || d > ctx.end) return;
    var x = line(String(e.currency));
    x.distributed_net = round2_(x.distributed_net + Number(e.amount));
    x.distributed_withholding = round2_(x.distributed_withholding + (Number(r.withholding) || 0));
    x.distributed_gross = round2_(x.distributed_gross + distributionGross_(r, e));
  });
  var home = homeCurrency_();
  var lines = Object.keys(byCur).sort(function (a, b) { return a === home ? -1 : (b === home ? 1 : (a < b ? -1 : 1)); }).map(function (k) { return byCur[k]; });
  return {
    friend_id: friendId, name: String(friend.name || ''), role: role, year: ctx.year, company: ctx.company,
    lines: lines, loans: loansShown.sort(function (a, b) { return a.date < b.date ? -1 : 1; }),
    open_months: ctx.openMonths, generated: Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd')
  };
}

// payload: { friend_id, year }
function getYearStatement(payload) {
  requireCompanyConstancia_();
  var year = validYear_(payload && payload.year);
  return yearStatement_(String(payload.friend_id || ''), constanciaContext_(year));
}

// "All the constancias": every lender and partner who has anything in that year, by name. SUNAT (the withholding's own debt) is left out:
// it is not an investor. payload: { year }
function getYearStatements(payload) {
  requireCompanyConstancia_();
  var year = validYear_(payload && payload.year);
  var ctx = constanciaContext_(year);
  var sunat = String(tr_('bank.withholdingPerson')).toLowerCase();
  return Object.keys(ctx.friends).filter(function (id) {
    var f = ctx.friends[id], role = friendRoleOf_(f);
    return (role === 'lender' || role === 'partner') && !f.trip_id && String(f.name).trim().toLowerCase() !== sunat;
  }).map(function (id) { return yearStatement_(id, ctx); })
    .filter(function (s) { return s.lines.length > 0; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}
