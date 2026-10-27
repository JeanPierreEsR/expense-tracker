/**
 * Business pack, step 3B (2026-10-27) — IGV. See specs/business.md § Step 3.
 *
 * IGV is OPTIONAL and per company: a company that "Charges IGV" shows an "Includes IGV" switch on its entries, and the IGV
 * inside an entry's amount is stored in Entries.igv_amount (the amount itself never changes, so Overview, Home, Budgets and
 * Projections keep seeing the full amount paid). Only the project, company and IGV screens show figures WITHOUT IGV.
 *
 * This file is the company's IGV screen: per month and per currency, IGV collected (on income), IGV credit (on expenses, at
 * the owner's share) and the position (collected − credit; positive = owed to the tax office). Payments made to the tax
 * office are INFORMATION ONLY here: they never become an expense, never touch an account, and are listed apart.
 * Withholdings / detracciones are not modelled (ask the accountant). Nothing is converted between currencies.
 *
 * Nothing here reads or writes a sheet while the pack is off (requireBusiness_), like Business.gs.
 */

function getIgvPaymentRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('IGV Payments');
}

function igvPaymentById_(id) {
  var found = null;
  getIgvPaymentRows_().forEach(function (p) { if (String(p.id) === String(id)) found = p; });
  return found;
}

function cleanIgvPaymentInput_(p, company) {
  var amount = Number(p.amount);
  if (!(amount > 0)) throw new Error(tr_('err.validAmount'));
  var currency = String(p.currency || homeCurrency_()).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (!validIsoDate_(p.date)) throw new Error(tr_('err.dateRequired'));
  return {
    company_id: String(company.id), date: String(p.date), amount: round2_(amount), currency: currency,
    note: String(p.note || '').trim().substring(0, 200)
  };
}

function addIgvPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  payload = payload || {};
  var company = companyById_(payload.company_id);
  if (!company) throw new Error(tr_('business.companyNotFound'));
  var row = cleanIgvPaymentInput_(payload, company);
  row.id = Utilities.getUuid();
  appendRowObject('IGV Payments', row);
  return row;
}

function updateIgvPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var sheet = getSheet('IGV Payments');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload && payload.id);
  var existing = igvPaymentById_(payload && payload.id);
  if (rowIndex === -1 || !existing) throw new Error(tr_('business.igvPaymentNotFound'));
  var company = companyById_(existing.company_id);
  if (!company) throw new Error(tr_('business.companyNotFound'));
  var clean = cleanIgvPaymentInput_(payload, company);
  withWriteBatch_(function () {
    Object.keys(clean).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, clean[key]); });
  });
  clean.id = existing.id;
  return clean;
}

function deleteIgvPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var id = String((payload && payload.id) || '');
  if (!igvPaymentById_(id)) throw new Error(tr_('business.igvPaymentNotFound'));
  deleteRowsWhere_('IGV Payments', function (row) { return String(row.id) === id; });
  return { done: true };
}

// One company's IGV for a calendar year: months (newest first) with a line per currency, yearly totals per currency (with what
// was paid to the tax office and what is left), and the payments themselves. `years` lists every year that has IGV or a payment.
function getCompanyIgv(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  payload = payload || {};
  var company = companyById_(payload.id);
  if (!company) throw new Error(tr_('business.companyNotFound'));
  var thisYear = businessToday_().substring(0, 4);
  var year = /^\d{4}$/.test(String(payload.year || '')) ? String(payload.year) : thisYear;

  var rows = businessRows_(function (e) { return String(e.company_id || '') === String(company.id); });
  var years = {};
  years[thisYear] = true;
  var byMonth = {};   // 'YYYY-MM' -> currency -> { collected, credit }
  var totals = {};    // currency -> { collected, credit, paid }
  function totalFor(cur) { return totals[cur] || (totals[cur] = { collected: 0, credit: 0, paid: 0 }); }

  rows.forEach(function (r) {
    if (!(r.igv > 0)) return;
    var date = String(r.entry.date);
    years[date.substring(0, 4)] = true;
    if (date.substring(0, 4) !== year) return;
    var month = date.substring(0, 7);
    var line = (byMonth[month] || (byMonth[month] = {}))[r.currency] || (byMonth[month][r.currency] = { collected: 0, credit: 0 });
    var t = totalFor(r.currency);
    if (r.entry.type === 'income') { line.collected += r.igv; t.collected += r.igv; } else { line.credit += r.igv; t.credit += r.igv; }
  });

  var payments = getIgvPaymentRows_().filter(function (p) { return String(p.company_id) === String(company.id); });
  var shown = [];
  payments.forEach(function (p) {
    years[String(p.date).substring(0, 4)] = true;
    if (String(p.date).substring(0, 4) !== year) return;
    totalFor(String(p.currency).toUpperCase()).paid += Number(p.amount);
    shown.push({ id: p.id, date: p.date, amount: Number(p.amount), currency: String(p.currency).toUpperCase(), note: p.note || '' });
  });
  shown.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });

  var months = Object.keys(byMonth).sort().reverse().map(function (month) {
    return {
      month: month,
      lines: orderedCurrencies_(byMonth[month]).map(function (cur) {
        var l = byMonth[month][cur];
        return { currency: cur, collected: round2_(l.collected), credit: round2_(l.credit), position: round2_(l.collected - l.credit) };
      })
    };
  });
  var totalLines = orderedCurrencies_(totals).map(function (cur) {
    var t = totals[cur];
    var position = round2_(t.collected - t.credit);
    return { currency: cur, collected: round2_(t.collected), credit: round2_(t.credit), position: position, paid: round2_(t.paid), balance: round2_(position - t.paid) };
  });
  return {
    company: { id: company.id, name: company.name, emoji: company.emoji || '', tax_id: String(company.tax_id || ''), igv_enabled: companyChargesIgv_(company) },
    year: year,
    years: Object.keys(years).sort().reverse(),
    rate: igvRate_(),
    months: months,
    totals: totalLines,
    payments: shown
  };
}
