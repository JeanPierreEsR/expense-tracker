/**
 * Phase 3: period summaries for the Overview screen. Aggregation happens
 * entirely here, server-side — with ~6,900+ historical entries, sending raw
 * rows to the browser for an "All-time" view and summing in JS would be far
 * too slow. Only the small aggregated result is returned.
 */

function getRateForEntryCurrency_(currency, dateStr) {
  if (currency === 'PEN') return 1;
  var month = String(dateStr).substring(0, 7);
  var rate = getExchangeRate(currency, month);
  return rate ? rate.rate : null;
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
  var tagById = rowsById_(getAllRows('Tags'));
  var pmById = rowsById_(getAllRows('Payment Methods'));

  var totals = { income: 0, expense: 0, investment: 0 };
  var excludedCount = 0;

  var acc = {
    expense: { category: {}, tag: {}, paymentMethod: {} },
    income: { category: {}, tag: {}, paymentMethod: {} }
  };

  entries.forEach(function (e) {
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
    else if (e.type === 'investment') totals.investment += ownAmountPen;
    else return;

    var bucket = e.type === 'expense' ? acc.expense : (e.type === 'income' ? acc.income : null);
    if (!bucket) return;

    addToBucket_(bucket.category, e.category_id, ownAmountPen, categoryById);
    (tagIdsByEntry[e.id] || []).forEach(function (tagId) {
      addToBucket_(bucket.tag, tagId, ownAmountPen, tagById);
    });
    if (e.paid_by === 'me' && e.payment_method_id) {
      addToBucket_(bucket.paymentMethod, e.payment_method_id, ownAmountPen, pmById);
    }
  });

  var net = totals.income - totals.expense - totals.investment;

  return {
    totals: {
      income: totals.income,
      expense: totals.expense,
      investment: totals.investment,
      net: net
    },
    excludedCount: excludedCount,
    breakdowns: {
      expense: {
        byCategory: bucketToList_(acc.expense.category, totals.expense, 'Uncategorized'),
        byTag: bucketToList_(acc.expense.tag, totals.expense, 'Untagged'),
        byPaymentMethod: bucketToList_(acc.expense.paymentMethod, totals.expense, 'Other')
      },
      income: {
        byCategory: bucketToList_(acc.income.category, totals.income, 'Uncategorized'),
        byTag: bucketToList_(acc.income.tag, totals.income, 'Untagged'),
        byPaymentMethod: bucketToList_(acc.income.paymentMethod, totals.income, 'Other')
      }
    }
  };
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
      name: ref ? (ref.name || ref.nickname || fallbackName) : fallbackName,
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
