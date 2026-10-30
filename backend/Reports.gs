/**
 * Phase 3: period summaries for the Overview screen. Aggregation happens
 * entirely here, server-side — with ~6,900+ historical entries, sending raw
 * rows to the browser for an "All-time" view and summing in JS would be far
 * too slow. Only the small aggregated result is returned.
 */

function getRateForEntryCurrency_(currency, dateStr) {
  if (currency === homeCurrency_()) return 1;
  var month = String(dateStr).substring(0, 7);
  return getLatestRateOnOrBefore_(currency, month);
}

function getPeriodSummary(payload) {
  var startDate = payload && payload.startDate;
  var endDate = payload && payload.endDate;

  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
  if (startDate) entries = entries.filter(function (e) { return e.date >= startDate; });
  if (endDate) entries = entries.filter(function (e) { return e.date <= endDate; });
  // Transfers between the owner's own accounts are never income/expense —
  // excluded from every figure this endpoint returns (see CLAUDE.md §5).
  entries = entries.filter(function (e) { return e.type !== 'transfer'; });
  // Overview's "Showing" filter (Business pack): personal / one company / one project. Ignored while the pack is off.
  entries = filterEntriesByScope_(entries, payload && payload.scope);

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  var tagIdsByEntry = {};
  getAllRows('Entry Tags').forEach(function (et) {
    if (!tagIdsByEntry[et.entry_id]) tagIdsByEntry[et.entry_id] = [];
    tagIdsByEntry[et.entry_id].push(et.tag_id);
  });

  var categoryById = rowsById_(getAllRows('Categories'));
  var tagById = rowsById_(localizeTags_(getAllRows('Tags')));
  var pmById = rowsById_(getAllRows('Payment Methods'));

  var totals = { income: 0, expense: 0, investment: 0 };
  var excludedCount = 0;
  // Investments are flows per platform in each entry's OWN currency (no conversion).
  var investmentFlows = {};

  var acc = {
    expense: { category: {}, tag: {}, paymentMethod: {} },
    income: { category: {}, tag: {}, paymentMethod: {} }
  };

  entries.forEach(function (e) {
    if (e.type === 'investment') {
      var pk = e.to_payment_method_id || '';
      var cur = e.currency || homeCurrency_();
      var f = investmentFlows[pk] || (investmentFlows[pk] = {});
      f[cur] = (f[cur] || 0) + Number(e.amount);
    }
    var rate = getRateForEntryCurrency_(e.currency, e.date);
    if (rate == null) { excludedCount++; return; }

    // own_share: amount minus whatever's been split off to friends. Only
    // expenses can carry splits (Entry Splits is expense-only per the data
    // model) — Loans/Splits (Phase 5) isn't built yet, so this is always
    // the full amount today, but the math is already correct for when it is.
    var ownAmount = Number(e.amount);
    if (e.type === 'expense') {
      ownAmount -= (splitSumByEntry[e.id] || 0);
    }
    var ownAmountPen = ownAmount * rate;

    if (e.type === 'expense') totals.expense += ownAmountPen;
    else if (e.type === 'income') totals.income += ownAmountPen;
    else if (e.type === 'investment') {
      totals.investment += ownAmountPen;
    }
    else return;

    var bucket = e.type === 'expense' ? acc.expense : (e.type === 'income' ? acc.income : null);
    if (!bucket) return;

    addToBucket_(bucket.category, e.category_id, ownAmountPen, categoryById);
    // An entry with no tag / no account of the owner's still counts, in its
    // own "no tag" / "no account" slice, so each pie covers the whole total.
    var tagIds = tagIdsByEntry[e.id] || [];
    if (!tagIds.length) addToBucket_(bucket.tag, '', ownAmountPen, tagById);
    tagIds.forEach(function (tagId) {
      addToBucket_(bucket.tag, tagId, ownAmountPen, tagById);
    });
    if (e.paid_by === 'me' && e.payment_method_id) {
      addToBucket_(bucket.paymentMethod, e.payment_method_id, ownAmountPen, pmById);
    } else {
      addToBucket_(bucket.paymentMethod, '', ownAmountPen, pmById);
    }
  });

  // Loans (owner's design, 2026-10-29): the Overview summary is four blocks that ADD UP to What's left, so the net money borrowed
  // and repaid in the period (a loan received and a repayment received are in, a loan given and a repayment paid are out) counts
  // in it, converted with the monthly rate table like every other figure. The Loans card keeps each currency apart.
  var loanFlows = loanFlowsForPeriod_(startDate, endDate, payload && payload.scope);
  totals.loans = loanFlows.netPen;
  excludedCount += loanFlows.excluded;
  var net = totals.income - totals.expense - totals.investment + totals.loans;

  return {
    totals: {
      income: totals.income,
      expense: totals.expense,
      investment: totals.investment,
      loans: totals.loans,
      net: net
    },
    excludedCount: excludedCount,
    investmentsByPlatform: investmentFlowsToList_(investmentFlows, pmById),
    loans: { people: loanFlows.people, totals: loanFlows.totals },
    breakdowns: {
      expense: {
        byCategory: bucketToList_(acc.expense.category, totals.expense, tr_('report.uncategorized')),
        byTag: bucketToList_(acc.expense.tag, totals.expense, tr_('report.untagged')),
        byPaymentMethod: bucketToList_(acc.expense.paymentMethod, totals.expense, tr_('report.noAccount'))
      },
      income: {
        byCategory: bucketToList_(acc.income.category, totals.income, tr_('report.uncategorized')),
        byTag: bucketToList_(acc.income.tag, totals.income, tr_('report.untagged')),
        byPaymentMethod: bucketToList_(acc.income.paymentMethod, totals.income, tr_('report.noAccount'))
      }
    }
  };
}

