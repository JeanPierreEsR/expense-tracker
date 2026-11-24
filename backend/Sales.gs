/**
 * Business 2, Phase 2, piece 11 (owner's plan "Fase 2 en detalle", approved 2026-11-23): SALES BY STAGE. Company copies only.
 *
 * A UNIT is a tag (piece 5: "Depa 805") that a project takes as one of its units. Tab 'Units': id, tag_id, project_id, buyer_id,
 * price, currency, status (free text the person types; the app only suggests Available / Reserved / Sold / Delivered), note.
 * Its expected collections per stage are ordinary Expected Payments (step 3A) with two more columns: `unit_tag_id` and `stage`
 * (reservation | down_payment | balance | bank_loan | other). No public-registry data decides anything.
 *
 * COLLECTED = the confirmed incomes of the project that carry the unit's tag, in the unit's currency (a returned deposit is a
 * negative income and lowers it). Still to collect = price − collected. The unit's incomes pay its stages in due-date order (an
 * income already linked to one expected payment by hand pays that one), so a stage is "paid" without anyone linking it; the
 * project's expected-payments list reads the same allocation (expectedPaidMap_ in BusinessPayments.gs).
 *
 * A RETURNED DEPOSIT (owner's option A, 2026-11-23): "Return the deposit" on one of the unit's incomes writes a NEGATIVE income on the
 * day the money goes back (same category, company, project, tag; `refund_of` = the original), so that month's income goes down and the
 * month it came in stays as it was — the app's usual rule for refunds and reversals.
 */

var UNIT_STAGES_ = { reservation: true, down_payment: true, balance: true, bank_loan: true, other: true };
var UNIT_STAGE_ORDER_ = ['reservation', 'down_payment', 'balance', 'bank_loan', 'other'];

function requireCompanySales_() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
}

function unitRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Units')) return [];
  return getAllRows('Units');
}

function ensureSalesColumns_() {
  ensureBusinessSheets_();
  ensureBusinessColumn_('Expected Payments', 'unit_tag_id', true);
  ensureBusinessColumn_('Expected Payments', 'stage', true);
}

// tag id -> [entry] : the confirmed incomes carrying each tag (any project), oldest first.
function taggedIncomes_() {
  var byEntry = {};
  getAllRows('Entry Tags').forEach(function (t) { (byEntry[t.entry_id] = byEntry[t.entry_id] || []).push(String(t.tag_id)); });
  var out = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'income' || e.status !== 'confirmed' || !byEntry[e.id]) return;
    byEntry[e.id].forEach(function (tagId) { (out[tagId] = out[tagId] || []).push(e); });
  });
  Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); }); });
  return out;
}

// The incomes of one unit: its tag, its project, its currency.
function unitIncomes_(unit, tagged) {
  return (tagged[String(unit.tag_id)] || []).filter(function (e) {
    return String(e.project_id || '') === String(unit.project_id) && String(e.currency) === String(unit.currency || homeCurrency_());
  });
}

// expected payment id -> what the unit's incomes paid on it (stages of every unit, due date order; incomes linked by hand to one
// expected payment pay that one first). Read by expectedPaidMap_.
function unitStagePaidMap_() {
  var rows = (businessOn_() ? getExpectedRows_() : []).filter(function (x) { return x.unit_tag_id; });
  if (!rows.length) return {};
  var units = unitRows_();
  var tagged = taggedIncomes_();
  var out = {};
  units.forEach(function (u) {
    var stages = rows.filter(function (x) { return String(x.unit_tag_id) === String(u.tag_id) && String(x.project_id) === String(u.project_id) && x.status !== 'covered'; })
      .sort(function (a, b) { return String(a.due_date) < String(b.due_date) ? -1 : 1; });
    if (!stages.length) return;
    var ids = {};
    stages.forEach(function (s) { ids[s.id] = true; });
    var pool = 0;
    unitIncomes_(u, tagged).forEach(function (e) {
      if (e.expected_payment_id && ids[e.expected_payment_id]) out[e.expected_payment_id] = round2_((out[e.expected_payment_id] || 0) + Number(e.amount));
      else pool += Number(e.amount);   // a returned deposit (negative) gives back what it took
    });
    stages.forEach(function (s) {
      var need = Math.max(0, Number(s.amount) - (out[s.id] || 0));
      var take = Math.max(0, Math.min(need, pool));
      out[s.id] = round2_((out[s.id] || 0) + take);
      pool -= take;
    });
  });
  return out;
}

