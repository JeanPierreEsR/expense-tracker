/**
 * Business 2, Phase 2, piece 11 (owner's plan "Fase 2 en detalle", approved 2026-11-23): SALES BY STAGE. Company copies only.
 *
 * A UNIT belongs to one project ("Depa 805"; since 2026-11-27 no longer a tag: Units.gs). Tab 'Units': id, tag_id (old), project_id,
 * buyer_id, price, currency, status (free text the person types; the app only suggests Available / Reserved / Sold / Delivered), note,
 * name. Its expected collections per stage are ordinary Expected Payments (step 3A) with two more columns: `unit_id` and `stage`
 * (reservation | down_payment | balance | bank_loan | other). No public-registry data decides anything.
 *
 * COLLECTED = the confirmed incomes of the unit (their `unit_id`), in the unit's currency (a returned deposit is a
 * negative income and lowers it). Still to collect = price − collected. The unit's incomes pay its stages in due-date order (an
 * income already linked to one expected payment by hand pays that one), so a stage is "paid" without anyone linking it; the
 * project's expected-payments list reads the same allocation (expectedPaidMap_ in BusinessPayments.gs).
 *
 * A RETURNED DEPOSIT (owner's option A, 2026-11-23): "Return the deposit" on one of the unit's incomes writes a NEGATIVE income on the
 * day the money goes back (same category, company, project, unit, tags; `refund_of` = the original), so that month's income goes down and the
 * month it came in stays as it was — the app's usual rule for refunds and reversals.
 */

var UNIT_STAGES_ = { reservation: true, down_payment: true, balance: true, bank_loan: true, other: true };
var UNIT_STAGE_ORDER_ = ['reservation', 'down_payment', 'balance', 'bank_loan', 'other'];

function requireCompanySales_() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
  ensureUnitsModel_();
}

function unitRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Units')) return [];
  return getAllRows('Units');
}

function ensureSalesColumns_() {
  ensureBusinessSheets_();
  ensureBusinessColumn_('Expected Payments', 'unit_id', true);
  ensureBusinessColumn_('Expected Payments', 'stage', true);
}

// unit id -> [entry] : the confirmed incomes of each unit, oldest first.
function taggedIncomes_() {
  var out = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'income' || e.status !== 'confirmed' || !e.unit_id) return;
    (out[e.unit_id] = out[e.unit_id] || []).push(e);
  });
  Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : (String(a.date) > String(b.date) ? 1 : 0); }); });
  return out;
}

// The incomes of one unit, in its currency.
function unitIncomes_(unit, tagged) {
  var today = businessToday_();
  return (tagged[String(unit.id)] || []).filter(function (e) {
    // A deposit returned on a later day counts from that day, not before (testers 2.68.2: "collected" dropped at once).
    if (e.refund_of && String(e.date).slice(0, 10) > today) return false;
    return String(e.project_id || '') === String(unit.project_id) && String(e.currency) === String(unit.currency || homeCurrency_());
  });
}

