/**
 * Split by category (owner's plan, 2026-11-27): ONE purchase saved as linked parts.
 *
 * Every part is an ordinary expense entry with its own category, amount and friends' split, so budgets, Overview, trips and
 * Projections count each part in its own category with no change. All parts share the date, account, currency, description,
 * payer, trip, tags and company, and carry the same `purchase_id`: the id of the FIRST part (the "main" entry, the one the
 * form opens and edits). A plain entry has no purchase_id.
 *
 * Money screens see the purchase whole: a bank statement line is matched to the sum of the parts (stmtCollapsePurchases_,
 * StatementMatch.gs), Home shows one row, a friend's Loans screen one line, and deleting any part deletes the purchase.
 *
 *   saveEntryAll { ..., parts: [{ id, category_id, amount, splits }] }   the OTHER parts (the main one is the entry itself);
 *                                                                        [] = no longer split (the other parts go)
 */

// What every part has the same as the main entry.
var PURCHASE_SHARED_FIELDS_ = ['date', 'currency', 'description', 'paid_by', 'payment_method_id', 'trip_id', 'company_id', 'project_id'];
var PURCHASE_ID_RE_ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var purchaseDeleting_ = false;   // set while a purchase deletes its own parts, so each part does not delete the others again

function purchaseIdOf_(entry) {
  return entry ? String(entry.purchase_id || '') : '';
}

// The other parts of the purchase this entry belongs to (never the entry itself), from one read of Entries.
function purchaseSiblings_(entry) {
  var pid = purchaseIdOf_(entry);
  if (!pid) return [];
  return getAllRows('Entries').filter(function (e) { return String(e.purchase_id || '') === pid && String(e.id) !== String(entry.id); });
}

// Why this entry cannot be split by category ('' = it can). Checked before anything is written.
function purchasePartsBlock_(main) {
  if (!main) return tr_('err.entryNotFound');
  if (main.type !== 'expense') return tr_('parts.onlyExpense');
  if (Number(main.amount) <= 0 || String(main.refund_of || '') || Number(main.paid_amount) > 0 || String(main.charge_pending || '') ||
      Number(main.igv_amount) > 0 || String(main.unit_id || '')) return tr_('parts.notThisOne');
  if (main.status !== 'confirmed') return tr_('parts.notThisOne');
  var links = getEntryRepaymentLinks({ id: main.id });
  if (links && (links.loan || links.forgiveness || links.repayment || links.repaymentExtra)) return tr_('parts.notThisOne');
  if (purchaseRefundSummary_(main.id)) return tr_('parts.notThisOne');
  return '';
}

function cleanPurchaseParts_(parts) {
  var cats = {};
  getAllRows('Categories').forEach(function (c) { cats[String(c.id)] = c; });
  var seen = {};
  return (parts || []).map(function (p) {
    var id = String((p && p.id) || '');
    if (!PURCHASE_ID_RE_.test(id) || seen[id]) throw new Error(tr_('parts.badPart'));
    seen[id] = true;
    var amount = Math.round(Number(p.amount) * 100) / 100;
    if (!(amount > 0)) throw new Error(tr_('parts.badAmount'));
    var cat = cats[String(p.category_id || '')];
    if (!cat || cat.type !== 'expense') throw new Error(tr_('parts.pickCategory'));
    return { id: id, category_id: String(cat.id), amount: amount, splits: Array.isArray(p.splits) ? p.splits : [] };
  });
}