// One unit as the app shows it.
function unitView_(u, tagsById, people, tagged, expectedViews) {
  var incomes = unitIncomes_(u, tagged);
  var collected = round2_(incomes.reduce(function (n, e) { return n + Number(e.amount); }, 0));
  var price = Number(u.price) || 0;
  var pms = {};
  getAllRows('Payment Methods').forEach(function (p) { pms[p.id] = p; });
  return {
    id: u.id, tag_id: u.tag_id, name: tagsById[u.tag_id] ? String(tagsById[u.tag_id].name) : '', project_id: u.project_id,
    buyer_id: u.buyer_id || '', buyer: people[u.buyer_id] ? String(people[u.buyer_id].name) : '',
    price: price, currency: String(u.currency || homeCurrency_()), status: String(u.status || ''), note: String(u.note || ''),
    collected: collected, remaining: round2_(price - collected),
    stages: expectedViews.filter(function (x) { return String(x.unit_tag_id) === String(u.tag_id) && String(x.project_id) === String(u.project_id); })
      .sort(function (a, b) { return a.due_date < b.due_date ? -1 : 1; }),
    payments: incomes.map(function (e) {
      return { id: e.id, date: String(e.date).slice(0, 10), amount: Number(e.amount), currency: e.currency, description: String(e.description || ''),
        account: pms[e.payment_method_id] ? String(pms[e.payment_method_id].nickname || '') : '', operation: String(e.receipt_no || ''),   // the series-number or operation typed (piece 10); no bank operation number is stored
        refund_of: String(e.refund_of || ''), category_id: e.category_id };
    })
  };
}