// expected payment id -> what the unit's incomes paid on it (stages of every unit, due date order; incomes linked by hand to one
// expected payment pay that one first). Read by expectedPaidMap_.
function unitStagePaidMap_() {
  var rows = (businessOn_() ? getExpectedRows_() : []).filter(function (x) { return x.unit_id; });
  if (!rows.length) return {};
  var units = unitRows_();
  var tagged = taggedIncomes_();
  var out = {};
  units.forEach(function (u) {
    var stages = rows.filter(function (x) { return String(x.unit_id) === String(u.id) && x.status !== 'covered'; })
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
function unitView_(u, people, tagged, expectedViews) {
  var incomes = unitIncomes_(u, tagged);
  var collected = round2_(incomes.reduce(function (n, e) { return n + Number(e.amount); }, 0));
  var price = Number(u.price) || 0;
  var pms = {};
  getAllRows('Payment Methods').forEach(function (p) { pms[p.id] = p; });
  return {
    id: u.id, name: String(u.name || ''), project_id: u.project_id,
    buyer_id: u.buyer_id || '', buyer: people[u.buyer_id] ? String(people[u.buyer_id].name) : '',
    price: price, currency: String(u.currency || homeCurrency_()), status: String(u.status || ''), note: String(u.note || ''),
    collected: collected, remaining: round2_(price - collected),
    stages: expectedViews.filter(function (x) { return String(x.unit_id) === String(u.id); })
      .sort(function (a, b) { return a.due_date < b.due_date ? -1 : 1; }),
    payments: incomes.map(function (e) {
      return { id: e.id, date: String(e.date).slice(0, 10), amount: Number(e.amount), currency: e.currency, description: String(e.description || ''),
        account: pms[e.payment_method_id] ? String(pms[e.payment_method_id].nickname || '') : '', operation: String(e.receipt_no || ''),   // the series-number or operation typed (piece 10); no bank operation number is stored
        refund_of: String(e.refund_of || ''), category_id: e.category_id };
    })
  };
}

// payload: { project_id } -> { units } (unassigned_tags stays empty: units are no longer made from tags)
function listProjectUnits(payload) {
  requireCompanySales_();
  var project = projectById_(payload && payload.project_id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var people = {};
  getAllRows('Friends').forEach(function (f) { people[f.id] = f; });
  var tagged = taggedIncomes_();
  var views = expectedViews_(getExpectedRows_().filter(function (x) { return String(x.project_id) === String(project.id); }), businessToday_());
  var raw = {};
  getExpectedRows_().forEach(function (x) { raw[x.id] = x; });
  views.forEach(function (v) { v.unit_id = (raw[v.id] || {}).unit_id || ''; v.stage = (raw[v.id] || {}).stage || ''; });
  var units = unitRows_().filter(function (u) { return String(u.project_id) === String(project.id) && String(u.name || '').trim(); })
    .map(function (u) { return unitView_(u, people, tagged, views); })
    .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  return { units: units, unassigned_tags: [] };
}

// New units of a project, by name (the "Add units" numbering). payload: { project_id, names } -> { added, skipped }
function addProjectUnits(payload) {
  requireCompanySales_();
  var project = projectById_(payload && payload.project_id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var pick = unitNamesToAdd_(project.id, payload || {});
  if (pick.names.length > 300) throw new Error(tr_('units.tooMany'));
  // A new unit is for sale until said otherwise (testers 2.68.2: "No status" read as missing data).
  var rows = pick.names.map(function (name) {
    return { id: Utilities.getUuid(), tag_id: '', project_id: String(project.id), buyer_id: '', price: '', currency: homeCurrency_(), status: tr_('sales.status.available'), note: '', name: name };
  });
  if (rows.length) appendRowsBulk_('Units', rows);
  if (ROWS_MEMO_) delete ROWS_MEMO_.Units;
  bumpStructureVersion_();
  return { added: rows.length, skipped: pick.skipped };
}

// payload: { id, name?, buyer_id | buyer_name, price, currency, status, note }
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
  if (payload.name !== undefined) {
    var name = String(payload.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) throw new Error(tr_('err.enterName'));
    if (unitRows_().some(function (r) { return r.id !== u.id && String(r.project_id) === String(u.project_id) && String(r.name || '').trim().toLowerCase() === name.toLowerCase(); })) {
      throw new Error(tr_('units.nameTaken', { name: name }));
    }
    fields.name = name;
  }
  updateRowFields_('Units', u.id, fields);
  if (ROWS_MEMO_) delete ROWS_MEMO_.Units;
  if (fields.name && fields.name !== String(u.name || '')) bumpStructureVersion_();   // the phones' search copy reads unit names: rebuilt
  return Object.assign({}, u, fields);
}

// Removes a unit nothing uses yet (a unit with entries or expected collections is refused: they would lose it). payload: { id }
function removeProjectUnit(payload) {
  requireCompanySales_();
  var id = String((payload && payload.id) || '');
  var used = getAllRows('Entries').filter(function (e) { return String(e.unit_id || '') === id; }).length
    + getExpectedRows_().filter(function (x) { return String(x.unit_id || '') === id; }).length;
  if (used) throw new Error(tr_('units.inUse', { n: used }));
  deleteRowsWhere_('Units', function (r) { return r.id === id; });
  bumpStructureVersion_();
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
      return String(r.unit_id) === String(u.id) && r.stage === stage && String(r.due_date).substring(0, 10) === String(payload.due_date || '').substring(0, 10) &&
        Math.abs(Number(r.amount) - Number(payload.amount)) < 0.005;
    });
    if (twin) return { id: twin.id, repeat: true };
  }
  var base = { project_id: u.project_id, client_id: u.buyer_id || '', amount: payload.amount, currency: u.currency || homeCurrency_(),
    due_date: payload.due_date, invoice_no: '', note: tr_('sales.stage.' + stage), igv_included: '' };
  var view = payload.id ? updateExpectedPayment(Object.assign({ id: payload.id }, base)) : addExpectedPayment(base);
  updateRowFields_('Expected Payments', view.id, { unit_id: String(u.id), stage: stage });
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
    var unitName = unitNameById_(orig.unit_id);
    var entry = {
      id: Utilities.getUuid(), type: 'income', date: date, amount: -round2_(amount), currency: orig.currency, category_id: orig.category_id,
      description: tr_('sales.returnDesc', { unit: unitName || String(orig.description || '') }), payment_method_id: String(payload.payment_method_id || orig.payment_method_id || ''),
      paid_by: orig.paid_by || 'me', status: 'confirmed', source: 'manual', external_id: '', import_batch_id: '', created_at: nowStamp_(),
      company_id: orig.company_id || '', project_id: orig.project_id || '', unit_id: orig.unit_id || '', refund_of: orig.id
    };
    appendRowObject('Entries', entry);
    tags.forEach(function (t) { appendRowObject('Entry Tags', { entry_id: entry.id, tag_id: t.tag_id }); });
    return { entry: entry };
  });
}

// The company Overview's two sales cards (companyOverview_): units by status and money per currency; expected collections due in the
// next 30 days and overdue (every expected payment of the company, stages or not).
function companySales_() {
  ensureUnitsModel_();
  var units = unitRows_().filter(function (u) { return String(u.name || '').trim(); });
  var unitsById = {};
  units.forEach(function (u) { unitsById[u.id] = u; });
  var tagged = taggedIncomes_();
  var byCur = {}, statuses = {};
  units.forEach(function (u) {
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
          unit: unitsById[r.unit_id] ? String(unitsById[r.unit_id].name) : '', stage: String(r.stage || ''), note: x.note };
      }) };
  };
  return {
    units: units.length,
    statuses: Object.keys(statuses).sort().map(function (s) { return { status: s, count: statuses[s] }; }),
    money: Object.keys(byCur).sort().map(function (c) { return byCur[c]; }),
    overdue: pick(open.filter(function (x) { return x.due_date < today; })),
    next30: pick(open.filter(function (x) { return x.due_date >= today && x.due_date <= in30; }))
  };
}