// Overview's Loans card (owner's request, 2026-10-29): debts with friends AND banks, as FLOWS in the period, each in the loan's own
// currency (never converted). Four kinds: borrowed (a loan received, +), lent (a loan given, -), repaid by the owner (-) and repaid to
// the owner (+). Never income or expense, so none of it touches the totals; forgiveness is not a flow (it books its own entry) and a
// repayment cancelled out against another loan (offset_loan_id) moved no money. Shared-bill shares are loans too (entry origin).
// Scope (Business pack): personal = loans with no project, project/company = that project's loans; anything else = all.
// Returns { people: [{ id, name, lines: [{ currency, borrowed, lent, paidBack, receivedBack, net }] }], totals: [same lines],
// netPen: the net in the main currency (monthly rate table), excluded: movements left out for lack of a rate }.
function loanFlowsForPeriod_(startDate, endDate, scope) {
  scope = String(scope || '');
  var inRange = function (d) {
    d = String(d || '').substring(0, 10);
    return !!d && (!startDate || d >= startDate) && (!endDate || d <= endDate);
  };
  var projectOk = function (loan) { return true; };
  if (scope && scope !== 'all' && businessOn_()) {
    var parts = scope.split(':');
    var id = parts.slice(1).join(':');
    if (scope === 'personal') {
      projectOk = function (loan) { return !loan.project_id; };
    } else if (parts[0] === 'project') {
      projectOk = function (loan) { return String(loan.project_id || '') === id; };
    } else if (parts[0] === 'company') {
      var ids = {};
      getProjectRows_().forEach(function (p) { if (String(p.company_id || '') === id) ids[p.id] = true; });
      projectOk = function (loan) { return !!ids[String(loan.project_id || '')]; };
    }
  }
  var loans = getAllRows('Loans').filter(projectOk);
  var loanById = rowsById_(loans);
  var friendById = rowsById_(getAllRows('Friends'));
  var people = {};
  var totals = {};
  var netPen = 0;
  var excluded = 0;
  var add = function (loan, kind, amount, date) {
    var cur = loan.currency || homeCurrency_();
    var rate = getRateForEntryCurrency_(cur, date);
    if (rate == null) excluded++;
    else netPen += (kind === 'borrowed' || kind === 'receivedBack' ? 1 : -1) * amount * rate;
    [people[loan.friend_id] || (people[loan.friend_id] = {}), totals].forEach(function (bag) {
      var l = bag[cur] || (bag[cur] = { currency: cur, borrowed: 0, lent: 0, paidBack: 0, receivedBack: 0 });
      l[kind] += amount;
    });
  };
  loans.forEach(function (l) {
    if (inRange(l.date)) add(l, l.direction === 'i_owe_them' ? 'borrowed' : 'lent', Number(l.amount) || 0, l.date);
  });
  getAllRows('Settlements').forEach(function (st) {
    if (st.offset_loan_id || !inRange(st.date)) return;
    var loan = loanById[st.loan_id];
    if (loan) add(loan, loan.direction === 'i_owe_them' ? 'paidBack' : 'receivedBack', Number(st.amount) || 0, st.date);
  });
  var finish = function (bag) {
    return Object.keys(bag).sort().map(function (cur) {
      var l = bag[cur];
      ['borrowed', 'lent', 'paidBack', 'receivedBack'].forEach(function (k) { l[k] = Math.round(l[k] * 100) / 100; });
      l.net = Math.round((l.borrowed - l.lent - l.paidBack + l.receivedBack) * 100) / 100;
      return l;
    }).filter(function (l) { return l.borrowed || l.lent || l.paidBack || l.receivedBack; });
  };
  return {
    people: Object.keys(people).map(function (fid) {
      var f = friendById[fid];
      return { id: fid, name: f ? f.name : '', lines: finish(people[fid]) };
    }).filter(function (r) { return r.lines.length; }).sort(function (a, b) {
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    }),
    totals: finish(totals),
    netPen: netPen,
    excluded: excluded
  };
}