// Saves the other parts of the purchase whose main entry is `mainId` (already saved with its own category, amount and split).
// Parts sent with an id that is already a part are updated, new ids are created (the id is the part's client_id, so a resend
// never makes a second one), and parts no longer sent are deleted. `tagIds` = the purchase's tags (undefined = keep each part's).
function saveEntryParts_(mainId, parts, tagIds) {
  ensureColumn_('Entries', 'purchase_id');
  var main = getEntryById_(mainId);
  var clean = cleanPurchaseParts_(parts);
  if (clean.length) {
    var block = purchasePartsBlock_(main);
    if (block) throw new Error(block);
  }
  if (!main) throw new Error(tr_('err.entryNotFound'));
  var shared = { type: 'expense' };
  PURCHASE_SHARED_FIELDS_.forEach(function (k) { if (main[k] !== undefined) shared[k] = main[k] === null ? '' : main[k]; });
  var before = purchaseSiblings_(Object.assign({}, main, { purchase_id: mainId }));
  var beforeIds = {};
  before.forEach(function (e) { beforeIds[String(e.id)] = true; });
  var tags = tagIds;
  if (tags === undefined) tags = getEntryTags({ entryId: mainId });
  var kept = {};
  clean.forEach(function (p) {
    if (beforeIds[p.id]) {
      updateEntryFields(p.id, Object.assign({}, shared, { category_id: p.category_id, amount: p.amount }));
      saveEntryTags({ entryId: p.id, tagIds: tags || [] });
    } else {
      if (getEntryById_(p.id)) throw new Error(tr_('parts.badPart'));   // an id that belongs to another entry
      createEntry(Object.assign({}, shared, { category_id: p.category_id, amount: p.amount, client_id: p.id, tag_ids: tags || [] }));
      updateRowFields_('Entries', p.id, { purchase_id: mainId });
    }
    saveEntrySplits(p.id, p.splits);   // always: a part a friend paid owes them its own share even with no split
    kept[p.id] = true;
  });
  before.forEach(function (e) {
    if (kept[String(e.id)]) return;
    purchaseDeleting_ = true;
    try { discardEntryWithRepayments_(String(e.id), undefined); }
    finally { purchaseDeleting_ = false; }
  });
  updateRowFields_('Entries', mainId, { purchase_id: clean.length ? mainId : '' });
  return { parts: clean.map(function (p) { return p.id; }) };
}

// Deleting any part deletes the whole purchase, with the same choice about repaid debts (called by discardEntryWithRepayments_
// after the entry itself is gone).
function deletePurchaseSiblings_(entry, repayments) {
  if (purchaseDeleting_ || !purchaseIdOf_(entry)) return;
  var siblings = purchaseSiblings_(entry);
  if (!siblings.length) return;
  purchaseDeleting_ = true;
  try {
    siblings.forEach(function (s) { if (getEntryById_(s.id)) discardEntryWithRepayments_(String(s.id), repayments); });
  } finally { purchaseDeleting_ = false; }
}

// A bulk delete given one part takes the whole purchase.
function expandPurchaseIds_(ids) {
  var want = {};
  ids.forEach(function (id) { want[String(id)] = true; });
  var pids = {};
  var all = getAllRows('Entries');
  all.forEach(function (e) { if (want[String(e.id)] && purchaseIdOf_(e)) pids[purchaseIdOf_(e)] = true; });
  if (!Object.keys(pids).length) return ids;
  var out = ids.slice();
  all.forEach(function (e) {
    if (pids[purchaseIdOf_(e)] && !want[String(e.id)]) { out.push(String(e.id)); want[String(e.id)] = true; }
  });
  return out;
}

// purchase id -> { total, count } over every part (confirmed or not), from one read of Entries.
function purchaseTotals_() {
  var out = {};
  getAllRows('Entries').forEach(function (e) {
    var pid = purchaseIdOf_(e);
    if (!pid) return;
    var t = out[pid] = out[pid] || { total: 0, count: 0 };
    t.total = Math.round((t.total + Number(e.amount || 0)) * 100) / 100;
    t.count++;
  });
  return out;
}

// listEntries / the search copy: each part says the whole purchase's amount and how many parts it has, so a list that shows
// only one part (a category's list) can say "120 of 160".
function addPurchaseTotals_(entries) {
  if (!entries.some(function (e) { return purchaseIdOf_(e); })) return entries;
  var totals = purchaseTotals_();
  entries.forEach(function (e) {
    var t = totals[purchaseIdOf_(e)];
    if (!t) return;
    e.purchase_total = t.total;
    e.purchase_count = t.count;
  });
  return entries;
}

// The whole purchase for the edit form, when the phone's list does not hold every part (a page cut it, or the form was opened
// from a list of one category): each part with its friends' split, main part first.
function getPurchaseParts(payload) {
  var entry = getEntryById_(String((payload && payload.id) || ''));
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  var pid = purchaseIdOf_(entry);
  if (!pid) return { purchase_id: '', parts: [] };
  var splits = {};
  getAllRows('Entry Splits').forEach(function (s) {
    (splits[s.entry_id] = splits[s.entry_id] || []).push({ friend_id: s.friend_id, amount: Number(s.amount) });
  });
  var parts = getAllRows('Entries').filter(function (e) { return purchaseIdOf_(e) === pid; })
    .sort(function (a, b) { return (String(a.id) === pid ? -1 : 0) - (String(b.id) === pid ? -1 : 0); })
    .map(function (e) { return { id: String(e.id), category_id: String(e.category_id || ''), amount: Number(e.amount), splits: splits[e.id] || [] }; });
  return { purchase_id: pid, parts: parts };
}

