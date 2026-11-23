/**
 * Business 2, Phase 2, piece 12 (owner's plan "Fase 2 en detalle", approved 2026-11-23): a STATEMENT TO SHARE with chosen sections
 * (what the company would send a partner each month, before any read-only access exists). Company copies only. Read-only, except
 * that the sections chosen are remembered for next time (Settings `share_sections`).
 *
 * Sections: cash (account balances today, the Balances card's figures), categories (the period's income and expenses by category,
 * the Overview's figures in the main currency), projects (each project's income, costs and result per currency, the Companies &
 * projects screen's figures), sales (piece 11's Sales card), owed (what is owed to each lender: OFF by default, the plan's rule),
 * partners (piece 7's Partners card). Every figure comes from the same reader the app's own screen uses, so they always agree.
 * It carries the notice "Prepared by the management. Not accounting or a certification." and says whether the period is closed
 * (piece 8).
 */

var SHARE_SECTIONS_ = ['cash', 'categories', 'projects', 'sales', 'owed', 'partners'];
var SHARE_DEFAULT_ = ['cash', 'categories', 'projects', 'sales', 'partners'];   // lenders are not shared unless chosen

function shareSectionsSaved_() {
  try {
    var saved = JSON.parse(String(getSettingsMap().share_sections || ''));
    if (Array.isArray(saved)) return saved.filter(function (s) { return SHARE_SECTIONS_.indexOf(s) !== -1; });
  } catch (e) { /* none saved yet */ }
  return SHARE_DEFAULT_.slice();
}

// The months of [start, end] that have ended and are not closed, and the close state when the period is one whole month.
function shareCloseInfo_(start, end) {
  var whole = wholeMonthOf_(start, end);
  if (whole) {
    var st = monthCloseState_(whole);
    return { month: whole, ended: st.ended, closed: st.closed, changed: st.changed, open_months: st.ended && !st.closed ? [whole] : [] };
  }
  var closed = {};
  closedMonths_().forEach(function (m) { closed[m] = true; });
  var today = businessToday_();
  var open = [];
  if (start && end) {
    var y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
    for (var guard = 0; guard < 120; guard++) {
      var key = y + '-' + ('0' + m).slice(-2);
      if (key > end.slice(0, 7)) break;
      if (monthLastDay_(key) < today && !closed[key]) open.push(key);
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return { month: '', ended: true, closed: false, changed: false, open_months: open };
}

/**
 * payload: { startDate, endDate, sections?: [..] (else the remembered ones), remember?: true }.
 * Returns { start, end, company, sections, close, data: { <section>: … only the chosen ones } }.
 */
function buildShareStatement(payload) {   // not "get…": it also remembers the sections (a write)
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
  payload = payload || {};
  var start = String(payload.startDate || ''), end = String(payload.endDate || '');
  var sections = Array.isArray(payload.sections)
    ? SHARE_SECTIONS_.filter(function (s) { return payload.sections.indexOf(s) !== -1; })
    : shareSectionsSaved_();
  if (!sections.length) throw new Error(tr_('share.pickOne'));
  if (Array.isArray(payload.sections) && payload.remember !== false) setSetting_('share_sections', JSON.stringify(sections));
  var want = {};
  sections.forEach(function (s) { want[s] = true; });
  var data = {};
  var summary = (want.categories || want.sales || want.owed || want.partners) ? getPeriodSummary({ startDate: start || undefined, endDate: end || undefined }) : null;
  var company = summary && summary.company;
  if (want.cash) {
    data.cash = listPaymentMethodBalances().filter(function (a) { return !a.statement_closed && a.balances; }).map(function (a) {
      return { name: String(a.nickname || ''), balances: a.balances.map(function (b) { return { currency: b.currency, amount: b.amount }; }) };
    });
  }
  if (want.categories) {
    var pick = function (list) { return (list || []).filter(function (c) { return Math.abs(Number(c.amount_pen) || 0) > 0.004; }).map(function (c) { return { name: c.name, amount: round2_(c.amount_pen) }; }); };
    data.categories = { currency: homeCurrency_(), income: round2_(summary.totals.income), expense: round2_(summary.totals.expense),
      result: round2_(summary.totals.income - summary.totals.expense),
      incomeBy: pick(summary.breakdowns.income.byCategory), expenseBy: pick(summary.breakdowns.expense.byCategory) };
  }
  if (want.projects) {
    data.projects = [];
    listCompaniesAndProjects({ startDate: start || undefined, endDate: end || undefined }).forEach(function (c) {
      c.projects.forEach(function (p) {
        var lines = (p.currencies || []).filter(function (x) { return Math.abs(x.income) > 0.004 || Math.abs(x.costs) > 0.004; })
          .map(function (x) { return { currency: x.currency, income: x.income, costs: x.costs, result: x.margin }; });
        if (lines.length || p.status !== 'closed') data.projects.push({ name: String(p.name || ''), lines: lines });
      });
    });
  }
  if (want.sales) data.sales = company ? { units: company.sales.units, statuses: company.sales.statuses, money: company.sales.money } : null;
  if (want.owed) data.owed = company ? { people: company.owed, totals: company.owedTotals } : null;
  if (want.partners) data.partners = company ? company.partners : [];
  var co = getCompanyRows_()[0];
  return {
    start: start, end: end, sections: sections, data: data,
    company: co ? { name: String(co.name || ''), tax_id: String(co.tax_id || '') } : null,
    close: shareCloseInfo_(start, end), generated: businessToday_()
  };
}

// The sections remembered (the sheet opens with them ticked).
function getShareSections() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
  return { sections: shareSectionsSaved_(), all: SHARE_SECTIONS_ };
}