// One row per platform: its net flow in each currency (a withdrawal is negative).
function investmentFlowsToList_(flows, pmById) {
  return Object.keys(flows).map(function (id) {
    var lines = Object.keys(flows[id]).map(function (cur) {
      return { currency: cur, amount: Math.round(flows[id][cur] * 100) / 100 };
    }).filter(function (l) { return Math.abs(l.amount) > 0.004; });
    var pm = id ? pmById[id] : null;
    return { id: id, name: pm ? pm.nickname : tr_('report.otherMethod'), lines: lines };
  }).filter(function (r) { return r.lines.length; }).sort(function (a, b) {
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
}

function rowsById_(rows) {
  var map = {};
  rows.forEach(function (r) { map[r.id] = r; });
  return map;
}

function addToBucket_(bucket, key, amountPen, lookup) {
  var k = key || '__none__';
  if (!bucket[k]) bucket[k] = { amountPen: 0, ref: key ? lookup[key] : null };
  bucket[k].amountPen += amountPen;
}

function bucketToList_(bucket, totalForPercent, fallbackName) {
  var items = Object.keys(bucket).map(function (key) {
    var b = bucket[key];
    var ref = b.ref;
    return {
      id: key === '__none__' ? '' : key,
      // A category row (it has parent_id) is shown with its translated name.
      name: ref ? (('parent_id' in ref) ? categoryLabel_(ref) : (ref.name || ref.nickname || fallbackName)) : fallbackName,
      color: ref && ref.color ? ref.color : '',
      icon: ref && ref.icon ? ref.icon : '',
      amount_pen: b.amountPen
    };
  });
  items.sort(function (a, b) { return b.amount_pen - a.amount_pen; });
  items.forEach(function (item) {
    item.percent = totalForPercent ? (item.amount_pen / totalForPercent * 100) : 0;
  });
  return items;
}