// A bank statement sees ONE payment for a split purchase: its parts are folded into the main entry carrying the whole amount,
// so the line matches it (and the discount / tip pairing compares the whole amount). Only for matching: nothing is written.
function stmtCollapsePurchases_(entries) {
  var groups = {};
  entries.forEach(function (e) { var pid = purchaseIdOf_(e); if (pid) (groups[pid] = groups[pid] || []).push(e); });
  var pids = Object.keys(groups).filter(function (pid) { return groups[pid].length > 1; });
  if (!pids.length) return entries;
  var carrier = {}, total = {};
  pids.forEach(function (pid) {
    var parts = groups[pid];
    carrier[pid] = parts.filter(function (e) { return String(e.id) === pid; })[0] || parts[0];
    total[pid] = Math.round(parts.reduce(function (sum, e) { return sum + Number(e.amount || 0); }, 0) * 100) / 100;
  });
  var out = [];
  entries.forEach(function (e) {
    var pid = purchaseIdOf_(e);
    if (!pid || !carrier[pid]) { out.push(e); return; }
    if (e !== carrier[pid]) return;
    out.push(Object.assign({}, e, { amount: total[pid], purchase_whole: true }));
  });
  return out;
}

// A statement's "already in the app" line for a split purchase: the whole amount and every part's category ("Gifts + Shopping").
function purchaseStmtSummary_(e, catsById, pmsById) {
  var pid = purchaseIdOf_(e);
  var parts = getAllRows('Entries').filter(function (x) { return purchaseIdOf_(x) === pid; });
  var main = parts.filter(function (x) { return String(x.id) === pid; })[0] || e;
  var total = Math.round(parts.reduce(function (sum, x) { return sum + Number(x.amount || 0); }, 0) * 100) / 100;
  var names = [];
  parts.forEach(function (x) {
    var c = catsById[x.category_id];
    var label = c ? categoryLabel_(c) : '';
    if (label && names.indexOf(label) === -1) names.push(label);
  });
  return {
    id: main.id, date: main.date, type: main.type, description: main.description,
    amount: total, currency: main.currency, status: main.status,
    category: names.join(' + '),
    account: pmsById[main.payment_method_id] ? pmsById[main.payment_method_id].nickname : '',
    to_account: pmsById[main.to_payment_method_id] ? pmsById[main.to_payment_method_id].nickname : ''
  };
}

// Undo of a Needs review confirm that split the purchase (owner, 2026-11-27: "it shouldn't be refused"): the purchase goes back
// to how it arrived — ONE waiting item with the whole amount and the first part's category; the other parts are deleted.
// A part shared with friends is refused, like the Undo of any shared entry (its friends' debts would have to go too).
function unconfirmPurchase_(entry) {
  var pid = purchaseIdOf_(entry);
  var all = getAllRows('Entries').filter(function (e) { return purchaseIdOf_(e) === pid; });
  var main = all.filter(function (e) { return String(e.id) === pid; })[0];
  if (!main || main.source === 'manual') throw new Error(tr_('err.cannotUnconfirm'));
  var ids = {};
  all.forEach(function (e) { ids[String(e.id)] = true; });
  var shared = getAllRows('Entry Splits').some(function (sp) { return ids[String(sp.entry_id)]; }) ||
    getAllRows('Loans').some(function (l) { return ids[String(l.entry_id)]; });
  if (shared) throw new Error(tr_('err.cannotUnconfirm'));
  var total = Math.round(all.reduce(function (sum, e) { return sum + Number(e.amount || 0); }, 0) * 100) / 100;
  purchaseDeleting_ = true;
  try {
    all.forEach(function (e) { if (String(e.id) !== pid) discardEntryWithRepayments_(String(e.id), undefined); });
  } finally { purchaseDeleting_ = false; }
  updateRowFields_('Entries', pid, { amount: total, purchase_id: '' });
  setEntryField_(pid, 'status', 'pending');
  return { done: true, id: pid };
}