// payload: { project_id } -> { units, unassigned_tags } (the tags no project has taken yet, to add as units)
function listProjectUnits(payload) {
  requireCompanySales_();
  var project = projectById_(payload && payload.project_id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var tagsById = {};
  getAllRows('Tags').forEach(function (t) { tagsById[t.id] = t; });
  var people = {};
  getAllRows('Friends').forEach(function (f) { people[f.id] = f; });
  var all = unitRows_();
  var taken = {};
  all.forEach(function (u) { taken[u.tag_id] = true; });
  var tagged = taggedIncomes_();
  var views = expectedViews_(getExpectedRows_().filter(function (x) { return String(x.project_id) === String(project.id); }), businessToday_());
  var raw = {};
  getExpectedRows_().forEach(function (x) { raw[x.id] = x; });
  views.forEach(function (v) { v.unit_tag_id = (raw[v.id] || {}).unit_tag_id || ''; v.stage = (raw[v.id] || {}).stage || ''; });
  var units = all.filter(function (u) { return String(u.project_id) === String(project.id) && tagsById[u.tag_id]; })
    .map(function (u) { return unitView_(u, tagsById, people, tagged, views); })
    .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  var unassigned = Object.keys(tagsById).filter(function (id) { return !taken[id] && !isAnnualTagName_(String(tagsById[id].name)) && id !== ANNUAL_TAG_ID; })
    .map(function (id) { return { id: id, name: String(tagsById[id].name) }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  return { units: units, unassigned_tags: unassigned };
}

// The project takes these tags as its units. payload: { project_id, tag_ids }
function addProjectUnits(payload) {
  requireCompanySales_();
  var project = projectById_(payload && payload.project_id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  ensureBusinessSheets_();
  var taken = {};
  unitRows_().forEach(function (u) { taken[u.tag_id] = true; });
  var tags = {};
  getAllRows('Tags').forEach(function (t) { tags[t.id] = t; });
  var rows = (payload.tag_ids || []).filter(function (id) { return tags[id] && !taken[id]; }).map(function (id) {
    taken[id] = true;
    return { id: Utilities.getUuid(), tag_id: id, project_id: String(project.id), buyer_id: '', price: '', currency: homeCurrency_(), status: '', note: '' };
  });
  if (rows.length) appendRowsBulk_('Units', rows);
  if (ROWS_MEMO_) delete ROWS_MEMO_.Units;
  return { added: rows.length };
}

// payload: { id, buyer_id | buyer_name, price, currency, status, note }
function saveUnit(payload) {
  requireCompanySales_();
  var u = unitRows_().find(function (r) { return r.id === (payload && payload.id); });
  if (!u) throw new Error(tr_('sales.unitGone'));
  var price = payload.price === '' || payload.price == null ? '' : Number(payload.price);
  if (price !== '' && !(isFinite(price) && price >= 0)) throw new Error(tr_('err.validAmount'));
  var currency = String(payload.currency || u.currency || homeCurrency_()).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  var buyerId = '';
  if (payload.buyer_id) {
    if (!getAllRows('Friends').some(function (f) { return f.id === payload.buyer_id; })) throw new Error(tr_('err.friendNotFound'));
    buyerId = String(payload.buyer_id);
  } else if (String(payload.buyer_name || '').trim()) {
    var name = String(payload.buyer_name).trim();
    var same = getAllRows('Friends').find(function (f) { return !f.trip_id && String(f.name).trim().toLowerCase() === name.toLowerCase(); });
    buyerId = same ? same.id : addFriend({ name: name, role: 'client' }).id;
  }
  var fields = { buyer_id: buyerId, price: price === '' ? '' : round2_(price), currency: currency,
    status: String(payload.status || '').trim().slice(0, 40), note: String(payload.note || '').trim().slice(0, 300) };
  updateRowFields_('Units', u.id, fields);
  if (ROWS_MEMO_) delete ROWS_MEMO_.Units;
  return Object.assign({}, u, fields);
}

// The project no longer counts this tag as a unit (the tag, its incomes and its expected payments stay). payload: { id }
function removeProjectUnit(payload) {
  requireCompanySales_();
  deleteRowsWhere_('Units', function (r) { return r.id === (payload && payload.id); });
  return { done: true };
}

// A stage's expected collection. payload: { unit_id, stage, amount, due_date, id? (edit) }
function saveUnitStage(payload) {
  requireCompanySales_();
  var u = unitRows_().find(function (r) { return r.id === (payload && payload.unit_id); });
  if (!u) throw new Error(tr_('sales.unitGone'));
  var stage = String(payload.stage || '');
  if (!UNIT_STAGES_[stage]) throw new Error(tr_('sales.pickStage'));
  ensureSalesColumns_();
  // The same stage twice (same unit, stage, date and amount) is a repeat, not a second payment due (testers 2.68.2: two
  // identical "Cuota inicial" rows doubled the project's expected collections). Answered with the one already there.
  if (!payload.id) {
    var twin = getAllRows('Expected Payments').find(function (r) {
      return String(r.unit_tag_id) === String(u.tag_id) && r.stage === stage && String(r.due_date).substring(0, 10) === String(payload.due_date || '').substring(0, 10) &&
        Math.abs(Number(r.amount) - Number(payload.amount)) < 0.005;
    });
    if (twin) return { id: twin.id, repeat: true };
  }
  var base = { project_id: u.project_id, client_id: u.buyer_id || '', amount: payload.amount, currency: u.currency || homeCurrency_(),
    due_date: payload.due_date, invoice_no: '', note: tr_('sales.stage.' + stage), igv_included: '' };
  var view = payload.id ? updateExpectedPayment(Object.assign({ id: payload.id }, base)) : addExpectedPayment(base);
  updateRowFields_('Expected Payments', view.id, { unit_tag_id: String(u.tag_id), stage: stage });
  bumpStructureVersion_();   // updateRowFields_ does not tell the 1-hour reference cache (Expected Payments is read through it)
  return { id: view.id };
}

/**
 * "Return the deposit": a NEGATIVE income on the day the money goes back. payload: { entry_id, amount, date, payment_method_id }.
 * The amount is at most what the original brought in, less what was already returned from it.
 */
function returnUnitDeposit(payload) {
  requireCompanySales_();
  return withScriptLockOnce_(function () {
    var orig = getEntryById_(payload && payload.entry_id);
    if (!orig || orig.type !== 'income' || orig.status !== 'confirmed' || !(Number(orig.amount) > 0)) throw new Error(tr_('sales.notAnIncome'));
    var amount = Number(payload.amount);
    var already = getAllRows('Entries').filter(function (e) { return String(e.refund_of || '') === String(orig.id); })
      .reduce(function (n, e) { return n - Number(e.amount); }, 0);
    if (!(amount > 0) || amount > Number(orig.amount) - already + 0.004) throw new Error(tr_('sales.tooMuch', { max: exportMoney_(Number(orig.amount) - already) }));
    var date = String(payload.date || businessToday_());
    if (!validIsoDate_(date)) throw new Error(tr_('err.dateRequired'));
    ensureColumn_('Entries', 'refund_of');
    var tags = getAllRows('Entry Tags').filter(function (t) { return t.entry_id === orig.id; });
    var tagNames = {};
    getAllRows('Tags').forEach(function (t) { tagNames[t.id] = t.name; });
    var unitName = tags.map(function (t) { return tagNames[t.tag_id]; }).filter(Boolean).join(', ');
    var entry = {
      id: Utilities.getUuid(), type: 'income', date: date, amount: -round2_(amount), currency: orig.currency, category_id: orig.category_id,
      description: tr_('sales.returnDesc', { unit: unitName || String(orig.description || '') }), payment_method_id: String(payload.payment_method_id || orig.payment_method_id || ''),
      paid_by: orig.paid_by || 'me', status: 'confirmed', source: 'manual', external_id: '', import_batch_id: '', created_at: nowStamp_(),
      company_id: orig.company_id || '', project_id: orig.project_id || '', refund_of: orig.id
    };
    appendRowObject('Entries', entry);
    tags.forEach(function (t) { appendRowObject('Entry Tags', { entry_id: entry.id, tag_id: t.tag_id }); });
    return { entry: entry };
  });
}

// The company Overview's two sales cards (companyOverview_): units by status and money per currency; expected collections due in the
// next 30 days and overdue (every expected payment of the company, stages or not).
function companySales_() {
  var units = unitRows_();
  var tagsById = {};
  getAllRows('Tags').forEach(function (t) { tagsById[t.id] = t; });
  var tagged = taggedIncomes_();
  var byCur = {}, statuses = {};
  units.forEach(function (u) {
    if (!tagsById[u.tag_id]) return;
    var st = String(u.status || '').trim() || '';
    statuses[st] = (statuses[st] || 0) + 1;
    var cur = String(u.currency || homeCurrency_());
    var x = byCur[cur] = byCur[cur] || { currency: cur, price: 0, collected: 0, remaining: 0 };
    var collected = unitIncomes_(u, tagged).reduce(function (n, e) { return n + Number(e.amount); }, 0);
    x.price = round2_(x.price + (Number(u.price) || 0));
    x.collected = round2_(x.collected + collected);
    x.remaining = round2_(x.price - x.collected);
  });
  var today = businessToday_();
  var in30 = (function () { var d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 30)); return d.toISOString().slice(0, 10); })();
  var open = expectedViews_(getExpectedRows_(), today).filter(function (x) { return x.state === 'open'; });
  var raw = {};
  getExpectedRows_().forEach(function (x) { raw[x.id] = x; });
  var pick = function (list) {
    var totals = {};
    list.forEach(function (x) { totals[x.currency] = round2_((totals[x.currency] || 0) + x.remaining); });
    return { count: list.length, totals: Object.keys(totals).sort().map(function (c) { return { currency: c, amount: totals[c] }; }),
      items: list.slice(0, 8).map(function (x) {
        var r = raw[x.id] || {};
        return { id: x.id, due_date: x.due_date, remaining: x.remaining, currency: x.currency, project_name: x.project_name, client_name: x.client_name,
          unit: tagsById[r.unit_tag_id] ? String(tagsById[r.unit_tag_id].name) : '', stage: String(r.stage || ''), note: x.note };
      }) };
  };
  return {
    units: units.filter(function (u) { return tagsById[u.tag_id]; }).length,
    statuses: Object.keys(statuses).sort().map(function (s) { return { status: s, count: statuses[s] }; }),
    money: Object.keys(byCur).sort().map(function (c) { return byCur[c]; }),
    overdue: pick(open.filter(function (x) { return x.due_date < today; })),
    next30: pick(open.filter(function (x) { return x.due_date >= today && x.due_date <= in30; }))
  };
}
